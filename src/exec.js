// Running commands on the VPS: SSH (or local bash in mode "local"), streaming, sudo and quoting helpers.

const { Client: SshClient } = require('ssh2');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const { config } = require('./context');
const { changesWebhook } = require('./notify');

// ---- Execution mode ----
//
// "ssh"   (default) — the GUI runs on your PC and runs every command on the
//                     VPS over SSH, exactly as before.
// "local"           — the GUI runs ON the VPS itself (e.g. as a systemd
//                     service, reachable 24/7). Commands run directly with
//                     bash — no SSH hop, no password stored anywhere.
// LocalClient mimics the small part of the ssh2 Client API this file uses
// (on('ready'|'error'), connect(), exec(cmd, cb), end()), and its streams
// mimic ssh2 channels ('data', 'exit', 'close', .stderr, .close()), so every
// endpoint below works unchanged in either mode.
const LOCAL_MODE = config.mode === 'local';

class LocalStream extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.stderr = new EventEmitter();
    child.stdout.on('data', (d) => this.emit('data', d));
    child.stderr.on('data', (d) => this.stderr.emit('data', d));
    if (child.stdin) {
      child.stdin.on('drain', () => this.emit('drain'));
      child.stdin.on('error', () => {}); // the command ended before reading everything (EPIPE)
    }
    child.on('error', (e) => {
      this.stderr.emit('data', Buffer.from(`[error] ${e.message}\n`));
      this.emit('exit', 1);
      this.emit('close', 1);
    });
    child.on('close', (code, signal) => {
      const c = code == null ? (signal ? 143 : 1) : code;
      this.emit('exit', c);
      this.emit('close', c, signal);
    });
  }
  // Only commands started with { stdin: true } have a stdin to write to (large uploads).
  write(chunk) {
    return this.child.stdin ? this.child.stdin.write(chunk) : true;
  }
  end() {
    if (this.child.stdin) this.child.stdin.end();
  }
  pause() {
    this.child.stdout.pause();
  }
  resume() {
    this.child.stdout.resume();
  }
  close() {
    // Kill the whole process group (e.g. both halves of `tail -F … | grep`).
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch (e) {
      try {
        this.child.kill('SIGTERM');
      } catch (err) {}
    }
  }
}

class LocalClient extends EventEmitter {
  constructor() {
    super();
    this.streams = new Set();
  }
  connect() {
    setImmediate(() => this.emit('ready'));
    return this;
  }
  exec(command, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    try {
      const child = spawn('/bin/bash', ['-c', command], { detached: true, stdio: [opts && opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const stream = new LocalStream(child);
      this.streams.add(stream);
      stream.on('close', () => this.streams.delete(stream));
      cb(null, stream);
    } catch (e) {
      cb(e);
    }
  }
  end() {
    // Matches ssh2 semantics closely enough: ending the "connection" stops
    // anything still running on it (only long-lived tails ever are).
    for (const s of this.streams) {
      if (s.child.exitCode === null) s.close();
    }
    this.streams.clear();
    setImmediate(() => this.emit('close'));
  }
}

const Client = LOCAL_MODE ? LocalClient : SshClient;

if (!LOCAL_MODE && !config.ssh.privateKeyPath && !config.ssh.password) {
  console.error('\nconfig.json: set either ssh.privateKeyPath or ssh.password.\n');
  process.exit(1);
}

function sshConnectOpts() {
  if (LOCAL_MODE) return {};
  const base = {
    host: config.ssh.host,
    port: config.ssh.port || 22,
    username: config.ssh.username,
    readyTimeout: 15000,
  };
  if (config.ssh.privateKeyPath) {
    base.privateKey = fs.readFileSync(config.ssh.privateKeyPath);
    if (config.ssh.passphrase) base.passphrase = config.ssh.passphrase;
  } else if (config.ssh.password) {
    base.password = config.ssh.password;
  } else {
    throw new Error('config.json needs either ssh.privateKeyPath or ssh.password set');
  }
  return base;
}

// ---- Shared SSH connection for short commands ----
//
// Previously every sshExec() opened a brand-new SSH connection (TCP + key
// exchange + auth — typically 0.5–2 s from the Philippines to the VPS) and
// tore it down afterwards. The dashboard alone polls status/info/stats every
// 10–20 s, and /api/mods/installed made five of these back to back. Now all
// short commands share ONE long-lived connection and just open a new
// channel on it (a few ms). OpenSSH allows 10 channels per connection by
// default (MaxSessions), so concurrent commands are capped below that and
// queued. The connection is re-established automatically if it drops.
// Long-running streams (logs/live, players/live, installs…) still use their
// own dedicated connections, exactly as before.
const SSH_MAX_CHANNELS = 6;
let sharedConn = null; // Promise<Client>
let activeChannels = 0;
const channelQueue = [];

function getSharedConn() {
  if (sharedConn) return sharedConn;
  const conn = new Client();
  const p = new Promise((resolve, reject) => {
    const reset = () => {
      if (sharedConn === p) sharedConn = null;
    };
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => {
        reset();
        reject(err);
      })
      .on('close', reset)
      .on('end', reset)
      .connect({ ...sshConnectOpts(), keepaliveInterval: 15000, keepaliveCountMax: 3 });
  });
  p.catch(() => {});
  sharedConn = p;
  return p;
}

function acquireChannel() {
  if (activeChannels < SSH_MAX_CHANNELS) {
    activeChannels++;
    return Promise.resolve();
  }
  return new Promise((resolve) => channelQueue.push(resolve));
}
function releaseChannel() {
  const next = channelQueue.shift();
  if (next) next();
  else activeChannels--;
}

function execOnConn(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code) => resolve({ code, stdout, stderr }))
        .on('data', (data) => {
          stdout += data.toString();
        });
      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

// Run a command, wait for it to finish, return the full output.
async function sshExec(command) {
  await acquireChannel();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let conn;
      try {
        conn = await getSharedConn();
        return await execOnConn(conn, command);
      } catch (err) {
        // Stale/dropped connection: throw it away and retry once on a fresh one.
        try {
          if (conn) conn.end();
        } catch (e) {}
        sharedConn = null;
        if (attempt === 1) throw err;
      }
    }
  } finally {
    releaseChannel();
  }
}

// Run a command, streaming output live to the client via Server-Sent Events.
// Closes when the remote command exits.
function sshExecStream(command, res, opts = {}) {
  // The backstop below is an INACTIVITY timer (re-armed by every chunk of output), so a
  // long job that keeps printing (an apt install, a Steam download, a backup) is never
  // cut off; opts.idleMs raises how long a silent job may stay silent.
  const idleMs = opts.idleMs || 180000;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Defense in depth alongside safeWrite() below: an unhandled 'error' on a
  // response stream crashes the whole Node process, not just this request.
  res.on('error', (e) => console.error('[sshExecStream] response stream error (ignored):', e.message));
  // opts.onDone(code, lines) is called once, with the last lines printed, for callers that act on the outcome.
  const tail = [];
  const send = (line) => {
    if (opts.onDone) { tail.push(line); if (tail.length > 60) tail.shift(); }
    safeWrite(res, `data: ${line.replace(/\r/g, '')}\n\n`);
  };
  // LinuxGSM and apt color their output; the escape codes would show up as stray "[1m" text.
  const plain = (data) => data.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  const conn = new Client();
  let exitCode;
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(failsafe);
    if (opts.onDone) { try { opts.onDone(code, tail.slice()); } catch (e) { console.error('[sshExecStream] onDone failed:', e.message); } }
    try {
      conn.end();
    } catch (e) {}
    safeWrite(res, `event: done\ndata: ${code}\n\n`);
    res.end();
  };
  // Backstop: if neither 'exit' nor 'close' ever fires (a real ssh2 quirk —
  // the remote command can finish while the channel itself never signals
  // done), don't hang the browser forever waiting for it.
  let failsafe;
  const armFailsafe = () => {
    clearTimeout(failsafe);
    if (finished) return;
    failsafe = setTimeout(() => {
      send(`[warning] no output or completion signal for ${Math.round(idleMs / 60000)} minutes — the remote command likely finished; closing this connection now.`);
      finish(1);
    }, idleMs);
  };
  armFailsafe();

  conn
    .on('ready', () => {
      send('[connected] running command...');
      conn.exec(command, (err, stream) => {
        if (err) {
          send(`[error] ${err.message}`);
          finish(1);
          return;
        }
        // 'exit' carries the code and often fires well before 'close' does —
        // use whichever arrives first.
        stream
          // 'exit' can be emitted before the last 'data' chunk of the same command has been
          // delivered, so give trailing output a moment to arrive; 'close' (which always comes
          // after all data) ends the stream immediately.
          .on('exit', (code) => { exitCode = code; setTimeout(() => finish(code), 400); })
          .on('close', (code) => finish(code === undefined || code === null ? exitCode : code))
          .on('data', (data) => {
            armFailsafe();
            plain(data).split('\n').forEach((l) => l.trim().length && send(l));
          });
        stream.stderr.on('data', (data) => {
          armFailsafe();
          plain(data).split('\n').forEach((l) => l.trim().length && send(l));
        });
      });
    })
    .on('error', (err) => {
      send(`[connection error] ${err.message}`);
      finish(1);
    })
    .connect(sshConnectOpts());
}

// A non-pty SSH exec channel does not signal the remote process when the channel
// closes, so a follow command such as `tail -F | grep` keeps running on the VPS
// (rarely writing, so it never even notices the broken pipe) and piles up with every
// page view. This wraps the command so it is killed as soon as the channel closes
// (stdin reaches EOF).
function followCmd(cmd) {
  return `( ${cmd} ) & P=$!; cat >/dev/null; pkill -P $P 2>/dev/null; kill $P 2>/dev/null; true`;
}

// Like sshExecStream, but for a long-running/"follow" command (e.g. `tail -f`,
// `journalctl -f`). Never emits "done" on its own — it runs until the client
// disconnects, at which point we kill the remote process too.
function sshExecFollow(command, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.on('error', (e) => console.error('[sshExecFollow] response stream error (ignored):', e.message));
  const send = (line) => safeWrite(res, `data: ${line.replace(/\r/g, '')}\n\n`);
  const conn = new Client();
  let sshStream = null;
  // No 'finish' concept here by design (this stream runs until the client
  // disconnects), but 'close' and 'error' can both still fire in a race —
  // this flag just stops a second res.end() / stray write from happening.
  let ended = false;
  const endOnce = () => {
    if (ended) return;
    ended = true;
    res.end();
  };
  conn
    .on('ready', () => {
      send('[connected] streaming live...');
      conn.exec(followCmd(command), (err, stream) => {
        if (err) {
          send(`[error] ${err.message}`);
          conn.end();
          endOnce();
          return;
        }
        sshStream = stream;
        stream.on('data', (data) => {
          data.toString().replace(/\r/g, '\n').split('\n').forEach((l) => l.trim().length && send(l));
        });
        stream.stderr.on('data', (data) => {
          data.toString().replace(/\r/g, '\n').split('\n').forEach((l) => l.trim().length && send(l));
        });
        stream.on('close', () => {
          conn.end();
          endOnce();
        });
      });
    })
    .on('error', (err) => {
      send(`[connection error] ${err.message}`);
      endOnce();
    })
    .connect(sshConnectOpts());

  req.on('close', () => {
    try {
      if (sshStream) sshStream.close();
    } catch (e) {}
    try {
      conn.end();
    } catch (e) {}
  });
}

// Like sshExecStream but writes plain text chunks (no SSE framing) — for POST
// endpoints read via fetch()'s streaming body reader instead of EventSource.
function sshExecPlainStream(command, res, onClose, opts = {}) {
  const idleMs = opts.idleMs || 180000; // inactivity backstop, re-armed by every chunk of output
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.on('error', (e) => console.error('[sshExecPlainStream] response stream error (ignored):', e.message));
  const conn = new Client();
  let exitCode;
  let finished = false;
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  console.log(`[sshExecPlainStream ${elapsed()}] starting: ${command.slice(0, 80)}...`);
  const finish = (code) => {
    if (finished) {
      console.log(`[sshExecPlainStream ${elapsed()}] finish(${code}) called again — ignored (already finished)`);
      return;
    }
    finished = true;
    console.log(`[sshExecPlainStream ${elapsed()}] finish(${code}) — ending response`);
    clearTimeout(failsafe);
    try {
      conn.end();
    } catch (e) {
      console.log(`[sshExecPlainStream ${elapsed()}] conn.end() threw: ${e.message}`);
    }
    res.end();
    if (onClose) onClose(code);
  };
  // Same backstop as sshExecStream — the remote command can finish while the
  // ssh2 channel itself never signals it, in which case res.end() would
  // otherwise never get called and the browser hangs forever.
  let failsafe;
  const armFailsafe = () => {
    clearTimeout(failsafe);
    if (finished) return;
    failsafe = setTimeout(() => {
      console.log(`[sshExecPlainStream ${elapsed()}] FAILSAFE FIRED — no output or exit/close event in ${idleMs / 1000}s`);
      safeWrite(res, `\n[warning] no output or completion signal for ${Math.round(idleMs / 60000)} minutes — the remote command likely finished; closing this connection now.\n`);
      finish(1);
    }, idleMs);
  };
  armFailsafe();

  conn
    .on('ready', () => {
      console.log(`[sshExecPlainStream ${elapsed()}] SSH connection ready`);
      safeWrite(res, '[connected] running command...\n');
      conn.exec(command, (err, stream) => {
        console.log(`[sshExecPlainStream ${elapsed()}] conn.exec callback fired, err=${err ? err.message : 'none'}`);
        if (err) {
          safeWrite(res, `[error] ${err.message}\n`);
          finish(1);
          return;
        }
        stream
          .on('exit', (code) => {
            console.log(`[sshExecPlainStream ${elapsed()}] stream 'exit' event, code=${code}`);
            exitCode = code;
            setTimeout(() => finish(code), 400); // let trailing output arrive; 'close' ends it sooner
          })
          .on('close', (code) => {
            console.log(`[sshExecPlainStream ${elapsed()}] stream 'close' event, code=${code}`);
            finish(code === undefined || code === null ? exitCode : code);
          })
          .on('data', (data) => {
            console.log(`[sshExecPlainStream ${elapsed()}] stdout data (${data.length} bytes): ${data.toString().slice(0, 200)}`);
            // 'exit' can fire (ending the response via finish()) before a
            // trailing 'data' chunk for the same stream has been delivered
            // — this is exactly the race that used to crash the whole
            // process with ERR_STREAM_WRITE_AFTER_END. safeWrite just drops
            // the stray chunk instead; the important output (the INSTALLED/
            // [error] marker) has already arrived by the time 'exit' fires.
            armFailsafe();
            safeWrite(res, data);
          });
        stream.stderr.on('data', (data) => {
          console.log(`[sshExecPlainStream ${elapsed()}] stderr data (${data.length} bytes): ${data.toString().slice(0, 200)}`);
          armFailsafe();
          safeWrite(res, data);
        });
      });
    })
    .on('error', (err) => {
      console.log(`[sshExecPlainStream ${elapsed()}] connection 'error' event: ${err.message}`);
      safeWrite(res, `[connection error] ${err.message}\n`);
      finish(1);
    })
    .connect(sshConnectOpts());
}

// Only prefix with sudo when connecting as a non-root user.
function maybeSudo(cmd) {
  if (LOCAL_MODE) return process.getuid && process.getuid() === 0 ? cmd : `sudo -n ${cmd}`;
  return config.ssh.username === 'root' ? cmd : `sudo -n ${cmd}`;
}

// Runs a command as the LGSM game-server account (config.lgsmUser, "vhserver"
// by default). Unlike maybeSudo above, this ALWAYS goes through sudo,
// regardless of what user the SSH connection itself is — vhserver is a
// separate, no-login-shell-needed service account that owns the LGSM
// install, and switching into it is what's needed either way, not just
// when the SSH session lacks root. Root satisfies any sudoers policy
// without a password prompt, so this "just works" for the normal
// SSH-as-root setup; -n makes it fail fast with a clear error instead of
// hanging on a password prompt if that ever isn't true (e.g. SSH as a
// different sudo-capable admin user whose sudoers rules don't cover this).
function asLgsmUser(cmd) {
  const user = config.lgsmUser || 'vhserver';
  const home = `/home/${user}`;
  // `sudo -u` does NOT change the working directory — the child inherits
  // whatever cwd the calling (root) SSH session happens to be in, which
  // for a normal SSH login is /root. vhserver has no permission to even
  // stat /root, and LGSM's own scripts shell out to `find` internally
  // (log rotation, etc.), which tries to fchdir back to that starting
  // directory when it's done and fails loudly the moment it does:
  // "find: Failed to restore initial working directory: /root: Permission
  // denied". `cd` into vhserver's own home first so the inherited cwd is
  // always somewhere vhserver can actually read.
  return `cd ${shq(home)} && sudo -n -u ${shq(user)} ${cmd}`;
}

// Best-effort Discord notification. Silently does nothing if no webhook is
// configured; logs (but never throws) on failure so a notification hiccup
// never breaks the actual action that triggered it.
// Returns true on success, false on failure — callers propagate this back
// to the GUI instead of assuming it worked, so "Sent!" only shows when a
// message actually went through.
async function postWebhook(url, message) {
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!r.ok) {
      console.error(`Discord notification failed: HTTP ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Discord notification failed:', e.message);
    return false;
  }
}
async function notifyDiscord(message) {
  return postWebhook(changesWebhook(), message);
}

function shq(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

// Guards against writing to an HTTP response after it has already ended.
// ssh2 can emit a trailing stdout/stderr 'data' event AFTER the 'exit' or
// 'close' event that already ended the response — a real observed race
// (installing two mods back to back: the second install's 'exit' fires,
// finish() ends the response, then one more 'data' chunk for that same
// stream arrives a few ms later). Without this guard that write throws
// ERR_STREAM_WRITE_AFTER_END, which is unhandled and crashes the entire
// Node process — taking down every other in-flight request with it, not
// just the one that raced.
function safeWrite(res, chunk) {
  if (res.writableEnded) return;
  try {
    res.write(chunk);
  } catch (e) {
    console.error('safeWrite: res.write failed (response likely already closing):', e.message);
  }
}

Object.assign(module.exports, { shq, sshExec, maybeSudo, asLgsmUser, Client, sshConnectOpts, LOCAL_MODE, sshExecPlainStream, sshExecStream, postWebhook, notifyDiscord, followCmd, sshExecFollow, safeWrite, getSharedConn });
