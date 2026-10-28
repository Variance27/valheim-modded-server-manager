// Mods: Mods.yaml, its sidecar files, and how installed folders map to entries.

const path = require('path');
const yaml = require('js-yaml');
const { config } = require('./context');
const { sshExec, shq } = require('./exec');

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
// /api/mods/install (mod-actions.js), after every successful install AND update —
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

Object.assign(module.exports, { compareVersions, normalize, loadEnforcerConfig, loadOverrides, loadDllsByFolder, loadInstalledFrom, classifyMod, saveInstalledFrom });
