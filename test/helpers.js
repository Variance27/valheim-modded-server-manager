'use strict';
// Starts a throwaway copy of the GUI in "local" mode, in a temp folder, so tests never touch the
// real config.json, auth.json, instances.json or notifications.json.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startGui(extraConfig = {}, { fakeFetch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmsm-test-'));
  for (const f of ['server.js', 'auth.js', 'modgraph.js', 'modsets.js', 'migration.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vps-scripts'), path.join(dir, 'vps-scripts'), { recursive: true });
  if (fakeFetch) fs.copyFileSync(path.join(__dirname, 'fake-fetch.js'), path.join(dir, 'fake-fetch.js'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'local', guiPort: port, ...extraConfig }));
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, NODE_ENV: 'test', ...(fakeFetch ? { NODE_OPTIONS: `--require ${path.join(dir, 'fake-fetch.js')}` } : {}) } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (!/Valheim GUI running at/.test(out)) {
    if (child.exitCode !== null) throw new Error(`the GUI exited early:\n${out}`);
    if (Date.now() - started > 20000) throw new Error(`the GUI did not start in time:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const m = /Password: (\S+)/.exec(out);
  return {
    dir,
    base,
    password: m ? m[1] : null,
    stop: () => {
      child.kill();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    },
  };
}

// A tiny client that keeps the session cookie and always sends the CSRF header.
function client(base) {
  let cookie = '';
  async function call(method, url, body, extraHeaders = {}) {
    const headers = { 'X-VGUI': '1', ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  // Binary bodies and responses (migration bundles).
  async function raw(method, url, buf, extraHeaders = {}) {
    const headers = { 'X-VGUI': '1', ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: buf, redirect: 'manual' });
    const buffer = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch (e) { /* not JSON */ }
    return { status: r.status, json, buffer, text: buffer.toString('utf8'), headers: r.headers };
  }
  return { call, raw, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), del: (u) => call('DELETE', u) };
}

module.exports = { startGui, client, ROOT };
