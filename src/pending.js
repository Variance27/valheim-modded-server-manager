// Restart-required tracking (the banner listing changes that need Stop -> Start).

const fs = require('fs');
const path = require('path');
const { ROOT, curId } = require('./context');
const { sshExec } = require('./exec');
const { app } = require('./app');
const serverControl = require('./server-control');

// ---- Restart-required tracking (API: GET /api/pending-changes) ----
//
// Valheim reads launch settings, world modifiers, plugin configs and the mod set
// only when it starts. Every change made through this dashboard is noted here with
// a time; a change is "pending" while the running server was started BEFORE it.
// Stop -> Start makes the server newer than every note, so they clear by themselves.
// One list per world; the main world keeps the original file name.
const pendingLists = new Map(); // world id -> array
const pendingFile = (id) => path.join(ROOT, '.cache', id === 'main' ? 'pending-changes.json' : `pending-changes.${id}.json`);
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


app.get('/api/pending-changes', async (req, res) => {
  try {
    const r = await sshExec(`${serverControl.stateSnippet()}; echo ---; date +%s`);
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

// Mod installs/removals/enables/disables also need a restart to take effect. Registered for /api/mods
// in app.js, ahead of every route, so it sees every mod change whichever file defines the route.
function trackModChange(req, res, next) {
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
}

Object.assign(module.exports, { pendingFile, notePending, trackModChange });
