// Hexium/Thunderstore lookups: update candidates, search, versions and dependencies.

const zlib = require('zlib');
const { config } = require('./context');
const { sshExec, shq } = require('./exec');
const { app } = require('./app');
const modData = require('./mod-data');
const packageCache = require('./package-cache');
const setup = require('./setup');

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
  return chunkResults.flat().map((raw) => packageCache.slimPackage(normalizeHexiumPackage(raw)));
}

async function getHexiumPackages() {
  try {
    return await packageCache.cachedPackages('hexium', fetchHexiumPackages);
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
  return source === 'hexium' ? getHexiumPackages() : packageCache.getThunderstorePackages();
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
      if (versions.length) pkg = packageCache.slimPackage({ ...raw, owner: raw.owner || owner, name: raw.name || name, versions });
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
    if (!feedLatest || modData.compareVersions(freshLatest, feedLatest) > 0) return fresh;
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
  const displayNorm = modData.normalize(displayName);
  const guidOwnerGuess = guidHint ? modData.normalize(guidHint.split('.')[0]) : null;
  const folderIdentity = parseFolderIdentity(folderName);
  const out = [];

  // Strongest signal of all, checked before the hexium/thunderstore loop
  // below even runs: installedFrom (Mods.installedFrom.yaml — see
  // loadInstalledFrom/saveInstalledFrom in mod-data.js) records the EXACT
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
      const ownerNorm = modData.normalize(installedFrom.owner);
      const nameNorm = modData.normalize(installedFrom.name);
      let match = pkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === ownerNorm && modData.normalize(p.name) === nameNorm);
      match = await freshenPackage(installedFrom.source, match, installedFrom.owner, installedFrom.name);
      const latest = match && match.versions[0]?.version_number;
      if (latest) {
        const regression = modData.compareVersions(latest, currentVersion) < 0;
        return [
          {
            source: installedFrom.source,
            latestVersion: latest,
            namespace: match.owner,
            packageName: match.name,
            updateAvailable: !regression && modData.compareVersions(latest, currentVersion) !== 0,
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
      const pinOwnerNorm = modData.normalize(pinOwner);
      const pinNameNorm = modData.normalize(pinName);
      match =
        pkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === pinOwnerNorm && modData.normalize(p.name) === pinNameNorm) ||
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
      const ownerNorm = modData.normalize(folderIdentity.owner);
      const nameNorm = modData.normalize(folderIdentity.name);
      match =
        pkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === ownerNorm && modData.normalize(p.name) === nameNorm) || null;
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
      const wholeFolderNorm = modData.normalize(folderName);
      if (wholeFolderNorm) {
        const exact = pkgs.filter((p) => !p.is_deprecated && modData.normalize(p.name) === wholeFolderNorm);
        if (exact.length === 1) {
          match = exact[0];
        } else if (exact.length > 1) {
          const owned = guidOwnerGuess ? exact.find((p) => modData.normalize(p.owner) === guidOwnerGuess) : null;
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
      const candidates = pkgs.filter((p) => !p.is_deprecated && modData.normalize(p.name) === displayNorm);
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
          const candOwnerNorm = modData.normalize(p.owner);
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
    const regression = modData.compareVersions(latest, currentVersion) < 0;

    out.push({
      source,
      latestVersion: latest,
      namespace: match.owner,
      packageName: match.name,
      // Semantic comparison, not raw string equality — "1.113" and "1.113.0"
      // are the same version, but would never match as strings, causing a
      // false "update available" badge for something already up to date.
      updateAvailable: !regression && modData.compareVersions(latest, currentVersion) !== 0,
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
  if (modData.compareVersions(fv, update.latestVersion) < 0) return update;
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
      modData.loadEnforcerConfig().catch(() => null), // Non-fatal
      modData.loadOverrides(),
      modData.loadDllsByFolder(),
      modData.loadInstalledFrom(),
      // Kick off the package-list downloads in parallel with the SSH reads
      // (cached/shared — see cachedPackages) rather than after them.
      withUpdates ? getHexiumPackages().catch(() => null) : null,
      withUpdates ? packageCache.getThunderstorePackages().catch(() => null) : null,
    ]);
    const folders = r.stdout.split('\n').filter(Boolean);
    const mods = await Promise.all(
      folders.map(async (name) => {
        const { status, reason, entry, guid } = modData.classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
        // thunderstorePackage/hexiumPackage/ignoreUpdates all come from
        // Mods.overrides.yaml now, never the Mods.yaml entry itself — see
        // loadOverrides() for why.
        const override = (guid && overridesByGuid[guid]) || null;
        const pins = { thunderstore: override?.thunderstorePackage, hexium: override?.hexiumPackage };
        // ignoreUpdates (set via /api/mods/ignore-updates in mod-actions.js) skips the
        // update check entirely rather than just hiding the badge — for a
        // mod like ValheimModding-YamlDotNet's detector plugin, which always
        // reports a stale bundled-assembly version and so flags a permanent,
        // uninteresting "update available" that's never worth acting on.
        const ignoreUpdates = !!(override && override.ignoreUpdates);
        // installedFrom (Mods.installedFrom.yaml — see loadInstalledFrom
        // in mod-data.js) records the exact source this specific folder was actually
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
    const displayNorm = modData.normalize(displayName);
    const guidOwnerGuess = guidHint ? modData.normalize(guidHint.split('.')[0]) : null;
    const out = {};
    for (const source of ['thunderstore', 'hexium']) {
      let data;
      try {
        data = await getPackages(source);
      } catch (e) {
        data = [];
      }
      const candidates = data.filter((p) => !p.is_deprecated && modData.normalize(p.name) === displayNorm);
      out[source] = candidates
        .map((p) => ({
          namespace: p.owner,
          name: p.name,
          guidLikely: guidOwnerGuess ? modData.normalize(p.owner) === guidOwnerGuess || modData.normalize(p.owner).includes(guidOwnerGuess) : false,
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
    const installedNorms = installedFolders.map(modData.normalize);

    const parsed = deps
      .map(parseDependencyString)
      // BepInExPack itself is always "installed" by definition (it's the
      // framework everything runs under) — never worth flagging as missing.
      .filter((d) => !/bepinexpack/i.test(d.name))
      .map((d) => {
        const depNorm = modData.normalize(d.name);
        const installed = installedNorms.some((f) => f === depNorm || f.includes(depNorm) || depNorm.includes(f));
        return { ...d, installed };
      });

    res.json({ dependencies: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolves the full dependency chain of one package (transitively, dependencies first), reporting
// which of them the plugins folder already has. Used by the install prompt and by Setup (Enforcer).
async function resolveDependencyPlan(src, owner, name, version, haveFolders) {
  const have = haveFolders.map(modData.normalize);
  const isInstalled = (n) => {
    const x = modData.normalize(n);
    return have.some((f) => f === x || f.includes(x));
  };
  const ordered = [];
  const seen = new Set();
  const visit = async (s, o, n, v, depth) => {
    if (depth > 6) return;
    let pkgs;
    try {
      pkgs = await getPackages(s);
    } catch (e) {
      return;
    }
    const hit = pkgs.find((p) => p.owner === o && p.name === n);
    const ver = hit && (hit.versions.find((x) => x.version_number === v) || hit.versions[0]);
    for (const depStr of (ver && ver.dependencies) || []) {
      const d = parseDependencyString(depStr);
      if (/bepinexpack/i.test(d.name)) continue;
      const key = modData.normalize(`${d.owner}-${d.name}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const latest = await setup.findLatestPackage(d.owner, d.name);
      if (!latest) {
        ordered.push({ owner: d.owner, name: d.name, version: d.version, source: null, missing: true, installed: isInstalled(d.name) });
        continue;
      }
      await visit(latest.source, latest.owner, latest.name, latest.version, depth + 1);
      ordered.push({ ...latest, installed: isInstalled(latest.name) });
    }
  };
  await visit(src, owner, name, version, 0);
  return ordered;
}

// What installing this package would also need: every dependency, dependencies first.
app.get('/api/mods/dependency-plan', async (req, res) => {
  const { namespace, name, version, source } = req.query;
  if (!namespace || !name || !version) return res.status(400).json({ error: 'missing fields' });
  try {
    const lsr = await sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`);
    const have = lsr.stdout.split('\n').filter(Boolean);
    const dependencies = await resolveDependencyPlan(source === 'hexium' ? 'hexium' : 'thunderstore', namespace, name, version, have);
    res.json({ dependencies });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { getHexiumPackages, buildDownloadUrl, parseDependencyString, modPageUrl, galeInstallLink, getPackages, resolveDependencyPlan });
