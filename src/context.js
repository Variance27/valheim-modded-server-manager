// Settings and worlds: config.json, instances.json, and the per-request `config` proxy.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'config.json');
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
// by the middleware in app.js), so no endpoint had to change. Anything that runs outside a
// request (start-up code) sees the main instance.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const INSTANCES_FILE = path.join(ROOT, 'instances.json');
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
const runtime = { serving: false };
const INSTANCE_KEYS = new Set(['paths', 'lgsmUser', 'lgsmServer', 'lgsmHome', 'worldName', 'connect']);
const config = new Proxy(
  {},
  {
    get(_, k) {
      if (process.env.VG_STRICT && runtime.serving && !als.getStore() && INSTANCE_KEYS.has(k)) console.warn(`[VG_STRICT] config.${String(k)} read outside a request context\n${new Error().stack.split('\n').slice(2, 6).join('\n')}`);
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

Object.assign(module.exports, { config, INSTANCE_ID_RE, getInstanceCtx, als, instanceCtx, readRegistry, curId, writeRegistry, instSfx, derivedPaths, runtime, ROOT });
