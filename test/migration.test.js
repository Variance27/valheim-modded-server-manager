'use strict';
// The migration scripts are run for real (bash, tar, sha256sum) in temp folders, standing in for the old and the new VPS.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-mig-'));
process.env.VGUI_MIGRATION_DIR = path.join(root, 'stage');
const test = require('node:test');
const assert = require('node:assert/strict');
const mig = require('../migration');

const user = os.userInfo().username;
const bash = (script) => spawnSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const have = spawnSync('bash', ['-c', 'tar --version | head -1; sha256sum --version | head -1; pgrep --version'], { encoding: 'utf8' });
const GNU = have.status === 0 && /GNU tar/.test(have.stdout);

function makeWorld(name, { withBepInEx = true } = {}) {
  const home = path.join(root, name);
  const listDir = path.join(home, '.config/unity3d/IronGate/Valheim');
  const serverDir = path.join(home, 'serverfiles');
  const cfgDir = path.join(home, 'lgsm/config-lgsm/vhserver');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(serverDir, 'BepInEx'), { recursive: true });
  fs.mkdirSync(listDir, { recursive: true });
  if (withBepInEx) fs.mkdirSync(path.join(serverDir, 'BepInEx/core'));
  return { id: 'main', label: 'Main world', user, lgsmServer: 'vhserver', home, listDir, serverDir, cfgDir, plannedPort: null };
}
const fill = (w) => {
  fs.mkdirSync(path.join(w.listDir, 'worlds_local'), { recursive: true });
  fs.writeFileSync(path.join(w.listDir, 'worlds_local/Asgard.db'), 'DB-CONTENT');
  fs.writeFileSync(path.join(w.listDir, 'worlds_local/Asgard.fwl'), 'FWL');
  fs.writeFileSync(path.join(w.listDir, 'adminlist.txt'), '76561198000000000\n');
  fs.writeFileSync(path.join(w.cfgDir, 'vhserver.cfg'), `servername="Asgard"\nserverpassword="secret"\nstartparameters="-savedir ${w.home}/.config/unity3d/IronGate/Valheim"\n`);
  fs.mkdirSync(path.join(w.serverDir, 'BepInEx/plugins/A-One-1.0.0'), { recursive: true });
  fs.writeFileSync(path.join(w.serverDir, 'BepInEx/plugins/A-One-1.0.0/One.dll'), 'dll');
  fs.mkdirSync(path.join(w.serverDir, 'BepInEx/config/ValheimEnforcer'), { recursive: true });
  fs.writeFileSync(path.join(w.serverDir, 'BepInEx/config/ValheimEnforcer/Mods.yaml'), 'requiredMods: {}\n');
  fs.mkdirSync(path.join(w.home, 'disabled-mods/Off-Mod-1.0.0'), { recursive: true });
};

test('checkSpec refuses anything that could escape the game account home or break the scripts', () => {
  const ok = { id: 'main', user: 'vhserver', home: '/home/vhserver', listDir: '/home/vhserver/.config/x', serverDir: '/home/vhserver/serverfiles', cfgDir: '/home/vhserver/lgsm/config-lgsm/vhserver' };
  assert.doesNotThrow(() => mig.checkSpec(ok));
  for (const bad of [{ id: 'Main' }, { user: 'root; rm' }, { listDir: '/etc' }, { listDir: '/home/vhserver/../etc' }, { serverDir: "/home/vhserver/a b" }, { cfgDir: "/home/vhserver/'x" }, { home: 'relative' }]) {
    assert.throws(() => mig.checkSpec({ ...ok, ...bad }), `${JSON.stringify(bad)} should be refused`);
  }
});

test('parseManifest accepts a real manifest and rejects odd ones', () => {
  const m = mig.buildManifest({ guiVersion: '1.2.0', includes: { saves: true, mods: false }, worlds: [{ id: 'main', label: 'Main', user: 'vhserver', home: '/home/vhserver', plannedPort: null }, { id: 'pvp', label: 'PvP', user: 'vhserver-pvp', home: '/home/vhserver-pvp', plannedPort: 2466 }] });
  const r = mig.parseManifest(JSON.stringify(m));
  assert.ok(r.ok);
  assert.equal(r.manifest.worlds[1].plannedPort, 2466);
  assert.equal(r.manifest.includes.mods, false);
  assert.ok(!mig.parseManifest('not json').ok);
  assert.ok(!mig.parseManifest(JSON.stringify({ ...m, format: 99 })).ok);
  assert.ok(!mig.parseManifest(JSON.stringify({ ...m, worlds: [{ ...m.worlds[0], id: '../x' }] })).ok);
  assert.ok(!mig.parseManifest(JSON.stringify({ ...m, worlds: [m.worlds[0], m.worlds[0]] })).ok);
  assert.ok(!mig.parseManifest(JSON.stringify({ ...m, worlds: [{ ...m.worlds[0], home: '/home/a b' }] })).ok);
});

test('export, download, verify and import move a whole world to a new home', (t) => {
  if (!GNU) return t.skip('needs GNU tar, sha256sum and pgrep');
  const oldW = makeWorld('old');
  fill(oldW);
  const token = '20261005120000';
  const manifest = mig.buildManifest({ guiVersion: 't', includes: { saves: true, mods: true }, worlds: [oldW] });
  const exp = bash(mig.exportScript({ token, worlds: [oldW], saves: true, mods: true, allowRunning: false, manifestJson: JSON.stringify(manifest) }));
  assert.equal(exp.status, 0, exp.stdout + exp.stderr);
  assert.match(exp.stdout, /EXPORT_READY 20261005120000 \d+/);

  // "download" and "upload": the same bytes, into the import folder of the new VPS
  const bundle = path.join(root, 'bundle.tar');
  assert.equal(bash(`${mig.downloadCommand(token)} > ${bundle}`).status, 0);
  const impToken = '20261005120500';
  const impDir = path.join(mig.STAGE_ROOT, `import-${impToken}`);
  fs.mkdirSync(impDir, { recursive: true });
  fs.copyFileSync(bundle, path.join(impDir, 'bundle.tar'));

  const mf = bash(mig.readBundleCommand(impToken, 'manifest.json'));
  const parsed = mig.parseManifest(mf.stdout);
  assert.ok(parsed.ok, mf.stdout);
  assert.deepEqual(bash(mig.listPartsCommand(impToken)).stdout.trim().split('\n').sort(), ['worlds/main/bepinex.tgz', 'worlds/main/extras.tgz', 'worlds/main/lgsm.tgz', 'worlds/main/saves.tgz']);

  const ver = bash(mig.verifyScript(impToken));
  assert.equal(ver.status, 0, ver.stdout + ver.stderr);
  assert.match(ver.stdout, /VERIFIED/);

  // import into a fresh home (different path, BepInEx already installed by Setup)
  const newW = makeWorld('new');
  const parts = ['saves.tgz', 'lgsm.tgz', 'bepinex.tgz', 'extras.tgz'];
  const run = (over) => bash(mig.importScript({ token: impToken, w: newW, parts, oldHome: oldW.home, overwrite: over, doSaves: true, doMods: true, ts: '20261005121000' }));
  const imp = run(false);
  assert.equal(imp.status, 0, imp.stdout + imp.stderr);
  assert.match(imp.stdout, /IMPORTED main/);
  assert.equal(fs.readFileSync(path.join(newW.listDir, 'worlds_local/Asgard.db'), 'utf8'), 'DB-CONTENT');
  assert.equal(fs.readFileSync(path.join(newW.listDir, 'adminlist.txt'), 'utf8'), '76561198000000000\n');
  assert.ok(fs.existsSync(path.join(newW.serverDir, 'BepInEx/plugins/A-One-1.0.0/One.dll')));
  assert.ok(fs.existsSync(path.join(newW.serverDir, 'BepInEx/config/ValheimEnforcer/Mods.yaml')));
  assert.ok(fs.existsSync(path.join(newW.home, 'disabled-mods/Off-Mod-1.0.0')));
  const cfg = fs.readFileSync(path.join(newW.cfgDir, 'vhserver.cfg'), 'utf8');
  assert.match(cfg, /serverpassword="secret"/);
  assert.ok(cfg.includes(newW.home) && !cfg.includes(oldW.home), 'paths in the LinuxGSM config now point at the new home');

  // importing again over existing saves is refused unless the caller says overwrite, and then keeps what was there
  const again = run(false);
  assert.equal(again.status, 3);
  assert.match(again.stdout, /\[collision\]/);
  fs.writeFileSync(path.join(newW.listDir, 'worlds_local/Asgard.db'), 'NEWER-LOCAL');
  const over = run(true);
  assert.equal(over.status, 0, over.stdout + over.stderr);
  assert.equal(fs.readFileSync(path.join(newW.listDir, 'worlds_local/Asgard.db'), 'utf8'), 'DB-CONTENT');
  assert.equal(fs.readFileSync(path.join(newW.home, 'pre-migration-20261005121000/saves/worlds_local/Asgard.db'), 'utf8'), 'NEWER-LOCAL');

  // a bundle with a flipped byte is caught by the checksum check
  const bad = fs.readFileSync(bundle);
  bad[Math.floor(bad.length / 2)] ^= 0xff;
  const badTok = '20261005121500';
  fs.mkdirSync(path.join(mig.STAGE_ROOT, `import-${badTok}`), { recursive: true });
  fs.writeFileSync(path.join(mig.STAGE_ROOT, `import-${badTok}`, 'bundle.tar'), bad);
  const v2 = bash(mig.verifyScript(badTok));
  assert.notEqual(v2.status, 0);
});

test('import refuses mods when BepInEx is not installed yet, and archives with paths outside the folder', (t) => {
  if (!GNU) return t.skip('needs GNU tar');
  const w = makeWorld('noinstall', { withBepInEx: false });
  const tok = '20261005130000';
  const dir = path.join(mig.STAGE_ROOT, `import-${tok}`);
  const build = path.join(root, 'evil');
  fs.mkdirSync(path.join(build, 'worlds/main'), { recursive: true });
  fs.mkdirSync(path.join(build, 'src'), { recursive: true });
  fs.writeFileSync(path.join(build, 'src/ok.txt'), 'x');
  // saves.tgz that tries to write ../escaped.txt
  assert.equal(bash(`cd ${build}/src && tar -czf ../worlds/main/saves.tgz --transform='s#^ok.txt#../escaped.txt#' ok.txt 2>/dev/null`).status, 0);
  assert.equal(bash(`cd ${build}/src && tar -czf ../worlds/main/bepinex.tgz ok.txt`).status, 0);
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(bash(`tar -cf ${dir}/bundle.tar -C ${build} worlds`).status, 0);
  const args = { token: tok, w, parts: ['saves.tgz', 'bepinex.tgz'], oldHome: w.home, overwrite: false, ts: '20261005130100' };
  const noBep = bash(mig.importScript({ ...args, doSaves: false, doMods: true }));
  assert.notEqual(noBep.status, 0);
  assert.match(noBep.stdout, /BepInEx is not installed/);
  const evil = bash(mig.importScript({ ...args, doSaves: true, doMods: false }));
  assert.notEqual(evil.status, 0);
  assert.match(evil.stdout, /outside its folder/);
  assert.ok(!fs.existsSync(path.join(w.home, '.config/unity3d/IronGate/escaped.txt')) && !fs.existsSync(path.join(w.listDir, '../escaped.txt')));
});

test('the preview reports sizes, and export refuses a running world unless allowed', (t) => {
  if (!GNU) return t.skip('needs GNU tar');
  const w = makeWorld('prev');
  fill(w);
  const p = bash(mig.previewScript([w]));
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /FREE_KB:\d+/);
  const line = p.stdout.split('\n').find((l) => l.startsWith('W|main|'));
  assert.ok(line, p.stdout);
  const f = line.split('|');
  assert.equal(f[2], '1'); // account exists
  assert.equal(f[3], '0'); // not running
  assert.equal(f[8], '1'); // BepInEx installed
  assert.equal(f[9], 'Asgard');

  // a running server (its argv[0] looks like the game binary) blocks the export unless allowed
  const { spawn } = require('child_process');
  const fake = spawn('bash', ['-c', 'exec -a ./valheim_server.x86_64 sleep 30'], { stdio: 'ignore' });
  try {
    spawnSync('sleep', ['0.3']);
    const manifestJson = JSON.stringify(mig.buildManifest({ includes: { saves: true, mods: false }, worlds: [w] }));
    const blocked = bash(mig.exportScript({ token: '20261005140000', worlds: [w], saves: true, mods: false, allowRunning: false, manifestJson }));
    assert.equal(blocked.status, 4, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /\[running\] main/);
    const allowed = bash(mig.exportScript({ token: '20261005140001', worlds: [w], saves: true, mods: false, allowRunning: true, manifestJson }));
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(bash(mig.previewScript([w])).stdout, /W\|main\|1\|[1-9]\d*\|/);
  } finally {
    fake.kill();
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
