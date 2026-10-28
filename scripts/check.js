'use strict';
// Syntax check for everything that cannot be run here: the server and browser JS (node --check),
// the VPS shell scripts (bash -n) and the VPS Python scripts (py_compile). Also fails on a shell
// script with CRLF line endings, which breaks on Linux ($'\r': command not found).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const files = walk(root);
const rel = (f) => path.relative(root, f);
const have = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const python = ['python3', 'python'].find((c) => have(c, ['--version']));

let failed = 0;
const run = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${label}\n${(r.stderr || r.stdout || (r.error && r.error.message) || '').trim()}`);
  }
};

for (const f of files.filter((f) => f.endsWith('.js'))) run(rel(f), process.execPath, ['--check', f]);

for (const f of files.filter((f) => f.endsWith('.sh'))) {
  if (fs.readFileSync(f, 'latin1').includes('\r')) {
    failed++;
    console.error(`FAIL ${rel(f)}: has CRLF line endings`);
  }
  if (have('bash', ['-c', 'true'])) run(rel(f), 'bash', ['-n', f]);
}

if (python) {
  for (const f of files.filter((f) => f.endsWith('.py'))) {
    run(rel(f), python, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', f]);
  }
} else {
  console.warn('python not found: skipped the .py files');
}

console.log(failed ? `${failed} problem(s)` : 'all files OK');
process.exit(failed ? 1 : 0);
