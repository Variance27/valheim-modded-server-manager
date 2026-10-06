'use strict';
// Pure helpers for mod snapshots and rollback: turn a list of plugin folders into a comparable
// "mod set", and work out what it would take to get from the current set to a saved one.
// No network or SSH in here, so it can be unit-tested.

const { parseFolder, norm } = require('./modgraph');

// Compare dotted versions numerically ("1.10.0" > "1.9.0"). Returns -1, 0 or 1.
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// folders: plugin folder names. recs: Mods.installedFrom.yaml map (folder -> {source, owner, name, version}).
// A folder is "restorable" when we know which package and version it is, so it can be reinstalled later.
function entriesFromFolders(folders, recs = {}) {
  const out = [];
  for (const folder of [...new Set(folders || [])].sort((a, b) => a.localeCompare(b))) {
    const rec = recs && recs[folder];
    if (rec && rec.owner && rec.name && rec.version) {
      out.push({ folder, owner: rec.owner, name: rec.name, version: String(rec.version), source: rec.source === 'hexium' ? 'hexium' : 'thunderstore', restorable: true });
      continue;
    }
    const pf = parseFolder(folder);
    if (pf) out.push({ folder, owner: pf.owner, name: pf.name, version: pf.version, source: null, restorable: true });
    else out.push({ folder, owner: null, name: folder, version: null, source: null, restorable: false });
  }
  return out;
}

const keyOf = (e) => (e.owner ? `${norm(e.owner)}/${norm(e.name)}` : null);

// current/target: arrays from entriesFromFolders. Lines:
//   install    - in the snapshot, missing now          -> install target version
//   downgrade  - installed newer than the snapshot     -> reinstall the older version
//   upgrade    - installed older than the snapshot     -> reinstall the newer version
//   remove     - installed now, not in the snapshot    -> remove the folder
//   manual     - hand-named in the snapshot and missing now: cannot be reinstalled from here
// Hand-named folders that exist now but were not in the snapshot are left alone (we cannot tell what they are).
function planRestore(current, target) {
  const cur = new Map();
  for (const e of current || []) if (keyOf(e)) cur.set(keyOf(e), e);
  const curFolders = new Set((current || []).map((e) => e.folder));
  const lines = [];
  const seen = new Set();
  let unchanged = 0;
  for (const t of target || []) {
    const k = keyOf(t);
    if (!k) {
      if (!curFolders.has(t.folder)) lines.push({ action: 'manual', folder: t.folder, name: t.name });
      else unchanged++;
      continue;
    }
    seen.add(k);
    const c = cur.get(k);
    if (!c) {
      lines.push({ action: 'install', owner: t.owner, name: t.name, version: t.version, source: t.source, folder: t.folder });
      continue;
    }
    const d = cmpVersion(c.version, t.version);
    if (d === 0) unchanged++;
    else lines.push({ action: d > 0 ? 'downgrade' : 'upgrade', owner: t.owner, name: t.name, from: c.version, version: t.version, source: t.source || c.source, folder: c.folder });
  }
  for (const [k, c] of cur) {
    if (!seen.has(k)) lines.push({ action: 'remove', owner: c.owner, name: c.name, version: c.version, folder: c.folder });
  }
  const order = { downgrade: 0, upgrade: 1, install: 2, remove: 3, manual: 4 };
  lines.sort((a, b) => order[a.action] - order[b.action] || String(a.name).localeCompare(String(b.name)));
  return { lines, unchanged };
}

// Two mod sets are the same when they hold the same folders and the same package versions.
function sameSet(a, b) {
  const sig = (list) => JSON.stringify((list || []).map((e) => `${e.folder}|${e.version || ''}`).sort());
  return sig(a) === sig(b);
}

module.exports = { cmpVersion, entriesFromFolders, planRestore, sameSet };
