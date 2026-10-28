'use strict';
// Pure logic for Project Zomboid mod history (no I/O, so it can be tested on its own).
//
// A "mod set" is what the server's .ini and the GUI's sidecar file hold about mods:
//   { workshopItems: ['123', '456'],      WorkshopItems=  (load order)
//     mods:          ['ModA', 'ModB'],    Mods=
//     map:           'Muldraugh, KY',     Map=  ('' when the ini has no Map= line)
//     sidecar: { '123': { name, modIds: ['ModA'] } } }   which Workshop item brought which Mod ID(s)
//
// planRestore() says what it would take to go from the current set to a saved one, as lines the
// person can tick or untick. applyPlan() performs exactly the ticked lines and nothing else.

const str = (v) => String(v).trim();
const uniq = (list) => [...new Set(list)];

function normalize(set) {
  const s = set || {};
  const sidecar = {};
  for (const [id, rec] of Object.entries(s.sidecar || {})) {
    const r = rec || {};
    sidecar[str(id)] = {
      name: typeof r.name === 'string' ? r.name : '',
      modIds: uniq((Array.isArray(r.modIds) ? r.modIds : []).map(str).filter(Boolean)),
      ...(r.addedAt ? { addedAt: r.addedAt } : {}),
    };
  }
  return {
    workshopItems: uniq((s.workshopItems || []).map(str).filter(Boolean)),
    mods: uniq((s.mods || []).map(str).filter(Boolean)),
    map: typeof s.map === 'string' ? s.map.trim() : '',
    sidecar,
  };
}

// Mod IDs in Mods= that no Workshop item in the sidecar claims (added by hand, or before the GUI tracked them).
function unmanagedModIds(set) {
  const claimed = new Set();
  Object.values(set.sidecar).forEach((r) => r.modIds.forEach((m) => claimed.add(m)));
  return set.mods.filter((m) => !claimed.has(m));
}

// Same set? Order matters (it is the load order). Names and dates do not.
function sameSet(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  const ids = (s) => JSON.stringify(Object.keys(s.sidecar).sort().map((k) => [k, s.sidecar[k].modIds]));
  return JSON.stringify(x.workshopItems) === JSON.stringify(y.workshopItems)
    && JSON.stringify(x.mods) === JSON.stringify(y.mods)
    && x.map === y.map
    && ids(x) === ids(y);
}

const nameOf = (set, id) => (set.sidecar[id] && set.sidecar[id].name) || `Workshop ${id}`;

function planRestore(current, target) {
  const C = normalize(current);
  const T = normalize(target);
  const lines = [];
  const inC = new Set(C.workshopItems);
  const inT = new Set(T.workshopItems);

  for (const id of T.workshopItems) {
    if (inC.has(id)) continue;
    const rec = T.sidecar[id];
    lines.push({ key: `add:${id}`, action: 'add', workshopId: id, name: nameOf(T, id), modIds: rec ? rec.modIds : [], modIdsKnown: !!(rec && rec.modIds.length) });
  }
  for (const id of C.workshopItems) {
    if (!inT.has(id)) lines.push({ key: `remove:${id}`, action: 'remove', workshopId: id, name: nameOf(C, id), modIds: (C.sidecar[id] || {}).modIds || [] });
  }
  // Same items, different order?
  const commonC = C.workshopItems.filter((id) => inT.has(id));
  const commonT = T.workshopItems.filter((id) => inC.has(id));
  if (JSON.stringify(commonC) !== JSON.stringify(commonT)) lines.push({ key: 'order', action: 'order' });

  const uC = new Set(unmanagedModIds(C));
  const uT = new Set(unmanagedModIds(T));
  const cMods = new Set(C.mods);
  const tMods = new Set(T.mods);
  for (const m of uT) if (!cMods.has(m)) lines.push({ key: `modid-add:${m}`, action: 'modid-add', modId: m });
  for (const m of uC) if (!tMods.has(m)) lines.push({ key: `modid-remove:${m}`, action: 'modid-remove', modId: m });

  if (T.map && T.map !== C.map) lines.push({ key: 'map', action: 'map', from: C.map, to: T.map });

  const unchanged = C.workshopItems.filter((id) => inT.has(id)).length;
  return { lines, unchanged };
}

// Performs only the lines whose keys are in `keys`. Returns the new set to write; `map` is
// undefined when the Map= line is to be left alone.
function applyPlan(current, target, keys) {
  const C = normalize(current);
  const T = normalize(target);
  const plan = planRestore(C, T);
  const sel = new Set(keys);
  const known = new Set(plan.lines.map((l) => l.key));
  for (const k of sel) if (!known.has(k)) throw new Error(`"${k}" is not part of this restore plan`);

  let items = C.workshopItems.filter((id) => !sel.has(`remove:${id}`));
  const sidecar = {};
  for (const id of items) if (C.sidecar[id]) sidecar[id] = C.sidecar[id];
  for (const id of T.workshopItems) {
    if (sel.has(`add:${id}`)) {
      items.push(id);
      if (T.sidecar[id]) sidecar[id] = T.sidecar[id];
    }
  }
  if (sel.has('order')) {
    const pos = new Map(T.workshopItems.map((id, i) => [id, i]));
    const inTarget = items.filter((id) => pos.has(id)).sort((a, b) => pos.get(a) - pos.get(b));
    const rest = items.filter((id) => !pos.has(id));
    items = [...inTarget, ...rest];
  }

  // Mods= follows the Workshop order: each item's Mod IDs, then the hand-added ones.
  const claimed = new Set();
  const mods = [];
  for (const id of items) {
    for (const m of (sidecar[id] || {}).modIds || []) {
      claimed.add(m);
      if (!mods.includes(m)) mods.push(m);
    }
  }
  const keep = unmanagedModIds(C).filter((m) => !sel.has(`modid-remove:${m}`));
  const added = [...sel].filter((k) => k.startsWith('modid-add:')).map((k) => k.slice('modid-add:'.length));
  for (const m of [...keep, ...added]) if (!mods.includes(m)) mods.push(m);

  return { workshopItems: items, mods, map: sel.has('map') ? T.map : undefined, sidecar };
}

// "2 Workshop items, 5 Mod IDs" for the history list.
function describe(set) {
  const s = normalize(set);
  return { count: s.workshopItems.length, modCount: s.mods.length };
}

module.exports = { normalize, unmanagedModIds, sameSet, planRestore, applyPlan, describe };
