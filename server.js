const express = require('express');
const { Client: SshClient } = require('ssh2');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const zlib = require('zlib');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('\nMissing config.json.\nCopy config.example.json to config.json and fill in your SSH details first.\n');
  process.exit(1);
}
const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
rawConfig.ssh = rawConfig.ssh || {};

// ---- Worlds (server instances) ----
//
// Every world is one LinuxGSM server instance with its own game account (and so its own server
// files, BepInEx, mods, backups, port and world). "main" is the instance described by config.json,
// exactly as before. Extra worlds live in instances.json (written by the Worlds page, never
// config.json) and derive every path from their own account name.
//
// All the code below reads `config.paths.x`, `config.lgsmUser`, ... as always. `config` is a thin
// proxy that answers from the instance the current request is for (a cookie or ?instance=, resolved
// by the middleware further down), so no endpoint had to change. Anything that runs outside a
// request (start-up code) sees the main instance.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const INSTANCES_FILE = path.join(__dirname, 'instances.json');
const INSTANCE_ID_RE = /^[a-z][a-z0-9]{0,15}$/;
const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

// Fills every setting the user did not give: all paths derive from lgsmUser / lgsmServer, so a fresh
// server's config.json only needs the connection details. Keys you set always win. The keys that
// were derived are remembered so the Setup tab can correct a guessed path (the ValheimEnforcer
// folder) once it can see the real one. config.json itself is never rewritten.
function buildInstanceConfig(raw, inst) {
  const cfg = JSON.parse(JSON.stringify(raw));
  cfg.ssh = cfg.ssh || {};
  if (inst) {
    cfg.lgsmUser = inst.lgsmUser;
    cfg.lgsmServer = inst.lgsmServer || 'vhserver';
    delete cfg.lgsmHome;
    delete cfg.worldName;
    delete cfg.connect;
    // Explicit paths in config.json describe the main world. Only the host-wide ones are shared.
    const shared = {};
    for (const k of ['cronDir', 'scriptDir', 'logDir', 'lockDir', 'stateDir']) if (raw.paths && raw.paths[k]) shared[k] = raw.paths[k];
    cfg.paths = shared;
  }
  cfg.lgsmUser = cfg.lgsmUser || 'vhserver';
  cfg.lgsmServer = cfg.lgsmServer || 'vhserver';
  cfg.thunderstoreCommunity = cfg.thunderstoreCommunity || 'valheim';
  cfg.paths = cfg.paths || {};
  const derived = new Set();
  const home = (cfg.lgsmHome || `/home/${cfg.lgsmUser}`).replace(/\/+$/, '');
  const scripts = (cfg.paths.scriptsDir || `${home}/scripts`).replace(/\/+$/, '');
  const serverDir = cfg.paths.valheimServerDir || `${home}/serverfiles`;
  const defaults = {
    scriptsDir: scripts,
    valheimServerDir: serverDir,
    commonCfgPath: `${home}/lgsm/config-lgsm/${cfg.lgsmServer}/common.cfg`,
    lgsmScript: `${home}/${cfg.lgsmServer}`,
    pluginsDir: `${serverDir}/BepInEx/plugins`,
    logFile: `${serverDir}/BepInEx/LogOutput.log`,
    consoleLog: `${home}/log/console/${cfg.lgsmServer}-console.log`,
    enforcerYaml: `${serverDir}/BepInEx/config/ValheimEnforcer/Mods.yaml`,
    disabledModsDir: `${home}/disabled-mods`,
    backupDir: `${home}/backups`,
    worldDir: `${home}/.config/unity3d/IronGate`,
    listDir: `${home}/.config/unity3d/IronGate/Valheim`,
    backupScript: `${scripts}/backup-valheim.sh`,
    checkUpdateScript: `${scripts}/check-valheim-update.sh`,
    applyUpdateScript: `${scripts}/update-valheim.sh`,
    moveModScript: `${scripts}/move-mod.py`,
    generateCodesScript: `${scripts}/generate-codes.py`,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!cfg.paths[k]) {
      cfg.paths[k] = v;
      derived.add(k);
    }
  }
  cfg.lgsmHome = home;
  const id = inst ? inst.id : 'main';
  cfg.instance = { id, label: inst ? inst.label : cfg.serverLabel || 'Main world', main: !inst };
  return { id, inst: inst || null, cfg, derived };
}

const instanceCtx = new Map(); // id -> { id, inst, cfg, derived }
instanceCtx.set('main', buildInstanceConfig(rawConfig, null));

function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    return Array.isArray(j.instances) ? j.instances.filter((i) => i && INSTANCE_ID_RE.test(i.id) && LINUX_USER_RE.test(i.lgsmUser)) : [];
  } catch (e) {
    return [];
  }
}
function writeRegistry(list) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify({ instances: list }, null, 2));
}
// Context for an instance id, or null. Rebuilt whenever the registry entry changed.
function getInstanceCtx(id) {
  if (!id || id === 'main') return instanceCtx.get('main');
  const entry = readRegistry().find((i) => i.id === id);
  if (!entry) {
    instanceCtx.delete(id);
    return null;
  }
  const have = instanceCtx.get(id);
  if (have && have.inst && have.inst.lgsmUser === entry.lgsmUser && have.inst.lgsmServer === entry.lgsmServer && have.inst.label === entry.label) return have;
  const ctx = buildInstanceConfig(rawConfig, entry);
  instanceCtx.set(id, ctx);
  return ctx;
}
const curCtx = () => als.getStore() || instanceCtx.get('main');
const curId = () => curCtx().id;
// Suffix for per-world file names on the host (cron files, wrappers, status files): none for main.
const instSfx = () => (curId() === 'main' ? '' : `-${curId()}`);

// Set VG_STRICT=1 while testing to log any instance-specific read that happens outside a request.
let serving = false;
const INSTANCE_KEYS = new Set(['paths', 'lgsmUser', 'lgsmServer', 'lgsmHome', 'worldName', 'connect']);
const config = new Proxy(
  {},
  {
    get(_, k) {
      if (process.env.VG_STRICT && serving && !als.getStore() && INSTANCE_KEYS.has(k)) console.warn(`[VG_STRICT] config.${String(k)} read outside a request context\n${new Error().stack.split('\n').slice(2, 6).join('\n')}`);
      return curCtx().cfg[k];
    },
    set(_, k, v) {
      curCtx().cfg[k] = v;
      return true;
    },
    has: (_, k) => k in curCtx().cfg,
    ownKeys: () => Reflect.ownKeys(curCtx().cfg),
    getOwnPropertyDescriptor: (_, k) => {
      const d = Object.getOwnPropertyDescriptor(curCtx().cfg, k);
      return d ? { ...d, configurable: true } : undefined;
    },
  }
);
// Keys of config.paths that were derived (not set by the user) for the current instance.
const derivedPaths = {
  has: (k) => curCtx().derived.has(k),
  add: (k) => curCtx().derived.add(k),
  delete: (k) => curCtx().derived.delete(k),
};

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
  exec(command, cb) {
    try {
      const child = spawn('/bin/bash', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const send = (line) => safeWrite(res, `data: ${line.replace(/\r/g, '')}\n\n`);
  // LinuxGSM and apt color their output; the escape codes would show up as stray "[1m" text.
  const plain = (data) => data.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  const conn = new Client();
  let exitCode;
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(failsafe);
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
async function notifyDiscord(message) {
  if (!config.discordWebhookUrl) return false;
  try {
    const r = await fetch(config.discordWebhookUrl, {
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

const app = express();

// Login (see auth.js): session cookie + hashed password in auth.json, rate
// limiting, CSRF protection. Always on — a random password is generated and
// printed on first run (or the old guiPassword from config.json is converted).
// Must come after express.json() (the login route reads the body) and before
// the static files and every /api route, so nothing is reachable without it.
app.use(express.json());
require('./auth').install(app, { config, dataDir: __dirname });

// Which world a request is for: ?instance= / X-Instance (explicit, used by the Worlds page), else the
// vg_instance cookie set by the world switcher, else the main world.
app.use((req, res, next) => {
  const explicit = (req.query && req.query.instance) || req.get('x-instance') || '';
  const ck = /(?:^|;\s*)vg_instance=([a-z0-9]+)/.exec(req.headers.cookie || '');
  const id = String(explicit || (ck && ck[1]) || 'main');
  const ctx = INSTANCE_ID_RE.test(id) || id === 'main' ? getInstanceCtx(id) : null;
  if (!ctx) {
    if (explicit) return res.status(404).json({ error: `Unknown world "${id}"` });
    return als.run(instanceCtx.get('main'), next); // stale cookie (a world that was removed): use the main world
  }
  als.run(ctx, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ---- Server control ----

// Shell snippet, not a standalone command: resolves the running Valheim
// process's PID via pgrep (there's no systemd unit to ask anymore — LGSM
// just forks the process directly) and, if found, its start time formatted
// the same way systemd used to ("YYYY-MM-DD HH:MM:SS UTC") so the frontend's
// existing parseSystemdTime() keeps working unchanged. Echoes "active"/
// "inactive" to match the state strings the frontend already understands
// (there's no LGSM equivalent of systemd's transient "activating"/"failed"
// states, so those are simply not distinguishable here — an honest
// degradation, not a guess).
function stateSnippet() {
  return [
    `PID=$(pgrep -u ${shq(config.lgsmUser || 'vhserver')} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
    `if [ -n "$PID" ]; then echo active; ` +
      `START_EPOCH=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
      `if [ -n "$START_EPOCH" ]; then date -u -d "@$START_EPOCH" '+%Y-%m-%d %H:%M:%S UTC'; fi; ` +
      `else echo inactive; fi`,
  ].join('; ');
}

app.get('/api/status', async (req, res) => {
  try {
    const port = (await getWorldInfo()).port || 2456;
    const queryPort = port + 1;
    // Process liveness alone says nothing about whether Valheim has
    // actually finished loading the world and is listening for players.
    // Check the real UDP ports too, via /proc/net/udp directly (works on
    // any Linux system, no dependency on a specific tool's CLI syntax like
    // `ss`'s filter DSL). Checks BOTH the game port and the query port
    // (game port + 1) and treats either one as "open": confirmed directly
    // against a live server that with `-crossplay` on (this project's
    // actual setup), the game port never shows as a bound listening
    // socket at all — Valheim routes crossplay traffic through PlayFab's
    // relay/P2P layer instead of a plain UDP listen — while the query
    // port (used for the classic Steam server-browser query) does bind
    // normally. LGSM's own `ss`-based check in `./vhserver details` shows
    // the identical split (Game: 0, Query: 1), so this isn't a quirk of
    // this /proc/net/udp method — it's inherent to how crossplay works.
    // Without this OR, the Dashboard would show "not listening" forever
    // on a crossplay server that is, in every other respect, up and
    // actively registered with a live join code.
    const cmd = [
      stateSnippet(),
      `echo ---`,
      `GAME_HEX=$(printf '%04X' ${port}); QUERY_HEX=$(printf '%04X' ${queryPort})`,
      `cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk -v g="$GAME_HEX" -v q="$QUERY_HEX" ` +
        `'{ n=split($2,a,":"); p=toupper(a[n]); if (p==g) fg=1; if (p==q) fq=1 } END { print (fg?"1":"0") (fq?"1":"0") }'`,
    ].join('; ');
    const r = await sshExec(cmd);
    const [stateBlock, portFlags] = r.stdout.split('---').map((s) => s.trim());
    const [state, ts] = stateBlock.split('\n').map((s) => s.trim());
    const gameOpen = portFlags[0] === '1';
    const queryOpen = portFlags[1] === '1';
    res.json({
      state: state || 'unknown',
      since: ts || null,
      portOpen: gameOpen || queryOpen,
      port,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/server/:action', async (req, res) => {
  const action = req.params.action;
  // 'restart' is intentionally not offered for the Valheim server: stop and
  // start are run as two separate, explicit steps so the world is saved on
  // the stop before anything starts again.
  if (!['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'invalid action — use stop, then start' });
  }
  try {
    const script = config.paths.lgsmScript || `/home/${config.lgsmUser || 'vhserver'}/vhserver`;
    if (action === 'start') {
      // Several worlds share one VPS: refuse a start that would collide with another world's port.
      const me = await getWorldInfo();
      if (!config.instance.main && !me.portExplicit) {
        return res.status(409).json({ error: 'This world has no game port saved yet. Open Setup, step 3, and save one (each world needs its own).' });
      }
      const clash = (await otherWorldPorts()).find((o) => portsOverlap(o.port, me.port));
      if (clash) return res.status(409).json({ error: `Game port ${me.port} overlaps the world "${clash.label}" (port ${clash.port}). A Valheim server also uses the next two ports, so keep worlds at least 3 apart. Change it in Settings.` });
    }
    // LinuxGSM colors its output; drop the escape codes (and its in-place "\r" redraws) so the console is readable.
    const clean = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n');
    let r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
    let note = '';
    // LinuxGSM refuses to start when any file under its lgsm/ or serverfiles/ folder is not owned by
    // the game account (a backup or side file written as root is enough). Fixing that is what the
    // install steps already do after every change, so do it here once and retry.
    if (action === 'start' && r.code !== 0 && /Ownership issues found/.test(r.stdout || '')) {
      const user = config.lgsmUser;
      const fix = await sshExec(maybeSudo(`chown -R ${shq(`${user}:${user}`)} ${shq(`${config.lgsmHome}/lgsm`)} ${shq(config.paths.valheimServerDir)}`) + ' && echo FIXED');
      if (fix.stdout.includes('FIXED')) {
        note = '[note] Some files under the LinuxGSM folders were owned by root, which makes LinuxGSM refuse to start. Their owner was corrected and the start was retried.\n';
        r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
      }
    }
    // On a brand-new install LinuxGSM fetches its start module from GitHub the first time. A dropped
    // connection there fails the start for no real reason, so try again a couple of times.
    for (let i = 0; i < 2 && action === 'start' && r.code !== 0 && /Downloading .*FAIL|FAIL.*Downloading/s.test(clean(r.stdout) + clean(r.stderr)); i++) {
      await new Promise((ok) => setTimeout(ok, 4000));
      note = '[note] LinuxGSM could not download one of its own files (network hiccup); retrying the start.\n';
      r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
    }
    res.json({ ...r, stdout: note + clean(r.stdout), stderr: clean(r.stderr) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---- Worlds (API: /api/instances) ----
//
// A world is a complete, separate server instance (own game account, files, mods, backups, port).
// Which world a request acts on is decided by the middleware near the top; these endpoints manage
// the list itself. Removing a world forgets it in the GUI; with ?purge=1 it is also uninstalled from the VPS (see below).
const worldList = () => ['main', ...readRegistry().map((i) => i.id)];
function inWorld(id, fn) {
  const ctx = getInstanceCtx(id);
  if (!ctx) throw new Error(`Unknown world "${id}"`);
  return als.run(ctx, fn);
}

async function worldSummary(id) {
  return inWorld(id, async () => {
    const [st, w] = await Promise.all([
      sshExec(`${stateSnippet()}; echo ---; [ -x ${shq(config.paths.lgsmScript)} ] && echo INSTALLED`),
      getWorldInfo(),
    ]);
    const [stateBlock, rest] = st.stdout.split('---');
    const [state, since] = stateBlock.trim().split('\n').map((x) => x.trim());
    const reg = readRegistry().find((i) => i.id === id);
    return {
      id,
      main: id === 'main',
      label: config.instance.label,
      lgsmUser: config.lgsmUser,
      installed: /INSTALLED/.test(rest || ''),
      state: state || 'unknown',
      since: since || null,
      world: w.world,
      worldReady: w.ready,
      serverName: w.serverName,
      brand: w.brand,
      port: w.port,
      portExplicit: w.portExplicit,
      plannedPort: reg ? reg.plannedPort || null : null,
    };
  });
}

// Other worlds' game ports (a Valheim server uses its port and the next two), to refuse overlaps.
async function otherWorldPorts() {
  const here = curId();
  const out = [];
  for (const id of worldList()) {
    if (id === here) continue;
    try {
      const w = await inWorld(id, async () => ({ info: await getWorldInfo(), label: config.instance.label }));
      // A new world that has no port saved yet will get its planned one (never the 2456 default).
      const reg = readRegistry().find((x) => x.id === id);
      const port = id === 'main' || w.info.portExplicit ? w.info.port : reg && reg.plannedPort;
      if (port) out.push({ id, label: w.label, port, explicit: id === 'main' || w.info.portExplicit });
    } catch (e) {
      /* unreadable world: ignore */
    }
  }
  return out;
}
const portsOverlap = (a, b) => Math.abs(Number(a) - Number(b)) < 3;

app.get('/api/instances', async (req, res) => {
  try {
    const ids = worldList();
    const list = await Promise.all(ids.map((id) => worldSummary(id).catch((e) => ({ id, main: id === 'main', label: id, error: e.message }))));
    res.json({ current: curId(), instances: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/select', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  if (!getInstanceCtx(id)) return res.status(404).json({ error: `Unknown world "${id}"` });
  res.setHeader('Set-Cookie', `vg_instance=${id}; Path=/; SameSite=Strict; Max-Age=31536000`);
  res.json({ ok: true, current: id });
});

app.post('/api/instances', async (req, res) => {
  try {
    const label = String((req.body && req.body.label) || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$/.test(label)) return res.status(400).json({ error: 'Give the world a short name: 1-30 letters, digits, spaces, . _ -' });
    const reg = readRegistry();
    if (reg.length >= 8) return res.status(400).json({ error: 'The GUI manages at most 8 extra worlds.' });
    if (reg.some((i) => i.label.toLowerCase() === label.toLowerCase())) return res.status(400).json({ error: `A world called "${label}" already exists.` });
    // id: letters/digits only, starts with a letter, unique.
    let base = label.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    if (!/^[a-z]/.test(base)) base = `w${base}`.slice(0, 10);
    if (base === 'main' || base === 'w') base = 'world';
    let id = base;
    for (let n = 2; reg.some((i) => i.id === id) || id === 'main'; n++) id = `${base.slice(0, 10 - String(n).length)}${n}`;
    const lgsmUser = `vhserver-${id}`;
    const mainPort = (await inWorld('main', () => getWorldInfo())).port || 2456;
    const used = new Set([mainPort, ...reg.map((i) => i.plannedPort).filter(Boolean)]);
    let plannedPort = mainPort + 10;
    while ([...used].some((p) => portsOverlap(p, plannedPort))) plannedPort += 10;
    const entry = { id, label, lgsmUser, lgsmServer: 'vhserver', plannedPort, created: new Date().toISOString() };
    writeRegistry([...reg, entry]);
    res.json({ ok: true, instance: entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/instances/:id', (req, res) => {
  const id = req.params.id;
  const label = String((req.body && req.body.label) || '').trim();
  const reg = readRegistry();
  const i = reg.findIndex((x) => x.id === id);
  if (i < 0) return res.status(404).json({ error: id === 'main' ? 'The main world is named in config.json.' : `Unknown world "${id}"` });
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$/.test(label)) return res.status(400).json({ error: 'Give the world a short name: 1-30 letters, digits, spaces, . _ -' });
  if (reg.some((x, j) => j !== i && x.label.toLowerCase() === label.toLowerCase())) return res.status(400).json({ error: `A world called "${label}" already exists.` });
  reg[i].label = label;
  writeRegistry(reg);
  res.json({ ok: true });
});

// ---- Firewall (ufw) ----
//
// A Valheim world needs UDP <port> to <port>+2 open. When the VPS runs ufw AND it is active, the GUI
// opens that range when the port is saved (Setup step 3 / Settings) and before the first start, and
// closes it again when the world is uninstalled. It never turns ufw on or off, never touches any
// other rule, and cannot change a firewall in your hosting provider's panel. Rules carry the comment
// "valheim-gui:<world id>" so they can be recognised later.
const gameRange = (port) => `${Number(port)}:${Number(port) + 2}`;
async function worldGamePort() {
  const info = await getWorldInfo();
  if (curId() === 'main' || info.portExplicit) return Number(info.port);
  const reg = readRegistry().find((i) => i.id === curId());
  return reg && reg.plannedPort ? Number(reg.plannedPort) : null;
}
// mode: status | open | close (any rule on exactly this range) | close-tagged (only a rule this GUI tagged for this world)
async function fwRun(mode, port, tag = `valheim-gui:${curId()}`) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65530) throw new Error(`Refusing to change firewall rules for port ${port}`);
  const range = gameRange(port);
  const script = [
    'set -u',
    `RANGE=${shq(range)}/udp; TAG=${shq(tag)}; MODE=${shq(mode)}`,
    'command -v ufw >/dev/null 2>&1 || { echo "FW:none"; exit 0; }',
    'ufw status 2>/dev/null | head -n1 | grep -qi "inactive" && { echo "FW:inactive"; exit 0; }',
    'echo "FW:active"',
    'has() { ufw status 2>/dev/null | awk -v r="$RANGE" -v t="$1" \'$1==r && (t=="" || index($0,t)>0){f=1} END{exit f?0:1}\'; }',
    'if has ""; then echo "OPEN:yes"; else echo "OPEN:no"; fi',
    'case "$MODE" in',
    '  open) if has ""; then echo "RESULT:already"; else OUT="$(ufw allow "$RANGE" comment "$TAG" 2>&1)" && echo "RESULT:opened" || echo "RESULT:failed $OUT"; fi ;;',
    '  close|close-tagged)',
    '    if [ "$MODE" = close-tagged ]; then T="$TAG"; else T=""; fi',
    '    if has "$T"; then OUT="$(ufw --force delete allow "$RANGE" 2>&1)"; if has ""; then echo "RESULT:failed $OUT"; else echo "RESULT:closed"; fi; else echo "RESULT:absent"; fi ;;',
    'esac',
  ].join('\n');
  const r = await sshExec(asRootScript(script));
  const out = `${r.stdout || ''}`;
  const tool = (/FW:(\w+)/.exec(out) || [])[1] || 'none';
  const result = (/RESULT:(\w+)(?: (.*))?/.exec(out) || []);
  const info = { tool: tool === 'none' ? 'none' : 'ufw', active: tool === 'active', open: /OPEN:yes/.test(out) || result[1] === 'opened', range, result: result[1] || null, detail: result[2] || '' };
  if (result[1] === 'closed') info.open = false;
  info.message = fwMessage(info, mode);
  return info;
}
function fwMessage(f, mode) {
  const udp = `UDP ${f.range}`;
  if (f.tool === 'none') return 'This VPS has no ufw firewall, so there was nothing to change. A firewall in your provider panel is separate and must be set there.';
  if (!f.active) return `The VPS firewall (ufw) is off, so nothing on the VPS blocks ${udp}. A firewall in your provider panel is separate and must be set there.`;
  if (f.result === 'opened') return `Opened ${udp} in the VPS firewall (ufw).`;
  if (f.result === 'already') return `${udp} is already open in the VPS firewall (ufw).`;
  if (f.result === 'closed') return `Closed ${udp} in the VPS firewall (ufw).`;
  if (f.result === 'absent') return `No ufw rule for ${udp} was found, so nothing was closed.`;
  if (f.result === 'failed') return `Could not change the ufw rule for ${udp}: ${f.detail}`;
  return f.open ? `${udp} is open in the VPS firewall (ufw).` : `${udp} is not open in the VPS firewall (ufw).`;
}

app.get('/api/firewall', async (req, res) => {
  try {
    const port = await worldGamePort();
    if (!port) return res.json({ tool: 'none', active: false, open: false, message: 'This world has no game port yet.' });
    res.json({ port, ...(await fwRun('status', port)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/firewall/open', async (req, res) => {
  try {
    const port = await worldGamePort();
    if (!port) return res.status(400).json({ error: 'This world has no game port yet. Save one in Setup step 3 first.' });
    res.json({ port, ...(await fwRun('open', port)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Uninstalling a world from the VPS ----
//
// "Remove" can either only forget a world in the GUI, or also delete it from the VPS: stop its
// processes, remove its scheduled jobs and their files, optionally keep a copy of its saves and
// backups, then delete its game account and home folder. Everything is derived from the world's
// registry entry and checked against strict patterns first, and nothing but the account named
// vhserver-<id> (and its own /home/vhserver-<id> folder) can ever be touched. The main world
// cannot be uninstalled from here.
const PURGE_ACCT_RE = /^vhserver-[a-z][a-z0-9]{0,9}$/;
const KEPT_WORLDS_DIR = '/var/lib/valheim-removed-worlds';

async function purgeTarget(entry) {
  const id = entry.id;
  const acct = entry.lgsmUser;
  const mainUser = await inWorld('main', async () => config.lgsmUser);
  if (id === 'main' || !PURGE_ACCT_RE.test(acct) || acct !== `vhserver-${id}` || acct === mainUser) {
    throw new Error(`Refusing to delete: "${acct}" is not a game account this GUI created for an extra world.`);
  }
  if (readRegistry().some((x) => x.id !== id && x.lgsmUser === acct)) throw new Error('Another world uses the same game account; refusing to delete it.');
  const home = `/home/${acct}`;
  const cfgHome = await inWorld(id, async () => config.lgsmHome);
  if (cfgHome !== home) throw new Error(`This world's home folder is ${cfgHome}, not ${home}; refusing to delete anything automatically.`);
  return { id, acct, home };
}

app.get('/api/instances/:id/uninstall-preview', async (req, res) => {
  try {
    const entry = readRegistry().find((x) => x.id === req.params.id);
    if (!entry) return res.status(404).json({ error: `Unknown world "${req.params.id}"` });
    const t = await purgeTarget(entry);
    const script = [
      `ACCT=${shq(t.acct)}; HOME_DIR=${shq(t.home)}`,
      'getent passwd "$ACCT" >/dev/null 2>&1 && echo "USER:1" || echo "USER:0"',
      '[ -d "$HOME_DIR" ] && echo "SIZE_MB:$(du -sm "$HOME_DIR" 2>/dev/null | cut -f1)" || echo "SIZE_MB:0"',
      'echo "BACKUPS:$(ls -1 "$HOME_DIR/backups" 2>/dev/null | wc -l)"',
      'echo "WORLDS:$(ls -1 "$HOME_DIR/.config/unity3d/IronGate/Valheim/worlds_local" 2>/dev/null | grep -c "\\.db$")"',
      'echo "PROCS:$(pgrep -u "$ACCT" 2>/dev/null | wc -l)"',
    ].join('\n');
    const r = await sshExec(asRootScript(script));
    const get = (k) => Number((new RegExp(`${k}:(\\d+)`).exec(r.stdout) || [])[1] || 0);
    res.json({ account: t.acct, home: t.home, userExists: get('USER') === 1, sizeMB: get('SIZE_MB'), backups: get('BACKUPS'), saves: get('WORLDS'), processes: get('PROCS') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function purgeWorldHost(entry, keepCopy) {
  const t = await purgeTarget(entry);
  const P = cronPaths();
  const sfx = `-${t.id}`;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const keepDir = `${KEPT_WORLDS_DIR}/${t.id}-${stamp}`;
  const files = [
    `${P.cronDir}/valheim-gui-backup${sfx}`,
    `${P.cronDir}/valheim-gui-update-check${sfx}`,
    `${P.binDir}/valheim-scheduled-backup${sfx}.sh`,
    `${P.binDir}/valheim-update-check${sfx}.sh`,
    `${P.logDir}/valheim-scheduled-backup${sfx}.status`,
    `${P.logDir}/valheim-update-check${sfx}.status`,
    `${P.lockDir}/valheim-scheduled-backup${sfx}.lock`,
    `${P.stateDir}/valheim-scheduled-backup${sfx}.pending`,
    `${P.stateDir}/valheim-update-check${sfx}.state`,
  ];
  const script = [
    'set -u',
    `ACCT=${shq(t.acct)}; HOME_DIR=${shq(t.home)}; KEEP=${keepCopy ? 1 : 0}; KEEPDIR=${shq(keepDir)}`,
    'if getent passwd "$ACCT" >/dev/null 2>&1; then',
    '  HAVE_USER=1',
    '  [ "$(getent passwd "$ACCT" | cut -d: -f6)" = "$HOME_DIR" ] || { echo "[error] the account\'s home folder is not $HOME_DIR - refusing to delete anything"; exit 3; }',
    'else',
    '  HAVE_USER=0',
    '  echo "[note] the account $ACCT does not exist (already deleted?)"',
    'fi',
    'if pgrep -u "$ACCT" >/dev/null 2>&1; then',
    '  echo "[step] Stopping the running processes of $ACCT..."',
    '  pkill -u "$ACCT"; sleep 3',
    '  if pgrep -u "$ACCT" >/dev/null 2>&1; then pkill -9 -u "$ACCT"; sleep 1; fi',
    '  pgrep -u "$ACCT" >/dev/null 2>&1 && { echo "[error] processes of $ACCT are still running"; exit 4; }',
    'fi',
    'if [ "$KEEP" = 1 ] && [ -d "$HOME_DIR" ]; then',
    '  echo "[step] Keeping a copy of the saves and backups in $KEEPDIR ..."',
    '  mkdir -p "$KEEPDIR" || { echo "[error] cannot create $KEEPDIR"; exit 6; }',
    '  V="$HOME_DIR/.config/unity3d/IronGate/Valheim"',
    '  if [ -d "$HOME_DIR/backups" ]; then cp -a "$HOME_DIR/backups" "$KEEPDIR/backups" || { echo "[error] could not copy the backups"; exit 6; }; fi',
    '  if [ -d "$V/worlds_local" ]; then cp -a "$V/worlds_local" "$KEEPDIR/worlds_local" || { echo "[error] could not copy the world saves"; exit 6; }; fi',
    '  for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$V/$f" ] && cp -a "$V/$f" "$KEEPDIR/"; done',
    '  chmod -R go-rwx "$KEEPDIR"',
    '  if [ -n "$(ls -A "$KEEPDIR" 2>/dev/null)" ]; then echo "[note] copy kept in $KEEPDIR"; else rmdir "$KEEPDIR" 2>/dev/null; echo "[note] nothing to keep: this world had no saves or backups"; fi',
    'fi',
    'echo "[step] Removing scheduled jobs and their files..."',
    'crontab -r -u "$ACCT" >/dev/null 2>&1 || true',
    `rm -f -- ${files.map(shq).join(' ')}`,
    'if [ "$HAVE_USER" = 1 ]; then',
    '  echo "[step] Deleting the game account $ACCT and its home folder..."',
    '  OUT="$(userdel -r -f "$ACCT" 2>&1)"; RC=$?',
    '  getent passwd "$ACCT" >/dev/null 2>&1 && { echo "[error] could not delete the account: $OUT"; exit 5; }',
    '  [ $RC -ne 0 ] && echo "[note] userdel said: $OUT"',
    'fi',
    'if [ -d "$HOME_DIR" ]; then echo "[step] Removing leftover files in $HOME_DIR ..."; rm -rf -- "$HOME_DIR"; fi',
    '[ -d "$HOME_DIR" ] && { echo "[error] $HOME_DIR could not be removed"; exit 7; }',
    'getent group "$ACCT" >/dev/null 2>&1 && groupdel "$ACCT" >/dev/null 2>&1',
    'echo "[done] $ACCT and $HOME_DIR are gone."',
  ].join('\n');
  const r = await sshExec(asRootScript(script));
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.code && r.code !== 0) throw new Error(out.split('\n').filter((l) => /\[error\]/.test(l)).join(' ') || out || `uninstall failed (exit ${r.code})`);
  return { log: out.split('\n').filter(Boolean), keptAt: keepCopy && /copy kept in/.test(out) ? keepDir : null };
}

app.delete('/api/instances/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (id === 'main') return res.status(400).json({ error: 'The main world cannot be removed.' });
    const reg = readRegistry();
    const entry = reg.find((x) => x.id === id);
    if (!entry) return res.status(404).json({ error: `Unknown world "${id}"` });
    const purge = req.query.purge === '1';
    const keep = req.query.keep === '1';
    const sum = await worldSummary(id);
    if (sum.state === 'active') return res.status(409).json({ error: 'Stop this world first.' });
    // Remove its scheduled jobs (best effort).
    await inWorld(id, async () => {
      for (const kind of ['backup', 'update']) {
        try {
          await installCronJob(kind, false, 0, false);
        } catch (e) {
          /* nothing scheduled */
        }
      }
    });
    // Uninstalling happens BEFORE the world is forgotten, so a failure leaves it listed and retryable.
    let purged = null;
    let fw = null;
    if (purge) {
      // The port is read BEFORE the world's files are deleted.
      const fwPort = await inWorld(id, () => worldGamePort()).catch(() => null);
      purged = await inWorld(id, () => purgeWorldHost(entry, keep));
      // Close its UDP range, unless another world's ports overlap it.
      fw = await inWorld(id, async () => {
        if (!fwPort) return null;
        try {
          if ((await otherWorldPorts()).some((o) => portsOverlap(o.port, fwPort))) return { message: `UDP ${gameRange(fwPort)} was left open because another world uses nearby ports.` };
          return await fwRun('close', fwPort);
        } catch (e) {
          return { message: `The firewall was not changed: ${e.message}` };
        }
      });
    }
    writeRegistry(reg.filter((x) => x.id !== id));
    instanceCtx.delete(id);
    worldInfoCaches.delete(id);
    try {
      fs.rmSync(pendingFile(id), { force: true });
    } catch (e) {
      /* no pending list */
    }
    const note = purge
      ? `"${entry.label}" was uninstalled: game account ${entry.lgsmUser} and its files were deleted from the VPS.${purged && purged.keptAt ? ` A copy of its saves and backups is in ${purged.keptAt}.` : ''} ${fw && fw.message ? fw.message : 'Check that its UDP ports are closed in your firewall.'}`
      : `"${entry.label}" is no longer managed here. Its game account (${entry.lgsmUser}) and files are still on the VPS.`;
    res.json({ ok: true, purged: !!purge, keptAt: purged ? purged.keptAt : null, log: purged ? purged.log : [], firewall: fw, note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Server info (dashboard summary card) ----

app.get('/api/info', async (req, res) => {
  try {
    const r = await sshExec(
      `${stateSnippet()}; echo ---; ` +
        `ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null | wc -l`
    );
    const [stateBlock, modCountRaw] = r.stdout.split('---').map((s) => s.trim());
    const [state, since] = stateBlock.split('\n').map((s) => s.trim());
    const world = await getWorldInfo();
    res.json({
      state: state || 'unknown',
      since: since || null,
      modCount: parseInt(modCountRaw, 10) || 0,
      worldName: world.world,
      worldReady: world.ready,
      serverName: world.serverName,
      brand: world.brand,
      instance: config.instance,
      connectHost: config.publicHost || config.ssh.host || '',
      connectPort: world.port || 2456,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- System resource stats ----

// Tracks the previous CPU-ticks sample for the Valheim process so each poll
// can report a delta-based %CPU for just that process — same convention
// `top`/`htop` use (100% = one full core saturated by that process's threads
// combined, not a share of the whole VPS). No explicit sleep is needed: the
// delta is computed against whenever this endpoint was last polled.
const valheimCpuSamples = new Map(); // world id -> { pid, ticks, atMs }
let lastHostCpuStat = null; // { total, steal, iowait } from /proc/stat
// Size of the backup folder, refreshed in the background at most every 5 minutes
// (du can be slow on a big folder, so the stats poll never waits for it).
const backupSizeCaches = new Map();
function backupSizeCache_() {
  const id = curId();
  if (!backupSizeCaches.has(id)) backupSizeCaches.set(id, { t: 0, mb: null, busy: false });
  return backupSizeCaches.get(id);
}
function refreshBackupSize() {
  const dir = config.paths && config.paths.backupDir;
  const backupSizeCache = backupSizeCache_();
  if (!dir || backupSizeCache.busy || Date.now() - backupSizeCache.t < 5 * 60 * 1000) return;
  backupSizeCache.busy = true;
  sshExec(`du -sm ${shq(dir)} 2>/dev/null | cut -f1`)
    .then((r) => { const n = parseInt(r.stdout, 10); if (Number.isFinite(n)) backupSizeCache.mb = n; })
    .catch(() => {})
    .finally(() => { backupSizeCache.t = Date.now(); backupSizeCache.busy = false; });
}

app.get('/api/system/stats', async (req, res) => {
  try {
    const r = await sshExec(
      `nproc; echo ---; cat /proc/loadavg; echo ---; free -m; echo ---; df -h / | tail -1; echo ---; ` +
        `PID=$(pgrep -u ${shq(config.lgsmUser || 'vhserver')} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null); ` +
        `if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then ` +
        `echo "PID=$PID"; awk '{print $14, $15}' "/proc/$PID/stat"; else echo NOPID; fi; echo ---; ` +
        `head -1 /proc/stat; echo ---; ` +
        `if [ -n "$PID" ]; then awk '/VmRSS/{print $2}' "/proc/$PID/status" 2>/dev/null; fi`
    );
    const [coresRaw, loadRaw, freeRaw, diskRaw, procRaw, cpuStatRaw, rssRaw] = r.stdout.split('---').map((s) => s.trim());
    const cores = parseInt(coresRaw, 10) || 1;
    const load = loadRaw.split(' ').slice(0, 3).map(Number);
    const memLine = freeRaw.split('\n').find((l) => l.startsWith('Mem:'));
    const memParts = memLine ? memLine.trim().split(/\s+/) : [];
    const memTotalMB = parseInt(memParts[1], 10) || 0;
    const memUsedMB = parseInt(memParts[2], 10) || 0;
    const diskParts = diskRaw.trim().split(/\s+/);

    // Valheim process CPU (see lastValheimCpuSample comment above).
    let valheimRunning = false;
    let valheimPid = null;
    let valheimCpuPercent = null;
    const procLines = (procRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (procLines[0] && procLines[0].startsWith('PID=') && procLines[1]) {
      valheimRunning = true;
      valheimPid = procLines[0].slice(4);
      const [utime, stime] = procLines[1].split(/\s+/).map(Number);
      const ticks = (utime || 0) + (stime || 0);
      const now = Date.now();
      const lastValheimCpuSample = valheimCpuSamples.get(curId());
      if (lastValheimCpuSample && lastValheimCpuSample.pid === valheimPid) {
        const dTicks = ticks - lastValheimCpuSample.ticks;
        const dSecs = (now - lastValheimCpuSample.atMs) / 1000;
        // USER_HZ is 100 on virtually every Linux distro (glibc default) —
        // getconf CLK_TCK would be the fully portable way to confirm this,
        // but 100 is safe for the Ubuntu VPS this runs on.
        if (dSecs > 0.5) valheimCpuPercent = Math.max(0, Math.round((dTicks / 100 / dSecs) * 100));
      }
      valheimCpuSamples.set(curId(), { pid: valheimPid, ticks, atMs: now });
    } else {
      valheimCpuSamples.delete(curId());
    }

    // Host CPU breakdown since the previous poll: "steal" is time the hypervisor gave to
    // other VPS tenants (a direct cause of lag you can't fix inside the VM); "iowait" is
    // time spent waiting on disk.
    let cpuStealPercent = null;
    let cpuIowaitPercent = null;
    const cs = (cpuStatRaw || '').split(/\s+/).slice(1).map(Number);
    if (cs.length >= 8 && cs.every((n) => Number.isFinite(n))) {
      const total = cs.slice(0, 8).reduce((a, b) => a + b, 0);
      if (lastHostCpuStat && total > lastHostCpuStat.total) {
        const dT = total - lastHostCpuStat.total;
        cpuStealPercent = Math.round(((cs[7] - lastHostCpuStat.steal) / dT) * 1000) / 10;
        cpuIowaitPercent = Math.round(((cs[4] - lastHostCpuStat.iowait) / dT) * 1000) / 10;
      }
      lastHostCpuStat = { total, steal: cs[7], iowait: cs[4] };
    }
    const swapLine = freeRaw.split('\n').find((l) => l.startsWith('Swap:'));
    const swapParts = swapLine ? swapLine.trim().split(/\s+/) : [];
    refreshBackupSize();

    res.json({
      cpuStealPercent,
      cpuIowaitPercent,
      swapTotalMB: parseInt(swapParts[1], 10) || 0,
      swapUsedMB: parseInt(swapParts[2], 10) || 0,
      valheimMemMB: rssRaw && /^\d+$/.test(rssRaw) ? Math.round(parseInt(rssRaw, 10) / 1024) : null,
      backupDirMB: backupSizeCache_().mb,
      cores,
      loadAvg: load,
      cpuPercent: Math.min(100, Math.round((load[0] / cores) * 100)),
      memTotalMB,
      memUsedMB,
      memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
      diskTotal: diskParts[1],
      diskUsed: diskParts[2],
      diskPercent: parseInt(diskParts[4], 10) || null,
      valheimRunning,
      valheimPid,
      // null on the very first poll (or right after a restart) — needs two
      // samples to compute a delta. The frontend shows "warming up…" for that.
      valheimCpuPercent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Backups ----

app.get('/api/backup/run', (req, res) => {
  // Shares the lock with the scheduled-backup cron job so the two can never run
  // at the same time (exit 99 = the lock is held by a running scheduled backup).
  const lock = `${cronPaths().lockDir}/valheim-scheduled-backup${instSfx()}.lock`;
  const cmd = `flock -n -E 99 ${shq(lock)} bash ${shq(config.paths.backupScript)}; rc=$?; ` +
    `if [ $rc -eq 99 ]; then echo "A scheduled backup is already running - wait for it to finish, then try again."; fi; exit $rc`;
  sshExecStream(maybeSudo(`bash -c ${shq(cmd)}`), res);
});

app.get('/api/backup/list', async (req, res) => {
  try {
    const r = await sshExec(`ls -1t ${shq(config.paths.backupDir)} 2>/dev/null | head -50`);
    res.json({ files: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Which world is this server running? ----
//
// The world name is a server setting (`worldname` in LGSM's cfg, LGSM's default is
// the instance name) — the GUI never hard-codes it. Order: config.worldName if you
// set it explicitly, else the effective `worldname` from the LGSM cfg files, else
// the LGSM instance name. `ready` is true once Valheim has actually created that
// world on disk; until then the GUI brands itself plain "Valheim" and switches to
// the world name the moment the world exists (an explicit config.worldName is
// trusted immediately).
const SAFE_WORLD_NAME = /^[A-Za-z0-9._-]+$/;
const worldInfoCaches = new Map(); // world id -> { t, v }
function worldInfoCache_() {
  const id = curId();
  if (!worldInfoCaches.has(id)) worldInfoCaches.set(id, { t: 0, v: null });
  return worldInfoCaches.get(id);
}
function invalidateWorldInfo() {
  worldInfoCache_().t = 0;
}
function expandSelfname(v) {
  return String(v).replace(/\$\{selfname\}|\$selfname(?![A-Za-z0-9_])/g, config.lgsmServer);
}
async function getWorldInfo() {
  const worldInfoCache = worldInfoCache_();
  if (worldInfoCache.v && Date.now() - worldInfoCache.t < 10000) return worldInfoCache.v;
  const explicitPort = config.connect && Number(config.connect.port);
  const explicit = config.worldName || null;
  let info = { port: explicitPort || 2456, world: explicit || config.lgsmServer, serverName: null, ready: !!explicit, brand: explicit || 'Valheim', source: explicit ? 'config.json' : 'default' };
  try {
    const files = [defaultCfgFile(), ...cfgFilesToSearch()].filter(Boolean);
    const parent = (config.paths && config.paths.worldDir) || `${config.lgsmHome}/.config/unity3d/IronGate`;
    const cmd = files.map((f) => `cat ${shq(f)} 2>/dev/null; echo '@@SEP@@'`).join('; ') + `; ls -1 ${shq(`${parent}/Valheim/worlds_local`)} 2>/dev/null`;
    const r = await sshExec(cmd);
    const parts = r.stdout.split('@@SEP@@\n');
    const entries = (parts[files.length] || '').split('\n').map((l) => l.trim()).filter(Boolean);
    let cfgWorld = null;
    let serverName = null;
    let cfgPort = null;
    let portExplicit = false;
    for (let i = 0; i < files.length; i++) {
      const w = parseCfgValue(parts[i] || '', 'worldname');
      const n = parseCfgValue(parts[i] || '', 'servername');
      if (w !== null && w !== '') cfgWorld = expandSelfname(w);
      if (n !== null && n !== '') serverName = expandSelfname(n);
      const pt = parseCfgValue(parts[i] || '', 'port');
      if (pt !== null && /^\d{2,5}$/.test(pt.trim())) {
        cfgPort = Number(pt);
        if (i > 0) portExplicit = true; // index 0 is LinuxGSM's shipped default (2456), not a choice
      }
    }
    const world = explicit || cfgWorld || config.lgsmServer;
    const exists = entries.some((e) => e === world || e.startsWith(`${world}.fwl`) || e.startsWith(`${world}.db`));
    info = {
      port: explicitPort || cfgPort || 2456,
      portExplicit: !!explicitPort || portExplicit,
      world,
      serverName,
      ready: exists || !!explicit,
      brand: exists || explicit ? world : 'Valheim',
      source: explicit ? 'config.json' : cfgWorld ? 'server settings' : 'default',
    };
  } catch (e) {
    // SSH hiccup: keep the last known answer (or the fallback above) and retry soon.
    if (worldInfoCache.v) return worldInfoCache.v;
    return info;
  }
  worldInfoCache.v = info;
  worldInfoCache.t = Date.now();
  return info;
}

// Where the world lives on disk. paths.worldDir in config.json is the PARENT of
// backup-valheim.sh's DATA_ROOT (e.g. /home/vhserver/.config/unity3d/IronGate),
// and DATA_ROOT is always ".../Valheim" — that's also the first path component
// inside every backup tarball.
async function worldPaths() {
  const parent = (config.paths && config.paths.worldDir) || `${config.lgsmHome}/.config/unity3d/IronGate`;
  const world = (await getWorldInfo()).world;
  return {
    parent,
    world,
    member: `Valheim/worlds_local/${world}`, // path of the world inside a backup tarball
    dir: `${parent}/Valheim/worlds_local/${world}`,
  };
}

// ---- World save health (API: GET /api/save-health) ----
//
// When did Valheim last write the world to disk? The server only saves on its
// autosave timer (-saveinterval) and on a clean stop, so a gap much longer than
// the interval means progress is only living in memory — exactly the situation
// that produced the "rolled back to day 1" surprise. Reads file times only.
app.get('/api/save-health', async (req, res) => {
  try {
    const { dir, world, parent } = await worldPaths();
    if (!SAFE_WORLD_NAME.test(world)) return res.status(500).json({ error: `The world name "${world}" has characters the GUI does not support (use letters, digits, . _ -)` });
    const user = config.lgsmUser || 'vhserver';
    const flat = `${parent}/Valheim/worlds_local/${world}`;
    const cmd = [
      `PID=$(pgrep -u ${shq(user)} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
      `LAST=$( { find ${shq(dir)} -maxdepth 2 -type f -not -path '*/backups/*' -printf '%T@\\n' 2>/dev/null; ` +
        `stat -c %Y ${shq(flat + '.db')} ${shq(flat + '.fwl')} 2>/dev/null; } | cut -d. -f1 | sort -n | tail -1 )`,
      `INTERVAL=1800`,
      `START=""`,
      `if [ -n "$PID" ]; then ` +
        `START=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
        `I=$(tr '\\0' ' ' < /proc/$PID/cmdline 2>/dev/null | grep -o -- '-saveinterval [0-9]*' | awk '{print $2}'); ` +
        `[ -n "$I" ] && INTERVAL=$I; fi`,
      `echo "RUNNING=$([ -n "$PID" ] && echo 1 || echo 0)"`,
      `echo "LAST=$LAST"`,
      `echo "START=$START"`,
      `echo "INTERVAL=$INTERVAL"`,
      `echo "NOW=$(date +%s)"`,
    ].join('; ');
    const r = await sshExec(cmd);
    const kv = {};
    r.stdout.split('\n').forEach((l) => {
      const i = l.indexOf('=');
      if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    });
    const num = (v) => (v !== undefined && v !== '' && isFinite(+v) ? +v : null);
    const running = kv.RUNNING === '1';
    const last = num(kv.LAST);
    const start = num(kv.START);
    const interval = num(kv.INTERVAL) || 1800;
    const now = num(kv.NOW) || Math.floor(Date.now() / 1000);
    const age = last != null ? Math.max(0, now - last) : null;
    const sinceStart = start != null ? Math.max(0, now - start) : null;

    let state;
    if (!running) state = 'stopped';
    else if (last == null) state = 'unknown'; // no world files found at all
    else if (start != null && last < start && sinceStart <= interval + 180) state = 'waiting'; // first autosave not due yet
    else if (age <= interval + 180) state = 'ok';
    else if (age <= interval * 2 + 180) state = 'late';
    else state = 'stale';

    res.json({
      state,
      running,
      lastSaveTs: last != null ? last * 1000 : null,
      ageSec: age,
      intervalSec: interval,
      serverStartTs: start != null ? start * 1000 : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore: put the world from a chosen backup tarball back, safely.
//
//  1. Verify the archive is readable AND actually contains this world — before
//     anything is stopped or touched.
//  2. Stop the server (a clean stop saves the current world).
//  3. Save a safety copy of the CURRENT world as PRE-RESTORE-<world>-<date>.tar.gz
//     in the backup folder, and verify it. (It shows up in the backup list, so a
//     bad restore can itself be undone.)
//  4. Delete the current world's files, then extract the world from the backup.
//     Deleting first matters: Valheim's newer save format numbers its files
//     (_main.2.db2, _main.4.db2, …) and loads the HIGHEST number, so extracting
//     an older backup over the top would leave the newer save in place and the
//     "restore" would silently do nothing.
//  5. Only the world is restored — mods and BepInEx configs are left as they are.
//     (The old restore also unpacked a stray BepInEx/ folder into the save dir.)
//  6. Fix ownership and start the server.
app.post('/api/backup/restore', async (req, res) => {
  const { file } = req.body || {};
  if (!file || typeof file !== 'string' || !/^[\w.@+-]+\.tar\.gz$/.test(file)) {
    return res.status(400).json({ error: 'missing or invalid backup file name' });
  }
  if (!config.paths.worldDir || !config.paths.backupDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.worldDir and paths.backupDir must be set in config.json before restoring.');
  }
  const { parent, world, member, dir } = await worldPaths();
  if (!SAFE_WORLD_NAME.test(world)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`[error] The world name "${world}" has characters the GUI does not support (use letters, digits, . _ -).`);
  }
  const user = config.lgsmUser || 'vhserver';
  const script = config.paths.lgsmScript || `/home/${user}/vhserver`;
  const backupPath = `${config.paths.backupDir}/${file}`;
  const flat = `${parent}/Valheim/worlds_local/${world}`;
  const cmd = [
    `echo "Verifying backup integrity before touching anything..."`,
    `tar -tzf ${shq(backupPath)} > /dev/null`,
    `( tar -tzf ${shq(backupPath)} | grep -qF -e ${shq(member + '/')} -e ${shq(member + '.fwl')} -e ${shq(member + '.db')} || { echo "[error] this archive contains no ${world} world data — refusing to restore"; false; } )`,
    `echo "Backup verified OK."`,
    asLgsmUser(`${shq(script)} stop`),
    `echo "Server stopped (world saved by the stop)."`,
    // Safety copy of what's on disk right now — whichever form the world has (folder, or flat .fwl/.db pair).
    `{ ITEMS=""; if [ -d ${shq(dir)} ]; then ITEMS=${shq(member)}; fi; ` +
      `if [ -f ${shq(flat + '.fwl')} ]; then ITEMS="$ITEMS "${shq(member + '.fwl')}" "${shq(member + '.db')}; fi; ` +
      `if [ -n "$ITEMS" ]; then ` +
      `SAFE=${shq(config.paths.backupDir)}"/PRE-RESTORE-${world}-$(date +%F-%H%M).tar.gz"; ` +
      `tar -czf "$SAFE" -C ${shq(parent)} $ITEMS && tar -tzf "$SAFE" > /dev/null && ` +
      `chown ${shq(user)}:${shq(user)} "$SAFE" && echo "Safety copy of the current world: $SAFE"; fi; }`,
    // Remove the current world's files (guarded so a bad path can never expand to something else).
    `{ case ${shq(dir)} in */worlds_local/?*) rm -rf -- ${shq(dir)}; rm -f -- ${shq(flat + '.db')} ${shq(flat + '.fwl')} ${shq(flat + '.db.old')} ${shq(flat + '.fwl.old')} ;; *) echo "[error] unexpected world path"; false ;; esac; }`,
    `echo "Extracting ${file}..."`,
    `{ tar -xzf ${shq(backupPath)} -C ${shq(parent)} ${shq(member)} 2>/dev/null; tar -xzf ${shq(backupPath)} -C ${shq(parent)} ${shq(member + '.fwl')} ${shq(member + '.db')} 2>/dev/null; ` +
      `if [ -d ${shq(dir)} ] || [ -f ${shq(flat + '.fwl')} ]; then true; else echo "[error] extraction produced no world files — the previous world is in: $SAFE"; false; fi; }`,
    // The world is either a folder (worlds_local/<name>/) or a flat <name>.fwl/.db pair; fix whichever came back.
    `{ if [ -d ${shq(dir)} ]; then chown -R ${shq(user)}:${shq(user)} ${shq(dir)}; fi; }`,
    `{ chown ${shq(user)}:${shq(user)} ${shq(flat + '.db')} ${shq(flat + '.fwl')} 2>/dev/null; true; }`,
    `echo "Extracted. Starting..."`,
    asLgsmUser(`${shq(script)} start`),
    `echo "RESTORED ${file}"`,
    `echo "Previous world kept as: \${SAFE:-none}"`,
  ].join(' && ');
  sshExecPlainStream(cmd, res);
});

// ---- Scheduled backups + update checks (real cron jobs on the VPS) ----
//
// Saving a schedule in the dashboard installs a cron job in /etc/cron.d plus a
// small wrapper script in /usr/local/bin on the VPS. After that the dashboard
// is not involved at all: cron runs the job whether or not this GUI (or your PC)
// is on. The dashboard only reads the cron file and a status file back to show
// you what is set and how the last run went. Turning a schedule off deletes the
// cron file and the wrapper.
//
// Wrapper behaviour (backup): skipped if the server is stopped (it never starts
// a server you stopped on purpose); with "only when nobody is online" it waits
// up to 1 hour for the server to empty (checking every 10 min) and otherwise
// skips that run; a lock prevents two runs overlapping; failures post to Discord.
const CRON_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 168];
// Prefix for status messages so two worlds' alerts can be told apart in one Discord channel (none for main).
function worldTag() {
  return config.instance.main ? '' : `[${config.instance.label}] `;
}
function cronPaths() {
  const p = config.paths || {};
  return {
    cronDir: p.cronDir || '/etc/cron.d',
    binDir: p.scriptDir || '/usr/local/bin',
    logDir: p.logDir || '/var/log',
    lockDir: p.lockDir || '/var/lock',
    stateDir: p.stateDir || '/var/lib',
  };
}
function cronExpr(hours, minute) {
  if (hours === 168) return `${minute} 4 * * 0`;
  if (hours === 48) return `${minute} 4 */2 * *`;
  if (hours === 1) return `${minute} * * * *`;
  if (hours === 24) return `${minute} 4 * * *`;
  return `${minute} */${hours} * * *`;
}
function describeCron(hours, minute) {
  const mm = String(minute).padStart(2, '0');
  if (hours === 168) return `weekly, Sunday 04:${mm}`;
  if (hours === 48) return `every 2 days at 04:${mm}`;
  if (hours === 1) return `every hour at :${mm}`;
  if (hours === 24) return `daily at 04:${mm}`;
  return `every ${hours} h (at :${mm} past)`;
}

async function writeRootFile(filePath, content, mode) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const cmd = [
    `printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${shq(filePath)}`)} >/dev/null`,
    maybeSudo(`chmod ${mode} ${shq(filePath)}`),
    maybeSudo(`chown root:root ${shq(filePath)}`),
    'echo WROTE',
  ].join(' && ');
  const r = await sshExec(cmd);
  if (!r.stdout.includes('WROTE')) throw new Error(`could not write ${filePath}: ${r.stdout} ${r.stderr}`.trim());
}

// Webhook for server status / backups / update checks (the cron jobs). Separate from
// discordWebhookUrl, which the mod-changes notification uses. Falls back to that one if unset.
function statusWebhook() {
  return config.discordStatusWebhookUrl || config.discordWebhookUrl || '';
}

function buildBackupWrapper(P, onlyEmpty) {
  const user = config.lgsmUser || 'vhserver';
  const lgsm = config.paths.lgsmScript || `/home/${user}/vhserver`;
  return [
    '#!/bin/bash',
    '# Managed by valheim-gui. Regenerated every time you save the backup schedule.',
    '# Usage: (no args) = the scheduled run; "retry" = run only if an earlier run was postponed.',
    `BACKUP=${shq(config.paths.backupScript)}`,
    `GAMELOG=${shq(config.paths.logFile)}`,
    `LGSM=${shq(lgsm)}`,
    `LGSM_USER=${shq(user)}`,
    `ONLY_EMPTY=${onlyEmpty ? 1 : 0}`,
    `WEBHOOK=${shq(statusWebhook())}`,
    `STATUS=${shq(`${P.logDir}/valheim-scheduled-backup${instSfx()}.status`)}`,
    `LOG=${shq(`${P.logDir}/valheim-scheduled-backup${instSfx()}.log`)}`,
    `PENDING=${shq(`${P.stateDir}/valheim-scheduled-backup${instSfx()}.pending`)}`,
    'MAX_RETRIES=48',
    `exec 9>${shq(`${P.lockDir}/valheim-scheduled-backup${instSfx()}.lock`)}`,
    'flock -n 9 || exit 0',
    'status() { echo "$(date +%s)|$1|$2" > "$STATUS"; }',
    `notify() { [ -n "$WEBHOOK" ] && curl -s -m 15 -H "Content-Type: application/json" -d "{\\"content\\":\\"${worldTag()}$1\\"}" "$WEBHOOK" >/dev/null 2>&1; }`,
    "running() { pgrep -u \"$LGSM_USER\" -f '^\\./valheim_server\\.x86_64' >/dev/null 2>&1; }",
    // Whole log, not just a tail: a busy modded log can push the last "Connections N" line out of a short tail, which would read as "0 players".
    "players() { local n; n=$(grep -aoE 'Connections [0-9]+ ZDOS' \"$GAMELOG\" 2>/dev/null | tail -n1 | grep -oE '[0-9]+'); echo \"${n:-0}\"; }",
    '',
    '# Retry ticks (every 15 min) do nothing unless a previous run was postponed because players were online.',
    'tries=0',
    'if [ "$1" = retry ]; then',
    '  [ -f "$PENDING" ] || exit 0',
    '  tries=$(cat "$PENDING" 2>/dev/null); tries=${tries:-0}',
    '  if [ "$tries" -ge "$MAX_RETRIES" ]; then rm -f "$PENDING"; status skipped "Gave up after $MAX_RETRIES retries (players kept being online); next scheduled run will try again."; exit 0; fi',
    'fi',
    '',
    'if ! running; then rm -f "$PENDING"; status skipped "Server is stopped (a scheduled backup never starts a stopped server)."; exit 0; fi',
    'if [ "$ONLY_EMPTY" = 1 ]; then',
    '  p=$(players)',
    '  if [ "$p" -gt 0 ]; then',
    '    echo $((tries + 1)) > "$PENDING"',
    '    status skipped "Postponed: $p player(s) online. Retrying every 15 min until the server is empty."',
    '    exit 0',
    '  fi',
    'fi',
    '',
    'rm -f "$PENDING"',
    'echo "=== $(date) scheduled backup start ===" >> "$LOG"',
    'bash "$BACKUP" >> "$LOG" 2>&1',
    'rc=$?',
    '# The server was running when we started. If it is not running now (e.g. the backup failed',
    '# after stopping it), bring it back rather than leaving everyone locked out.',
    '# LGSM start returns before the game process is visible; give it up to 90s before deciding it is down.',
    'for _ in $(seq 1 18); do running && break; sleep 5; done',
    'if ! running; then',
    '  echo "=== $(date) server not running after backup (exit $rc) - starting it ===" >> "$LOG"',
    '  su - "$LGSM_USER" -c "\\"$LGSM\\" start" >> "$LOG" 2>&1 9>&-',
    '  sleep 20',
    '  if running; then restarted=" Server was restarted automatically."; else restarted=" SERVER IS STILL DOWN - start it manually."; fi',
    'else',
    '  restarted=""',
    'fi',
    'if [ $rc -eq 75 ]; then',
    '  # backup script reported "busy" (a manual run holds its lock): not a failure, nothing to alert.',
    '  status skipped "Another backup was already running; this scheduled run was skipped."',
    'elif [ $rc -eq 0 ]; then',
    '  status ok "Backup completed.$restarted"',
    '  [ -n "$restarted" ] && notify "Valheim backup finished but the server had stopped.$restarted ($(hostname))"',
    'else',
    '  status fail "Backup failed (exit $rc) - see $LOG.$restarted"',
    '  notify "Scheduled Valheim backup FAILED (exit $rc) on $(hostname).$restarted"',
    'fi',
    '',
  ].join('\n');
}

function buildUpdateWrapper(P) {
  return [
    '#!/bin/bash',
    '# Managed by valheim-gui. Regenerated every time you save the update-check schedule.',
    `CHECK=${shq(config.paths.checkUpdateScript || '')}`,
    `WEBHOOK=${shq(statusWebhook())}`,
    `STATUS=${shq(`${P.logDir}/valheim-update-check${instSfx()}.status`)}`,
    `STATE=${shq(`${P.stateDir}/valheim-update-check${instSfx()}.state`)}`,
    'status() { echo "$(date +%s)|$1|$2" > "$STATUS"; }',
    `notify() { [ -n "$WEBHOOK" ] && curl -s -m 15 -H "Content-Type: application/json" -d "{\\"content\\":\\"${worldTag()}$1\\"}" "$WEBHOOK" >/dev/null 2>&1; }`,
    'out=$(bash "$CHECK" 2>&1 | tail -n 4 | tr "\\n" " " | sed \'s/["\\\\]//g\' | cut -c1-300)',
    "if echo \"$out\" | grep -qiE 'no update|up[- ]to[- ]date|already (on |the )*(latest|newest)'; then",
    '  status ok "Server is up to date."; echo none > "$STATE"',
    "elif echo \"$out\" | grep -qiE 'update available|new version|newer|out ?of ?date|outdated|needs? (an )?update'; then",
    '  status update "Server update available."',
    '  if [ "$(cat "$STATE" 2>/dev/null)" != "$out" ]; then notify "Valheim server update available (nothing was installed or restarted). $out"; echo "$out" > "$STATE"; fi',
    'else',
    '  status ok "Checked. $out"',
    'fi',
    '',
  ].join('\n');
}

// File names of one world's cron job. The main world keeps the original names; every other world gets
// its own set (suffix "-<id>") and a staggered minute so two worlds never stop for a backup together.
function cronJob(kind) {
  const sfx = instSfx();
  const idx = curId() === 'main' ? 0 : readRegistry().findIndex((i) => i.id === curId()) + 1;
  const off = ((idx % 6) * 7) % 60;
  return kind === 'backup'
    ? { file: `valheim-gui-backup${sfx}`, script: `valheim-scheduled-backup${sfx}.sh`, status: `valheim-scheduled-backup${sfx}.status`, minute: (17 + off) % 60 }
    : { file: `valheim-gui-update-check${sfx}`, script: `valheim-update-check${sfx}.sh`, status: `valheim-update-check${sfx}.status`, minute: (47 + off) % 60 };
}

async function readCronJob(kind) {
  const P = cronPaths();
  const j = cronJob(kind);
  const r = await sshExec(`cat ${shq(`${P.cronDir}/${j.file}`)} 2>/dev/null; echo ---STATUS---; cat ${shq(`${P.logDir}/${j.status}`)} 2>/dev/null`);
  const [cronText, statusText] = r.stdout.split('---STATUS---');
  const out = { enabled: false, intervalHours: kind === 'backup' ? 12 : 24, onlyWhenEmpty: true, lastRun: null, description: null, mechanism: 'cron on the VPS' };
  const m = (cronText || '').match(/# valheim-gui: hours=(\d+) onlyEmpty=([01])/);
  if (m) {
    out.enabled = true;
    out.intervalHours = Number(m[1]);
    out.onlyWhenEmpty = m[2] === '1';
    out.description = describeCron(out.intervalHours, j.minute);
  }
  const s = (statusText || '').trim().split('|');
  if (s.length >= 3 && /^\d+$/.test(s[0])) {
    out.lastRun = { ts: Number(s[0]) * 1000, ok: s[1] === 'ok' ? true : s[1] === 'fail' ? false : null, state: s[1], message: s.slice(2).join('|') };
  }
  return out;
}

async function installCronJob(kind, enabled, hours, onlyEmpty) {
  const P = cronPaths();
  const j = cronJob(kind);
  const cronPath = `${P.cronDir}/${j.file}`;
  const scriptPath = `${P.binDir}/${j.script}`;
  if (!enabled) {
    await sshExec(`${maybeSudo(`rm -f ${shq(cronPath)} ${shq(scriptPath)}`)}; echo DONE`);
    return;
  }
  const chk = await sshExec(`[ -d ${shq(P.cronDir)} ] && echo HAVE_CRON_D; (command -v cron || command -v crond) >/dev/null 2>&1 && echo HAVE_CRON`);
  if (!chk.stdout.includes('HAVE_CRON_D') || !chk.stdout.includes('HAVE_CRON')) {
    throw new Error('cron is not installed on the VPS (run: sudo apt install cron && sudo systemctl enable --now cron)');
  }
  if (kind === 'update' && !config.paths.checkUpdateScript) throw new Error('paths.checkUpdateScript is not set in config.json');
  if (kind === 'backup' && !config.paths.backupScript) throw new Error('paths.backupScript is not set in config.json');
  await writeRootFile(scriptPath, kind === 'backup' ? buildBackupWrapper(P, onlyEmpty) : buildUpdateWrapper(P), '700');
  const cron = [
    `# valheim-gui: hours=${hours} onlyEmpty=${onlyEmpty ? 1 : 0}`,
    '# Managed by the valheim-gui dashboard. Edit the schedule there, or delete this file to stop it.',
    'SHELL=/bin/bash',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${cronExpr(hours, j.minute)} root ${scriptPath}`,
    ...(kind === 'backup' ? ['# Retry ticks: only act if the last run was postponed because players were online.', `*/15 * * * * root ${scriptPath} retry`] : []),
    '',
  ].join('\n');
  await writeRootFile(cronPath, cron, '644');
}

function validHours(v) {
  const h = Number(v);
  return CRON_HOURS.includes(h) ? h : null;
}

app.get('/api/backup/schedule', async (req, res) => {
  try {
    res.json({ ...(await readCronJob('backup')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/schedule', async (req, res) => {
  try {
    const { enabled, intervalHours, onlyWhenEmpty } = req.body || {};
    const hours = validHours(intervalHours);
    if (!hours) return res.status(400).json({ error: `intervalHours must be one of ${CRON_HOURS.join(', ')}` });
    await installCronJob('backup', !!enabled, hours, onlyWhenEmpty !== false);
    res.json({ ...(await readCronJob('backup')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/update/schedule', async (req, res) => {
  try {
    res.json({ ...(await readCronJob('update')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/update/schedule', async (req, res) => {
  try {
    const { enabled, intervalHours } = req.body || {};
    const hours = validHours(intervalHours);
    if (!hours) return res.status(400).json({ error: `intervalHours must be one of ${CRON_HOURS.join(', ')}` });
    await installCronJob('update', !!enabled, hours, true);
    res.json({ ...(await readCronJob('update')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Server settings + player lists (API: /api/settings, /api/lists) ----
//
// Settings live as KEY="value" lines in LGSM's common.cfg. An edit replaces the
// existing line (or appends one), after copying common.cfg to a timestamped
// .bak. Only the whitelisted keys below can be touched. Nothing is applied to
// the running game: Valheim reads these only at launch, so stop → start after.
const SETTING_DEFS = {
  servername: { label: 'Server name', type: 'text', max: 60, hint: 'Shown in the server browser.' },
  worldname: { label: 'World name', type: 'text', max: 40, pattern: /^[A-Za-z0-9._-]+$/, patternMsg: 'letters, digits, dot, dash and underscore only', hint: 'Valheim creates the world the first time the server starts. Changing it later starts a NEW world (the old one stays on disk).' },
  serverpassword: { label: 'Server password', type: 'password', min: 5, max: 64, hint: 'At least 5 characters and must not contain the world name.' },
  port: { label: 'Game port', type: 'int', minV: 1024, maxV: 65530, hint: 'UDP; the next two ports are used too.' },
  public: { label: 'Listed publicly', type: 'bool01', hint: '1 = shows in the server list, 0 = join by IP only.' },
  saveinterval: { label: 'Autosave interval (seconds)', type: 'int', minV: 60, maxV: 7200, hint: 'Valheim only writes the world on this timer and on a clean stop — 600 is a safe value.' },
  backups: { label: 'Auto-backups kept', type: 'int', minV: 1, maxV: 50, hint: 'Valheim’s own rotating world backups.' },
  backupshort: { label: 'First backup after (seconds)', type: 'int', minV: 60, maxV: 86400, hint: 'Interval of the short backups (default 7200).' },
  backuplong: { label: 'Later backups every (seconds)', type: 'int', minV: 600, maxV: 604800, hint: 'Interval of the long backups (default 43200).' },
  // Edited through the World modifiers card (/api/modifiers), not the generic form.
  worldmodifiers: { label: 'World modifiers', type: 'text', max: 300, allowEmpty: true, hidden: true },
};
const WEAK_PASSWORDS = new Set(['qwerty1234', 'password', 'password1', '12345678', '123456789', '1234567890', 'valheim', 'valheim123', 'qwerty', 'qwerty123']);

function parseCfgValue(text, key) {
  // Last active (non-comment) assignment wins, like the shell would treat it.
  const re = new RegExp(`^[ \\t]*${key}=(?:"((?:[^"\\\\\\n]|\\\\.)*)"|'([^'\\n]*)'|([^\\s#]*))`, 'gm');
  let m;
  let val = null;
  while ((m = re.exec(text))) val = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return val;
}

function cfgFilesToSearch() {
  const common = config.paths.commonCfgPath;
  if (!common) return [];
  // LGSM merges common.cfg and (optionally) <server>.cfg; the instance cfg wins.
  const instance = common.replace(/common\.cfg$/, `${config.lgsmServer || 'vhserver'}.cfg`);
  return instance !== common ? [common, instance] : [common];
}
// LGSM's shipped defaults: lowest priority, read-only (overwritten on LGSM updates).
function defaultCfgFile() {
  const common = config.paths.commonCfgPath;
  return common ? common.replace(/common\.cfg$/, '_default.cfg') : null;
}

app.get('/api/settings', async (req, res) => {
  try {
    const files = cfgFilesToSearch();
    if (!files.length) return res.status(400).json({ error: 'paths.commonCfgPath is not set in config.json' });
    const texts = {};
    for (const f of files) texts[f] = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
    if (!texts[files[0]]) return res.status(400).json({ error: `Can't read ${files[0]} — LinuxGSM isn't installed yet (use the Setup tab) or paths.commonCfgPath is wrong.` });
    const dflt = defaultCfgFile();
    const dfltText = dflt && dflt !== files[0] ? (await sshExec(`cat ${shq(dflt)} 2>/dev/null`)).stdout : '';
    const settings = {};
    let startparams = null;
    for (const key of Object.keys(SETTING_DEFS)) {
      let value = null;
      let source = null;
      if (dfltText) {
        const dv = parseCfgValue(dfltText, key);
        if (dv !== null) { value = dv; source = 'LGSM default'; }
      }
      for (const f of files) {
        const v = parseCfgValue(texts[f], key);
        if (v !== null) { value = v; source = f; }
      }
      settings[key] = { ...SETTING_DEFS[key], value, source };
    }
    if (dfltText) startparams = parseCfgValue(dfltText, 'startparameters');
    for (const f of files) {
      const v = parseCfgValue(texts[f], 'startparameters');
      if (v !== null) startparams = v;
    }
    const usesVar = (k) => (startparams ? new RegExp('\\$\\{?' + k + '(?![A-Za-z0-9_])').test(startparams) : null);
    for (const key of Object.keys(settings)) settings[key].usedByStartParameters = usesVar(key);
    const wi = await getWorldInfo();
    const pw = settings.serverpassword.value;
    res.json({
      settings,
      writeTo: files[0],
      worldName: wi.world,
      worldNameOverride: config.worldName || null,
      passwordWarning: pw && WEAK_PASSWORDS.has(pw.toLowerCase()) ? 'This password is on the list of very common passwords — anyone who finds the server can guess it.' : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const incoming = (req.body && req.body.values) || {};
    const clean = {};
    for (const [key, raw] of Object.entries(incoming)) {
      const def = SETTING_DEFS[key];
      if (!def) return res.status(400).json({ error: `Unknown setting: ${key}` });
      const v = String(raw == null ? '' : raw).trim();
      if (def.type === 'int') {
        if (!/^\d+$/.test(v) || Number(v) < def.minV || Number(v) > def.maxV) return res.status(400).json({ error: `${def.label} must be a whole number between ${def.minV} and ${def.maxV}.` });
      } else if (def.type === 'bool01') {
        if (v !== '0' && v !== '1') return res.status(400).json({ error: `${def.label} must be 0 or 1.` });
      } else {
        if ((!v && !def.allowEmpty) || v.length > def.max) return res.status(400).json({ error: `${def.label} must be 1–${def.max} characters.` });
        if (/["'`$\\\n\r]/.test(v)) return res.status(400).json({ error: `${def.label} can't contain quotes, backslashes or $ (they break the launch command).` });
        if (def.pattern && !def.pattern.test(v)) return res.status(400).json({ error: `${def.label}: ${def.patternMsg}.` });
        if (key === 'serverpassword' && v.length < def.min) return res.status(400).json({ error: 'The server password must be at least 5 characters.' });
      }
      clean[key] = v;
    }
    const keys = Object.keys(clean);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
    if (clean.port !== undefined) {
      // Each world on this VPS needs its own game port (Valheim also uses the next two).
      const clash = (await otherWorldPorts()).find((o) => portsOverlap(o.port, clean.port));
      if (clash) return res.status(400).json({ error: `Game port ${clean.port} overlaps the world "${clash.label}" (port ${clash.port}). Valheim also uses the next two ports, so keep worlds at least 3 apart.` });
    }
    if (clean.serverpassword !== undefined || clean.worldname !== undefined) {
      // Valheim refuses to start when the password contains the world name; check the
      // pair as it will be after this save (the one being saved, else what is set now).
      const world = clean.worldname !== undefined ? clean.worldname : (await getWorldInfo()).world;
      const pw = clean.serverpassword !== undefined ? clean.serverpassword : (await readEffectiveCfgValue('serverpassword')) || '';
      if (pw && world && pw.toLowerCase().includes(world.toLowerCase())) {
        return res.status(400).json({ error: 'Valheim refuses a password that contains the world name. Change one of them.' });
      }
    }
    const oldPort = clean.port !== undefined ? await worldGamePort().catch(() => null) : null;
    const out = await applyCfgValues(clean);
    invalidateWorldInfo();
    if (out.applied) notePending(`Server settings changed (${keys.filter((k) => k !== 'worldmodifiers').join(', ') || 'world modifiers'})`);
    // A changed game port: open the new UDP range and close the one this GUI opened for the old port.
    // Firewall trouble never fails the settings save.
    if (clean.port !== undefined && out.applied) {
      try {
        const fw = await fwRun('open', Number(clean.port));
        if (oldPort && Number(oldPort) !== Number(clean.port) && fw.active) {
          const old = await fwRun('close-tagged', oldPort);
          if (old.result === 'closed') fw.message += ` ${old.message}`;
        }
        out.firewall = fw;
      } catch (e) {
        out.firewall = { tool: 'none', message: `Firewall not changed: ${e.message}` };
      }
    }
    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Writes already-validated KEY="value" pairs into the LGSM cfg that currently wins
// for each key (common.cfg by default), with a timestamped .bak of every file touched.
async function applyCfgValues(clean) {
  const keys = Object.keys(clean);
  const fail = (msg, code) => Object.assign(new Error(msg), { statusCode: code || 500 });
  const files = cfgFilesToSearch();
  if (!files.length) throw fail('paths.commonCfgPath is not set in config.json', 400);
  const texts = {};
  for (const f of files) texts[f] = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
  if (!texts[files[0]]) throw fail(`couldn't read ${files[0]}`, 400);
  // Each key is written to the file that currently wins for it (the instance
  // cfg overrides common.cfg); keys set nowhere go to common.cfg.
  const nextText = { ...texts };
  const touched = new Set();
  for (const key of keys) {
    let target = files[0];
    for (const f of files) if (parseCfgValue(texts[f], key) !== null) target = f;
    let next = nextText[target] || '';
    const line = `${key}="${clean[key]}"`;
    const all = [...next.matchAll(new RegExp(`^[ \\t]*${key}=.*$`, 'gm'))];
    if (all.length) {
      const last = all[all.length - 1];
      next = next.slice(0, last.index) + line + next.slice(last.index + last[0].length);
    } else {
      next = next.replace(/\n*$/, '\n') + line + '\n';
    }
    nextText[target] = next;
    touched.add(target);
  }
  const backups = [];
  for (const target of touched) {
    if (nextText[target] === texts[target]) continue;
    const backupPath = `${target}.bak.${Date.now()}`;
    const b64 = Buffer.from(nextText[target], 'utf8').toString('base64');
    const cmd = [
      `if [ -f ${shq(target)} ]; then ${maybeSudo(`cp -p ${shq(target)} ${shq(backupPath)}`)}; fi`,
      `printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${shq(target)}`)} >/dev/null`,
      'echo APPLIED',
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) throw fail(`write to ${target} failed: ${r.stdout} ${r.stderr}`);
    backups.push(backupPath);
  }
  if (!backups.length) return { applied: false, note: 'No changes.' };
  return { applied: true, changed: keys, backups, note: 'Saved. Stop and start the server to apply (Valheim reads these only at launch).' };
}

const LIST_FILES = { admin: 'adminlist.txt', banned: 'bannedlist.txt', permitted: 'permittedlist.txt' };
function listDir() {
  const user = config.lgsmUser || 'vhserver';
  return (config.paths && config.paths.listDir) || `/home/${user}/.config/unity3d/IronGate/Valheim`;
}
const STEAMID = /^\d{17}$/;

function parseList(text) {
  // Valheim format: one ID per line; lines starting with // are comments (the
  // game writes the header and uses "// name" after IDs it knows).
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map((l) => {
    const [id, ...rest] = l.split(/\s+/);
    return { id, note: rest.join(' ').replace(/^\/\/\s*/, '') };
  });
}

app.get('/api/lists', async (req, res) => {
  try {
    const dir = listDir();
    const out = {};
    for (const [k, f] of Object.entries(LIST_FILES)) {
      const r = await sshExec(`cat ${shq(`${dir}/${f}`)} 2>/dev/null`);
      out[k] = parseList(r.stdout);
    }
    res.json({ dir, lists: out, players: await getOnlinePlayers().catch(() => []) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replaces one whole list. Backs the old file up first. Valheim re-reads these
// files while running (about every minute), so no restart is needed.
app.post('/api/lists/:which', async (req, res) => {
  try {
    const file = LIST_FILES[req.params.which];
    if (!file) return res.status(404).json({ error: 'Unknown list' });
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'entries must be an array' });
    if (entries.length > 500) return res.status(400).json({ error: 'Too many entries' });
    const seen = new Set();
    const lines = [];
    for (const e of entries) {
      const id = String((e && e.id) || '').trim();
      if (!STEAMID.test(id)) return res.status(400).json({ error: `"${id}" is not a 17-digit SteamID64.` });
      if (seen.has(id)) continue;
      seen.add(id);
      const note = String((e && e.note) || '').replace(/[\r\n]/g, ' ').trim().slice(0, 60);
      lines.push(note ? `${id} // ${note}` : id);
    }
    const dir = listDir();
    const target = `${dir}/${file}`;
    const header = `//List of ${req.params.which === 'admin' ? 'admin' : req.params.which === 'banned' ? 'banned' : 'permitted'} players ID ONLY ONE per line\n`;
    const b64 = Buffer.from(header + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8').toString('base64');
    const user = config.lgsmUser || 'vhserver';
    const cmd = [
      `if [ -f ${shq(target)} ]; then ${maybeSudo(`cp -p ${shq(target)} ${shq(`${target}.bak.${Date.now()}`)}`)}; fi`,
      `cd ${shq(`/home/${user}`)} && printf '%s' ${shq(b64)} | base64 -d | sudo -n -u ${shq(user)} tee ${shq(target)} >/dev/null`,
      'echo APPLIED',
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) return res.status(500).json({ error: `write failed: ${r.stdout} ${r.stderr}` });
    res.json({ applied: true, count: lines.length, note: 'Saved. Valheim re-reads the lists on its own within about a minute.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Restart-required tracking (API: GET /api/pending-changes) ----
//
// Valheim reads launch settings, world modifiers, plugin configs and the mod set
// only when it starts. Every change made through this dashboard is noted here with
// a time; a change is "pending" while the running server was started BEFORE it.
// Stop -> Start makes the server newer than every note, so they clear by themselves.
// One list per world; the main world keeps the original file name.
const pendingLists = new Map(); // world id -> array
const pendingFile = (id) => path.join(__dirname, '.cache', id === 'main' ? 'pending-changes.json' : `pending-changes.${id}.json`);
function pendingList(id = curId()) {
  if (!pendingLists.has(id)) {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(pendingFile(id), 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      /* none yet */
    }
    pendingLists.set(id, list);
  }
  return pendingLists.get(id);
}
function savePending(id, list) {
  pendingLists.set(id, list);
  try {
    fs.mkdirSync(path.dirname(pendingFile(id)), { recursive: true });
    fs.writeFileSync(pendingFile(id), JSON.stringify(list));
  } catch (e) {
    console.error('[pending-changes] could not save:', e.message);
  }
}
function notePending(label, id = curId()) {
  let list = pendingList(id);
  list.push({ ts: Date.now(), label: String(label).slice(0, 160) });
  if (list.length > 50) list = list.slice(-50);
  savePending(id, list);
}

// Mod installs/removals/enables/disables also need a restart to take effect.
app.use('/api/mods', (req, res, next) => {
  const verbs = { '/install': 'installed', '/remove': 'removed', '/disable': 'disabled', '/enable': 'enabled' };
  const verb = req.method === 'POST' ? verbs[req.path] : null;
  if (verb) {
    const worldId = curId(); // 'finish' fires outside this request's context, so remember which world it was
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const b = req.body || {};
      const who = b.name || b.folder || b.folderName || b.packageName || b.displayName || '';
      notePending(`Mod ${verb}${who ? ': ' + who : ''}`, worldId);
    });
  }
  next();
});

app.get('/api/pending-changes', async (req, res) => {
  try {
    const r = await sshExec(`${stateSnippet()}; echo ---; date +%s`);
    const [stateBlock, nowRaw] = r.stdout.split('---').map((x) => x.trim());
    const [state, since] = stateBlock.split('\n').map((x) => x.trim());
    const skew = (parseInt(nowRaw, 10) || 0) * 1000 - Date.now(); // VPS clock minus this machine's clock
    const startMs = since ? Date.parse(since.replace(' UTC', 'Z').replace(' ', 'T')) : NaN;
    let changes = [];
    if (state === 'active' && Number.isFinite(startMs)) {
      const all = pendingList();
      changes = all.filter((c) => c.ts + skew > startMs);
      if (changes.length !== all.length) savePending(curId(), changes);
    }
    res.json({ required: changes.length > 0, changes: changes.map((c) => ({ ts: c.ts, label: c.label })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- World modifiers (API: GET/POST /api/modifiers) ----
//
// Stored in LGSM's `worldmodifiers` variable, which your startparameters append to
// the launch line. Valheim flags: -preset <name>, -modifier <key> <value>, -setkey <key>.
const WM_PRESETS = ['normal', 'casual', 'easy', 'hard', 'hardcore', 'immersive', 'hammer'];
const WM_MODIFIERS = {
  combat: ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources: ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids: ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals: ['casual', 'hard', 'veryhard'],
};
const WM_KEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];

function parseWorldModifiers(str) {
  const out = { preset: '', modifiers: {}, keys: [], extra: '' };
  const toks = String(str || '').split(/\s+/).filter(Boolean);
  const extra = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    if (t === '-preset' && toks[i + 1]) out.preset = toks[++i].toLowerCase();
    else if (t === '-modifier' && toks[i + 2]) { const k = toks[++i].toLowerCase(); out.modifiers[k] = toks[++i].toLowerCase(); }
    else if (t === '-setkey' && toks[i + 1]) out.keys.push(toks[++i].toLowerCase());
    else extra.push(toks[i]);
  }
  out.extra = extra.join(' ');
  return out;
}

async function readEffectiveCfgValue(key) {
  const files = cfgFilesToSearch();
  const dflt = defaultCfgFile();
  let value = null;
  const order = [dflt && dflt !== files[0] ? dflt : null, ...files].filter(Boolean);
  for (const f of order) {
    const t = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
    const v = parseCfgValue(t, key);
    if (v !== null) value = v;
  }
  return value;
}

app.get('/api/modifiers', async (req, res) => {
  try {
    if (!cfgFilesToSearch().length) return res.status(400).json({ error: 'paths.commonCfgPath is not set in config.json' });
    const raw = (await readEffectiveCfgValue('worldmodifiers')) || '';
    res.json({ ...parseWorldModifiers(raw), options: { presets: WM_PRESETS, modifiers: WM_MODIFIERS, keys: WM_KEYS } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/modifiers', async (req, res) => {
  try {
    const b = req.body || {};
    const preset = String(b.preset || '').toLowerCase();
    if (preset && !WM_PRESETS.includes(preset)) return res.status(400).json({ error: `Unknown preset: ${preset}` });
    const parts = [];
    if (preset) parts.push(`-preset ${preset}`);
    for (const [k, v] of Object.entries(b.modifiers || {})) {
      if (!v) continue;
      if (!WM_MODIFIERS[k]) return res.status(400).json({ error: `Unknown modifier: ${k}` });
      if (!WM_MODIFIERS[k].includes(String(v))) return res.status(400).json({ error: `Invalid value for ${k}: ${v}` });
      parts.push(`-modifier ${k} ${v}`);
    }
    for (const k of b.keys || []) {
      if (!WM_KEYS.includes(k)) return res.status(400).json({ error: `Unknown world key: ${k}` });
      parts.push(`-setkey ${k}`);
    }
    const extra = String(b.extra || '').trim();
    if (extra && !/^[A-Za-z0-9 _.\-]*$/.test(extra)) return res.status(400).json({ error: 'Other launch options contain unsupported characters.' });
    if (extra) parts.push(extra);
    const value = parts.join(' ');
    const out = await applyCfgValues({ worldmodifiers: value });
    if (out.applied) notePending('World modifiers changed');
    res.json({ ...out, value });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ---- Mod config editor (API: /api/configs) ----
//
// BepInEx plugin configs (BepInEx/config/*.cfg). The parser reads the "## description",
// "# Setting type", "# Default value", "# Acceptable values/range" comments the game's
// BepInEx writes above each entry, so the editor can show proper inputs. Edits replace
// only the value on an existing "Key = value" line (comments and layout are untouched)
// and keep a timestamped .bak (newest 5 kept per file). Needs a Stop -> Start to apply.
function bepinexConfigDir() {
  const p = config.paths || {};
  if (p.bepinexConfigDir) return p.bepinexConfigDir;
  if (p.pluginsDir) return path.posix.join(path.posix.dirname(p.pluginsDir), 'config');
  return null;
}
const CFG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ \-]*\.cfg$/;

function parseBepinexCfg(text) {
  const lines = text.split('\n');
  const entries = [];
  let section = '';
  let meta = { desc: [], type: '', def: '', accept: '', range: '' };
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    let m;
    if ((m = line.match(/^\[(.+)\]\s*$/))) { section = m[1]; meta = { desc: [], type: '', def: '', accept: '', range: '' }; return; }
    if (/^\s*$/.test(line)) { meta = { desc: [], type: '', def: '', accept: '', range: '' }; return; }
    if (line.startsWith('##')) { meta.desc.push(line.replace(/^##\s?/, '')); return; }
    if (line.startsWith('#')) {
      if ((m = line.match(/^# Setting type:\s*(.+)$/))) meta.type = m[1].trim();
      else if ((m = line.match(/^# Default value:\s*(.*)$/))) meta.def = m[1].trim();
      else if ((m = line.match(/^# Acceptable values:\s*(.+)$/))) meta.accept = m[1].trim();
      else if ((m = line.match(/^# Acceptable value range:\s*(.+)$/))) meta.range = m[1].trim();
      else meta.desc.push(line.replace(/^#\s?/, ''));
      return;
    }
    if ((m = line.match(/^([^=#\[][^=]*?)\s*=\s?(.*)$/))) {
      entries.push({
        line: idx, section, key: m[1].trim(), value: m[2],
        description: meta.desc.join('\n').trim(), type: meta.type, default: meta.def,
        acceptable: meta.accept ? meta.accept.split(/,\s*/) : null, range: meta.range || null,
      });
      meta = { desc: [], type: '', def: '', accept: '', range: '' };
    }
  });
  return entries;
}

function validateCfgValue(entry, value) {
  const t = (entry.type || '').toLowerCase();
  const v = String(value);
  if (/[\r\n]/.test(v)) return 'Value cannot contain a line break.';
  if (t === 'boolean') return /^(true|false)$/i.test(v) ? null : 'Must be true or false.';
  if (['int32', 'int', 'int64', 'byte', 'uint32', 'uint16'].includes(t)) { if (!/^-?\d+$/.test(v)) return 'Must be a whole number.'; }
  else if (['single', 'float', 'double', 'decimal'].includes(t)) { if (!/^-?\d+([.,]\d+)?(e[+-]?\d+)?$/i.test(v)) return 'Must be a number.'; }
  const rm = entry.range && entry.range.match(/From\s+(-?[\d.eE+-]+)\s+to\s+(-?[\d.eE+-]+)/i);
  if (rm && /^-?\d/.test(v)) {
    const n = parseFloat(v.replace(',', '.'));
    if (n < parseFloat(rm[1]) || n > parseFloat(rm[2])) return `Must be between ${rm[1]} and ${rm[2]}.`;
  }
  if (entry.acceptable && !/flags/i.test(entry.description || '') && entry.acceptable.length && !entry.acceptable.some((a) => a.toLowerCase() === v.trim().toLowerCase())) {
    return `Must be one of: ${entry.acceptable.join(', ')}.`;
  }
  return null;
}

app.get('/api/configs', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    if (!dir) return res.status(400).json({ error: 'paths.pluginsDir (or paths.bepinexConfigDir) is not set in config.json' });
    const r = await sshExec(`find ${shq(dir)} -maxdepth 1 -type f -name '*.cfg' -printf '%f\\t%s\\t%T@\\n' 2>/dev/null | sort -f`);
    const files = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [name, size, mtime] = l.split('\t');
      return { name, size: Number(size), mtime: Math.round(Number(mtime) * 1000) };
    });
    res.json({ dir, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/configs/file', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    const name = String(req.query.name || '');
    if (!dir || !CFG_FILE_RE.test(name)) return res.status(400).json({ error: 'Invalid config file name.' });
    const r = await sshExec(`cat ${shq(`${dir}/${name}`)} 2>/dev/null`);
    if (!r.stdout) return res.status(404).json({ error: `${name} is empty or could not be read.` });
    res.json({ name, entries: parseBepinexCfg(r.stdout) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/configs/file', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    const { name, changes } = req.body || {};
    if (!dir || !CFG_FILE_RE.test(String(name || ''))) return res.status(400).json({ error: 'Invalid config file name.' });
    if (!Array.isArray(changes) || !changes.length) return res.status(400).json({ error: 'No changes.' });
    if (changes.length > 400) return res.status(400).json({ error: 'Too many changes.' });
    const target = `${dir}/${name}`;
    const cur = (await sshExec(`cat ${shq(target)} 2>/dev/null`)).stdout;
    if (!cur) return res.status(404).json({ error: `${name} could not be read.` });
    const entries = parseBepinexCfg(cur);
    const lines = cur.split('\n');
    const crlf = /\r\n/.test(cur);
    let changed = 0;
    for (const c of changes) {
      const e = entries.find((x) => x.section === c.section && x.key === c.key);
      if (!e) return res.status(400).json({ error: `Setting not found: [${c.section}] ${c.key}` });
      const val = String(c.value == null ? '' : c.value);
      const bad = validateCfgValue(e, val);
      if (bad) return res.status(400).json({ error: `[${e.section}] ${e.key}: ${bad}` });
      const old = lines[e.line].replace(/\r$/, '');
      const eq = old.indexOf('=');
      const next = `${old.slice(0, eq).replace(/\s+$/, '')} = ${val}`;
      if (next !== old) { lines[e.line] = next + (crlf ? '\r' : ''); changed++; }
    }
    if (!changed) return res.json({ applied: false, note: 'No changes.' });
    const user = config.lgsmUser || 'vhserver';
    const b64 = Buffer.from(lines.join('\n'), 'utf8').toString('base64');
    const bak = `${target}.bak.${Date.now()}`;
    const cmd = [
      maybeSudo(`cp -p ${shq(target)} ${shq(bak)}`),
      `cd ${shq(`/home/${user}`)} && printf '%s' ${shq(b64)} | base64 -d | sudo -n -u ${shq(user)} tee ${shq(target)} >/dev/null`,
      `(ls -1t ${shq(target)}.bak.* 2>/dev/null | tail -n +6 | while read -r f; do ${maybeSudo('rm -f "$f"')}; done; true)`,
      'echo APPLIED',
    ].join(' && ');
    const out = await sshExec(cmd);
    if (!out.stdout.includes('APPLIED')) return res.status(500).json({ error: `write failed: ${out.stdout} ${out.stderr}` });
    notePending(`Mod config edited: ${name}`);
    res.json({ applied: true, changed, backup: bak, note: 'Saved. Stop and start the server to apply.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Updates ----

app.get('/api/update/check', (req, res) => {
  sshExecStream(`bash ${shq(config.paths.checkUpdateScript)}`, res);
});

app.get('/api/update/apply', (req, res) => {
  sshExecStream(maybeSudo(`bash ${shq(config.paths.applyUpdateScript)}`), res, { idleMs: 600000 });
});

// ---- Mods ----

async function loadEnforcerConfig() {
  if (!config.paths.enforcerYaml) return null;
  const r = await sshExec(`cat ${shq(config.paths.enforcerYaml)} 2>/dev/null`);
  if (!r.stdout.trim()) return null;
  return yaml.load(r.stdout);
}

const OVERRIDES_FILENAME = 'Mods.overrides.yaml';

// Loads Mods.overrides.yaml — the sidecar file next to Mods.yaml that holds
// folderName/ignoreUpdates/thunderstorePackage/hexiumPackage overrides, keyed
// by GUID. NOT read from Mods.yaml itself: ValheimEnforcer deserializes
// Mods.yaml into its own internal model and rewrites the whole file from
// that model on its own (confirmed: happens on every VPS/GUI restart) — it
// only knows its own fields, so any extra key added directly to an entry
// gets silently dropped the next time it does that (real symptom this
// caused: a folderName pin and an ignoreUpdates flag both vanishing on
// every restart). This file is never touched by ValheimEnforcer, so nothing
// it does can ever wipe it. Written by move-mod.py's pin-folder/
// pin-thunderstore/pin-hexium/ignore-updates targets. Fails soft (returns
// {}), same as loadEnforcerConfig().
async function loadOverrides() {
  if (!config.paths.enforcerYaml) return {};
  const overridesPath = path.join(path.dirname(config.paths.enforcerYaml), OVERRIDES_FILENAME);
  try {
    const r = await sshExec(`cat ${shq(overridesPath)} 2>/dev/null`);
    if (!r.stdout.trim()) return {};
    return yaml.load(r.stdout) || {};
  } catch (e) {
    return {};
  }
}

// DLL basenames per top-level installed folder, keyed by that folder's name
// (a nested DLL — some mods ship an extra subfolder layer — still counts
// against its TOP-LEVEL folder). Used ONLY to correlate a folder to its
// Mods.yaml entry (findEnforcerEntry below) — never to resolve package
// identity, since a DLL's filename can be a generic one several unrelated
// packages share (e.g. "BetterUI.dll", "ValheimPlus.dll" — exactly the
// ambiguity fix #3/#5 already solved; package lookup still uses the
// folder's own real name). A DLL's filename is very often the compiled
// assembly's real product name — exactly what Mods.yaml's `name` field is
// read from — even when the folder itself was renamed to something
// unrelated by whoever packaged it for Thunderstore/Hexium. Confirmed real
// case: BepInEx/plugins/AAA_Crafting contains AzuAntiArthriticCrafting.dll,
// an exact match to Mods.yaml's AzuAntiArthriticCrafting entry with zero
// relationship to the folder name itself. Fails soft (returns {}) —
// correlation just falls back to folder-name-only matching.
async function loadDllsByFolder() {
  if (!config.paths.pluginsDir) return {};
  try {
    const r = await sshExec(`find ${shq(config.paths.pluginsDir)} -name '*.dll' -printf '%P\\n' 2>/dev/null`);
    const dllsByFolder = {};
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const slash = line.indexOf('/');
      if (slash < 0) continue;
      const folder = line.slice(0, slash);
      const base = line.slice(slash + 1).split('/').pop().replace(/\.dll$/i, '');
      (dllsByFolder[folder] = dllsByFolder[folder] || []).push(base);
    }
    return dllsByFolder;
  } catch (e) {
    return {};
  }
}

const INSTALLED_FROM_FILENAME = 'Mods.installedFrom.yaml';

// Loads Mods.installedFrom.yaml — a second sidecar file next to Mods.yaml,
// keyed by INSTALLED FOLDER NAME (not GUID, unlike Mods.overrides.yaml — a
// freshly installed mod has no Mods.yaml entry/GUID yet, but its folder
// name is known immediately at install time). Written automatically by
// /api/mods/install below, after every successful install AND update —
// never hand-set. Records exactly {source, owner, name, version}: whichever
// source (thunderstore/hexium), package identity, and version were actually
// chosen and downloaded.
//
// Why this exists: a mod can be published on BOTH platforms under the
// identical owner+name, independently versioned — a confirmed real case:
// OdinHorse, Thunderstore has 1.7.0, Hexium has 1.7.1. Without this record,
// nothing downstream (this file's own getUpdateCandidates, or
// generate-codes.py's find_package_by_folder_name) has any way to tell
// those two packages apart when an exact owner+name match is found on both
// — it just silently picks whichever source's package object happens to
// come first, completely independent of which one was actually installed.
// If the version actually installed isn't published under that
// guessed-wrong source at all, that can mean comparing against — or
// generating a code with — the wrong platform's version entirely. This file
// removes the guessing for any mod the GUI itself installed or updated: the
// exact source+package+version is simply known, not inferred. Fails soft
// (returns {}), same as loadOverrides().
async function loadInstalledFrom() {
  if (!config.paths.enforcerYaml) return {};
  const filePath = path.join(path.dirname(config.paths.enforcerYaml), INSTALLED_FROM_FILENAME);
  try {
    const r = await sshExec(`cat ${shq(filePath)} 2>/dev/null`);
    if (!r.stdout.trim()) return {};
    return yaml.load(r.stdout) || {};
  } catch (e) {
    return {};
  }
}

// Records which exact source+package+version a mod's installed folder was
// just populated from. Read-modify-write over SSH, base64-encoded to avoid
// any shell-quoting risk from the YAML content (same technique as the Setup
// tab's systemd-apply). Best-effort: called fire-and-forget after the
// install's own response has already ended, so a failure here never fails
// the install itself — it just means the next generate-codes.py run/update
// check falls back to folder-name guessing for this one mod, same as
// before this feature existed.
async function saveInstalledFrom(folderName, record, replacesFolderName) {
  if (!config.paths.enforcerYaml) return;
  const filePath = path.join(path.dirname(config.paths.enforcerYaml), INSTALLED_FROM_FILENAME);
  let data = {};
  try {
    const r = await sshExec(`cat ${shq(filePath)} 2>/dev/null`);
    if (r.stdout.trim()) data = yaml.load(r.stdout) || {};
  } catch (e) {
    // Missing/unreadable — start fresh rather than failing the whole save.
  }
  if (replacesFolderName && replacesFolderName !== folderName) delete data[replacesFolderName];
  data[folderName] = record;
  const content = yaml.dump(data);
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  // Written as root, but LinuxGSM refuses to start the server when any file under serverfiles/ is not
  // owned by the game account — so give the file the owner of the folder it sits in.
  const dir = path.dirname(filePath);
  await sshExec(`echo ${shq(b64)} | base64 -d > ${shq(filePath)} && chown --reference=${shq(dir)} ${shq(filePath)}`);
}

// Strip everything but letters/digits and lowercase, so punctuation
// differences (dots vs dashes vs underscores vs spaces) between a Thunderstore
// folder name and Mods.yaml's GUID/display name don't cause a false miss —
// e.g. "goldenrevolver.quick_stack_store" and "goldenrevolver-QuickStack..."
// both normalize to the same run of characters.
// Memoized: update checking normalizes every package name in the (large)
// package lists once per installed mod, so caching the result saves a lot
// of repeated regex work on big mod lists.
const normalizeMemo = new Map();
function normalize(str) {
  const key = str || '';
  let v = normalizeMemo.get(key);
  if (v === undefined) {
    v = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizeMemo.size > 200000) normalizeMemo.clear();
    normalizeMemo.set(key, v);
  }
  return v;
}

// Semantic version comparison, not string equality — "1.113" and "1.113.0"
// are the same version but would never match as raw strings (real bug: a
// mod showing a false "update available" purely from formatting). Returns
// negative if a<b, 0 if equal, positive if a>b. Non-numeric components
// compare as 0, which is good enough for the mod-version-strings we see.
function compareVersions(a, b) {
  let pa = String(a || '').split('.').map((p) => parseInt(p, 10) || 0);
  let pb = String(b || '').split('.').map((p) => parseInt(p, 10) || 0);
  // Some mods' actual running assembly version (what ValheimEnforcer reads
  // into activeMods — the "current version" side of this comparison) keeps
  // an extra leading-zero segment from a 4-part "0.X.Y.Z" internal scheme,
  // while the SAME release is tagged without it on Thunderstore/Hexium (the
  // "latest version" side) — confirmed for real against Grantapher's
  // ValheimPlus fork: its GitHub releases are tagged "0.10.1.2"-style, but
  // the identical release is published on Hexium as plain "10.1.2". Without
  // this, that shows up as a bogus "Required↑ 0.10.1.2 → 10.1.2" — a huge,
  // scary-looking jump for what's actually already the current version.
  // When one side has exactly one extra leading zero segment, drop it
  // before comparing; a real version difference underneath still compares
  // correctly afterward (e.g. 0.10.1.2 vs a genuine newer 10.1.3 still
  // correctly flags an update).
  if (pa.length === pb.length + 1 && pa[0] === 0) pa = pa.slice(1);
  else if (pb.length === pa.length + 1 && pb[0] === 0) pb = pb.slice(1);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findEnforcerEntry(folderName, bucket, overridesByGuid, dllBasenames) {
  if (!bucket) return null;
  const folderNorm = normalize(folderName);
  // Candidate identity strings for THIS installed folder: its own name, plus
  // every DLL basename found inside it. A DLL's filename is very often the
  // compiled assembly's real product name (exactly what Mods.yaml's `name`
  // field is read from), even when the folder itself was renamed to
  // something unrelated by whoever packaged it for Thunderstore/Hexium.
  // Confirmed real case: BepInEx/plugins/AAA_Crafting contains
  // AzuAntiArthriticCrafting.dll — an exact match to Mods.yaml's
  // AzuAntiArthriticCrafting entry, with zero relationship to the folder
  // name itself (verified against 23 real installed mods:
  // 20 resolve via an exact DLL/folder name match, the rest via substring).
  const identityNorms = [folderNorm, ...(dllBasenames || []).map(normalize)].filter(Boolean);
  const MIN_SUBSTRING_LEN = 4; // avoid short fragments matching everything
  let best = null;
  let bestScore = Infinity; // 0 = exact; otherwise the length gap of the closest substring match
  for (const [guid, entry] of Object.entries(bucket)) {
    // An explicit folderName override (Mods.overrides.yaml — see
    // loadOverrides() — set by the GUI's "Link to existing entry" button or
    // move-mod.py's pin-folder) always wins outright. Only needed now for a
    // mod whose folder AND every DLL inside it still fail to correlate.
    const override = (overridesByGuid && overridesByGuid[guid]) || null;
    if (override && override.folderName && normalize(override.folderName) === folderNorm) return { guid, entry };
    const guidNorm = normalize(guid);
    const nameNorm = normalize(entry.name);
    // Exact match on the folder's own name OR any DLL basename inside it
    // wins outright.
    for (const identNorm of identityNorms) {
      if (identNorm === guidNorm || identNorm === nameNorm) return { guid, entry };
    }
    // Otherwise, the same bidirectional substring scoring as before, now
    // checked against the folder name AND every DLL basename inside it
    // (covers a DLL name with an extra/missing prefix word, e.g.
    // "Advize_PlantEverything.dll" for Mods.yaml's "PlantEverything").
    for (const identNorm of identityNorms) {
      if (identNorm.length >= MIN_SUBSTRING_LEN && guidNorm.length >= MIN_SUBSTRING_LEN) {
        if (guidNorm.includes(identNorm) || identNorm.includes(guidNorm)) {
          const score = Math.abs(guidNorm.length - identNorm.length);
          if (score < bestScore) {
            bestScore = score;
            best = { guid, entry };
          }
        }
      }
      if (identNorm.length >= MIN_SUBSTRING_LEN && nameNorm.length >= MIN_SUBSTRING_LEN) {
        if (identNorm.includes(nameNorm) || nameNorm.includes(identNorm)) {
          const score = Math.abs(nameNorm.length - identNorm.length);
          if (score < bestScore) {
            bestScore = score;
            best = { guid, entry };
          }
        }
      }
    }
  }
  return best;
}

function classifyMod(folderName, enforcerCfg, overridesByGuid, dllBasenames) {
  if (!enforcerCfg) return { status: 'unknown', reason: 'ValheimEnforcer config not read', entry: null, guid: null };

  const buckets = [
    ['required', enforcerCfg.requiredMods, 'Listed in requiredMods — clients must have this to connect'],
    ['adminOnly', enforcerCfg.adminOnlyMods, 'Listed in adminOnlyMods — only admins may connect with this'],
    ['serverOnly', enforcerCfg.serverOnlyMods, 'Listed in serverOnlyMods — clients are rejected if they install it'],
    ['optional', enforcerCfg.optionalMods, 'Listed in optionalMods — safe for clients to connect without it'],
  ];

  // activeMods is rebuilt fresh every server start, so it only ever contains
  // entries for what's genuinely loaded right now — a much smaller, more
  // trustworthy target to fuzzy-match against than the category buckets,
  // which can carry a stale leftover entry for a mod that was since replaced
  // (e.g. a fork like "Foo_ForeverMaintained" wrongly matching old "Foo"'s
  // abandoned entry via loose substring matching, since "foo" legitimately
  // is a substring of the fork's name too). Get the TRUE guid from here
  // first, then do an EXACT (non-fuzzy) lookup into the category buckets —
  // no more guessing once the real identity is known.
  const activeMatch = findEnforcerEntry(folderName, enforcerCfg.activeMods, overridesByGuid, dllBasenames);
  if (activeMatch) {
    for (const [status, bucket, reason] of buckets) {
      if (bucket && bucket[activeMatch.guid]) {
        // The bucket entry owns category-relevant/human-set fields (pins,
        // notes, etc.) — but its `version` can go stale (e.g. left over
        // from before a mod was switched to a differently-versioned fork,
        // a real case: a bucket entry still reading "0.10.1.1" from the
        // original mod's 4-part scheme while activeMods, rebuilt from the
        // actually-loaded assembly every server start, correctly shows the
        // installed fork's real "10.1.1"). Prefer activeMods' own version
        // — it's ground truth for what's actually running right now.
        const bucketEntry = bucket[activeMatch.guid];
        const entry = {
          ...bucketEntry,
          version: activeMatch.entry?.version || bucketEntry.version,
          name: bucketEntry.name || activeMatch.entry?.name,
        };
        return { status, reason, entry, guid: activeMatch.guid };
      }
    }
    // Genuinely loaded but not (yet) in any category bucket — use activeMods'
    // own record so at least the version shown is accurate, not stale.
    return {
      status: 'unknown',
      reason: 'Currently loaded but not yet categorized into any bucket',
      entry: activeMatch.entry,
      guid: activeMatch.guid,
    };
  }

  // Nothing in activeMods matched (e.g. installed but the server hasn't
  // restarted since, so it was never detected as loaded) — fall back to
  // fuzzy-matching the category buckets directly, same as before.
  for (const [status, bucket, reason] of buckets) {
    const match = findEnforcerEntry(folderName, bucket, overridesByGuid, dllBasenames);
    if (match) return { status, reason, entry: match.entry, guid: match.guid };
  }
  return { status: 'unknown', reason: 'Not found in Mods.yaml at all yet', entry: null, guid: null };
}

// ---- Package-list cache (Thunderstore + Hexium) ----
//
// The Thunderstore package list is a very large JSON blob, and update
// checking used to be the slowest part of loading the Mods tab by far:
//   1. /api/mods/installed checks every mod IN PARALLEL, and with a cold (or
//      just-expired) cache every one of those parallel checks started its
//      OWN full download of the package list — 40 mods = 40 simultaneous
//      downloads of the same file. Now concurrent callers share one
//      in-flight request.
//   2. After 5 minutes the cache expired and the next page load paid the
//      full download again. Now it's stale-while-revalidate: an expired list
//      is still returned instantly while a fresh copy downloads in the
//      background (the next load picks it up).
//   3. The cache now survives GUI restarts (saved under .cache/ next to
//      server.js) and is warmed at startup, so even the first load after
//      `npm start` is fast.
const PKG_CACHE_DIR = path.join(__dirname, '.cache');
const PKG_FRESH_MS = 15 * 60 * 1000; // younger than this: used without refreshing
const pkgCaches = {}; // key -> { time, data, inflight }

function pkgCacheFile(key) {
  return path.join(PKG_CACHE_DIR, `${key}-packages.v2.json`);
}

function loadPkgCacheFromDisk(key) {
  try {
    const file = pkgCacheFile(key);
    const stat = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data) && data.length) return { time: stat.mtimeMs, data };
  } catch (e) {
    // no cache yet / unreadable — fine
  }
  return null;
}

function savePkgCacheToDisk(key, data) {
  fs.promises
    .mkdir(PKG_CACHE_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(pkgCacheFile(key), JSON.stringify(data)))
    .catch((e) => console.error(`[pkg-cache] could not save ${key} cache:`, e.message));
}

async function cachedPackages(key, fetcher) {
  let c = pkgCaches[key];
  if (!c) {
    c = pkgCaches[key] = loadPkgCacheFromDisk(key) || { time: 0, data: null };
  }
  const refresh = () => {
    if (!c.inflight) {
      const started = Date.now();
      c.inflight = fetcher()
        .then((data) => {
          if (Array.isArray(data) && data.length) {
            c.data = data;
            c.time = Date.now();
            savePkgCacheToDisk(key, data);
            console.log(`[pkg-cache] ${key}: ${data.length} packages in ${Date.now() - started} ms`);
          }
          return c.data || data;
        })
        .finally(() => {
          c.inflight = null;
        });
    }
    return c.inflight;
  };
  if (c.data) {
    if (Date.now() - c.time > PKG_FRESH_MS) refresh().catch((e) => console.error(`[pkg-cache] ${key} refresh failed:`, e.message));
    return c.data;
  }
  return refresh();
}

// Only the fields this file actually reads are kept (owner, name, full_name,
// is_deprecated, versions[].version_number/dependencies, and description/
// downloads for the latest version). The raw Thunderstore listing carries a
// lot more per version (icons, URLs, dates, older descriptions…), which is
// what used to push the dashboard's memory well past 300 MB.
function slimPackage(p) {
  const versions = (p.versions || []).map((v, i) => {
    const out = { version_number: v.version_number, dependencies: v.dependencies || [] };
    if (i === 0) {
      out.description = v.description;
      out.downloads = v.downloads;
    }
    return out;
  });
  return { owner: p.owner, name: p.name, full_name: p.full_name, is_deprecated: !!p.is_deprecated, versions };
}

// Streams a (very large) top-level JSON array and parses it one element at a
// time, so memory never holds the whole multi-hundred-MB document at once.
async function fetchJsonArrayStreaming(url, mapFn) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    let start = depth >= 1 ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === 92) escaped = true; // backslash
        else if (ch === 34) inString = false; // "
        continue;
      }
      if (ch === 34) {
        inString = true;
      } else if (ch === 123 || ch === 91) {
        // { or [
        depth++;
        if (depth === 2) start = i; // an element of the top-level array begins
      } else if (ch === 125 || ch === 93) {
        // } or ]
        if (depth === 2) {
          pieces.push(text.slice(start, i + 1));
          const item = mapFn(JSON.parse(pieces.join('')));
          if (item) out.push(item);
          pieces = [];
          start = -1;
        }
        depth--;
      }
    }
    if (depth >= 2 && start >= 0) pieces.push(text.slice(start));
    else if (depth >= 2) pieces.push(text);
  }
  return out;
}

async function getThunderstorePackages() {
  return cachedPackages('thunderstore', () =>
    fetchJsonArrayStreaming(`https://thunderstore.io/c/${config.thunderstoreCommunity}/api/v1/package/`, slimPackage)
  );
}

// ---- Hexium (thunderstore.io alternative — https://hexium.gg) ----
//
// Hexium doesn't expose Thunderstore's old flat `/api/v1/package/` listing.
// Its public data comes from the same chunked/gzip "package-listing-index"
// scheme Thunderstore itself now uses under the hood for its official mod
// managers: a gzip'd JSON array of chunk URLs, each chunk itself a gzip'd
// JSON array of packages. Each package's `full_name` is a bare
// "Owner-Name" string (not separate fields) and each of its versions'
// `full_name` is "Owner-Name-Version" — normalizeHexiumPackage() below
// converts both into the same flat { owner, name, versions: [{version_number,
// ...}] } shape the rest of this file already expects from Thunderstore, so
// every existing matcher (search, update-checking, dependency parsing) works
// unmodified against either source.
function normalizeHexiumPackage(raw) {
  const fullName = raw.full_name || '';
  const dash = fullName.indexOf('-');
  const owner = dash >= 0 ? fullName.slice(0, dash) : fullName;
  const name = dash >= 0 ? fullName.slice(dash + 1) : '';
  const versionPrefix = `${owner}-${name}-`;
  const versions = (raw.versions || []).map((v) => {
    const vFull = v.full_name || '';
    const version_number = vFull.startsWith(versionPrefix) ? vFull.slice(versionPrefix.length) : vFull.split('-').pop() || '';
    return {
      version_number,
      description: v.description,
      downloads: v.downloads,
      // Dependency idents ("Owner-Name-Version") are the exact same string
      // format Thunderstore uses — parseDependencyString() below handles both.
      dependencies: v.dependencies || [],
    };
  });
  return {
    owner,
    name,
    full_name: fullName,
    is_deprecated: !!raw.is_deprecated,
    versions,
  };
}

async function fetchHexiumPackages() {
  const indexUrl = `https://${config.thunderstoreCommunity}.hexium.gg/api/v1/package-listing-index/`;
  const idxRes = await fetch(indexUrl);
  if (!idxRes.ok) throw new Error(`index HTTP ${idxRes.status}`);
  const idxBuf = Buffer.from(await idxRes.arrayBuffer());
  const chunkUrls = JSON.parse(zlib.gunzipSync(idxBuf).toString('utf8'));
  const chunkResults = await Promise.all(
    chunkUrls.map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`chunk HTTP ${r.status} for ${u}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    })
  );
  return chunkResults.flat().map((raw) => slimPackage(normalizeHexiumPackage(raw)));
}

async function getHexiumPackages() {
  try {
    return await cachedPackages('hexium', fetchHexiumPackages);
  } catch (e) {
    // Fail soft: Hexium being unreachable/misconfigured for this community
    // should never take Thunderstore search/updates down with it — just
    // means Hexium results won't show up until the next successful fetch.
    console.error('Hexium package fetch failed:', e.message);
    return [];
  }
}

// Dispatches to whichever source's package list was asked for. 'thunderstore'
// is the default everywhere a caller doesn't specify — matches this GUI's
// behavior before Hexium support existed.
async function getPackages(source) {
  return source === 'hexium' ? getHexiumPackages() : getThunderstorePackages();
}

function buildDownloadUrl(source, namespace, pkgName, version) {
  if (source === 'hexium') {
    return `https://cdn.hexium.gg/uploads/${namespace}/${pkgName}/${version}.zip`;
  }
  return `https://thunderstore.io/package/download/${namespace}/${pkgName}/${version}/`;
}

function modPageUrl(source, namespace, name) {
  if (source === 'hexium') {
    return `https://${config.thunderstoreCommunity}.hexium.gg/mods/${namespace}/${name}`;
  }
  return `https://thunderstore.io/c/${config.thunderstoreCommunity}/p/${namespace}/${name}/`;
}

// Gale's own deep-link scheme (gale://install/<backend>/<owner>/<name>/<version>)
// — clicking one of these, if Gale is installed, opens Gale and installs that
// exact mod/version directly. Works for both backends Gale supports.
function galeInstallLink(source, namespace, name, version) {
  return `gale://install/${source}/${namespace}/${name}/${version}`;
}

// Installed mod folder names always follow Thunderstore's own
// "Owner-PackageName" convention (every mod manager — r2modman, Gale,
// Thunderstore's own CLI — writes plugin folders this way), and Thunderstore
// usernames can never contain a dash, so splitting on the FIRST dash always
// separates the real owner from the real package name correctly, even when
// the package name itself has more dashes in it. That makes the folder name
// a far more reliable identity than Mods.yaml's cosmetic display `name`
// field, which is often generic ("Valheim Plus") and can collide with a
// same-or-similar-named but unrelated package — the exact failure mode
// behind two real cases: "BetterUI_ForeverMaintained-BetterUI_ForeverMaintained"
// matching some other "BetterUI"-named package with an older version (shown
// as a false "unverifiable match" regression), and
// "Grantapher-ValheimPlus_Grantapher_Temporary" (a specific community fork)
// matching an unrelated "ValheimPlus" package instead of Grantapher's own,
// producing a version jump that looked like an update but wasn't actually
// checking the installed fork's real version history at all.
function parseFolderIdentity(folderName) {
  // Folders written by Gale/r2modman/this GUI's installer are
  // "Owner-PackageName-Version" (e.g. "MidnightMods-ValheimCommunityPatch-0.30.0").
  // Strip a trailing dotted-number version first — otherwise the "name" half
  // becomes "ValheimCommunityPatch-0.30.0", which never matches any real
  // package name, so update-checking silently found nothing for every
  // version-suffixed folder. (Mirrors generate-codes.py's parse_folder_strict.)
  let base = folderName || '';
  const m = base.match(/^(.*)-(\d+(?:\.\d+){1,3})$/);
  if (m && m[1].includes('-')) base = m[1];
  const idx = base.indexOf('-');
  if (idx <= 0) return null;
  return { owner: base.slice(0, idx), name: base.slice(idx + 1) };
}

// Thunderstore's community feed (/c/<community>/api/v1/package/) does NOT
// list every package that can be installed by dependency string — e.g.
// MidnightMods-ValheimCommunityPatch is installable but absent from the
// valheim feed, so a feed-only lookup finds no package and therefore no
// update, ever. When an exact owner+name isn't in the feed, ask Thunderstore
// for that one package directly. Cached 30 min (including misses).
const exactPkgCache = new Map();
async function fetchExactPackage(source, owner, name) {
  const key = `${source}:${owner}/${name}`.toLowerCase();
  const hit = exactPkgCache.get(key);
  if (hit && Date.now() - hit.time < 30 * 60 * 1000) return hit.pkg;
  let pkg = null;
  try {
    // Hexium runs the same package API as Thunderstore (its bulk listing uses
    // Thunderstore's own chunked package-listing-index scheme), so the same
    // per-package endpoint is tried there. If Hexium doesn't serve it, this
    // just misses (cached) and callers fall back to the bulk list.
    const base = source === 'hexium' ? `https://${config.thunderstoreCommunity}.hexium.gg` : 'https://thunderstore.io';
    const r = await fetch(`${base}/api/experimental/package/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/`, {
      headers: { 'User-Agent': 'curl/8.5.0' },
    });
    if (r.ok) {
      const raw = await r.json();
      let versions = raw.versions && raw.versions.length ? raw.versions : raw.latest ? [raw.latest] : [];
      // Make sure the newest version is first (everything downstream reads versions[0]).
      if (raw.latest && raw.latest.version_number) {
        versions = [raw.latest, ...versions.filter((v) => v.version_number !== raw.latest.version_number)];
      }
      // Hexium-style entries may carry only full_name ("Owner-Name-1.2.3").
      versions = versions
        .map((v) => ({ ...v, version_number: v.version_number || (v.full_name ? v.full_name.split('-').pop() : undefined) }))
        .filter((v) => v.version_number);
      if (versions.length) pkg = slimPackage({ ...raw, owner: raw.owner || owner, name: raw.name || name, versions });
    }
  } catch (e) {
    // network failure: cache the miss briefly via the same map below
  }
  exactPkgCache.set(key, { time: Date.now(), pkg });
  return pkg;
}

function fetchExactThunderstorePackage(owner, name) {
  return fetchExactPackage('thunderstore', owner, name);
}

// Thunderstore's bulk community feed (what getThunderstorePackages() caches)
// lags behind new releases — a version can be live on the package page and via
// the per-package API for a long while before the feed lists it, so a
// feed-only check silently misses fresh updates (real case: OdinArchitect
// 1.7.7 on Hexium's list and Thunderstore's page, but Thunderstore's feed
// still said 1.7.6). For a package we're about to compare on Thunderstore,
// ask the live per-package endpoint too (cached 30 min) and use it when it
// is newer than what the feed says. Never downgrades, never changes source.
async function freshenPackage(source, feedMatch, owner, name) {
  try {
    const fresh = await fetchExactPackage(source, owner, name);
    const freshLatest = fresh && fresh.versions[0] && fresh.versions[0].version_number;
    if (!freshLatest) return feedMatch;
    const feedLatest = feedMatch && feedMatch.versions[0] && feedMatch.versions[0].version_number;
    if (!feedLatest || compareVersions(freshLatest, feedLatest) > 0) return fresh;
  } catch (e) {
    // fall through to the feed's answer
  }
  return feedMatch;
}

// Checks BOTH sources for a possible update and returns one candidate per
// Hexium ONLY, deliberately — not "whichever source has a name match".
//
// Checking both sources was the root cause behind a whole class of bad
// update badges (BetterUI/ValheimPlus in fix #3/#5, then
// ValheimModding-YamlDotNet jumping "1.0.0 → 16.3.1" and
// Grantapher-ValheimPlus_Grantapher_Temporary showing "0.10.1.2 → 10.1.2"):
// Thunderstore and Hexium each independently host packages under the same
// display names/owners, sometimes completely unrelated ones, and no amount
// of exact-owner+name matching removes that ambiguity when the SAME
// owner+name pair can exist as two different, independently-versioned
// packages on the two platforms. Checking exactly one canonical source
// removes that ambiguity outright instead of trying to disambiguate after
// the fact. The maintainer's mods are being kept uniformly on Hexium going forward,
// so that's the one source of truth for "what's the latest version" here.
//
// This does NOT affect installing/searching for a brand-new mod (the Mods
// tab's search still covers both sources) — only the automatic
// update-checking path (the "Update available" badge, bulk update, and
// what /api/mods/installed reports), since that's specifically where a
// same-name-different-package mismatch silently misleads rather than being
// a deliberate choice the person is making in the moment.
async function getUpdateCandidates(displayName, currentVersion, guidHint, folderName, pins, installedFrom) {
  if (!displayName || !currentVersion) return [];
  const displayNorm = normalize(displayName);
  const guidOwnerGuess = guidHint ? normalize(guidHint.split('.')[0]) : null;
  const folderIdentity = parseFolderIdentity(folderName);
  const out = [];

  // Strongest signal of all, checked before the hexium/thunderstore loop
  // below even runs: installedFrom (Mods.installedFrom.yaml — see
  // loadInstalledFrom/saveInstalledFrom above) records the EXACT
  // source+owner+name this mod was actually installed/updated from, written
  // automatically every time that happens — not inferred from a folder name
  // that can exist on both platforms under the identical owner+name with
  // different, independently-versioned histories (confirmed real case:
  // OdinHorse — Thunderstore 1.7.0, Hexium 1.7.1). When present, and no
  // manual pin overrides it (a human-set pin still wins outright — see the
  // per-source pin check inside the loop below), this checks ONLY the one
  // source it was actually installed from, for that exact owner+name — no
  // ambiguity, and no risk of comparing against, or later re-downloading,
  // the wrong platform's version.
  const hasPin = pins && (pins.hexium || pins.thunderstore);
  if (!hasPin && installedFrom && installedFrom.owner && installedFrom.name &&
      (installedFrom.source === 'hexium' || installedFrom.source === 'thunderstore')) {
    try {
      const pkgs = await getPackages(installedFrom.source);
      const ownerNorm = normalize(installedFrom.owner);
      const nameNorm = normalize(installedFrom.name);
      let match = pkgs.find((p) => !p.is_deprecated && normalize(p.owner) === ownerNorm && normalize(p.name) === nameNorm);
      match = await freshenPackage(installedFrom.source, match, installedFrom.owner, installedFrom.name);
      const latest = match && match.versions[0]?.version_number;
      if (latest) {
        const regression = compareVersions(latest, currentVersion) < 0;
        return [
          {
            source: installedFrom.source,
            latestVersion: latest,
            namespace: match.owner,
            packageName: match.name,
            updateAvailable: !regression && compareVersions(latest, currentVersion) !== 0,
            ambiguous: false,
            pinned: false,
            installedFromRecord: true, // surfaced so the GUI can show "matched via install record" instead of "double check this one"
            versionRegression: regression,
          },
        ];
      }
      // Recorded package no longer resolves on its recorded source (removed
      // or renamed upstream?) — fall through to the normal matching cascade
      // below instead of giving up outright.
    } catch (e) {
      // getPackages() erroring here shouldn't block falling back below.
    }
  }

  // Hexium first, Thunderstore only as a fallback when a mod has NO match
  // there at all — not a re-introduction of fix #6's original per-mod
  // ambiguity (both sources listing the same owner+name), but a fix for a
  // different, real gap fix #6 introduced: a mod that simply isn't
  // published on Hexium (e.g. ValheimEnforcer — confirmed Thunderstore-only,
  // never mirrored there) got silently zero update candidates forever, not
  // just an occasional false "update available" from a cross-source
  // collision. The `break` below is what preserves fix #6's actual intent:
  // once a source produces a real match, later sources are never consulted,
  // so a mod present on both still resolves to exactly one canonical result
  // (Hexium's), with Thunderstore only ever used for mods Hexium has none
  // of.
  for (const source of ['hexium', 'thunderstore']) {
    let pkgs;
    try {
      pkgs = await getPackages(source);
    } catch (e) {
      continue; // this source erroring shouldn't block falling back to the other
    }

    // Highest priority: an explicit hexiumPackage/thunderstorePackage pin on
    // this mod's Mods.yaml entry — the same "Owner-PackageName-Version" pin
    // format generate-codes.py already trusts completely (it skips fuzzy
    // matching entirely for a pinned mod). A pin is a human saying "I've
    // verified this is the exact right package" — stronger evidence than
    // even the installed folder's own name, so it wins outright when
    // present.
    let match = null;
    let ambiguous = false;
    let pinned = false;
    const pin = pins && pins[source];
    if (pin) {
      const { owner: pinOwner, name: pinName } = parseDependencyString(pin);
      const pinOwnerNorm = normalize(pinOwner);
      const pinNameNorm = normalize(pinName);
      match =
        pkgs.find((p) => !p.is_deprecated && normalize(p.owner) === pinOwnerNorm && normalize(p.name) === pinNameNorm) ||
        null;
      pinned = !!match;
    }

    // Next: the plugin folder's own owner+name is exactly how this mod was
    // actually installed, so an exact match against it can never point at
    // the wrong package the way a cosmetic-name-only match can. Only fall
    // back to fuzzy matching below when neither a pin nor that exact
    // owner+name is found (e.g. renamed, removed, or the folder doesn't
    // follow the Owner-Name convention).
    if (!match && folderIdentity) {
      const ownerNorm = normalize(folderIdentity.owner);
      const nameNorm = normalize(folderIdentity.name);
      match =
        pkgs.find((p) => !p.is_deprecated && normalize(p.owner) === ownerNorm && normalize(p.name) === nameNorm) || null;
      // Not in this source's feed — for Thunderstore, ask for the exact
      // package directly (see fetchExactThunderstorePackage). Only when the
      // Hexium pass already came up empty, so Hexium stays preferred.
      if (!match && source === 'thunderstore') {
        match = await fetchExactThunderstorePackage(folderIdentity.owner, folderIdentity.name);
      }
    }

    // Next: the WHOLE folder name as an exact match against a package's own
    // `name` field — covers the confirmed real case where an installed
    // folder has NO owner prefix at all (e.g. "AAA_Crafting" rather than
    // "Azumatt-AAA_Crafting"), which parseFolderIdentity() can't split on a
    // dash it doesn't have, so folderIdentity is null for these and the
    // owner+name check above never runs. This is exactly what fixed the
    // same acronym-vs-cosmetic-name problem (AzuAntiArthriticCrafting vs.
    // AAA_Crafting) for generate-codes.py's code generation — see fix #21
    // and its find_package_by_folder_name() — applied here too so update-
    // checking benefits the same way, without needing a separate
    // thunderstorePackage/hexiumPackage pin on top of the folderName one.
    if (!match && folderName) {
      const wholeFolderNorm = normalize(folderName);
      if (wholeFolderNorm) {
        const exact = pkgs.filter((p) => !p.is_deprecated && normalize(p.name) === wholeFolderNorm);
        if (exact.length === 1) {
          match = exact[0];
        } else if (exact.length > 1) {
          const owned = guidOwnerGuess ? exact.find((p) => normalize(p.owner) === guidOwnerGuess) : null;
          match = owned || exact[0];
          ambiguous = !owned;
        }
      }
    }

    if (!match) {
      // Normalized match, not exact string equality: Mods.yaml's "name"
      // field is a cosmetic display name (often pulled from the assembly's
      // product name, e.g. "Valheim Plus" with a space) while a package's
      // `name` is always a slug with no spaces (e.g. "ValheimPlus") — an
      // exact match would never find it, silently hiding real available
      // updates.
      const candidates = pkgs.filter((p) => !p.is_deprecated && normalize(p.name) === displayNorm);
      if (!candidates.length) continue;

      match = candidates[0];
      ambiguous = candidates.length > 1;
      if (candidates.length > 1 && guidOwnerGuess) {
        // Multiple authors can publish a package with the same display name
        // — grabbing the first one blindly can point an update at a
        // completely unrelated package/owner. Prefer whichever candidate's
        // owner resembles the mod's actual GUID prefix (e.g. "MidnightsFX"
        // from "MidnightsFX.NetworkPerformanceSystem").
        const better = candidates.find((p) => {
          const candOwnerNorm = normalize(p.owner);
          return candOwnerNorm === guidOwnerGuess || candOwnerNorm.includes(guidOwnerGuess) || guidOwnerGuess.includes(candOwnerNorm);
        });
        if (better) match = better;
      }
    }

    match = await freshenPackage(source, match, match.owner, match.name);
    const latest = match.versions[0]?.version_number;
    if (!latest) continue;

    // Version regression check: a legitimate "latest available version"
    // should essentially never be LOWER than what's already recorded as
    // running — if it is, this match is very likely a different, unrelated
    // mod that just happens to share a name (confirmed real cases: an
    // abandoned original mod's name colliding with an unrelated package,
    // or an unofficial reupload under a numbered owner). Suppress the
    // misleading "update available" badge in that case rather than
    // implying a downgrade is a real update. Kept even for an exact
    // folder-identity match as a sanity check (e.g. a genuine rollback).
    const regression = compareVersions(latest, currentVersion) < 0;

    out.push({
      source,
      latestVersion: latest,
      namespace: match.owner,
      packageName: match.name,
      // Semantic comparison, not raw string equality — "1.113" and "1.113.0"
      // are the same version, but would never match as strings, causing a
      // false "update available" badge for something already up to date.
      updateAvailable: !regression && compareVersions(latest, currentVersion) !== 0,
      ambiguous, // surfaced so the GUI can flag "double check this one"
      pinned, // surfaced so the GUI can show "verified via pin" instead of "double check this one"
      versionRegression: regression, // surfaced so the GUI can flag "this match is probably wrong"
    });
    break; // got a real match from this source — don't also check the next one (see comment above the loop)
  }
  return out;
}

async function getUpdateInfo(displayName, currentVersion, guidHint, folderName, pins, installedFrom) {
  try {
    const candidates = await getUpdateCandidates(displayName, currentVersion, guidHint, folderName, pins, installedFrom);
    if (!candidates.length) return null;
    // "best" keeps the response shape backward-compatible for anything that
    // reads mod.update directly (the update badge, bulk-update). Only ever
    // one candidate now — getUpdateCandidates stops at the first source that
    // has a real match (Hexium preferred, Thunderstore as fallback) — but
    // `candidates` stays an array so the add/update prompt's rendering
    // doesn't need to change shape.
    const best = candidates.find((c) => c.updateAvailable) || candidates[0];
    return { ...best, candidates };
  } catch (e) {
    return null;
  }
}

app.get('/api/mods/installed', async (req, res) => {
  try {
    // ?updates=0 skips the (slow, network-bound) update check entirely so
    // the list itself can render immediately; the GUI then asks again with
    // updates on and fills in the update badges when that returns.
    res.json(await listInstalledMods(req.query.updates !== '0'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Library packages (e.g. ValheimModding-YamlDotNet) ship a tiny detector plugin whose
// internal version never changes (always "1.0.0"), so comparing ValheimEnforcer's
// reported version against the latest release flags a permanent false "update".
// The GUI installs every package into a folder named Author-Name-<version>, which
// IS the real package version: if that is already >= the latest release, it is up to date.
// This only ever suppresses a false positive; it never creates an update.
function folderVersionOf(folderName) {
  const m = /-(\d+\.\d+(?:\.\d+){0,2})$/.exec(String(folderName || ''));
  return m ? m[1] : null;
}
function settleUpdateWithFolderVersion(update, folderName) {
  const fv = folderVersionOf(folderName);
  if (!update || !update.updateAvailable || !fv) return update;
  if (compareVersions(fv, update.latestVersion) < 0) return update;
  const settled = (c) => ({ ...c, updateAvailable: false, settledByFolderVersion: fv });
  return { ...settled(update), candidates: (update.candidates || []).map(settled) };
}

// Shared by the route above and the scheduled update check.
async function listInstalledMods(withUpdates) {
  {
    // All five remote reads run at the same time over the shared SSH
    // connection (previously: one after another, each on a new connection).
    const [r, enforcerCfg, overridesByGuid, dllsByFolder, installedFromByFolder] = await Promise.all([
      sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`),
      loadEnforcerConfig().catch(() => null), // Non-fatal
      loadOverrides(),
      loadDllsByFolder(),
      loadInstalledFrom(),
      // Kick off the package-list downloads in parallel with the SSH reads
      // (cached/shared — see cachedPackages) rather than after them.
      withUpdates ? getHexiumPackages().catch(() => null) : null,
      withUpdates ? getThunderstorePackages().catch(() => null) : null,
    ]);
    const folders = r.stdout.split('\n').filter(Boolean);
    const mods = await Promise.all(
      folders.map(async (name) => {
        const { status, reason, entry, guid } = classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
        // thunderstorePackage/hexiumPackage/ignoreUpdates all come from
        // Mods.overrides.yaml now, never the Mods.yaml entry itself — see
        // loadOverrides() for why.
        const override = (guid && overridesByGuid[guid]) || null;
        const pins = { thunderstore: override?.thunderstorePackage, hexium: override?.hexiumPackage };
        // ignoreUpdates (set via /api/mods/ignore-updates below) skips the
        // update check entirely rather than just hiding the badge — for a
        // mod like ValheimModding-YamlDotNet's detector plugin, which always
        // reports a stale bundled-assembly version and so flags a permanent,
        // uninteresting "update available" that's never worth acting on.
        const ignoreUpdates = !!(override && override.ignoreUpdates);
        // installedFrom (Mods.installedFrom.yaml — see loadInstalledFrom
        // above) records the exact source this specific folder was actually
        // installed/updated from, so update-checking compares against that
        // same source instead of guessing between Thunderstore and Hexium.
        const update = entry && !ignoreUpdates && withUpdates
          ? settleUpdateWithFolderVersion(await getUpdateInfo(entry.name, entry.version, entry.pluginID, name, pins, installedFromByFolder[name]), name)
          : null;
        // pins/guid are already computed above (guid via classifyMod, pins
        // for update-checking) but neither was actually returned to the
        // client before — both needed now so the GUI can show current pin
        // state, offer Unpin, and target /api/mods/pin-package by guid
        // instead of only ever having the folder name to work with.
        return { name, status, reason, currentVersion: entry?.version || null, update, ignoreUpdates, pins, guid: guid || null };
      })
    );
    return { mods, enforcerRead: !!enforcerCfg, updatesChecked: withUpdates };
  }
}

// Subsequence fuzzy match: every character of the query must appear in the
// target in order, but not necessarily contiguously — so "azuclok" still
// finds "AzuClock", "qkstack" still finds "Quick Stack...". Lower score is a
// tighter match (characters closer together, matched earlier); used both to
// filter (null = no match at all) and to rank results.
function fuzzyScore(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatch >= 0 ? ti - lastMatch - 1 : ti;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

app.get('/api/mods/search', async (req, res) => {
  const q = req.query.q || '';
  // 'thunderstore' | 'hexium' | 'both' (default) — the search box searches
  // both sources at once so the Install prompt can offer a real choice.
  const sourceParam = req.query.source === 'thunderstore' || req.query.source === 'hexium' ? req.query.source : 'both';
  const sources = sourceParam === 'both' ? ['thunderstore', 'hexium'] : [sourceParam];
  try {
    const scored = [];
    for (const source of sources) {
      let data;
      try {
        data = await getPackages(source);
      } catch (e) {
        continue; // one source erroring shouldn't kill results from the other
      }
      data
        .filter((p) => !p.is_deprecated) // never surface deprecated mods to install
        .forEach((p) => {
          // Best (lowest) score across name and full_name, whichever the
          // query matches better against.
          const nameScore = fuzzyScore(q, p.name);
          const fullScore = fuzzyScore(q, p.full_name);
          const scores = [nameScore, fullScore].filter((s) => s !== null);
          if (!scores.length) return;
          scored.push({
            score: Math.min(...scores),
            source,
            name: p.name,
            namespace: p.owner,
            full_name: p.full_name,
            version: p.versions[0]?.version_number,
            versionCount: p.versions.length,
            description: p.versions[0]?.description,
            downloads: p.versions[0]?.downloads,
          });
        });
    }
    scored.sort((a, b) => a.score - b.score);
    res.json({ results: scored.slice(0, 25) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All published versions of one exact package, for the Install/Update
// prompt's version picker. Pulled from the already-cached package list, so
// this is just a lookup, no extra network round trip.
app.get('/api/mods/package-versions', async (req, res) => {
  const { source, namespace, name } = req.query;
  if (!namespace || !name) return res.status(400).json({ error: 'missing namespace/name' });
  const src = source === 'hexium' ? 'hexium' : 'thunderstore';
  try {
    const data = await getPackages(src);
    const pkg = data.find((p) => p.owner === namespace && p.name === name);
    if (!pkg) return res.json({ versions: [], deprecated: false });
    res.json({
      deprecated: !!pkg.is_deprecated,
      versions: pkg.versions.map((v) => ({ version: v.version_number, downloads: v.downloads, description: v.description })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Which source(s)/owner(s) a mod display name is available under, across
// BOTH Thunderstore and Hexium — powers the "switch source" control in the
// Install/Update prompt (e.g. a mod moved to Hexium-only, or is published
// independently under different owners on each).
app.get('/api/mods/package-sources', async (req, res) => {
  const displayName = req.query.name;
  const guidHint = req.query.guidHint;
  if (!displayName) return res.status(400).json({ error: 'missing name' });
  try {
    const displayNorm = normalize(displayName);
    const guidOwnerGuess = guidHint ? normalize(guidHint.split('.')[0]) : null;
    const out = {};
    for (const source of ['thunderstore', 'hexium']) {
      let data;
      try {
        data = await getPackages(source);
      } catch (e) {
        data = [];
      }
      const candidates = data.filter((p) => !p.is_deprecated && normalize(p.name) === displayNorm);
      out[source] = candidates
        .map((p) => ({
          namespace: p.owner,
          name: p.name,
          guidLikely: guidOwnerGuess ? normalize(p.owner) === guidOwnerGuess || normalize(p.owner).includes(guidOwnerGuess) : false,
          versions: p.versions.map((v) => v.version_number),
        }))
        .sort((a, b) => (b.guidLikely ? 1 : 0) - (a.guidLikely ? 1 : 0));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Checks a mod's Thunderstore-declared dependencies against what's actually
// installed, so the GUI can warn before installing something that will
// silently fail to work without them (Thunderstore mod managers auto-resolve
// this; this GUI doesn't install the dependency chain for you, just flags
// what's missing so it's a decision, not a surprise).
function parseDependencyString(dep) {
  // Format: Owner-PackageName-Major.Minor.Patch (package name itself may
  // contain hyphens, so parse from both ends rather than a fixed split).
  const parts = dep.split('-');
  const owner = parts[0];
  const version = parts[parts.length - 1];
  const name = parts.slice(1, -1).join('-');
  return { owner, name, version };
}

app.get('/api/mods/dependencies', async (req, res) => {
  const { namespace, name, version, source } = req.query;
  if (!namespace || !name || !version) return res.status(400).json({ error: 'missing fields' });
  try {
    const packages = await getPackages(source === 'hexium' ? 'hexium' : 'thunderstore');
    const pkg = packages.find((p) => p.owner === namespace && p.name === name);
    if (!pkg) return res.json({ dependencies: [] });
    const versionEntry = pkg.versions.find((v) => v.version_number === version) || pkg.versions[0];
    const deps = (versionEntry && versionEntry.dependencies) || [];

    const r = await sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`);
    const installedFolders = r.stdout.split('\n').filter(Boolean);
    const installedNorms = installedFolders.map(normalize);

    const parsed = deps
      .map(parseDependencyString)
      // BepInExPack itself is always "installed" by definition (it's the
      // framework everything runs under) — never worth flagging as missing.
      .filter((d) => !/bepinexpack/i.test(d.name))
      .map((d) => {
        const depNorm = normalize(d.name);
        const installed = installedNorms.some((f) => f === depNorm || f.includes(depNorm) || depNorm.includes(f));
        return { ...d, installed };
      });

    res.json({ dependencies: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mods/install', async (req, res) => {
  const { namespace, name, version, packageName, source } = req.body;
  if (!namespace || !name || !version) return res.status(400).json({ error: 'missing fields' });
  const src = source === 'hexium' ? 'hexium' : 'thunderstore';
  const sourceLabel = src === 'hexium' ? 'Hexium' : 'Thunderstore';
  // `name` is the LOCAL FOLDER to write into (preserved as-is so updating a
  // mod overwrites its existing folder, whatever it's called). `packageName`
  // is the actual package slug for the download URL — these can differ,
  // e.g. a mod originally installed with an "Owner-PackageName" folder
  // convention. Conflating them (using `name` for both) built a
  // doubly-prefixed, nonexistent URL for exactly that case — curl -f then
  // failed instantly and silently, which looked identical to a hang since
  // nothing downstream ever got a chance to print an error.
  const pkgName = packageName || name;
  const downloadUrl = buildDownloadUrl(src, namespace, pkgName, version);
  const tmp = `/tmp/modinstall_${name}_$$`;

  // Keep the version in the folder name current on updates. A folder written
  // as "Owner-Package-<oldVersion>" (the fresh-install convention, see
  // app.js) is renamed to "Owner-Package-<newVersion>" when it's updated, so
  // the folder no longer keeps advertising a stale version (which also
  // misled generate-codes.py's strict folder-name parse). Only renames when
  // the folder's prefix is exactly this package's Owner-Package (never a
  // hand-named or differently-owned folder) and its version suffix differs,
  // and never when a Mods.overrides.yaml folderName pin points at the old
  // name (renaming would silently break that pin). Files are moved, not
  // re-created, so anything a mod keeps inside its own folder survives.
  let finalName = name;
  const verSuffix = name.match(/^(.+)-(\d+(?:\.\d+){1,3})$/);
  if (verSuffix && verSuffix[2] !== version && verSuffix[1].toLowerCase() === `${namespace}-${pkgName}`.toLowerCase()) {
    let pinned = false;
    try {
      const ovr = await loadOverrides();
      pinned = Object.values(ovr || {}).some((o) => o && o.folderName && normalize(o.folderName) === normalize(name));
    } catch (e) {
      pinned = true; // can't tell — safer to keep the old folder name
    }
    if (!pinned) finalName = `${verSuffix[1]}-${version}`;
  }
  const plug = config.paths.pluginsDir;
  const cmd = [
    `\\rm -rf ${shq(tmp)}`,
    `mkdir -p ${shq(tmp)}`,
    // No -f here (unlike before): curl -f fails silently on a bad URL with
    // zero output, which skipped every diagnostic check below it. Without
    // -f, a 404/error page still gets saved to mod.zip, and our own checks
    // (empty file, not a real zip) catch it with an actual clear message.
    `curl -sL --connect-timeout 15 --max-time 120 -w "HTTP_STATUS:%{http_code}\\n" ${shq(downloadUrl)} -o ${shq(tmp)}/mod.zip`,
    `if [ ! -s ${shq(tmp)}/mod.zip ]; then echo "[error] downloaded file is empty — check ${namespace}/${pkgName}/${version} actually exists on ${sourceLabel} (URL: ${downloadUrl})"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `if ! head -c 2 ${shq(tmp)}/mod.zip | grep -q PK; then echo "[error] downloaded file is not a valid zip — ${sourceLabel} returned something else for this namespace/name/version combo (URL: ${downloadUrl})"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // unzip's own exit codes: 0 = clean, 1 = WARNINGS ONLY (extraction still
    // succeeded — e.g. "appears to use backslashes as path separators",
    // common for a mod zipped on Windows), 2+ = a real failure. Every other
    // step in this chain is joined with `&&`, so without this check a mere
    // warning (exit 1) silently aborted the whole install right here — curl
    // had already succeeded, unzip had already extracted the mod correctly,
    // but the plugin folder never got copied into place and no [error] ever
    // printed, because everything after this line simply never ran. Real
    // case: ValheimModding-Jotunn's zip triggers exactly this warning.
    `cd ${shq(tmp)} && unzip -oq mod.zip -d extracted; UNZIP_EC=$?; cd - >/dev/null; ` +
      `if [ "$UNZIP_EC" -gt 1 ]; then echo "[error] unzip exited with code $UNZIP_EC — the downloaded file is likely corrupt or not a valid zip"; \\rm -rf ${shq(tmp)}; exit 1; fi; ` +
      `if [ "$UNZIP_EC" -eq 1 ]; then echo "[note] unzip reported warnings (exit 1, e.g. backslash path separators) — extraction still succeeded, continuing"; fi`,
    `if [ -z "$(ls -A ${shq(tmp)}/extracted 2>/dev/null)" ]; then echo "[error] zip extracted but contained nothing"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // Some Thunderstore packages mirror BepInEx's own layout inside the zip
    // (a top-level plugins/ folder, sometimes alongside config/ or
    // patchers/), rather than putting the DLL at the zip root. Flatten that
    // one level so the mod's files always land directly in its own folder —
    // matches how the majority of mods are packaged and avoids a spurious
    // nested plugins/ folder inside plugins/<name>/.
    // Some Thunderstore packages mirror BepInEx's own layout inside the zip
    // (a top-level plugins/ folder, sometimes alongside config/ or
    // patchers/), rather than putting the DLL at the zip root. Merge that
    // plugins/ subfolder's contents UP into the top level rather than
    // discarding everything else — keeps manifest.json/README/icon etc.
    // alongside the actual plugin files, just without the extra nesting.
    `if [ -d ${shq(tmp)}/extracted/plugins ]; then \\cp -rf ${shq(tmp)}/extracted/plugins/. ${shq(tmp)}/extracted/ && \\rm -rf ${shq(tmp)}/extracted/plugins; fi`,
    finalName !== name
      ? `if [ -d ${shq(plug)}/${shq(name)} ]; then if [ -e ${shq(plug)}/${shq(finalName)} ]; then \\cp -rf ${shq(plug)}/${shq(name)}/. ${shq(plug)}/${shq(finalName)}/ && \\rm -rf ${shq(plug)}/${shq(name)}; else \\mv -f ${shq(plug)}/${shq(name)} ${shq(plug)}/${shq(finalName)}; fi; echo "[note] renamed folder ${name} -> ${finalName}"; fi`
      : `true`,
    `mkdir -p ${shq(config.paths.pluginsDir)}/${shq(finalName)}`,
    // \cp bypasses any `alias cp='cp -i'` (a common root .bashrc default on
    // many VPS images) — without this, overwriting an existing file (i.e.
    // every update, since install always into an empty folder) would hang
    // forever waiting for a y/n prompt that has no terminal to answer it.
    `\\cp -rf ${shq(tmp)}/extracted/* ${shq(config.paths.pluginsDir)}/${shq(finalName)}/`,
    `\\rm -rf ${shq(tmp)}`,
    // The SSH connection runs as root (config.ssh.username), so every file
    // just written above is root-owned. LGSM actively checks file
    // ownership before it'll start the game process and refuses outright
    // ("Ownership issues found") if anything under serverfiles isn't owned
    // by the game-server account — real failure hit in production the
    // first time a mod was installed/updated through the GUI after moving
    // to LGSM. `|| true` so a chown hiccup (e.g. a stray permission quirk)
    // doesn't fail the whole install after the mod files themselves already
    // landed correctly.
    // Zips can carry odd permission bits (a directory without read/execute,
    // root-only modes) that unzip preserves. Even after the chown below, LGSM's
    // ownership check (a `find` run as the game user) then fails with
    // "Permission denied" on that folder and refuses to start the server
    // (real case: momos3939-TameCraft). Normalize: owner read/write, everyone
    // read, directories searchable.
    `chmod -R u+rwX,go+rX ${shq(config.paths.pluginsDir)}/${shq(finalName)} || true`,
    `chown -R ${shq(config.lgsmUser || 'vhserver')}:${shq(config.lgsmUser || 'vhserver')} ${shq(config.paths.pluginsDir)}/${shq(finalName)} || true`,
    // Success marker deliberately keeps the name the CLIENT sent (the
    // frontend matches on `INSTALLED <name> <version>`), even when the folder
    // was just renamed to finalName above.
    `echo INSTALLED ${name} ${version}`,
  ].join(' && ');
  sshExecPlainStream(cmd, res, (code) => {
    // Record exactly which source+package+version this folder was just
    // populated from — see saveInstalledFrom() above. Runs after res has
    // already ended (fire-and-forget), and only on a genuine success (the
    // command chain above `exit 1`s on every failure path, so a non-zero
    // code here means the install/update did NOT actually complete).
    if (code === 0) {
      saveInstalledFrom(finalName, { source: src, owner: namespace, name: pkgName, version }, name).catch((e) => {
        console.error(`[installedFrom] failed to record install source for '${name}':`, e.message);
      });
    }
  });
});

// Sends ONE Discord message summarizing every change since the person last
// clicked "Notify Discord" — installs, updates, removes, and now also
// player/admin code generation, however many happened in between. No
// per-action auto-notify; the GUI collects changes client-side and calls
// this once, on request, specifically to avoid one-message-per-action spam.
// Recategorizations aren't included — moving a mod between
// required/admin/server buckets is internal bookkeeping players have no
// use for.
app.post('/api/mods/notify-summary', async (req, res) => {
  const { changes } = req.body;
  if (!Array.isArray(changes) || !changes.length) return res.json({ ok: true, skipped: true });

  const groups = { install: [], update: [], remove: [], disable: [], enable: [], codes: [] };
  changes.forEach((c) => {
    if (groups[c.type]) groups[c.type].push(c);
  });

  const sections = [];
  if (groups.install.length) {
    sections.push(`**Installed:**\n${groups.install.map((c) => `• ${c.name} v${c.version}`).join('\n')}`);
  }
  if (groups.update.length) {
    sections.push(`**Updated:**\n${groups.update.map((c) => `• ${c.name} → v${c.version}`).join('\n')}`);
  }
  if (groups.remove.length) {
    sections.push(`**Removed:**\n${groups.remove.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.disable.length) {
    sections.push(`**Disabled:**\n${groups.disable.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.enable.length) {
    sections.push(`**Re-enabled:**\n${groups.enable.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.codes.length) {
    sections.push(
      `**Codes generated:**\n${groups.codes.map((c) => `• ${c.name}: \`${c.code}\``).join('\n')}\nUse Gale Mod Manager when importing codes: File > Import profile > From code.`
    );
  }
  if (!sections.length) return res.json({ ok: true, skipped: true });
  if (!config.discordWebhookUrl) {
    return res.json({ ok: false, error: 'discordWebhookUrl is not set in config.json' });
  }

  const brand = (await getWorldInfo()).brand;
  const sent = await notifyDiscord(`🛠️ **${brand} mod changes** (${changes.length} total):\n\n${sections.join('\n\n')}`);
  res.json({ ok: sent, error: sent ? undefined : 'Discord rejected the message or was unreachable — check the webhook URL and server logs.' });
});

app.post('/api/mods/remove', async (req, res) => {
  const { name, force } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });

  let enforcerCfg = null;
  try {
    enforcerCfg = await loadEnforcerConfig();
  } catch (e) {}
  const [overridesByGuid, dllsByFolder] = await Promise.all([loadOverrides(), loadDllsByFolder()]);
  const { status, reason } = classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
  const blocked = status === 'required' || status === 'adminOnly';

  if (blocked && !force) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `[blocked] "${name}" is ${status === 'required' ? 'REQUIRED' : 'ADMIN-ONLY'} in ValheimEnforcer.\n` +
        `${reason}\n` +
        `Removing this will lock players out (or yourself, if you're not on the admin list) until it's ` +
        `also taken out of Mods.yaml or the config is regenerated.\n` +
        `Not removed. Resend with force to override.`
    );
    return;
  }

  const warn = blocked ? `echo "[WARNING] removed a ${status} mod despite the enforcer check" && ` : '';
  const removeFolderCmd = `rm -rf ${shq(config.paths.pluginsDir)}/${shq(name)} && echo REMOVED ${name}`;

  // After deleting the plugin folder, also clean up its entry in Mods.yaml
  // (if it has one — a mod removed before its first restart never got one).
  // Wrapped so a "no entry found" result reads as informational, not a
  // failure of the removal itself, which already succeeded by this point.
  const yamlCleanupCmd = config.paths.moveModScript
    ? `(python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(name)} delete || echo "[note] no Mods.yaml entry found for '${name}' — nothing to clean up there")`
    : `echo "[note] paths.moveModScript not set — Mods.yaml entry (if any) was NOT cleaned up, only the plugin folder"`;

  sshExecPlainStream(`${warn}${removeFolderCmd} && ${yamlCleanupCmd}`, res);
});

// Disable: pulls the plugin folder OUT of BepInEx/plugins entirely (not into
// a subfolder inside it — BepInEx scans plugins recursively, so a hidden
// subfolder would still get loaded) and moves its Mods.yaml entry to
// optionalMods. optionalMods is the only bucket where both "client has it"
// and "client doesn't" are allowed — required or admin-only would each
// wrongly reject one side or the other for a mod the server no longer runs.
app.post('/api/mods/disable', async (req, res) => {
  const { name, force } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (!config.paths.disabledModsDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.disabledModsDir is not set in config.json.');
  }

  let enforcerCfg = null;
  try {
    enforcerCfg = await loadEnforcerConfig();
  } catch (e) {}
  const [overridesByGuid, dllsByFolder] = await Promise.all([loadOverrides(), loadDllsByFolder()]);
  const { status, reason } = classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
  const blocked = status === 'required' || status === 'adminOnly';

  if (blocked && !force) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `[blocked] "${name}" is ${status === 'required' ? 'REQUIRED' : 'ADMIN-ONLY'} in ValheimEnforcer.\n${reason}\n` +
        `Disabling it stops the server from running it, which can break anything that depends on it, or (until the ` +
        `Mods.yaml move below takes effect) mis-enforce who can connect.\n` +
        `Not disabled. Resend with force to override.`
    );
    return;
  }

  const warn = blocked ? `echo "[WARNING] disabling a ${status} mod despite the enforcer check" && ` : '';
  const lgsmUser = shq(config.lgsmUser || 'vhserver');
  const moveFolderCmd =
    // `mkdir -p` here runs as root (the SSH user) — if disabledModsDir
    // doesn't exist yet, this creates it root-owned, which trips LGSM's
    // ownership check on the next start same as the /api/mods/install fix
    // above. chown it every time (cheap, idempotent) rather than only on
    // first creation.
    `mkdir -p ${shq(config.paths.disabledModsDir)} && chown -R ${lgsmUser}:${lgsmUser} ${shq(config.paths.disabledModsDir)} && ` +
    `\\mv -f ${shq(config.paths.pluginsDir)}/${shq(name)} ${shq(config.paths.disabledModsDir)}/${shq(name)} && echo DISABLED ${name}`;
  const yamlMoveCmd = config.paths.moveModScript
    ? `(python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(name)} optional || echo "[note] no Mods.yaml entry found for '${name}' — nothing to recategorize")`
    : `echo "[note] paths.moveModScript not set — Mods.yaml entry (if any) was NOT moved to optional"`;

  sshExecPlainStream(`${warn}${moveFolderCmd} && ${yamlMoveCmd}`, res);
});

app.post('/api/mods/enable', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (!config.paths.disabledModsDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.disabledModsDir is not set in config.json.');
  }
  const cmd =
    `\\mv -f ${shq(config.paths.disabledModsDir)}/${shq(name)} ${shq(config.paths.pluginsDir)}/${shq(name)} && echo ENABLED ${name}` +
    ` && echo "[note] stop and start the server for ValheimEnforcer to detect it again, then set its category from the Mods tab if it shouldn't just be Required"`;
  sshExecPlainStream(cmd, res);
});

app.get('/api/mods/disabled', async (req, res) => {
  if (!config.paths.disabledModsDir) return res.json({ mods: [] });
  try {
    const r = await sshExec(`mkdir -p ${shq(config.paths.disabledModsDir)} && ls -1 ${shq(config.paths.disabledModsDir)} 2>/dev/null`);
    res.json({ mods: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NOTE: the old profile-sync endpoint (/api/mods/sync, driving
// sync-mods-from-r2modman.sh) was removed from the GUI along with the
// r2modman-based workflow it supported. The script itself is untouched on
// the VPS for the rare one-time bulk-import case; wire it back in here if
// that need comes up again.

// Generates player/admin Thunderstore codes DIRECTLY from Mods.yaml — no
// master r2modman profile needed at all. Runs generate-codes.py, which does
// hash verification, thunderstorePackage pin support, and the
// always-included framework packages (BepInExPack/JsonDotNET)
// under the hood. Also passes --plugins-dir so generate-codes.py can resolve
// a mod's real package identity directly from its installed BepInEx/plugins
// folder name (fixes cases like AzuAntiArthriticCrafting/AAA_Crafting, where
// Mods.yaml's cosmetic name has no relationship to the real package name —
// see the --plugins-dir docs at the top of generate-codes.py). Streams
// progress + the resulting code(s).
app.get('/api/mods/generate-codes', async (req, res) => {
  const mode = req.query.mode || 'both'; // player | admin | both
  const dryRun = req.query.dryRun === 'true';
  if (!['player', 'admin', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be player, admin, or both' });
  }
  if (!config.paths.generateCodesScript) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] paths.generateCodesScript is not set in config.json.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  const flag = dryRun ? ' --dry-run' : '';
  const pluginsDirFlag = config.paths.pluginsDir ? ` --plugins-dir ${shq(config.paths.pluginsDir)}` : '';
  // Profile label shown in Gale ("<world> (Player)"): the world's own name, or plain "Valheim" before it exists.
  let label = 'Valheim';
  try { label = (await getWorldInfo()).brand || 'Valheim'; } catch (e) { /* keep the default */ }
  const cmd = `python3 ${shq(config.paths.generateCodesScript)} ${shq(config.paths.enforcerYaml)} --mode ${shq(mode)}${pluginsDirFlag} --profile-name ${shq(label)}${flag}`;
  sshExecStream(cmd, res);
});

// Read-only reference for players: current Required/Optional mods straight
// from Mods.yaml, with a best-effort mod-page link (checked across BOTH
// Thunderstore and Hexium — same fuzzy name matching used for
// update-checking) plus a Gale deep link (gale://install/...) that installs
// the exact mod+version in one click if the player has Gale installed. This
// is what replaces the old r2modman-profile-code distribution flow — Gale
// supports both sources, so this reference list plus its deep links now
// covers a Hexium-only mod exactly as well as a Thunderstore one.
app.get('/api/mods/requirements', async (req, res) => {
  try {
    const enforcerCfg = await loadEnforcerConfig();
    if (!enforcerCfg) return res.json({ required: [], optional: [] });

    let thunderstorePkgs = [];
    let hexiumPkgs = [];
    try {
      [thunderstorePkgs, hexiumPkgs] = await Promise.all([getThunderstorePackages(), getHexiumPackages()]);
    } catch (e) {
      // Link lookup is best-effort — still return the list without links.
    }
    const overridesByGuid = await loadOverrides();
    // A thunderstorePackage/hexiumPackage override (Mods.overrides.yaml —
    // never the Mods.yaml entry itself, see loadOverrides()) beats the
    // cosmetic-name-only match below — it names the exact package a human
    // has already verified, so it can't land on an unrelated same-or-
    // similar-named package the way name-only matching can.
    const findMatch = (entry, guid) => {
      const override = overridesByGuid[guid] || {};
      const pinTs = override.thunderstorePackage;
      if (pinTs) {
        const { owner, name } = parseDependencyString(pinTs);
        const ownerNorm = normalize(owner);
        const nameNorm = normalize(name);
        const pinMatch = thunderstorePkgs.find((p) => !p.is_deprecated && normalize(p.owner) === ownerNorm && normalize(p.name) === nameNorm);
        if (pinMatch) return { source: 'thunderstore', namespace: pinMatch.owner, name: pinMatch.name };
      }
      const pinHex = override.hexiumPackage;
      if (pinHex) {
        const { owner, name } = parseDependencyString(pinHex);
        const ownerNorm = normalize(owner);
        const nameNorm = normalize(name);
        const pinMatch = hexiumPkgs.find((p) => !p.is_deprecated && normalize(p.owner) === ownerNorm && normalize(p.name) === nameNorm);
        if (pinMatch) return { source: 'hexium', namespace: pinMatch.owner, name: pinMatch.name };
      }

      const nameNorm = normalize(entry.name);
      if (!nameNorm) return null;
      const tsMatch = thunderstorePkgs.find((p) => !p.is_deprecated && normalize(p.name) === nameNorm);
      if (tsMatch) return { source: 'thunderstore', namespace: tsMatch.owner, name: tsMatch.name };
      const hexMatch = hexiumPkgs.find((p) => !p.is_deprecated && normalize(p.name) === nameNorm);
      if (hexMatch) return { source: 'hexium', namespace: hexMatch.owner, name: hexMatch.name };
      return null;
    };
    const listBucket = (bucket) =>
      Object.entries(bucket || {}).map(([guid, entry]) => {
        const match = findMatch(entry, guid);
        return {
          name: entry.name || '(unknown)',
          version: entry.version || '',
          source: match ? match.source : null,
          link: match ? modPageUrl(match.source, match.namespace, match.name) : null,
          galeLink: match && entry.version ? galeInstallLink(match.source, match.namespace, match.name, entry.version) : null,
        };
      });

    res.json({
      required: listBucket(enforcerCfg.requiredMods),
      optional: listBucket(enforcerCfg.optionalMods),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Moves a mod between requiredMods/optionalMods/adminOnlyMods/serverOnlyMods
// in Mods.yaml by shelling out to move-mod.py (which does the actual
// comment-preserving YAML edit + backup). This is what replaces manually
// cutting/pasting a mod's entry after ValheimEnforcer auto-adds it.
app.post('/api/mods/categorize', (req, res) => {
  const { query, bucket } = req.body;
  const allowed = ['required', 'optional', 'admin', 'server'];
  if (!query || !bucket) return res.status(400).json({ error: 'missing query/bucket' });
  if (!allowed.includes(bucket)) return res.status(400).json({ error: `bucket must be one of ${allowed.join(', ')}` });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(query)} ${shq(bucket)}`;
  sshExecPlainStream(cmd, res);
});

// Every known Mods.yaml entry across all four buckets, for the "link to
// existing entry" picker on an Unlisted mod — see /api/mods/pin-folder
// below. A mod shows Unlisted not only when it's genuinely never been
// categorized, but also when it IS correctly in a bucket and the installed
// plugin folder name just doesn't textually resemble the GUID/display name
// (e.g. an acronym like "AAA_Crafting" for "AzuAntiArthriticCrafting") —
// this list is what lets a human pick the right entry instead of hand-
// editing Mods.yaml to add a folderName: pin.
app.get('/api/mods/all-entries', async (req, res) => {
  try {
    const enforcerCfg = await loadEnforcerConfig();
    if (!enforcerCfg) return res.json({ entries: [] });
    const overridesByGuid = await loadOverrides();
    const bucketList = [
      ['required', enforcerCfg.requiredMods],
      ['optional', enforcerCfg.optionalMods],
      ['admin', enforcerCfg.adminOnlyMods],
      ['server', enforcerCfg.serverOnlyMods],
    ];
    const entries = [];
    for (const [bucket, contents] of bucketList) {
      for (const [guid, entry] of Object.entries(contents || {})) {
        entries.push({
          bucket,
          guid,
          name: (entry && entry.name) || guid,
          version: (entry && entry.version) || '',
          // folderName comes from Mods.overrides.yaml now, never the
          // Mods.yaml entry itself — see loadOverrides().
          folderName: (overridesByGuid[guid] && overridesByGuid[guid].folderName) || '',
        });
      }
    }
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pins an installed plugin folder name to an existing Mods.yaml entry, so
// findEnforcerEntry() can match it going forward without relying on fuzzy
// substring matching. Doesn't move the entry between buckets — purely a
// name-matching fix, so (like /api/mods/categorize) this is internal
// bookkeeping and isn't logged to the Discord change summary.
app.post('/api/mods/pin-folder', (req, res) => {
  const { guid, folderName } = req.body;
  if (!guid || !folderName) return res.status(400).json({ error: 'missing guid/folderName' });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} pin-folder ${shq(folderName)}`;
  sshExecPlainStream(cmd, res);
});

// Sets/clears the ignoreUpdates flag on a Mods.yaml entry, so a mod that
// keeps flagging a real but uninteresting/unwanted "update available" (e.g.
// ValheimModding-YamlDotNet's detector plugin, which always reports a stale
// bundled-assembly version — investigated and confirmed genuine, just not
// something worth being reminded about) can be silenced without editing
// Mods.yaml by hand. Like categorize/pin-folder, this is internal
// bookkeeping — not logged to the Discord change summary.
app.post('/api/mods/ignore-updates', (req, res) => {
  const { query, ignore } = req.body;
  if (!query || typeof ignore !== 'boolean') return res.status(400).json({ error: 'missing query/ignore (boolean)' });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const target = ignore ? 'ignore-updates' : 'unignore-updates';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(query)} ${shq(target)}`;
  sshExecPlainStream(cmd, res);
});

// Pins a Mods.yaml entry's real Thunderstore/Hexium package IDENTITY (owner
// + package name) — for a mod the automatic matcher can't resolve on its
// own: a generic display name matching several unrelated packages, or a
// fork that publishes under a name/owner nothing in Mods.yaml hints at
// (e.g. Valheim Plus's actual current owner being "Grantapher"). The
// `version` field here is NOT frozen into the pin — generate-codes.py
// always resolves the version to actually use from Mods.yaml's own live
// record for this mod (see that script's resolve_entries()), so a pinned
// mod keeps updating normally forever after. It's only required here (and
// by move-mod.py's pin-thunderstore/pin-hexium) to confirm you're pointing
// at a real, currently-published package at the moment you set this.
app.post('/api/mods/pin-package', (req, res) => {
  const { guid, source, owner, packageName, version } = req.body;
  if (!guid || !owner || !packageName || !version || !['thunderstore', 'hexium'].includes(source)) {
    return res.status(400).json({ error: 'missing guid/source/owner/packageName/version' });
  }
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const pinString = `${owner}-${packageName}-${version}`;
  const target = source === 'hexium' ? 'pin-hexium' : 'pin-thunderstore';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} ${target} ${shq(pinString)}`;
  sshExecPlainStream(cmd, res);
});

// Clears a thunderstorePackage/hexiumPackage pin, falling back to the
// normal fuzzy name/hash matching again on the next generate-codes.py run.
app.post('/api/mods/unpin-package', (req, res) => {
  const { guid, source } = req.body;
  if (!guid || !['thunderstore', 'hexium'].includes(source)) {
    return res.status(400).json({ error: 'missing guid/source' });
  }
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const target = source === 'hexium' ? 'unpin-hexium' : 'unpin-thunderstore';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} ${target}`;
  sshExecPlainStream(cmd, res);
});

// ---- Players (parsed from the BepInEx log — Valheim has no built-in RCON) ----
//
// Valheim logs a join and a leave with DIFFERENT identifiers:
//   join:  "Got connection SteamID 7656119…"           (network id)
//          "Got character ZDOID from Alice : 12345:1"   (character name)
//   leave: "Closing socket 7656119…"                   (network id only!)
// The old parser keyed joins by character name and leaves by the socket id,
// so a leave never matched anyone and players stayed "online" until the
// log rotated. PlayerTracker links each character name to the connection
// id that preceded it, so the matching "Closing socket" line removes them.
// It also resets on a server (re)start ("Load world") and trusts Valheim's
// own periodic "Connections N ZDOS:" line when it reports 0 connections.
// Crossplay (PlayFab) builds log "Platform ID Steam_7656…" style ids — those
// are handled too.
class PlayerTracker {
  constructor() {
    this.online = new Map(); // name -> { id, since }
    this.pending = []; // connection ids seen but not yet linked to a character
    // Join times are only known for joins seen live; joins replayed from the
    // log history (seed) get null, since the log lines carry no reliable timezone.
    this.live = false;
  }
  _normId(id) {
    return String(id || '').trim().replace(/^(Steam_|steam_)/, '');
  }
  // Returns true if the roster changed.
  feed(line) {
    let m;
    if (/Load world:|Starting to load scene/.test(line)) {
      const changed = this.online.size > 0;
      this.online.clear();
      this.pending = [];
      return changed;
    }
    if ((m = line.match(/Got connection SteamID (\d+)/)) || (m = line.match(/received local Platform ID (\S+)/))) {
      const id = this._normId(m[1]);
      if (!this.pending.includes(id)) this.pending.push(id);
      if (this.pending.length > 20) this.pending.shift();
      return false;
    }
    if ((m = line.match(/Got character ZDOID from (.+?) : (-?\d+):(\d+)/))) {
      const name = m[1].trim();
      if (m[2] === '0') return false; // ZDOID 0:0 = the character died; they're still connected
      if (this.online.has(name)) return false; // respawn / re-sent — already tracked
      const id = this.pending.shift() || null;
      this.online.set(name, { id, since: this.live ? Date.now() : null });
      return true;
    }
    if ((m = line.match(/Closing socket (\S+)/)) || (m = line.match(/Disposing socket (\S+)/))) {
      const id = this._normId(m[1]);
      this.pending = this.pending.filter((p) => p !== id);
      for (const [name, info] of this.online) {
        if (info.id && info.id === id) {
          this.online.delete(name);
          return true;
        }
      }
      return false;
    }
    if ((m = line.match(/Connections (\d+) ZDOS:/))) {
      if (m[1] === '0' && this.online.size) {
        this.online.clear();
        this.pending = [];
        return true;
      }
      return false;
    }
    return false;
  }
  list() {
    return Array.from(this.online.keys());
  }
  details() {
    return Array.from(this.online.entries()).map(([name, info]) => ({ name, since: info.since }));
  }
}

const PLAYER_LINE_PATTERN =
  'Got character ZDOID from|Closing socket|Disposing socket|Got connection SteamID|received local Platform ID|Load world:|Starting to load scene|Connections [0-9]+ ZDOS:';

// Look at the tail of the log for connect/disconnect lines and derive who's
// currently on. Still a heuristic (log-based), not an authoritative list.
async function getOnlinePlayers() {
  const r = await sshExec(`tail -n 20000 ${shq(config.paths.logFile)} 2>/dev/null | grep -E ${shq(PLAYER_LINE_PATTERN)}`);
  const tracker = new PlayerTracker();
  r.stdout.split('\n').filter(Boolean).forEach((line) => tracker.feed(line));
  return tracker.list();
}

app.get('/api/players', async (req, res) => {
  try {
    res.json({ players: await getOnlinePlayers(), heuristic: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live version: tails the log continuously (seeded from recent history),
// parses join/leave lines the moment they're written, and pushes the roster
// to the client whenever it changes (plus once right after seeding, so the
// page gets an immediate answer even when nobody is online).
app.get('/api/players/live', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.on('error', () => {});
  const send = () => {
    try {
      res.write(`data: ${JSON.stringify({ players: tracker.list(), details: tracker.details() })}\n\n`);
    } catch (e) {}
  };
  const tracker = new PlayerTracker();
  const conn = new Client();
  let sshStream = null;
  let partial = '';
  let seeded = false;
  let seedTimer = null;
  // Keep proxies/browsers from timing out an idle stream.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {}
  }, 25000);

  conn
    .on('ready', () => {
      // grep --line-buffered so each matching line is forwarded immediately
      // instead of waiting for a 4 KB pipe buffer to fill.
      const cmd = `tail -n 20000 -F ${shq(config.paths.logFile)} 2>/dev/null | grep --line-buffered -E ${shq(PLAYER_LINE_PATTERN)}`;
      conn.exec(followCmd(cmd), (err, stream) => {
        if (err) {
          res.write(`event: error\ndata: ${err.message}\n\n`);
          conn.end();
          res.end();
          return;
        }
        sshStream = stream;
        const onData = (data) => {
          const text = partial + data.toString();
          const lines = text.split('\n');
          partial = lines.pop(); // keep an incomplete trailing line for the next chunk
          let changed = false;
          lines.forEach((line) => {
            if (tracker.feed(line)) changed = true;
          });
          if (!seeded) {
            // The seed history arrives as a burst; send one snapshot once it settles.
            clearTimeout(seedTimer);
            seedTimer = setTimeout(() => {
              seeded = true;
              tracker.live = true;
              send();
            }, 400);
          } else if (changed) send();
        };
        stream.on('data', onData);
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          conn.end();
          res.end();
        });
        // Empty/missing log: still answer once.
        seedTimer = setTimeout(() => {
          if (!seeded) {
            seeded = true;
            tracker.live = true;
            send();
          }
        }, 1500);
      });
    })
    .on('error', (err) => {
      res.write(`event: error\ndata: ${err.message}\n\n`);
      res.end();
    })
    .connect(sshConnectOpts());

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(seedTimer);
    try {
      if (sshStream) sshStream.close();
    } catch (e) {}
    try {
      conn.end();
    } catch (e) {}
  });
});

// ---- Logs ----

app.get('/api/logs/tail', async (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(config.paths.logFile)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Named "journal" for backward compatibility with the frontend's existing
// source selector, but there is no systemd journal anymore — this now
// tails LGSM's own console log (config.paths.consoleLog), which is what
// captures the game process's raw stdout/stderr under LGSM.
app.get('/api/logs/journal', async (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(config.paths.consoleLog)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live-follow either the LGSM console log ("journal", by legacy name) or the
// BepInEx log file.
app.get('/api/logs/live', (req, res) => {
  const source = req.query.source === 'tail' ? 'tail' : 'journal';
  const cmd =
    source === 'tail'
      ? `tail -n 20 -F ${shq(config.paths.logFile)}`
      : `tail -n 20 -F ${shq(config.paths.consoleLog)}`;
  sshExecFollow(cmd, req, res);
});

// ---- Setup (bootstrap a fresh VPS: dedicated server -> BepInEx -> ValheimEnforcer) ----
//
// Everything above this section assumes BepInEx + ValheimEnforcer already
// exist on the VPS — that's true for an established server, but not for someone
// starting from a brand-new headless VPS. This section is deliberately
// separate and additive: it never runs automatically, every step is its own
// button with its own confirmation, and the one genuinely risky step
// (wiring the doorstop env vars that make LGSM launch through BepInEx into
// common.cfg) is split into a preview call and a separate apply call so
// nothing gets changed without the human seeing exactly what's about to be
// added first. New config.json fields this section needs:
// paths.valheimServerDir (the dedicated server's install root — where
// valheim_server.x86_64 lives) and paths.commonCfgPath (LGSM's
// config-lgsm/vhserver/common.cfg) — both optional; every endpoint here
// degrades to a clear "not configured" response rather than crashing if
// they're unset.
//
// Rebuilt 2026-09-29: there's no systemd unit anymore (LGSM manages the
// process directly), so the old "rewrite the ExecStart= line" step doesn't
// apply. The equivalent risky step now is making sure common.cfg actually
// exports the four DOORSTOP_*/LD_* variables that route LGSM's launch
// through BepInEx's doorstop injector instead of running Valheim bare.

// Finds a package by its exact owner+name across both sources and returns
// its latest published version — used to resolve BepInExPack_Valheim and
// ValheimEnforcer's current version without hardcoding one that inevitably
// goes stale. Thunderstore is checked first since both packages have
// historically been published there.
async function findLatestPackage(owner, pkgName) {
  const ownerNorm = normalize(owner);
  const nameNorm = normalize(pkgName);
  for (const source of ['thunderstore', 'hexium']) {
    let pkgs;
    try {
      pkgs = await getPackages(source);
    } catch (e) {
      continue;
    }
    const match = pkgs.find((p) => !p.is_deprecated && normalize(p.owner) === ownerNorm && normalize(p.name) === nameNorm);
    if (match) {
      const latest = match.versions[0]?.version_number;
      if (latest) return { source, owner: match.owner, name: match.name, version: latest };
    }
  }
  return null;
}

// ---- Setup helpers ----

// Streams lines to the browser the same way sshExecStream does (SSE: `data:` lines,
// then a `done` event carrying the exit code) for steps that are made of several
// separate remote calls.
function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.on('error', (e) => console.error('[startSse] response stream error (ignored):', e.message));
  return {
    send: (line) => safeWrite(res, `data: ${String(line).replace(/[\r\n]+/g, ' ')}\n\n`),
    done: (code) => {
      safeWrite(res, `event: done\ndata: ${code}\n\n`);
      res.end();
    },
  };
}

// Runs a whole bash script as root (directly when the connection is root, through sudo
// otherwise). Base64 keeps the script free of any quoting problems.
function asRootScript(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return maybeSudo(`bash -c "$(printf '%s' ${shq(b64)} | base64 -d)"`);
}

// The config values that get written into scripts on the VPS must be boring paths/names.
const SAFE_SETUP_VALUE = /^[A-Za-z0-9_./ +@:-]+$/;
function setupValues() {
  const p = config.paths;
  return {
    LGSM_USER: config.lgsmUser,
    LGSM_SERVER: config.lgsmServer,
    LGSM_HOME: config.lgsmHome,
    LGSM_SCRIPT: p.lgsmScript,
    SERVER_DIR: p.valheimServerDir,
    DATA_ROOT: p.worldDir,
    BACKUP_DIR: p.backupDir,
    COMMON_CFG: p.commonCfgPath,
  };
}

// Reads a script template from vps-scripts/ and fills in its __NAME__ values.
function renderScriptTemplate(name) {
  const vals = setupValues();
  for (const [k, v] of Object.entries(vals)) {
    if (!v || !SAFE_SETUP_VALUE.test(v)) throw new Error(`The config value for ${k} ("${v}") is empty or has characters the Setup steps do not allow (use letters, digits and . _ / - only).`);
  }
  const text = fs.readFileSync(path.join(__dirname, 'vps-scripts', name), 'utf8').replace(/__([A-Z][A-Z_]*)__/g, (m, k) => (k in vals ? vals[k] : m));
  const left = text.match(/__[A-Z][A-Z_]*__/);
  if (left) throw new Error(`${name}: value ${left[0]} was not filled in`);
  return text;
}

// Writes a file as root in chunks (a single command line cannot carry a very large
// file), then moves it into place atomically.
async function writeRootFileChunked(filePath, content, mode) {
  const buf = Buffer.from(content, 'utf8');
  const CHUNK = 12 * 1024; // multiple of 3 so each chunk decodes on its own; keeps every ssh exec command well under the 32 KiB packet limit
  const tmp = `${filePath}.new.${process.pid}`;
  for (let off = 0, first = true; off < buf.length || first; off += CHUNK, first = false) {
    const b64 = buf.subarray(off, off + CHUNK).toString('base64');
    const r = await sshExec(`printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${first ? '' : '-a '}${shq(tmp)}`)} >/dev/null && echo CHUNK_OK`);
    if (!r.stdout.includes('CHUNK_OK')) throw new Error(`could not write ${filePath}: ${r.stderr || r.stdout}`.trim());
  }
  const fin = await sshExec([maybeSudo(`chmod ${mode} ${shq(tmp)}`), maybeSudo(`chown root:root ${shq(tmp)}`), maybeSudo(`mv -f ${shq(tmp)} ${shq(filePath)}`), 'echo WROTE'].join(' && '));
  if (!fin.stdout.includes('WROTE')) throw new Error(`could not finish writing ${filePath}: ${fin.stderr || fin.stdout}`.trim());
}

// The helper scripts the GUI's other tabs call. Key = config.paths key.
const HELPER_SCRIPTS = [
  { key: 'backupScript', file: 'backup-valheim.sh', mode: '755', check: 'bash' },
  { key: 'checkUpdateScript', file: 'check-valheim-update.sh', mode: '755', check: 'bash' },
  { key: 'applyUpdateScript', file: 'update-valheim.sh', mode: '755', check: 'bash' },
  { key: 'moveModScript', file: 'move-mod.py', mode: '644', check: 'py', verbatim: true },
  { key: 'generateCodesScript', file: 'generate-codes.py', mode: '644', check: 'py', verbatim: true },
];

// Read-only diagnostic covering every stage of the bootstrap. Safe to call
// as often as the Setup tab wants (e.g. after each step) to refresh its
// checklist — nothing here changes any state.
app.get('/api/setup/status', async (req, res) => {
  try {
    const p = config.paths;
    const sd = p.valheimServerDir;
    const yn = (name, test) => `if ${test}; then echo "${name}:yes"; else echo "${name}:no"; fi`;
    const checks = [
      yn('LGSM_USER', `id -u ${shq(config.lgsmUser)} >/dev/null 2>&1`),
      yn('LGSM_INSTALLED', `test -x ${shq(p.lgsmScript)}`),
      yn('DEDICATED_SERVER', `test -f ${shq(sd)}/valheim_server.x86_64`),
      yn('COMMON_CFG', `test -f ${shq(p.commonCfgPath)}`),
      yn('BEPINEX_CORE', `test -f ${shq(sd)}/BepInEx/core/BepInEx.dll`),
      yn('BEPINEX_LAUNCHER', `test -f ${shq(sd)}/start_server_bepinex.sh`),
      // Same "is it actually wired" question as before, aimed at common.cfg's
      // doorstop export lines; the preview call does the careful line-by-line
      // check before actually changing anything.
      yn('DOORSTOP_WIRED', `grep -q "DOORSTOP_ENABLED=1" ${shq(p.commonCfgPath)} 2>/dev/null`),
      yn('ENFORCER_PLUGIN', `ls -1 ${shq(p.pluginsDir)} 2>/dev/null | grep -qi valheimenforcer`),
      yn('JOTUNN_PLUGIN', `ls -1 ${shq(p.pluginsDir)} 2>/dev/null | grep -qi jotunn`),
      yn('ENFORCER_CONFIG', `test -f ${shq(p.enforcerYaml)}`),
      `echo "ENFORCER_FOUND:$(find ${shq(sd)}/BepInEx -maxdepth 4 -name Mods.yaml -ipath '*enforcer*' 2>/dev/null | head -n1)"`,
      yn('BEPINEX_LOADED', `grep -qE "Chainloader (started|startup complete)" ${shq(p.logFile)} 2>/dev/null`),
      yn('ENFORCER_LOADED', `grep -qiE "Loading \\[[^]]*ValheimEnforcer" ${shq(p.logFile)} 2>/dev/null`),
      yn('RUAMEL', `python3 -c 'import ruamel.yaml' 2>/dev/null`),
      yn('CRON', `command -v cron >/dev/null 2>&1 || command -v crond >/dev/null 2>&1`),
      ...HELPER_SCRIPTS.map((h) => yn(`HELPER_${h.key}`, `test -f ${shq(p[h.key])}`)),
      // Running server older than the newest change to common.cfg / the plugins folder?
      // Then it is still running without that change and needs a stop + start.
      `PID=$(pgrep -u ${shq(config.lgsmUser)} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
      `if [ -n "$PID" ]; then echo "SERVER_STATE:active"; ` +
        `SE=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
        `if [ -n "$SE" ] && [ -n "$(find ${shq(p.commonCfgPath)} ${shq(p.pluginsDir)} -newermt "@$SE" -print -quit 2>/dev/null)" ]; then echo "NEEDS_RESTART:yes"; else echo "NEEDS_RESTART:no"; fi; ` +
        `else echo "SERVER_STATE:inactive"; echo "NEEDS_RESTART:no"; fi`,
    ];
    const r = await sshExec(checks.join('\n'));
    const st = {};
    r.stdout.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) st[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    // ValheimEnforcer's folder is a guess until the plugin has run once; if the real
    // Mods.yaml is somewhere else, follow it (only when the path was not set by hand).
    if (st.ENFORCER_FOUND && st.ENFORCER_FOUND !== p.enforcerYaml && derivedPaths.has('enforcerYaml')) {
      p.enforcerYaml = st.ENFORCER_FOUND;
      st.ENFORCER_CONFIG = 'yes';
    }

    // The server identity (name / world / password) lives in LinuxGSM's cfg files.
    let identity = null;
    if (st.COMMON_CFG === 'yes') {
      const w = await getWorldInfo();
      const pw = (await readEffectiveCfgValue('serverpassword').catch(() => null)) || '';
      identity = {
        serverName: w.serverName,
        worldName: w.world,
        worldCreated: w.ready,
        passwordSet: pw.length >= 5,
        passwordWeak: WEAK_PASSWORDS.has(pw.toLowerCase()),
        port: w.port,
        portSet: w.portExplicit,
        plannedPort: (readRegistry().find((i) => i.id === curId()) || {}).plannedPort || null,
      };
    }

    const helpers = {};
    for (const h of HELPER_SCRIPTS) helpers[h.key] = st[`HELPER_${h.key}`] === 'yes';
    res.json({
      instance: config.instance,
      plannedPort: (readRegistry().find((i) => i.id === curId()) || {}).plannedPort || null,
      lgsmUser: st.LGSM_USER === 'yes',
      lgsmInstalled: st.LGSM_INSTALLED === 'yes',
      dedicatedServer: st.DEDICATED_SERVER === 'yes',
      commonCfg: st.COMMON_CFG === 'yes',
      identity,
      bepinexCore: st.BEPINEX_CORE === 'yes',
      bepinexLauncher: st.BEPINEX_LAUNCHER === 'yes',
      doorstopWired: st.DOORSTOP_WIRED === 'yes',
      enforcerPlugin: st.ENFORCER_PLUGIN === 'yes',
      jotunnPlugin: st.JOTUNN_PLUGIN === 'yes',
      enforcerConfig: st.ENFORCER_CONFIG === 'yes',
      enforcerPath: p.enforcerYaml,
      helpers,
      ruamel: st.RUAMEL === 'yes',
      cron: st.CRON === 'yes',
      serverState: st.SERVER_STATE || 'unknown',
      needsRestart: st.NEEDS_RESTART === 'yes',
      bepinexLoaded: st.BEPINEX_LOADED === 'yes',
      enforcerLoaded: st.ENFORCER_LOADED === 'yes',
      firewall: await (async () => {
        try {
          const port = await worldGamePort();
          return port && st.LGSM_USER === 'yes' ? { port, ...(await fwRun('status', port)) } : null;
        } catch (e) {
          return null;
        }
      })(),
      paths: { serverDir: sd, scriptsDir: p.scriptsDir, commonCfg: p.commonCfgPath },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 1: game account + LinuxGSM + its dependencies (vps-scripts/setup-prepare.sh, as root).
app.get('/api/setup/prepare', (req, res) => {
  let script;
  try {
    script = renderScriptTemplate('setup-prepare.sh');
  } catch (e) {
    const sse = startSse(res);
    sse.send(`[error] ${e.message}`);
    return sse.done(1);
  }
  sshExecStream(asRootScript(script), res, { idleMs: 900000 });
});

// Step 2: LinuxGSM downloads and installs the Valheim dedicated server
// (vps-scripts/setup-install-server.sh). The path name stays install-server.
app.get('/api/setup/install-server', (req, res) => {
  let script;
  try {
    script = renderScriptTemplate('setup-install-server.sh');
  } catch (e) {
    const sse = startSse(res);
    sse.send(`[error] ${e.message}`);
    return sse.done(1);
  }
  sshExecStream(asRootScript(script), res, { idleMs: 900000 });
});

// Step 5: the helper scripts every other tab relies on (backups, update check and
// apply, mod categorizing, profile codes), plus the folders they use. An existing
// script that differs is kept as <name>.bak.<time> before being replaced.
app.get('/api/setup/install-helpers', async (req, res) => {
  const sse = startSse(res);
  try {
    const p = config.paths;
    const user = config.lgsmUser;
    const vals = setupValues(); // validates every path used below
    for (const k of ['scriptsDir', 'disabledModsDir']) {
      if (!SAFE_SETUP_VALUE.test(p[k] || '')) throw new Error(`paths.${k} has unsupported characters`);
    }
    sse.send('[step] Creating folders...');
    const mk = await sshExec(
      [
        maybeSudo(`install -d -m 755 ${shq(p.scriptsDir)}`),
        maybeSudo(`install -d -o ${shq(user)} -g ${shq(user)} ${shq(p.backupDir)} ${shq(p.disabledModsDir)} ${shq(`${vals.LGSM_HOME}/.config`)}`),
        'echo MADE',
      ].join(' && ')
    );
    if (!mk.stdout.includes('MADE')) throw new Error(`could not create folders: ${mk.stderr || mk.stdout}`.trim());

    sse.send('[step] Checking the Python YAML library the Mods tab needs (ruamel.yaml)...');
    const py = await sshExec(
      `python3 -c 'import ruamel.yaml' 2>/dev/null && echo HAVE || { ${maybeSudo('apt-get install -y -qq python3-ruamel.yaml')} >/dev/null 2>&1; python3 -c 'import ruamel.yaml' 2>/dev/null && echo INSTALLED || { ${maybeSudo('pip3 install --quiet --break-system-packages ruamel.yaml')} >/dev/null 2>&1; python3 -c 'import ruamel.yaml' 2>/dev/null && echo INSTALLED || echo MISSING; }; }`
    );
    if (py.stdout.includes('MISSING')) throw new Error('could not install ruamel.yaml — run "apt install python3-ruamel.yaml" on the VPS and retry');
    sse.send(py.stdout.includes('HAVE') ? '[note] ruamel.yaml already installed' : '[note] ruamel.yaml installed');

    for (const h of HELPER_SCRIPTS) {
      const dest = p[h.key];
      if (!SAFE_SETUP_VALUE.test(dest)) throw new Error(`paths.${h.key} has unsupported characters`);
      const content = h.verbatim ? fs.readFileSync(path.join(__dirname, 'vps-scripts', h.file), 'utf8') : renderScriptTemplate(h.file);
      sse.send(`[step] Installing ${h.file} -> ${dest}`);
      const sum = crypto.createHash('sha256').update(content).digest('hex');
      const cur = await sshExec(`sha256sum ${shq(dest)} 2>/dev/null | cut -d' ' -f1`);
      if (cur.stdout.trim() === sum) {
        sse.send('[note] already up to date');
        continue;
      }
      if (cur.stdout.trim()) {
        const bak = `${dest}.bak.${Date.now()}`;
        await sshExec(maybeSudo(`cp -p ${shq(dest)} ${shq(bak)}`));
        sse.send(`[note] the existing file differed — kept as ${bak}`);
      }
      await writeRootFileChunked(dest, content, h.mode);
      const syn = h.check === 'bash' ? `bash -n ${shq(dest)}` : `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' ${shq(dest)}`;
      const chk = await sshExec(`${syn} && echo SYNTAX_OK`);
      if (!chk.stdout.includes('SYNTAX_OK')) throw new Error(`${h.file} was written but failed its syntax check: ${chk.stderr || chk.stdout}`.trim());
    }
    sse.send('[done] Helper scripts installed. Backups, the update check and the Mods tab can now run.');
    sse.done(0);
  } catch (e) {
    sse.send(`[error] ${e.message}`);
    sse.done(1);
  }
});

// Downloads BepInExPack_Valheim's current version and merges its contents
// (the BepInEx/ folder, winhttp.dll, doorstop_config.ini, and the
// start_server_bepinex.sh/start_game_bepinex.sh launcher scripts) directly
// into paths.valheimServerDir, exactly as denikson's own install
// instructions describe for a dedicated server — this does NOT touch the
// systemd unit; that's the separate preview/apply step below, on purpose.
app.get('/api/setup/install-bepinex', async (req, res) => {
  if (!config.paths.valheimServerDir) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] paths.valheimServerDir is not set in config.json.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  let pkg;
  try {
    pkg = await findLatestPackage('denikson', 'BepInExPack_Valheim');
  } catch (e) {
    pkg = null;
  }
  if (!pkg) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] could not find denikson-BepInExPack_Valheim on Thunderstore or Hexium right now.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  const dir = config.paths.valheimServerDir;
  const downloadUrl = buildDownloadUrl(pkg.source, pkg.owner, pkg.name, pkg.version);
  const tmp = `/tmp/bepinex_setup_$$`;
  const cmd = [
    `echo "[step] installing BepInExPack_Valheim v${pkg.version} from ${pkg.source} into ${dir}..."`,
    `\\rm -rf ${shq(tmp)}`,
    `mkdir -p ${shq(tmp)}`,
    `curl -sL --connect-timeout 15 --max-time 180 ${shq(downloadUrl)} -o ${shq(tmp)}/pack.zip`,
    `if [ ! -s ${shq(tmp)}/pack.zip ]; then echo "[error] downloaded file is empty — check the download URL is still valid: ${downloadUrl}"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `if ! head -c 2 ${shq(tmp)}/pack.zip | grep -q PK; then echo "[error] downloaded file is not a valid zip"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `cd ${shq(tmp)} && unzip -oq pack.zip -d extracted; UNZIP_EC=$?; cd - >/dev/null; ` +
      `if [ "$UNZIP_EC" -gt 1 ]; then echo "[error] unzip exited with code $UNZIP_EC"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // The package zip has manifest.json / icon.png / README.md at its top level and the
    // files that belong in the game folder inside a "BepInExPack_Valheim/" wrapper folder
    // (the same thing mod managers special-case). Merge that folder's CONTENTS: find the
    // folder holding start_server_bepinex.sh. Only if the pack has no such file, fall back to
    // "a single wrapper folder and nothing else".
    `SRC=${shq(tmp)}/extracted; ` +
      `MARK="$(find "$SRC" -maxdepth 3 -type f -name start_server_bepinex.sh | head -n 1)"; ` +
      `if [ -n "$MARK" ]; then SRC="$(dirname "$MARK")"; ` +
      `elif [ "$(find "$SRC" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$SRC" -mindepth 1 -maxdepth 1)" ]; then SRC="$(find "$SRC" -mindepth 1 -maxdepth 1)"; fi; ` +
      `chmod -R u+rwX,go+rX "$SRC"; ` +
      `\\cp -rf "$SRC"/. ${shq(dir)}/`,
    `chmod u+x ${shq(dir)}/start_server_bepinex.sh 2>/dev/null; chmod u+x ${shq(dir)}/start_game_bepinex.sh 2>/dev/null; true`,
    `\\rm -rf ${shq(tmp)}`,
    `if [ ! -f ${shq(dir)}/start_server_bepinex.sh ]; then echo "[error] extraction finished but start_server_bepinex.sh is missing from ${dir} — the pack's layout may have changed, check manually"; exit 1; fi`,
    // Same reasoning as install-server above: this ran as root over SSH,
    // so the BepInEx files just merged in are root-owned. LGSM's ownership
    // check would otherwise block every future start.
    `chown -R ${shq(config.lgsmUser || 'vhserver')}:${shq(config.lgsmUser || 'vhserver')} ${shq(dir)}`,
    `echo "[done] BepInEx files placed in ${dir}. Next: use the preview/apply buttons below to wire common.cfg's doorstop env vars, then Stop and Start the server from the Dashboard."`,
  ].join(' && ');
  sshExecStream(asRootScript(cmd), res, { idleMs: 600000 });
});

// Computes (but does not apply) the common.cfg addition needed to launch
// through BepInEx under LGSM: LGSM has no ExecStart= line to swap — the
// dedicated server binary is always launched the same way — so what's
// actually needed is the four `export DOORSTOP_*`/`export LD_*` lines that
// route that launch through BepInEx's doorstop injector instead of running
// Valheim bare. Read-only. Idempotent via BEPINEX_MARKER: re-running when
// already wired reports alreadyWired instead of proposing a duplicate block.
const BEPINEX_MARKER = '# --- BepInEx doorstop (added by valheim-gui) ---';

async function computeDoorstopChange() {
  const cfgPath = config.paths.commonCfgPath;
  const dir = config.paths.valheimServerDir;
  if (!cfgPath || !dir) return { error: 'paths.commonCfgPath and paths.valheimServerDir must both be set in config.json' };

  const r = await sshExec(`cat ${shq(cfgPath)} 2>/dev/null`);
  const current = r.stdout;
  if (!current) return { error: `couldn't read ${cfgPath} — check paths.commonCfgPath is correct and the file exists on the VPS` };

  const alreadyWired = current.includes(BEPINEX_MARKER) && current.includes('DOORSTOP_ENABLED=1');
  const proposedBlock = [
    BEPINEX_MARKER,
    'export DOORSTOP_ENABLED=1',
    `export DOORSTOP_TARGET_ASSEMBLY="${dir}/BepInEx/core/BepInEx.Preloader.dll"`,
    `export LD_LIBRARY_PATH="${dir}/doorstop_libs:\${LD_LIBRARY_PATH}"`,
    // Absolute path, not a bare filename — this project already hit a real
    // bug where a bare "libdoorstop_x64.so" depended on LD_LIBRARY_PATH
    // ordering/timing during LGSM's own startup and silently failed to
    // preload. The absolute path removes that dependency entirely.
    `export LD_PRELOAD="${dir}/doorstop_libs/libdoorstop_x64.so"`,
  ].join('\n');

  return {
    currentContent: current,
    proposedBlock,
    alreadyWired,
    cfgPath,
  };
}

app.get('/api/setup/systemd-preview', async (req, res) => {
  try {
    const result = await computeDoorstopChange();
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Applies the block computed above. Re-computes it server-side rather than
// trusting anything from the request body, so this can only ever apply the
// exact same block the preview call just showed the human — nothing else is
// editable through this endpoint. Backs up common.cfg first; does NOT
// restart the service (use the Dashboard's Stop, then Start once this is
// applied, so the live process only bounces on an explicit, separate
// action — env var changes in common.cfg only take effect on next start).
app.post('/api/setup/systemd-apply', async (req, res) => {
  try {
    const result = await computeDoorstopChange();
    if (result.error) return res.status(400).json({ error: result.error });
    if (result.alreadyWired) return res.json({ ...result, applied: false, note: 'already wired to BepInEx — nothing to change' });

    const cfgPath = config.paths.commonCfgPath;
    const backupPath = `${cfgPath}.bak.${Date.now()}`;
    // Base64-encode the block before interpolating it into the remote
    // command — same reasoning as the old systemd version had: no shell
    // metacharacters to worry about no matter what the paths contain.
    const blockB64 = Buffer.from(`\n${result.proposedBlock}\n`, 'utf8').toString('base64');
    const cmd = [
      // -p keeps the file's owner: LinuxGSM refuses to start the server when anything under its
      // lgsm/ folder (which holds common.cfg) is not owned by the game account.
      maybeSudo(`cp -p ${shq(cfgPath)} ${shq(backupPath)}`),
      // Appended, not substituted — common.cfg has no existing doorstop
      // lines to replace on a fresh install, unlike the old single
      // ExecStart= line. Written through sudo so only the actual write
      // needs elevation, same convention as the old apply endpoint.
      `printf '%s' ${shq(blockB64)} | base64 -d | ${maybeSudo(`tee -a ${shq(cfgPath)}`)} >/dev/null`,
      `echo APPLIED`,
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) {
      return res.status(500).json({ error: `command did not complete as expected: ${r.stdout} ${r.stderr}` });
    }
    res.json({ ...result, applied: true, backupPath, note: 'Added to common.cfg. Stop and Start the server from the Dashboard to pick it up.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolves ValheimEnforcer's current version/source so the frontend can
// hand it straight to the existing, already-battle-tested /api/mods/install
// endpoint — ValheimEnforcer is, from Thunderstore/Hexium's point of view,
// just a normal BepInEx plugin, so it doesn't need its own install logic.
app.get('/api/setup/enforcer-version', async (req, res) => {
  try {
    const pkg = await findLatestPackage('MidnightMods', 'ValheimEnforcer');
    if (!pkg) return res.status(404).json({ error: 'could not find MidnightMods-ValheimEnforcer on Thunderstore or Hexium right now' });
    // Enforcer needs Jotunn (and whatever Jotunn needs). A plain install of
    // the plugin alone makes BepInEx refuse to load it ("missing dependencies:
    // com.jotunn.jotunn"), so resolve the chain here and report only what the
    // plugins folder doesn't already contain, dependencies first.
    const lsr = await sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`);
    const have = lsr.stdout.split('\n').filter(Boolean).map(normalize);
    const isInstalled = (name) => { const n = normalize(name); return have.some((f) => f === n || f.includes(n)); };
    const ordered = [];
    const seen = new Set();
    const visit = async (src, owner, name, version, depth) => {
      if (depth > 4) return;
      let pkgs;
      try { pkgs = await getPackages(src); } catch (e) { return; }
      const hit = pkgs.find((p) => p.owner === owner && p.name === name);
      const ver = hit && (hit.versions.find((v) => v.version_number === version) || hit.versions[0]);
      for (const depStr of (ver && ver.dependencies) || []) {
        const d = parseDependencyString(depStr);
        if (/bepinexpack/i.test(d.name)) continue;
        const key = normalize(`${d.owner}-${d.name}`);
        if (seen.has(key)) continue;
        seen.add(key);
        const latest = await findLatestPackage(d.owner, d.name);
        if (!latest) { ordered.push({ owner: d.owner, name: d.name, version: d.version, source: null, missing: true, installed: isInstalled(d.name) }); continue; }
        await visit(latest.source, latest.owner, latest.name, latest.version, depth + 1);
        ordered.push({ ...latest, installed: isInstalled(latest.name) });
      }
    };
    await visit(pkg.source, pkg.owner, pkg.name, pkg.version, 0);
    res.json({ ...pkg, dependencies: ordered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================================
// Project Zomboid — a second game managed from this same GUI, on the same
// VPS (same SSH/local connection as Valheim above — nothing here opens a
// second connection). Fully additive: nothing in this section is called by,
// or changes the behavior of, anything above it. No Mods or Setup tab here
// on purpose — Steam Workshop mods are wired directly into servertest.ini
// per the setup guide, not managed from this GUI, and there's no bootstrap
// wizard equivalent (yet).
// ==========================================================================

const PZ = config.zomboid || null;

// Live server output lives directly in the Zomboid data dir as
// server-console.txt — NOT under Logs/, which only holds timestamped/zipped
// archives from past sessions (confirmed against the Project Zomboid
// Dedicated Server Setup Guide). This is Zomboid's equivalent of Valheim's
// BepInEx LogOutput.log for tailing purposes.
const PZ_LOG_FILE = PZ ? `${PZ.dataDir}/server-console.txt` : null;

function requirePz(req, res) {
  if (!PZ || !PZ.enabled) {
    res.status(404).json({ error: 'Project Zomboid is not configured — add a "zomboid" block to config.json' });
    return false;
  }
  return true;
}

// Shells out to mcrcon (github.com/Tiiffi/mcrcon — not an apt package on
// Ubuntu, built from source per its own INSTALL.md). Returns {ok, output}
// rather than throwing: a wrong password or a down server are routine,
// expected outcomes here, not exceptional ones. The three error strings
// matched below are mcrcon's own literal stdout/stderr text, confirmed
// directly against its source (mcrcon.c) rather than guessed.
async function pzRcon(command) {
  if (!PZ.rcon || !PZ.rcon.password) {
    return { ok: false, output: 'RCON password is not set — add it to zomboid.rcon.password in config.json.' };
  }
  const cmd = `mcrcon -H 127.0.0.1 -P ${PZ.rcon.port || 27015} -p ${shq(PZ.rcon.password)} ${shq(command)} 2>&1`;
  const r = await sshExec(cmd);
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (/command not found|No such file or directory/i.test(out)) {
    return { ok: false, output: "mcrcon isn't installed on the VPS (it's built from source, not an apt package — see github.com/Tiiffi/mcrcon)." };
  }
  if (/Authentication failed/i.test(out)) {
    return { ok: false, output: "RCON authentication failed — zomboid.rcon.password in config.json doesn't match RCONPassword in servertest.ini." };
  }
  if (/Connection failed/i.test(out)) {
    return { ok: false, output: 'Could not reach RCON — is the server running, and does zomboid.rcon.port match RCONPort in servertest.ini?' };
  }
  return { ok: true, output: out };
}

// ---- Status / info / service actions ----

app.get('/api/pz/status', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const svc = PZ.serviceName;
    const port = (PZ.connect && PZ.connect.port) || 16261;
    // Same "is the port actually open" check as Valheim's /api/status,
    // adapted for Zomboid's default UDP port.
    const r = await sshExec(
      `systemctl is-active ${svc} 2>/dev/null; echo ---; ` +
        `systemctl show ${svc} --property=ActiveEnterTimestamp --value 2>/dev/null; echo ---; ` +
        `PORT_HEX=$(printf '%04X' ${port}); ` +
        `cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk -v want="$PORT_HEX" '{ n=split($2,a,":"); if (toupper(a[n]) == want) f=1 } END { exit !f }' && echo LISTENING || echo NOT_LISTENING`
    );
    const [state, since, portStatus] = r.stdout.split('---').map((s) => s.trim());
    res.json({
      state: state || 'unknown',
      since: since || null,
      portOpen: portStatus === 'LISTENING',
      port,
      connectHost: config.publicHost || config.ssh.host || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/server/:action', async (req, res) => {
  if (!requirePz(req, res)) return;
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  try {
    // KillSignal=SIGINT in the unit (per the setup guide) lets systemctl
    // stop/restart flush the world save cleanly — no separate "graceful
    // stop via RCON quit" path needed here.
    const r = await sshExec(maybeSudo(`systemctl ${action} ${PZ.serviceName}`));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- System resource stats (its own CPU sampler, independent of Valheim's) ----

let lastPzCpuSample = null; // { pid, ticks, atMs }

app.get('/api/pz/system/stats', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await sshExec(
      `nproc; echo ---; cat /proc/loadavg; echo ---; free -m; echo ---; df -h / | tail -1; echo ---; ` +
        `PID=$(systemctl show ${PZ.serviceName} -p MainPID --value 2>/dev/null); ` +
        `if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/stat" ]; then ` +
        `echo "PID=$PID"; awk '{print $14, $15}' "/proc/$PID/stat"; else echo NOPID; fi`
    );
    const [coresRaw, loadRaw, freeRaw, diskRaw, procRaw] = r.stdout.split('---').map((s) => s.trim());
    const cores = parseInt(coresRaw, 10) || 1;
    const load = loadRaw.split(' ').slice(0, 3).map(Number);
    const memLine = freeRaw.split('\n').find((l) => l.startsWith('Mem:'));
    const memParts = memLine ? memLine.trim().split(/\s+/) : [];
    const memTotalMB = parseInt(memParts[1], 10) || 0;
    const memUsedMB = parseInt(memParts[2], 10) || 0;
    const diskParts = diskRaw.trim().split(/\s+/);

    // Same delta-based per-process %CPU as Valheim's sampler (see the
    // comment above /api/system/stats) — 100% = one full core, top/htop
    // convention — but with its own independent sample state so polling
    // one game's stats never disturbs the other's baseline.
    let pzRunning = false;
    let pzPid = null;
    let pzCpuPercent = null;
    const procLines = (procRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (procLines[0] && procLines[0].startsWith('PID=') && procLines[1]) {
      pzRunning = true;
      pzPid = procLines[0].slice(4);
      const [utime, stime] = procLines[1].split(/\s+/).map(Number);
      const ticks = (utime || 0) + (stime || 0);
      const now = Date.now();
      if (lastPzCpuSample && lastPzCpuSample.pid === pzPid) {
        const dTicks = ticks - lastPzCpuSample.ticks;
        const dSecs = (now - lastPzCpuSample.atMs) / 1000;
        if (dSecs > 0.5) pzCpuPercent = Math.max(0, Math.round((dTicks / 100 / dSecs) * 100));
      }
      lastPzCpuSample = { pid: pzPid, ticks, atMs: now };
    } else {
      lastPzCpuSample = null;
    }

    res.json({
      cores,
      loadAvg: load,
      cpuPercent: Math.min(100, Math.round((load[0] / cores) * 100)),
      memTotalMB,
      memUsedMB,
      memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
      diskTotal: diskParts[1],
      diskUsed: diskParts[2],
      diskPercent: parseInt(diskParts[4], 10) || null,
      pzRunning,
      pzPid,
      pzCpuPercent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Players (via RCON — Zomboid has no BepInEx-style log to tail) ----

app.get('/api/pz/players', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await pzRcon('players');
    if (!r.ok) return res.json({ players: [], error: r.output });
    // Project Zomboid's documented `players` response is a header line
    // ("Players connected (N):") followed by one "-Name" line per player.
    // Parsed leniently here since it hasn't been checked against a real
    // server response yet — worth a quick sanity check once this is live.
    const players = r.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic RCON passthrough — quick-action buttons (save/players/broadcast/
// kick/ban) and the free-form command box on the PZ dashboard both call
// this one endpoint.
app.post('/api/pz/rcon', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { command } = req.body || {};
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'missing command' });
  try {
    const r = await pzRcon(String(command).trim());
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Mods (Steam Workshop) ----
// The running server already fetches/updates whatever WorkshopItems= lists
// at its own startup (per the setup guide) — nothing here duplicates that
// or touches the live process. This only edits two paired lines in
// servertest.ini (WorkshopItems= and Mods=) plus a small sidecar JSON file
// that remembers which Workshop ID contributed which internal Mod ID(s),
// since the ini itself doesn't encode that relationship.

const PZ_INI_PATH = PZ ? `${PZ.dataDir}/Server/${PZ.serverName}.ini` : null;
const PZ_MODS_SIDECAR = PZ ? `${PZ.dataDir}/Server/zomboid-mods.json` : null;
// The base game's app id — Workshop content for Zomboid is registered
// there, not under the dedicated server tool's own app id (380870).
// Confirmed directly against community server-setup guides.
const PZ_WORKSHOP_APPID = 108600;

// Accepts a bare numeric ID or a workshop page URL (both the current
// /sharedfiles/ path and the older /workshop/ path use ?id=).
function pzExtractWorkshopId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

function pzParseIniList(iniText, key) {
  const m = iniText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return [];
  return m[1].split(';').map((s) => s.trim()).filter(Boolean);
}

async function pzReadIni() {
  const r = await sshExec(`cat ${shq(PZ_INI_PATH)} 2>/dev/null`);
  return { text: r.stdout, workshopItems: pzParseIniList(r.stdout, 'WorkshopItems'), mods: pzParseIniList(r.stdout, 'Mods') };
}

async function pzReadModsSidecar() {
  try {
    const r = await sshExec(`cat ${shq(PZ_MODS_SIDECAR)} 2>/dev/null`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : {};
  } catch (e) {
    return {}; // missing/unreadable/corrupt — start fresh rather than failing the whole request
  }
}

async function pzWriteModsSidecar(data) {
  const b64 = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
  await sshExec(`echo ${shq(b64)} | base64 -d > ${shq(PZ_MODS_SIDECAR)}`);
}

// Rewrites WorkshopItems=/Mods= in place — every other line of the ini is
// left untouched — after backing up the ini first. Base64-encodes both
// replacement lines before interpolating them into the remote command (same
// technique as the Setup tab's systemd-apply): servertest.ini values can
// contain characters that would otherwise need careful shell-escaping, and
// base64's alphabet sidesteps that entirely. The read (awk > tmp) and the
// write (cp tmp back over the original) are kept as separate steps
// deliberately — piping `awk file | tee file` reads and truncates the same
// file at once, which is a real race; `cp` onto an existing file preserves
// its owner/permissions (pzuser), which a plain `>` from a fresh awk output
// would not.
async function pzWriteIniLists(workshopItems, mods) {
  const wsLine = `WorkshopItems=${workshopItems.join(';')}`;
  const modsLine = `Mods=${mods.join(';')}`;
  const wsB64 = Buffer.from(wsLine, 'utf8').toString('base64');
  const modsB64 = Buffer.from(modsLine, 'utf8').toString('base64');
  const backupPath = `${PZ_INI_PATH}.bak.${Date.now()}`;
  const tmpPath = `${PZ_INI_PATH}.tmp.${Date.now()}`;
  const cmd = [
    `cp ${shq(PZ_INI_PATH)} ${shq(backupPath)}`,
    `WSLINE="$(printf '%s' ${shq(wsB64)} | base64 -d)"`,
    `MODSLINE="$(printf '%s' ${shq(modsB64)} | base64 -d)"`,
    `awk -v ws="$WSLINE" -v mods="$MODSLINE" '` +
      `{ if ($0 ~ /^WorkshopItems=/) { print ws; wsSeen=1 } ` +
      `else if ($0 ~ /^Mods=/) { print mods; modsSeen=1 } ` +
      `else print } ` +
      `END { if (!wsSeen) print ws; if (!modsSeen) print mods }` +
      `' ${shq(PZ_INI_PATH)} > ${shq(tmpPath)}`,
    `cp ${shq(tmpPath)} ${shq(PZ_INI_PATH)}`,
    `rm -f ${shq(tmpPath)}`,
    `echo APPLIED`,
  ].join(' && ');
  const r = await sshExec(cmd);
  if (!r.stdout.includes('APPLIED')) throw new Error(`ini write did not complete as expected: ${r.stdout} ${r.stderr}`);
  return backupPath;
}

app.get('/api/pz/mods/list', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const [sidecar, ini] = await Promise.all([pzReadModsSidecar(), pzReadIni()]);
    const managedModIds = new Set();
    const entries = ini.workshopItems.map((id) => {
      const rec = sidecar[id] || {};
      (rec.modIds || []).forEach((m) => managedModIds.add(m));
      return {
        workshopId: id,
        name: rec.name || `Workshop ${id}`,
        modIds: rec.modIds || [],
        addedAt: rec.addedAt || null,
        unrecorded: !sidecar[id],
      };
    });
    const unmanagedModIds = ini.mods.filter((id) => !managedModIds.has(id));
    res.json({ entries, unmanagedModIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pre-fetches a Workshop item with SteamCMD (into the server's own install
// dir — the exact cache location it uses itself at startup, so nothing here
// is wasted) and scans the result for mod.info, which is the only reliable
// source for a mod's internal ID(s) — a single Workshop item occasionally
// bundles more than one. Read-only: does not touch the ini. Same
// steamcmd/app-id combination as the setup guide's own manual instructions.
app.post('/api/pz/mods/detect', async (req, res) => {
  if (!requirePz(req, res)) return;
  const workshopId = pzExtractWorkshopId((req.body || {}).input);
  if (!workshopId) {
    return res.status(400).json({ error: "Couldn't find a Workshop ID in that — paste the numeric ID or the workshop page URL." });
  }
  try {
    const contentDir = `${PZ.installDir}/steamapps/workshop/content/${PZ_WORKSHOP_APPID}/${workshopId}`;
    const cmd =
      `steamcmd +force_install_dir ${shq(PZ.installDir)} +login anonymous +workshop_download_item ${PZ_WORKSHOP_APPID} ${workshopId} +quit 2>&1; ` +
      `echo ---; ` +
      `find ${shq(contentDir)} -name mod.info 2>/dev/null -exec sh -c ` +
      `'id=$(grep -m1 "^id=" "$1" | cut -d= -f2-); name=$(grep -m1 "^name=" "$1" | cut -d= -f2-); printf "%s\\t%s\\n" "$id" "$name"' _ {} \\;`;
    const r = await sshExec(cmd);
    const [dlOutput, foundRaw] = r.stdout.split('---');
    const mods = (foundRaw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, name] = l.split('\t');
        return { id: (id || '').trim(), name: (name || '').trim() };
      })
      .filter((m) => m.id);
    if (!mods.length) {
      const tail = (dlOutput || '').trim().split('\n').slice(-6).join('\n');
      return res.json({ workshopId, mods: [], error: tail ? `Last steamcmd output:\n${tail}` : undefined });
    }
    res.json({ workshopId, mods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/add', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { workshopId, mods, name } = req.body || {}; // mods: [{id, name}]
  if (!workshopId || !Array.isArray(mods) || !mods.length) {
    return res.status(400).json({ error: 'missing workshopId or mods' });
  }
  try {
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    if (workshopItems.includes(String(workshopId))) {
      return res.status(400).json({ error: 'That Workshop item is already added.' });
    }
    const newModIds = mods.map((m) => String(m.id || '').trim()).filter(Boolean);
    if (!newModIds.length) return res.status(400).json({ error: 'No Mod IDs given.' });
    const mergedWs = [...workshopItems, String(workshopId)];
    const mergedMods = [...currentModIds, ...newModIds.filter((id) => !currentModIds.includes(id))];
    const backupPath = await pzWriteIniLists(mergedWs, mergedMods);
    const sidecar = await pzReadModsSidecar();
    sidecar[workshopId] = {
      modIds: newModIds,
      name: (name || '').trim() || mods.map((m) => m.name).filter(Boolean).join(', ') || `Workshop ${workshopId}`,
      addedAt: new Date().toISOString(),
    };
    await pzWriteModsSidecar(sidecar);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/remove', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { workshopId } = req.body || {};
  if (!workshopId) return res.status(400).json({ error: 'missing workshopId' });
  try {
    const sidecar = await pzReadModsSidecar();
    const entry = sidecar[workshopId];
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    const remainingWs = workshopItems.filter((id) => id !== String(workshopId));
    // Only drop mod ids this entry owned, and only if no other remaining
    // sidecar entry still claims the same id (two Workshop items can rarely
    // share an internal Mod ID — a shared framework dependency, say).
    const stillClaimed = new Set();
    Object.entries(sidecar).forEach(([id, rec]) => {
      if (id !== String(workshopId)) (rec.modIds || []).forEach((m) => stillClaimed.add(m));
    });
    const toDrop = new Set((entry && entry.modIds) || []);
    const remainingMods = currentModIds.filter((id) => !toDrop.has(id) || stillClaimed.has(id));
    const backupPath = await pzWriteIniLists(remainingWs, remainingMods);
    delete sidecar[workshopId];
    await pzWriteModsSidecar(sidecar);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/reorder', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { order } = req.body || {}; // array of workshopId strings, new order
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'missing order' });
  try {
    const sidecar = await pzReadModsSidecar();
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    // Anything the client didn't send (shouldn't normally happen) is kept,
    // appended at the end, rather than silently dropped.
    const known = new Set(order.map(String));
    const finalWs = [...order.map(String), ...workshopItems.filter((id) => !known.has(id))];
    const managedModIds = new Set();
    Object.values(sidecar).forEach((rec) => (rec.modIds || []).forEach((m) => managedModIds.add(m)));
    const orderedModIds = [];
    finalWs.forEach((id) => {
      const rec = sidecar[id];
      if (rec) (rec.modIds || []).forEach((m) => { if (!orderedModIds.includes(m)) orderedModIds.push(m); });
    });
    // Unmanaged mod ids (in Mods= from before this feature existed, or
    // added by hand) keep their place at the end, untouched by reordering.
    currentModIds.forEach((id) => {
      if (!managedModIds.has(id) && !orderedModIds.includes(id)) orderedModIds.push(id);
    });
    const backupPath = await pzWriteIniLists(finalWs, orderedModIds);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Backups ----
// No dedicated backup script exists for PZ (unlike Valheim's
// backup-valheim.sh) — the setup guide's own approach is a plain tar of the
// whole ~/Zomboid folder (Saves + Server config together), so that's what
// this runs directly instead of requiring a script to be deployed first.

app.get('/api/pz/backup/run', (req, res) => {
  if (!requirePz(req, res)) return;
  const parentDir = path.dirname(PZ.dataDir);
  const baseName = path.basename(PZ.dataDir);
  const stamp = 'zomboid-$(date +%Y%m%d-%H%M%S).tar.gz';
  const cmd = [
    `mkdir -p ${shq(PZ.backupDir)}`,
    `cd ${shq(parentDir)}`,
    `tar -czf ${shq(PZ.backupDir)}/${stamp} ${shq(baseName)}`,
    `echo "BACKED UP"`,
  ].join(' && ');
  sshExecStream(cmd, res);
});

app.get('/api/pz/backup/list', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await sshExec(`ls -1t ${shq(PZ.backupDir)} 2>/dev/null | head -50`);
    res.json({ files: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore: stop the service, extract the chosen backup tarball back over
// ~/Zomboid (Saves + Server together, matching how backup/run created it),
// restart. Same integrity-check-before-touching-anything approach as
// Valheim's /api/backup/restore.
app.post('/api/pz/backup/restore', (req, res) => {
  if (!requirePz(req, res)) return;
  const { file } = req.body;
  if (!file) return res.status(400).json({ error: 'missing file' });
  const svc = PZ.serviceName;
  const backupPath = `${PZ.backupDir}/${file}`;
  const parentDir = path.dirname(PZ.dataDir);
  const cmd = [
    `echo "Verifying backup integrity before touching anything..."`,
    `tar -tzf ${shq(backupPath)} > /dev/null`,
    `echo "Backup verified OK."`,
    maybeSudo(`systemctl stop ${svc}`),
    `echo "Stopped ${svc}, extracting ${file}..."`,
    `tar -xzf ${shq(backupPath)} -C ${shq(parentDir)}`,
    `echo "Extracted. Starting ${svc}..."`,
    maybeSudo(`systemctl start ${svc}`),
    `echo "RESTORED ${file}"`,
  ].join(' && ');
  sshExecPlainStream(cmd, res);
});

// ---- Updates ----
// No separate "check" script exists for PZ either — the guide's own update
// flow is just re-running the SteamCMD install command, which is a no-op if
// already current and prints what it changed either way. That doubles as
// both check and apply, streamed live so a mod-compatibility warning (see
// the guide's closing note) is visible as it happens.

app.get('/api/pz/update/apply', (req, res) => {
  if (!requirePz(req, res)) return;
  const cmd = [
    maybeSudo(`systemctl stop ${PZ.serviceName}`),
    `steamcmd +force_install_dir ${shq(PZ.installDir)} +login anonymous +app_update 380870 validate +quit`,
    maybeSudo(`systemctl start ${PZ.serviceName}`),
    `echo "UPDATE APPLIED"`,
  ].join(' && ');
  sshExecStream(cmd, res);
});

// ---- Logs ----
// Same shape as Valheim's /api/logs/* — journal, plus a direct file tail,
// plus a live follow of either. PZ_LOG_FILE (server-console.txt) stands in
// for Valheim's config.paths.logFile.

app.get('/api/pz/logs/tail', async (req, res) => {
  if (!requirePz(req, res)) return;
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(PZ_LOG_FILE)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pz/logs/journal', async (req, res) => {
  if (!requirePz(req, res)) return;
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`journalctl -u ${PZ.serviceName} -n ${lines} --no-pager`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live-follow either the journal or server-console.txt itself.
app.get('/api/pz/logs/live', (req, res) => {
  if (!requirePz(req, res)) return;
  const source = req.query.source === 'tail' ? 'tail' : 'journal';
  const cmd =
    source === 'tail'
      ? `tail -n 20 -F ${shq(PZ_LOG_FILE)}`
      : `journalctl -u ${PZ.serviceName} -n 20 -f --no-pager`;
  sshExecFollow(cmd, req, res);
});

const PORT = config.guiPort || 4173;
// Bind to localhost only. Without an explicit host, Node listens on ALL
// network interfaces — meaning anyone on your LAN (or the internet, if this
// port is ever forwarded) could reach this with zero login and full control,
// including your VPS root password sitting in config.json. There is no
// legitimate reason for this to be reachable from anywhere but this machine.
// Keep this on 127.0.0.1. To reach a GUI running on the VPS, use an SSH
// tunnel or Tailscale Serve (see deploy/README-DEPLOY.md) — both forward to
// this localhost port without exposing it to the internet.
const BIND_HOST = config.bindHost || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  serving = true;
  console.log(`Valheim GUI running at http://${BIND_HOST === '127.0.0.1' ? 'localhost' : BIND_HOST}:${PORT} (mode: ${LOCAL_MODE ? 'local, on this machine' : 'ssh → ' + config.ssh.host})`);
  // Warm the package-list caches and the shared SSH connection in the
  // background so the first Mods-tab load doesn't pay for them.
  getThunderstorePackages().catch((e) => console.error('[pkg-cache] thunderstore warm-up failed:', e.message));
  getHexiumPackages().catch(() => {});
  getSharedConn().catch((e) => console.error('[ssh] initial connection failed:', e.message));
});
