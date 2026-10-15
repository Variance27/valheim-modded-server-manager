'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'vps-scripts');

test('every shell script passes bash -n', (t) => {
  const bash = spawnSync('bash', ['--version']);
  if (bash.status !== 0) return t.skip('bash is not available');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sh'))) {
    const r = spawnSync('bash', ['-n', path.join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('every Python script compiles', (t) => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) return t.skip('python3 is not available');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.py'))) {
    const r = spawnSync('python3', ['-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())`, path.join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('no personal data is shipped in the scripts or the GUI', () => {
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(__dirname, '..', 'server.js'), path.join(__dirname, '..', 'public', 'app.js'), path.join(__dirname, '..', 'public', 'index.html')];
  for (const f of files) {
    if (!fs.statSync(f).isFile()) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/discord(app)?\.com\/api\/webhooks\/\d{15,}\/[A-Za-z0-9_-]{40,}/.test(text), `${path.basename(f)} contains what looks like a real Discord webhook`);
    assert.ok(!/NIUByVikings|BocaueWorld/.test(text), `${path.basename(f)} contains a hard-coded server name`);
  }
});

test('the backup script records the installed mod set as JSON (no PyYAML needed)', (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 is not available');
  const os = require('os');
  const src = fs.readFileSync(path.join(dir, 'backup-valheim.sh'), 'utf8');
  const m = /<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF/.exec(src);
  assert.ok(m, 'mod-set block not found in backup-valheim.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-modset-'));
  fs.mkdirSync(path.join(tmp, 'plugins', 'A-One-1.0.0'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'plugins', 'HandMade'));
  fs.writeFileSync(path.join(tmp, 'rec.yaml'), "A-One-1.0.0:\n  name: One\n  owner: A\n  source: hexium\n  version: 1.0.0\nGone-X-1.0.0:\n  name: X\n");
  fs.writeFileSync(path.join(tmp, 'x.py'), m[1]);
  const r = spawnSync('python3', [path.join(tmp, 'x.py'), path.join(tmp, 'plugins'), path.join(tmp, 'rec.yaml')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.folders, ['A-One-1.0.0', 'HandMade']);
  assert.equal(j.installedFrom['A-One-1.0.0'].source, 'hexium');
  assert.ok(!j.installedFrom['Gone-X-1.0.0'], 'records for folders that are gone are dropped');
  // the nightly prune removes the -mods.txt with its archive
  assert.match(src, /rm -f "\$old_manifest" "\$\{old_archive%\.tar\.gz\}-mods\.txt"/);
});

// ---- update-valheim.sh: LinuxGSM first, SteamCMD as the fallback, always try to restart ----
function updateRig(t, { withSteamcmd = true } = {}) {
  const os = require('os');
  if (spawnSync('bash', ['--version']).status !== 0) { t.skip('bash is not available'); return null; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-upd-'));
  const home = path.join(tmp, 'home'), scripts = path.join(tmp, 'scripts'), bin = path.join(tmp, 'bin'), srv = path.join(home, 'serverfiles');
  for (const d of [home, scripts, bin, srv, path.join(home, '.steam', 'steamcmd')]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(tmp, 'calls.log');
  const src = fs.readFileSync(path.join(dir, 'update-valheim.sh'), 'utf8')
    .replace(/__LGSM_USER__/g, 'vhserver').replace(/__LGSM_SCRIPT__/g, path.join(home, 'vhserver'))
    .replace(/__LGSM_HOME__/g, home).replace(/__SERVER_DIR__/g, srv)
    // keep the test independent of a real steamcmd on the machine running it
    .replace('/usr/games/steamcmd', path.join(tmp, 'no-such-steamcmd'));
  fs.writeFileSync(path.join(scripts, 'update-valheim.sh'), src);
  fs.writeFileSync(path.join(scripts, 'backup-valheim.sh'), `#!/bin/bash\necho backup >> "${log}"\n[ "\${FAKE_BACKUP:-ok}" = ok ]\n`);
  fs.writeFileSync(path.join(home, 'vhserver'), `#!/bin/bash\necho "lgsm $1" >> "${log}"\ncase "$1" in update) [ "\${FAKE_LGSM_UPDATE:-ok}" = ok ];; start) [ "\${FAKE_START:-ok}" = ok ];; esac\n`, { mode: 0o755 });
  // su - USER -c CMD  ->  just run CMD
  fs.writeFileSync(path.join(bin, 'su'), '#!/bin/bash\nshift 3\nexec bash -c "$1"\n', { mode: 0o755 });
  if (withSteamcmd) {
    fs.writeFileSync(path.join(home, '.steam', 'steamcmd', 'steamcmd.sh'),
      `#!/bin/bash\necho "steamcmd $*" >> "${log}"\nif [ "\${FAKE_STEAMCMD:-ok}" = ok ]; then echo "Success! App '896660' fully installed."; else echo "Error! App '896660' state is 0x202"; exit 8; fi\n`, { mode: 0o755 });
  }
  const run = (env = {}) => {
    const r = spawnSync('bash', [path.join(scripts, 'update-valheim.sh')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, ...env } });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { r, calls, maint: fs.existsSync(path.join(home, '.maintenance')), srv };
  };
  return { run };
}

test('update-valheim.sh: LinuxGSM update works -> no SteamCMD call, server restarted', (t) => {
  const rig = updateRig(t); if (!rig) return;
  const { r, calls, maint } = rig.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls, ['backup', 'lgsm update', 'lgsm start']);
  assert.equal(maint, false, 'the maintenance flag is removed again');
});

test('update-valheim.sh: LinuxGSM update fails -> SteamCMD runs on the server folder, then the server starts', (t) => {
  const rig = updateRig(t); if (!rig) return;
  const { r, calls, srv } = rig.run({ FAKE_LGSM_UPDATE: 'fail' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(calls[0], 'backup'); assert.equal(calls[1], 'lgsm update');
  // refresh Steam's app info in its own run first, then update in a second run
  assert.match(calls[2], /^steamcmd .*\+login anonymous \+app_info_update 1 \+app_info_print 896660 \+quit$/);
  assert.match(calls[3], new RegExp(`^steamcmd .*\\+force_install_dir ${srv.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\+login anonymous \\+app_update 896660 \\+quit$`));
  assert.ok(!/app_info_update/.test(calls[3]), 'the update run does not also refresh');
  assert.equal(calls[4], 'lgsm start');
  assert.match(r.stdout, /SteamCMD directly/);
});

test('update-valheim.sh: both methods fail -> the server is started again and the script exits 1', (t) => {
  const rig = updateRig(t); if (!rig) return;
  const { r, calls, maint } = rig.run({ FAKE_LGSM_UPDATE: 'fail', FAKE_STEAMCMD: 'fail' });
  assert.equal(r.status, 1);
  assert.equal(calls[calls.length - 1], 'lgsm start', 'the old build is started again');
  assert.match(r.stdout, /running again on its previous build/);
  assert.equal(maint, false);
});

test('update-valheim.sh: no SteamCMD at all -> stops before the backup and touches nothing', (t) => {
  const rig = updateRig(t, { withSteamcmd: false }); if (!rig) return;
  const { r, calls } = rig.run();
  assert.equal(r.status, 1);
  assert.deepEqual(calls, [], 'no backup, no stop, no start');
  assert.match(r.stdout, /Nothing was stopped or changed/);
});

test('update-valheim.sh: a failed backup still aborts before any update', (t) => {
  const rig = updateRig(t); if (!rig) return;
  const { r, calls } = rig.run({ FAKE_BACKUP: 'fail' });
  assert.equal(r.status, 1);
  assert.deepEqual(calls, ['backup']);
});
