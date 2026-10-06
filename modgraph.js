'use strict';
// Pure helpers for the Mods tab's dependency prompts: work out which installed plugin folder is
// which Thunderstore/Hexium package, which installed mods need which, and what a removal would
// leave behind. No network or SSH in here, so it can be unit-tested.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "Owner-PackageName-1.2.3" -> { owner, name, version }; the package name may itself contain hyphens.
function parseDep(dep) {
  const parts = String(dep || '').split('-');
  return { owner: parts[0], name: parts.slice(1, -1).join('-'), version: parts[parts.length - 1] };
}

// A folder written by this GUI is "Owner-Name-<version>"; anything else is a hand-named folder.
function parseFolder(folder) {
  const m = /^([^-]+)-(.+)-(\d+(?:\.\d+){1,3})$/.exec(String(folder || ''));
  return m ? { owner: m[1], name: m[2], version: m[3] } : null;
}

const isFramework = (name) => /bepinexpack/i.test(name);

function findPkg(list, owner, name) {
  const o = norm(owner);
  const n = norm(name);
  return (list || []).find((p) => norm(p.owner) === o && norm(p.name) === n) || null;
}

function depsOf(pkg, version) {
  const v = (pkg.versions || []).find((x) => x.version_number === version) || (pkg.versions || [])[0];
  return ((v && v.dependencies) || []).map(parseDep).filter((d) => d.name && !isFramework(d.name));
}

// lists = { thunderstore: [pkg], hexium: [pkg] }; rec = Mods.installedFrom.yaml entry for the folder, if any.
function identifyFolder(folder, rec, lists) {
  const sources = ['thunderstore', 'hexium'];
  const hit = (src, owner, name, version) => {
    const pkg = findPkg(lists[src], owner, name);
    return pkg ? { owner: pkg.owner, name: pkg.name, source: src, version: version || null, deps: depsOf(pkg, version) } : null;
  };
  if (rec && rec.owner && rec.name) {
    const r = hit(rec.source === 'hexium' ? 'hexium' : 'thunderstore', rec.owner, rec.name, rec.version);
    if (r) return r;
  }
  const pf = parseFolder(folder);
  if (pf) {
    for (const s of sources) {
      const r = hit(s, pf.owner, pf.name, pf.version);
      if (r) return r;
    }
  }
  // Last resort: a hand-named folder that matches exactly one package name.
  const bare = norm(pf ? pf.name : folder);
  if (!bare) return null;
  const found = [];
  for (const s of sources) {
    for (const p of lists[s] || []) if (norm(p.name) === bare) found.push({ s, p });
  }
  const distinct = new Set(found.map((f) => `${norm(f.p.owner)}/${norm(f.p.name)}`));
  if (distinct.size !== 1) return null;
  return hit(found[0].s, found[0].p.owner, found[0].p.name, null);
}

// folders: [name]; recs: { folder: installedFrom record }; lists as above.
function buildGraph(folders, recs, lists) {
  return folders.map((folder) => {
    const id = identifyFolder(folder, (recs || {})[folder], lists);
    const pf = parseFolder(folder);
    return {
      folder,
      known: !!id,
      id: id ? norm(id.owner + id.name) : null,
      nameNorm: id ? norm(id.name) : norm(pf ? pf.name : folder),
      deps: id ? id.deps : [],
    };
  });
}

function needs(a, b) {
  return a.deps.some((d) => (b.id && norm(d.owner + d.name) === b.id) || norm(d.name) === b.nameNorm);
}

// What removing `targets` (folder names) touches: installed mods that need them, and the libraries
// they need, with who else still needs each library.
function planRemoval(nodes, targets) {
  const T = new Set(targets);
  const inT = nodes.filter((n) => T.has(n.folder));
  const rest = nodes.filter((n) => !T.has(n.folder));
  const dependents = rest
    .filter((n) => inT.some((t) => needs(n, t)))
    .map((n) => ({ folder: n.folder, needs: inT.filter((t) => needs(n, t)).map((t) => t.folder) }));
  const dependencies = rest
    .filter((n) => inT.some((t) => needs(t, n)))
    .map((n) => ({ folder: n.folder, neededBy: rest.filter((o) => o !== n && needs(o, n)).map((o) => o.folder) }));
  return { dependents, dependencies, unknown: inT.filter((t) => !t.known).map((t) => t.folder) };
}

module.exports = { norm, parseDep, parseFolder, identifyFolder, buildGraph, planRemoval };
