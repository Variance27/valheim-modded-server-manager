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
