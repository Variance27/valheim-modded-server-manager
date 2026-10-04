'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
