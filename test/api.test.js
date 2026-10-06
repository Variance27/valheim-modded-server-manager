'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startGui, client } = require('./helpers');

let gui;
let api;

before(async () => {
  gui = await startGui();
  api = client(gui.base);
});
after(() => gui && gui.stop());

test('everything except the login page needs a session', async () => {
  const anon = client(gui.base);
  const a = await anon.get('/api/discord');
  assert.equal(a.status, 401);
  const page = await anon.call('GET', '/');
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /login\.html/);
});

test('login rejects a wrong password and accepts the right one', async () => {
  assert.ok(gui.password, 'the first start should print a one-time password');
  const bad = await client(gui.base).post('/api/auth/login', { username: 'admin', password: 'definitely-wrong' });
  assert.equal(bad.status, 401);
  const good = await api.post('/api/auth/login', { username: 'admin', password: gui.password });
  assert.equal(good.status, 200);
  const st = await api.get('/api/auth/status');
  assert.equal(st.json.authenticated, true);
  const mode = fs.statSync(path.join(gui.dir, 'auth.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  assert.ok(!fs.readFileSync(path.join(gui.dir, 'auth.json'), 'utf8').includes(gui.password), 'the password must not be stored in clear text');
});

test('state-changing requests need the CSRF header and a same-origin Origin', async () => {
  const noHeader = await fetch(`${gui.base}/api/discord`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'x=1' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const cross = await api.call('POST', '/api/discord', {}, { Origin: 'https://evil.example.com' });
  assert.equal(cross.status, 403);
});

test('Discord webhooks: validation, masking and private storage', async () => {
  const empty = await api.get('/api/discord');
  assert.equal(empty.json.changes.set, false);

  const bad = await api.post('/api/discord', { changes: 'https://evil.example.com/api/webhooks/123456789012345678/abc' });
  assert.equal(bad.status, 400);
  const shellish = await api.post('/api/discord', { changes: "https://discord.com/api/webhooks/1/x'; rm -rf /" });
  assert.equal(shellish.status, 400);

  const url = `https://discord.com/api/webhooks/123456789012345678/${'A'.repeat(40)}WXYZ`;
  const saved = await api.post('/api/discord', { changes: url });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.changes.set, true);
  assert.ok(saved.json.changes.masked.endsWith('WXYZ'));
  assert.ok(!saved.text.includes(url), 'the full URL must never be sent back to the browser');
  assert.ok((await api.get('/api/discord')).text.includes('WXYZ'));
  assert.ok(!(await api.get('/api/discord')).text.includes('A'.repeat(40)));

  const file = path.join(gui.dir, 'notifications.json');
  assert.ok(fs.readFileSync(file, 'utf8').includes(url));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const cleared = await api.post('/api/discord', { changes: '' });
  assert.equal(cleared.json.changes.set, false);
});

test('Discord webhook test button refuses a missing or invalid URL', async () => {
  const none = await api.post('/api/discord/test', { which: 'changes' });
  assert.equal(none.json.ok, false);
  const invalid = await api.post('/api/discord/test', { which: 'status', url: 'http://example.com/x' });
  assert.equal(invalid.json.ok, false);
});

test('Discord bot install validates input before touching the server', async () => {
  const id = '123456789012345678';
  const tooShort = await api.post('/api/bot/install', { token: 'short', userIds: id });
  assert.match(tooShort.text, /does not look like a Discord bot token/);
  const badIds = await api.post('/api/bot/install', { token: 'a'.repeat(60), userIds: '12345; rm -rf /' });
  assert.match(badIds.text, /15-25 digits/);
  const nobody = await api.post('/api/bot/install', { token: 'a'.repeat(60) });
  assert.match(nobody.text, /at least one/i);
  const action = await api.post('/api/bot/service', { action: 'rm -rf /' });
  assert.equal(action.status, 400);
});

test('worlds: names are validated, ports are spaced, duplicates are refused', async () => {
  for (const label of ['', ' ', '../etc', 'a'.repeat(31), 'bad;name']) {
    const r = await api.post('/api/instances', { label });
    assert.equal(r.status, 400, `"${label}" should be refused`);
  }
  const one = await api.post('/api/instances', { label: 'Test World' });
  assert.equal(one.status, 200);
  assert.match(one.json.instance.lgsmUser, /^vhserver-[a-z][a-z0-9]{0,9}$/);
  assert.equal(one.json.instance.plannedPort % 10, 6);
  const dup = await api.post('/api/instances', { label: 'test world' });
  assert.equal(dup.status, 400);
  const two = await api.post('/api/instances', { label: 'Second' });
  assert.equal(two.status, 200);
  assert.ok(Math.abs(two.json.instance.plannedPort - one.json.instance.plannedPort) >= 10, 'worlds must be at least 10 ports apart');
  const registry = JSON.parse(fs.readFileSync(path.join(gui.dir, 'instances.json'), 'utf8'));
  assert.equal(registry.instances.length, 2);
});

test('the main world cannot be removed or uninstalled', async () => {
  const r = await api.del('/api/instances/main?purge=1');
  assert.equal(r.status, 400);
  const unknown = await api.del('/api/instances/doesnotexist');
  assert.equal(unknown.status, 404);
});

test('too many wrong logins lock the address out', async () => {
  const fresh = await startGui();
  try {
    const c = client(fresh.base);
    let last;
    for (let i = 0; i < 5; i++) last = await c.post('/api/auth/login', { username: 'admin', password: `wrong-${i}` });
    assert.equal(last.status, 401);
    const locked = await c.post('/api/auth/login', { username: 'admin', password: fresh.password });
    assert.equal(locked.status, 429, 'even the right password is refused while locked out');
  } finally {
    fresh.stop();
  }
});

test('Health alerts: thresholds are validated only when the VPS checks apply', async () => {
  await api.post('/api/auth/login', { username: 'admin', password: gui.password });
  const badMinutes = await api.post('/api/health/schedule', { enabled: true, minutes: 7, disk: 85, mem: 10 });
  assert.equal(badMinutes.status, 400);
  const badDisk = await api.post('/api/health/schedule', { enabled: true, minutes: 15, live: true, res: true, disk: 20, mem: 10 });
  assert.equal(badDisk.status, 400);
  assert.match(badDisk.json.error, /disk threshold/);
  const badMem = await api.post('/api/health/schedule', { enabled: true, minutes: 15, live: true, res: true, disk: 85, mem: 99 });
  assert.equal(badMem.status, 400);
  // With the disk/memory check off, blank or stale thresholds must not block saving.
  const blank = await api.post('/api/health/schedule', { enabled: false, minutes: 15, live: true, res: false, disk: null, mem: null });
  assert.notEqual(blank.status, 400, blank.text);
});

test('the GUI script has no duplicate top-level function names (a later one silently replaces the earlier)', () => {
  const src = fs.readFileSync(path.join(gui.dir, 'public', 'app.js'), 'utf8');
  const names = [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  const dups = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dups, []);
});

test('the backup list shows no .txt files (the -plugins.txt records are left out)', async () => {
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-backups-'));
  for (const f of ['W-2026-10-05-1217.tar.gz', 'W-2026-10-05-1217-plugins.txt', 'W-2026-10-04-0017.tar.gz', 'W-2026-10-04-0017-plugins.txt', 'PRE-RESTORE-W-2026-10-05-1300.tar.gz', 'notes.txt']) fs.writeFileSync(path.join(bdir, f), 'x');
  const g = await startGui({ paths: { backupDir: bdir } });
  try {
    const c = client(g.base);
    await c.post('/api/auth/login', { username: 'admin', password: g.password });
    const r = await c.get('/api/backup/list');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.files.slice().sort(), ['PRE-RESTORE-W-2026-10-05-1300.tar.gz', 'W-2026-10-04-0017.tar.gz', 'W-2026-10-05-1217.tar.gz']);
  } finally {
    g.stop();
  }
});

test('mod snapshots: save, list with backups, and plan a restore', async (t) => {
  const { spawnSync } = require('child_process');
  if ((process.getuid && process.getuid() !== 0) && spawnSync('sudo', ['-n', 'true']).status !== 0) return t.skip('needs root or passwordless sudo');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-snap-'));
  const plugins = path.join(root, 'plugins');
  const bdir = path.join(root, 'backups');
  const home = path.join(root, 'home');
  for (const d of ['A-One-1.0.0', 'B-Two-2.0.0']) fs.mkdirSync(path.join(plugins, d), { recursive: true });
  fs.mkdirSync(bdir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'W-2026-10-01-0017-mods.txt'), JSON.stringify({ folders: ['A-One-0.9.0'], installedFrom: {} }));
  fs.writeFileSync(path.join(bdir, 'W-2026-10-01-0017-plugins.txt'), 'x');
  const g = await startGui({ lgsmHome: home, paths: { pluginsDir: plugins, backupDir: bdir } }, { fakeFetch: true });
  try {
    const c = client(g.base);
    await c.post('/api/auth/login', { username: 'admin', password: g.password });
    const saved = await c.post('/api/mods/snapshot', { reason: 'test snapshot' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.count, 2);
    const hist = await c.get('/api/mods/history');
    assert.equal(hist.status, 200, hist.text);
    assert.ok(hist.json.items.some((i) => i.kind === 'snapshot' && i.reason === 'test snapshot' && i.count === 2));
    assert.ok(hist.json.items.some((i) => i.kind === 'backup' && i.id === 'backup:W-2026-10-01-0017-mods.txt'));

    fs.rmSync(path.join(plugins, 'B-Two-2.0.0'), { recursive: true });
    fs.mkdirSync(path.join(plugins, 'C-Three-1.0.0'));
    const plan = await c.get(`/api/mods/restore-plan?id=${encodeURIComponent(saved.json.id)}`);
    assert.equal(plan.status, 200, plan.text);
    const by = (n) => plan.json.lines.find((l) => l.name === n);
    assert.equal(by('Two').action, 'install');
    assert.equal(by('Two').source, 'thunderstore');
    assert.equal(plan.json.checked, true);
    assert.equal(by('Three').action, 'remove');
    assert.equal(plan.json.unchanged, 1);

    // a version that is no longer published cannot be restored automatically
    fs.mkdirSync(path.join(plugins, 'B-Two-0.5.0'));
    const stale = await c.post('/api/mods/snapshot', { reason: 'stale' });
    fs.rmSync(path.join(plugins, 'B-Two-0.5.0'), { recursive: true });
    const plan2 = await c.get(`/api/mods/restore-plan?id=${encodeURIComponent(stale.json.id)}`);
    assert.equal(plan2.json.lines.find((l) => l.name === 'Two' && l.action === 'manual').note, 'Version 0.5.0 is no longer published.');

    // ids are validated: no path tricks
    assert.equal((await c.get('/api/mods/restore-plan?id=backup:../etc/passwd')).status, 404);
    assert.equal((await c.get('/api/mods/restore-plan?id=snap:../../x')).status, 404);
  } finally {
    g.stop();
  }
});

test('migration: preview, export, download, upload, verify and import through the API', async (t) => {
  const { spawnSync } = require('child_process');
  if ((process.getuid && process.getuid() !== 0) && spawnSync('sudo', ['-n', 'true']).status !== 0) return t.skip('needs root or passwordless sudo');
  if (!/GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout || '')) return t.skip('needs GNU tar');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-migapi-'));
  const home = path.join(root, 'home');
  const listDir = path.join(home, '.config/unity3d/IronGate/Valheim');
  fs.mkdirSync(path.join(listDir, 'worlds_local'), { recursive: true });
  fs.mkdirSync(path.join(home, 'serverfiles/BepInEx/core'), { recursive: true });
  fs.mkdirSync(path.join(home, 'serverfiles/BepInEx/plugins/A-One-1.0.0'), { recursive: true });
  fs.mkdirSync(path.join(home, 'lgsm/config-lgsm/vhserver'), { recursive: true });
  fs.writeFileSync(path.join(listDir, 'worlds_local/Asgard.db'), 'DB-CONTENT');
  fs.writeFileSync(path.join(home, 'serverfiles/BepInEx/plugins/A-One-1.0.0/One.dll'), 'dll');
  fs.writeFileSync(path.join(home, 'lgsm/config-lgsm/vhserver/vhserver.cfg'), 'servername="Asgard"\n');
  process.env.VGUI_MIGRATION_DIR = path.join(root, 'stage');
  const g = await startGui({ lgsmHome: home, lgsmUser: os.userInfo().username });
  try {
    const c = client(g.base);
    await c.post('/api/auth/login', { username: 'admin', password: g.password });
    assert.equal((await c.get('/api/migration/preview')).status, 200);
    const prev = (await c.get('/api/migration/preview')).json;
    assert.equal(prev.worlds[0].id, 'main');
    assert.deepEqual(prev.worlds[0].worlds, ['Asgard']);
    assert.equal(prev.worlds[0].running, false);

    assert.equal((await c.post('/api/migration/export', { worlds: [], saves: true })).status, 400);
    assert.equal((await c.post('/api/migration/export', { worlds: ['main'], saves: false, mods: false })).status, 400);
    const exp = await c.post('/api/migration/export', { worlds: ['main'], saves: true, mods: true });
    assert.equal(exp.status, 200, exp.text);
    const tok = (/EXPORT_READY (\d{14}) \d+/.exec(exp.text) || [])[1];
    assert.ok(tok, exp.text);

    assert.equal((await c.get('/api/migration/download/../../etc')).status, 404);
    const dl = await c.raw('GET', `/api/migration/download/${tok}`);
    assert.equal(dl.status, 200);
    assert.ok(dl.buffer.length > 1000);

    const up = await c.raw('POST', '/api/migration/upload', dl.buffer, { 'Content-Type': 'application/octet-stream', 'X-Bundle-Size': String(dl.buffer.length) });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.bytes, dl.buffer.length);
    const short = await c.raw('POST', '/api/migration/upload', dl.buffer, { 'Content-Type': 'application/octet-stream', 'X-Bundle-Size': String(dl.buffer.length + 5) });
    assert.equal(short.status, 400);

    // the first upload was replaced by the second (only one staged import at a time), so use the latest token
    const up2 = await c.raw('POST', '/api/migration/upload', dl.buffer, { 'Content-Type': 'application/octet-stream', 'X-Bundle-Size': String(dl.buffer.length) });
    const itok = up2.json.token;
    const insp = await c.get(`/api/migration/inspect/${itok}`);
    assert.equal(insp.status, 200, insp.text);
    assert.equal(insp.json.targets[0].id, 'main');
    assert.deepEqual(insp.json.targets[0].parts.sort(), ['bepinex.tgz', 'lgsm.tgz', 'saves.tgz']);
    assert.equal(insp.json.targets[0].known, true);
    const ver = await c.post(`/api/migration/verify/${itok}`, {});
    assert.match(ver.text, /VERIFIED/);

    // saves already exist here: refused until overwrite is chosen, then the old copy is kept
    const refused = await c.post('/api/migration/import', { token: itok, id: 'main', saves: true, mods: false });
    assert.match(refused.text, /\[collision\]/);
    fs.writeFileSync(path.join(listDir, 'worlds_local/Asgard.db'), 'LOCAL-EDIT');
    const done = await c.post('/api/migration/import', { token: itok, id: 'main', saves: true, mods: true, overwrite: true });
    assert.match(done.text, /IMPORTED main/, done.text);
    assert.equal(fs.readFileSync(path.join(listDir, 'worlds_local/Asgard.db'), 'utf8'), 'DB-CONTENT');
    assert.ok(fs.readdirSync(home).some((n) => n.startsWith('pre-migration-')));

    // unknown worlds and bad ids are refused
    assert.equal((await c.post('/api/migration/import', { token: itok, id: 'nope', saves: true })).status, 400);
    assert.equal((await c.del(`/api/migration/import/${itok}`)).status, 200);
    assert.equal((await c.del('/api/migration/other/12345678901234')).status, 400);
  } finally {
    g.stop();
    delete process.env.VGUI_MIGRATION_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
