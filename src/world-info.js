// Which world a server runs, and where its files are.

const { curId, config } = require('./context');
const { shq, sshExec } = require('./exec');
const settings = require('./settings');

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
    const files = [settings.defaultCfgFile(), ...settings.cfgFilesToSearch()].filter(Boolean);
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
      const w = settings.parseCfgValue(parts[i] || '', 'worldname');
      const n = settings.parseCfgValue(parts[i] || '', 'servername');
      if (w !== null && w !== '') cfgWorld = expandSelfname(w);
      if (n !== null && n !== '') serverName = expandSelfname(n);
      const pt = settings.parseCfgValue(parts[i] || '', 'port');
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

Object.assign(module.exports, { getWorldInfo, worldInfoCaches, worldPaths, SAFE_WORLD_NAME, invalidateWorldInfo });
