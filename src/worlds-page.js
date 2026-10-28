// The Worlds page: list, add, select and rename worlds.

const { readRegistry, getInstanceCtx, als, config, curId, writeRegistry } = require('./context');
const { sshExec, maybeSudo, shq } = require('./exec');
const { app } = require('./app');
const serverControl = require('./server-control');
const worldInfo = require('./world-info');
const bot = require('./bot');

// ---- Worlds (API: /api/instances) ----
//
// A world is a complete, separate server instance (own game account, files, mods, backups, port).
// Which world a request acts on is decided by the middleware in app.js; these endpoints manage
// the list itself. Removing a world forgets it in the GUI; with ?purge=1 it is also uninstalled from the VPS (see world-removal.js).
const worldList = () => ['main', ...readRegistry().map((i) => i.id)];
function inWorld(id, fn) {
  const ctx = getInstanceCtx(id);
  if (!ctx) throw new Error(`Unknown world "${id}"`);
  return als.run(ctx, fn);
}

async function worldSummary(id) {
  return inWorld(id, async () => {
    const [st, w] = await Promise.all([
      sshExec(`${serverControl.stateSnippet()}; echo ---; ${maybeSudo(`test -x ${shq(config.paths.lgsmScript)}`)} && echo INSTALLED`),
      worldInfo.getWorldInfo(),
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
      const w = await inWorld(id, async () => ({ info: await worldInfo.getWorldInfo(), label: config.instance.label }));
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
    const mainPort = (await inWorld('main', () => worldInfo.getWorldInfo())).port || 2456;
    const used = new Set([mainPort, ...reg.map((i) => i.plannedPort).filter(Boolean)]);
    let plannedPort = mainPort + 10;
    while ([...used].some((p) => portsOverlap(p, plannedPort))) plannedPort += 10;
    const entry = { id, label, lgsmUser, lgsmServer: 'vhserver', plannedPort, created: new Date().toISOString() };
    writeRegistry([...reg, entry]);
    bot.syncBotWorlds().catch(() => {});
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

Object.assign(module.exports, { otherWorldPorts, portsOverlap, inWorld, worldList, worldSummary });
