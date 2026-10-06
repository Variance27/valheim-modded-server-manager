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
