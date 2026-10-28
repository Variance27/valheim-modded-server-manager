'use strict';
// Starts the real server on a copy of the project with a fake VPS (SSH to a closed local port) and
// no internet. Catches files that fail to load, a feature used at load time before it exists, and
// broken login or world selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const port = 40000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

let dir;
let child;
let output = '';

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgui-boot-'));
  for (const f of ['server.js', 'auth.js', 'migration.js', 'modgraph.js', 'modsets.js', 'pzmodsets.js', 'package.json', 'src', 'public', 'vps-scripts']) {
    fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ssh: { host: '127.0.0.1', port: 9, username: 'root', password: 'x' }, guiPort: port }));
  fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify({ instances: [{ id: 'second', label: 'Second', lgsmUser: 'vhserver-second', lgsmServer: 'vhserver' }] }));
  require(path.join(dir, 'auth.js')).saveCredentials(dir, 'admin', 'boot-test-password');

  child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'offline.js'), 'server.js'], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
  // Settles on the first of: the "running" line, the server exiting, or 15 s. Nothing is left
  // waiting afterwards, so a server that fails to start fails the test instead of hanging it.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 15 s:\n${output}`)), 15000);
    const onData = (d) => {
      output += d;
      if (output.includes('Valheim GUI running at')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}) before starting:\n${output}`));
    });
  });
});

test.after(async () => {
  // Windows will not delete a folder a running process uses as its working directory.
  if (child && child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve).kill());
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function call(method, url, { body, cookie } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-vgui': '1', origin: base, cookie: cookie || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

test('serves the login page and refuses the API without a session', async () => {
  assert.equal((await call('GET', '/login.html')).status, 200);
  assert.equal((await call('GET', '/api/status')).status, 401);
});

test('logs in, lists both worlds, and selects a world per request', async () => {
  const bad = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const login = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'boot-test-password' } });
  assert.equal(login.status, 200);
  const cookie = login.cookie;

  const worlds = await call('GET', '/api/instances?instance=second', { cookie });
  assert.equal(worlds.status, 200);
  assert.equal(worlds.json.current, 'second');
  assert.deepEqual(worlds.json.instances.map((w) => w.id), ['main', 'second']);
  assert.equal((await call('GET', '/api/instances?instance=nope', { cookie })).status, 404);

  // Reaches the (unreachable) VPS and reports it, instead of crashing.
  const status = await call('GET', '/api/status', { cookie });
  assert.equal(status.status, 500);
  assert.match(status.json.error, /ECONNREFUSED/);

  // Input checks run before anything touches the VPS.
  assert.equal((await call('POST', '/api/server/explode', { cookie })).status, 400);
  assert.equal((await call('GET', '/api/mods/package-versions', { cookie })).status, 400);
});

test('state-changing requests need the X-VGUI header', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  assert.equal(r.status, 403);
});
