#!/usr/bin/env python3
"""
generate-codes.py — generates player/admin profile codes in the same
Thunderstore-format "r2x" export that Gale (the mod manager players use
instead of r2modman) and r2modman both read.

THE FLOW (folder-first, not Mods.yaml-first):
  1. The installed BepInEx/plugins FOLDER is the main basis for what gets
     downloaded. A folder written in the GUI's install-naming convention,
     "Owner-PackageName-Version" (e.g. "Azumatt-AAA_Crafting-2.1.10"), is
     already a complete, unique dependency string — it resolves to exactly
     one real package on Thunderstore or Hexium, no guessing, no candidate
     list. See resolve_package_for_folder()'s docstring for the full
     priority order (pin override > installedFrom record > this strict
     parse > lenient name match > hash verification > fuzzy match — the
     later ones only ever fire for a folder that predates the naming fix
     or was renamed by hand).
  2. Every installed folder gets resolved this way FIRST, independent of
     Mods.yaml.
  3. THEN each resolved folder is compared — by folder name OR by any .dll
     basename inside it — against Mods.yaml's requiredMods/adminOnlyMods
     (see classify_folder()) to decide which profile code(s) it belongs in:

       PLAYER code = folders that correlate to requiredMods
       ADMIN code  = folders that correlate to requiredMods + adminOnlyMods

     A folder that correlates to optionalMods or serverOnlyMods, or to
     nothing in Mods.yaml at all, is resolved (so any [AMBIGUOUS]/[CONFLICT]
     warnings still surface) but never included in either code — optional
     mods are, by definition, the player's own choice to add or not, and
     serverOnlyMods must never reach any client, admin included.

Mods.yaml (kept accurate by the GUI's install/update/remove/categorize
actions) is still what decides WHICH profile a mod belongs to and which
exact version to fetch — this just changed WHICH side drives the loop.

Each entry is matched against BOTH Thunderstore's and Hexium's live package
lists (same normalized-matching approach the GUI itself uses; deprecated
packages on either platform are never matched) to find its real
Owner/PackageName, then uses the EXACT version recorded in Mods.yaml — not
just whatever the latest published version happens to be. Handing a player
a newer version than the server has loaded would give them a file whose
hash doesn't match what ValheimEnforcer actually expects, which defeats the
whole point. If that exact version can't be found in a package's version
history, it falls back to latest and prints a loud warning — check any mod
that triggers this manually before trusting it. Every generated mod entry
carries a `source: Thunderstore` or `source: Hexium` field (matching Gale's
own export format exactly) so Gale knows which platform to actually fetch
each mod from on import — this is also why the code itself gets uploaded to
Hexium's create endpoint instead of Thunderstore's whenever the profile
contains at least one Hexium-sourced mod (same rule Gale itself uses).

If an entry has a `thunderstorePackage` or `hexiumPackage` override set,
its owner+name are used DIRECTLY on the matching platform and fuzzy
name-matching is skipped entirely for that mod. This matters for exactly
the cases fuzzy matching can't solve on its own: a generic mod name (e.g.
"BetterUI") that matches several unrelated packages, a mod whose real
maintained fork publishes under a name/owner nothing in Mods.yaml hints at
(e.g. Valheim Plus's actual current owner being "Grantapher", nothing like
the GUID "org.bepinex.plugins.valheim_plus"), or a mod that's Hexium-only.
The pin only settles WHICH PACKAGE this is — the version to actually use
still always comes from Mods.yaml's own live `version` field for that
entry, exactly like every other resolution path. The version written into
the pin string itself (move-mod.py still asks for "Owner-Name-Version",
matching how a package identity is normally written elsewhere) is used
only to confirm the pin points at a real, existing package at the moment
it's set — it is NEVER used as the version in a generated code, and a pin
never needs to be touched again just because the mod updated. Earlier
versions of this script used the pinned version verbatim forever, which
meant a pinned mod's code silently stopped updating the moment you pinned
it — fixed; see resolve_entries() below.

IMPORTANT — where these overrides actually live: NOT as extra fields
written directly into a Mods.yaml entry. ValheimEnforcer deserializes
Mods.yaml into its own internal model and rewrites the whole file from that
model on its own (confirmed: happens on every VPS/GUI restart) — it only
knows its own fields, so any extra key added directly to an entry gets
silently dropped the next time it does that. Instead, `folderName`,
`thunderstorePackage`, `hexiumPackage` (and the GUI's `ignoreUpdates`) all
live in a separate sidecar file next to Mods.yaml: Mods.overrides.yaml, a
flat "GUID: {field: value}" map ValheimEnforcer never touches at all, so
nothing it does can ever wipe it. Set these via move-mod.py, never by
hand-editing Mods.yaml itself:
    python3 move-mod.py Mods.yaml <mod> pin-thunderstore Grantapher-ValheimPlus_Grantapher_Temporary-10.1.2
    python3 move-mod.py Mods.yaml <mod> pin-hexium Smoothbrain-Network-1.1.1

A mod installed or updated through the GUI itself is resolved with even
more certainty than a folderName override: server.js records exactly which
source (Thunderstore or Hexium), package, and version was actually chosen,
in a second sidecar file, Mods.installedFrom.yaml (keyed by installed
folder name — see load_installed_from() below). This matters specifically
because the SAME owner+name package can exist on both platforms,
independently versioned — a confirmed real case: OdinHorse, Thunderstore
has 1.7.0, Hexium has 1.7.1. Without this record, an exact owner+name match
found on both platforms has no way to know which one is actually
installed, and would otherwise just take whichever comes first in the
combined package list. When present, this record is trusted over the
generic folder-name search (see resolve_package_for_folder()) — there's no
separate override to set for these mods; it's written automatically every
time the GUI installs or updates something.

--plugins-dir is now REQUIRED (see main()) — every installed folder under
it is what this script resolves from and classifies, per THE FLOW above.
Folder/DLL-name matching solves a specific, common class of mismatch that
matching on Mods.yaml's own `name` field never could: that field is the
compiled assembly's cosmetic product name (e.g. "AzuAntiArthriticCrafting"),
which can be completely unrelated to the mod's real Thunderstore/Hexium
package name (e.g. "AAA_Crafting") — the mod author simply chose two
different strings for these. The installed folder name, however, IS (or
contains) the real package name, because that's the literal naming
convention Thunderstore/Hexium/Gale use when extracting a downloaded mod
("Owner-PackageName[-Version]", or sometimes just "PackageName" with no
owner prefix). A `folderName` override (same field the GUI's "Link to
existing entry" button sets, and `move-mod.py <mod> pin-folder
<folder-name>` sets directly) is only needed when a folder can't be
correlated to its Mods.yaml entry automatically for classification
purposes — it does not affect which package gets downloaded (that's what
thunderstorePackage/hexiumPackage pins are for).

Both codes ALSO always include BepInExPack_Valheim and JsonDotNET (always
resolved from Thunderstore specifically — they're core framework packages)
— framework/dependency packages that ValheimEnforcer's own Mods.yaml can
never track by its own design (BepInExPack is the framework, not a plugin).
JsonDotNET is only added when the server has it installed: it ships a small
detector plugin (com.ValheimModding.NewtonsoftJsonDetector), so ValheimEnforcer
rejects a client that has it when the server doesn't. Without them, a generated code installs
real mods with nothing to run them under (the "Failed to find preloader
dll" error is exactly this — no BepInExPack in the code at all).
HookGenPatcher used to be seeded here as a third one and was removed on
request — see ALWAYS_INCLUDE below for what that trade-off means.

Requires: pip install pyyaml --break-system-packages

Usage:
  python3 generate-codes.py Mods.yaml --plugins-dir <path to BepInEx/plugins> [--mode player|admin|both] [--community valheim] [--profile-name <label>] [--dry-run]

--plugins-dir is required — see THE FLOW above for why.

Examples:
  python3 generate-codes.py Mods.yaml --plugins-dir /home/valheim/server/BepInEx/plugins
  python3 generate-codes.py Mods.yaml --plugins-dir /home/valheim/server/BepInEx/plugins --mode player --dry-run
"""
import sys
import os
import re
import json
import base64
import zipfile
import io
import gzip
import hashlib
import uuid
import time
import urllib.request
import urllib.error
import concurrent.futures

try:
    import yaml
except ImportError:
    print("Missing dependency: pip install pyyaml --break-system-packages", file=sys.stderr)
    sys.exit(1)

# Thunderstore's own create endpoint. Hexium (https://hexium.gg) exposes the
# identical experimental legacyprofile API, so a Hexium-hosted code is
# generated the exact same way, just posted to hexium.gg instead — see
# choose_create_url() below. This mirrors how Gale itself decides where to
# host an export: Thunderstore by default, Hexium if the profile has any
# Hexium-sourced mod in it.
THUNDERSTORE_CREATE_URL = "https://thunderstore.io/api/experimental/legacyprofile/create/"
HEXIUM_CREATE_URL = "https://hexium.gg/api/experimental/legacyprofile/create/"
MIN_SUBSTRING_LEN = 4
# Concurrent downloads for the exhaustive hash-verification fallback (see
# verify_by_hash() below) — this work is entirely network-latency-bound
# (downloading and hashing a zip), not CPU-bound, so running several at
# once cuts real wall-clock time roughly by this factor for a mod with
# several ambiguous candidates and no clean version-string match (a
# confirmed real case: "Sailing" needed 33 sequential downloads to resolve
# — one of the main reasons a full run could outlast the GUI's 3-minute
# connection timeout).
HASH_CHECK_WORKERS = 8


def normalize(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _version_sort_key(version_str):
    """Parse a dotted version string into a tuple of ints for comparison,
    e.g. '1.0.12' -> (1, 0, 12). A non-numeric segment sorts as 0 rather
    than raising, so a malformed/unexpected version string never crashes
    comparison — it just sorts low, same fail-soft philosophy as the rest
    of this file's matching code."""
    parts = []
    for seg in re.split(r"[.\-]", version_str or ""):
        try:
            parts.append(int(seg))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def _latest_version_key(package):
    versions = package.get("versions") or []
    if not versions:
        return ()
    return _version_sort_key(versions[0].get("version_number", ""))


def pick_best_candidate(candidates):
    """When several packages are otherwise tied (same owner+name, or same
    normalized display name) but published independently on different
    platforms, prefer whichever one's latest published version is
    actually newer — not just whichever happened to come first in the
    combined packages list (always Thunderstore, since packages =
    ts_packages + hex_packages, regardless of which platform is actually
    ahead). If their latest versions are equal (or unparseable), keep the
    original list order — genuinely doesn't matter which is picked then.

    This directly fixes cases like Smoothbrain-DualWield sitting at
    v1.0.10 on Thunderstore but v1.0.12 on Hexium: with no
    installedFrom/pin record to say which platform a mod was actually
    installed from, defaulting to "whichever has the update" is a much
    better guess than defaulting to "whichever list was concatenated
    first" — it also happens to line up with Mods.yaml's own recorded
    expected version far more often, since that's usually the newest one
    anyway. Still not a certainty — the [AMBIGUOUS] warning and the
    move-mod.py pin suggestion this feeds into are unchanged, so a
    genuinely wrong guess is still visible and still fixable permanently."""
    if not candidates:
        return None
    best = candidates[0]
    best_key = _latest_version_key(best)
    for p in candidates[1:]:
        key = _latest_version_key(p)
        if key > best_key:
            best = p
            best_key = key
    return best


OVERRIDES_FILENAME = "Mods.overrides.yaml"


def load_overrides(yaml_path):
    """Loads Mods.overrides.yaml — the sidecar file next to Mods.yaml that
    holds folderName/thunderstorePackage/hexiumPackage overrides (see the
    module docstring for why these live here and not in Mods.yaml itself).
    Written by move-mod.py's pin-folder/pin-thunderstore/pin-hexium targets.
    Fails soft (returns {}) on any error — a missing/unreadable/malformed
    overrides file should never break code generation, same philosophy as
    fetch_hexium_packages() above; it just means every entry falls back to
    folder-name/hash/fuzzy matching as if no overrides existed."""
    path = os.path.join(os.path.dirname(os.path.abspath(yaml_path)), OVERRIDES_FILENAME)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data or {}
    except Exception as ex:
        print(f"  [warn] could not read {OVERRIDES_FILENAME}: {ex}", file=sys.stderr)
        return {}


INSTALLED_FROM_FILENAME = "Mods.installedFrom.yaml"


def load_installed_from(yaml_path):
    """Loads Mods.installedFrom.yaml — a second sidecar file next to
    Mods.yaml, keyed by INSTALLED FOLDER NAME (not GUID, unlike
    Mods.overrides.yaml — a freshly installed mod has no Mods.yaml entry/GUID
    yet, but its folder name is known immediately at install time). Written
    automatically by the GUI's server.js (/api/mods/install, after every
    successful install AND update) — never hand-set like the
    thunderstorePackage/hexiumPackage overrides. Records exactly
    {source, owner, name, version}: whichever source (thunderstore/hexium),
    package identity, and version were actually chosen and downloaded.

    Why this exists: a mod can be published on BOTH platforms under the
    identical owner+name, independently versioned — a confirmed real case:
    OdinHorse, Thunderstore has 1.7.0, Hexium has 1.7.1. Without this record,
    find_package_by_folder_name()'s exact owner+name match has no way to
    tell those two packages apart — it just picks whichever source's package
    object happens to come first in the combined list (Thunderstore, since
    it's fetched first — see main()), completely independent of which one
    is actually installed. If the version actually installed isn't
    published under that guessed-wrong source at all, code generation would
    silently fall back to that WRONG source's latest version, handing
    players a mod whose hash won't match what the server actually has
    loaded. This file removes the guessing entirely for any mod the GUI
    itself installed or updated — see resolve_entries() below for where
    it's checked, and at what priority relative to a manual pin.

    Fails soft (returns {}) on any error, same philosophy as
    load_overrides()."""
    path = os.path.join(os.path.dirname(os.path.abspath(yaml_path)), INSTALLED_FROM_FILENAME)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data or {}
    except Exception as ex:
        print(f"  [warn] could not read {INSTALLED_FROM_FILENAME}: {ex}", file=sys.stderr)
        return {}


def parse_dependency_string(dep):
    # Format: Owner-PackageName-Major.Minor.Patch (package name itself may
    # contain hyphens, so parse from both ends rather than a fixed split).
    parts = dep.split("-")
    owner = parts[0]
    version = parts[-1]
    name = "-".join(parts[1:-1])
    return owner, name, version


def fetch_packages(community):
    url = f"https://thunderstore.io/c/{community}/api/v1/package/"
    # Cloudflare (error 1010) blocks urllib's default User-Agent outright —
    # same fix already needed for the upload side in filter_profile.py.
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        packages = json.loads(resp.read().decode())
    for p in packages:
        p["source"] = "Thunderstore"
    return packages


_EXACT_FETCH_CACHE = {}
# Folders that parsed cleanly as Owner-Name-Version but whose owner+name
# exist on NO platform (pool AND direct Thunderstore lookup). The fuzzy
# fallbacks must not substitute some other package for these.
_STRICT_NOT_FOUND = set()


def fetch_exact_thunderstore_package(owner, name):
    """Direct lookup of ONE package via Thunderstore's experimental API.
    The community feed (/c/<community>/api/v1/package/) does not list every
    package that Gale/r2modman can install by dependency string (e.g.
    MidnightMods-ValheimCommunityPatch), so an exact owner+name missing from
    the pool is re-checked here before being declared unresolvable. Returns a
    package dict in the same flat shape fetch_packages() produces, or None."""
    key = (owner.lower(), name.lower())
    if key in _EXACT_FETCH_CACHE:
        return _EXACT_FETCH_CACHE[key]
    result = None
    url = f"https://thunderstore.io/api/experimental/package/{owner}/{name}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
        latest = raw.get("latest") or {}
        versions = raw.get("versions") or ([latest] if latest else [])
        # experimental API only guarantees `latest` on some responses; make
        # sure the latest version is present and first (matchers expect
        # newest-first like the v1 feed).
        if latest and not any(v.get("version_number") == latest.get("version_number") for v in versions):
            versions = [latest] + list(versions)
        result = {
            "owner": raw.get("owner", owner),
            "name": raw.get("name", name),
            "full_name": raw.get("full_name", f"{owner}-{name}"),
            "is_deprecated": bool(raw.get("is_deprecated")),
            "versions": [
                {
                    "version_number": v.get("version_number"),
                    "description": v.get("description"),
                    "downloads": v.get("downloads"),
                    "dependencies": v.get("dependencies", []),
                }
                for v in versions
            ],
            "source": "Thunderstore",
        }
    except Exception as ex:
        print(f"    [strict-folder] direct Thunderstore lookup of {owner}/{name} failed: {ex}", file=sys.stderr)
    _EXACT_FETCH_CACHE[key] = result
    return result


def _fetch_gzip_json(url, retries=3):
    """A single flaky request used to be able to nuke the ENTIRE Hexium
    package list for a run (see fetch_hexium_packages() below) — a
    transient timeout/connection-reset on any one of several chunk URLs
    aborted the whole fetch via one shared try/except, silently returning []
    and quietly dropping every package that would otherwise have resolved
    fine, generate-codes.py's own diagnostics never showing WHY (a real
    case: Azumatt-AAA_Crafting, confirmed to genuinely exist on Hexium,
    intermittently "could not resolve a real package on either platform").
    A few quick retries with a short backoff absorbs an ordinary transient
    blip before it can cause that; the caller still handles a persistent
    failure."""
    last_ex = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(gzip.decompress(resp.read()).decode())
        except Exception as ex:
            last_ex = ex
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise last_ex


def fetch_hexium_packages(community):
    """Hexium (https://hexium.gg) doesn't expose Thunderstore's old flat
    /api/v1/package/ listing — only the newer chunked/gzip
    "package-listing-index" scheme (a gzip'd JSON array of chunk URLs, each
    chunk itself a gzip'd JSON array of packages). Each package's full_name
    is a bare "Owner-Name" string and each version's full_name is
    "Owner-Name-Version" rather than separate fields — normalized below into
    the exact same flat {owner, name, versions: [{version_number, ...}]}
    shape fetch_packages() returns for Thunderstore, so every matcher in
    this file (find_package, find_all_candidates, hash verification) works
    unmodified against a combined Thunderstore+Hexium package list.

    Each chunk is fetched independently (with its own retries via
    _fetch_gzip_json) and a chunk that still fails after retries is skipped
    with a loud warning rather than discarding every OTHER chunk that did
    succeed — previously one bad chunk silently emptied the entire Hexium
    package list for the whole run, which is exactly the kind of failure
    that looks identical to "this mod genuinely isn't on Hexium" in the
    final per-folder warning, with nothing in the log to tell them apart.
    Only the index fetch itself failing is still fully fatal (returns []) —
    there's no partial list to build without it."""
    index_url = f"https://{community}.hexium.gg/api/v1/package-listing-index/"
    try:
        chunk_urls = _fetch_gzip_json(index_url)
    except Exception as ex:
        print(f"  [warn] could not fetch the Hexium package-listing INDEX for '{community}' (all retries failed): {ex} — Hexium packages will be completely missing from this run", file=sys.stderr)
        return []

    packages = []
    failed_chunks = 0
    for i, chunk_url in enumerate(chunk_urls):
        try:
            packages.extend(_fetch_gzip_json(chunk_url))
        except Exception as ex:
            failed_chunks += 1
            print(f"  [warn] could not fetch Hexium package chunk {i + 1}/{len(chunk_urls)} (all retries failed): {ex} — packages in this chunk will be missing from this run", file=sys.stderr)
    if failed_chunks:
        print(f"  [warn] {failed_chunks}/{len(chunk_urls)} Hexium package chunk(s) never loaded — any mod published only in one of those chunks will show as unresolved below even though it may genuinely exist on Hexium. Re-run if that happens.", file=sys.stderr)

    normalized = []
    for raw in packages:
        full_name = raw.get("full_name", "")
        dash = full_name.find("-")
        owner = full_name[:dash] if dash >= 0 else full_name
        name = full_name[dash + 1:] if dash >= 0 else ""
        version_prefix = f"{owner}-{name}-"
        versions = []
        for v in raw.get("versions", []):
            v_full = v.get("full_name", "")
            version_number = v_full[len(version_prefix):] if v_full.startswith(version_prefix) else v_full.rsplit("-", 1)[-1]
            versions.append({
                "version_number": version_number,
                "description": v.get("description"),
                "downloads": v.get("downloads"),
                # Dependency idents ("Owner-Name-Version") are the same
                # string format Thunderstore uses — parse_dependency_string
                # handles both without changes.
                "dependencies": v.get("dependencies", []),
            })
        normalized.append({
            "owner": owner,
            "name": name,
            "full_name": full_name,
            "is_deprecated": bool(raw.get("is_deprecated")),
            "versions": versions,
            "source": "Hexium",
        })
    return normalized


def find_all_candidates(entry_name, packages):
    """Every package whose name is an exact or substring match — the full
    pool worth hash-checking, since hash verification will confirm-or-reject
    each candidate anyway (real-world evidence: a companion "Detector"
    plugin legitimately needing its much-shorter underlying library, e.g.
    "YamlDotNet Detector" needing "YamlDotNet", is a valid pattern, not a
    false match to filter out)."""
    target = normalize(entry_name)
    if not target:
        return []
    candidates = []
    for p in packages:
        if p.get("is_deprecated"):
            continue
        pname = normalize(p.get("name", ""))
        if not pname:
            continue
        if pname == target or pname in target or target in pname:
            candidates.append(p)
    return candidates


FOLDER_MIN_SUBSTRING_LEN = 4


def build_enforcer_index(doc):
    """Flattens Mods.yaml's four category dicts into one
    guid -> (status, entry) map, so classify_folder() below can look up
    "does this installed folder belong to anything in Mods.yaml, and if so
    which bucket" in a single pass. status is one of 'required', 'adminOnly',
    'optional', 'serverOnly'."""
    buckets = [
        ("required", doc.get("requiredMods") or {}),
        ("adminOnly", doc.get("adminOnlyMods") or {}),
        ("optional", doc.get("optionalMods") or {}),
        ("serverOnly", doc.get("serverOnlyMods") or {}),
    ]
    index = {}
    for status, bucket in buckets:
        for guid, entry in (bucket or {}).items():
            index[guid] = (status, entry or {})
    return index


def classify_folder(folder, dlls_by_folder, enforcer_index, overrides):
    """The inverse of the old find_installed_folder(): this script now
    iterates the actual installed BepInEx/plugins folders FIRST (see the
    module docstring for why), so for each folder it needs to work out
    which Mods.yaml entry — and therefore which status bucket
    (required/adminOnly/optional/serverOnly/none) — it corresponds to, not
    the other way around. Mirrors server.js's classifyMod()/
    findEnforcerEntry() priority order exactly, so the GUI's status display
    and this script's player/admin separation always agree:
      1. An explicit `folderName` override (Mods.overrides.yaml, set by the
         GUI's "Link to existing entry" button or move-mod.py's pin-folder)
         always wins outright.
      2. An exact match between the folder's own name OR any .dll basename
         inside it and an entry's GUID/name (verified against real data:
         20 of 23 currently installed mods resolve this way, INCLUDING the
         hardest case, AAA_Crafting containing AzuAntiArthriticCrafting.dll,
         with zero pin needed).
      3. The same bidirectional substring scoring as before, checked
         against the folder name AND every DLL basename inside it.
    Returns (guid, status, entry) — status is 'unlisted' (entry is None)
    when nothing in Mods.yaml correlates to this folder at all."""
    folder_norm = normalize(folder)
    dll_norms = [normalize(d) for d in dlls_by_folder.get(folder, [])]
    identities = [folder_norm] + dll_norms

    for guid, override in (overrides or {}).items():
        pin = override.get("folderName")
        if pin and normalize(pin) == folder_norm and guid in enforcer_index:
            status, entry = enforcer_index[guid]
            return guid, status, entry

    for guid, (status, entry) in enforcer_index.items():
        guid_norm = normalize(guid)
        name_norm = normalize(entry.get("name") or guid)
        for ident in identities:
            if ident and (ident == guid_norm or ident == name_norm):
                return guid, status, entry

    best = None
    best_score = None
    for guid, (status, entry) in enforcer_index.items():
        guid_norm = normalize(guid)
        name_norm = normalize(entry.get("name") or guid)
        for ident in identities:
            if not ident:
                continue
            for other_norm in (name_norm, guid_norm):
                if len(ident) >= FOLDER_MIN_SUBSTRING_LEN and len(other_norm) >= FOLDER_MIN_SUBSTRING_LEN:
                    if ident in other_norm or other_norm in ident:
                        score = abs(len(ident) - len(other_norm))
                        if best_score is None or score < best_score:
                            best_score = score
                            best = (guid, status, entry)
    if best:
        return best
    return None, "unlisted", None


def find_package_by_folder_name(folder_name, packages, guid_hint=None):
    """Resolves a mod's real Thunderstore/Hexium package directly from its
    installed BepInEx/plugins folder name — EXACT matching only, no fuzzy
    substring guessing, because the folder name already follows
    Thunderstore/Hexium/Gale's own extraction convention: "Owner-PackageName"
    or "Owner-PackageName-Version", or sometimes just "PackageName" with the
    owner segment dropped (seen in practice — e.g. an installed
    "AAA_Crafting" folder for a package actually published as
    Azumatt-AAA_Crafting). This is the fallback tier for exactly the case
    where resolve_folder_strict() already found a real owner+name match but
    couldn't trust the folder's version outright (it isn't in the package's
    CURRENTLY published version list — e.g. a locally installed version
    newer than what generate-codes.py's most recent package-list fetch
    shows, a confirmed real case: AAA_Crafting installed at 2.1.10, only up
    to 2.1.8 published at fetch time) — so a trailing version-looking
    segment is stripped first (same check parse_folder_strict() uses)
    before splitting the rest into owner+name. Skipping this step used to
    mean this whole fallback silently could never match ANY folder already
    written in the full "Owner-Name-Version" form (i.e. every fresh install
    since the GUI's install-folder-naming fix) — the leftover version
    digits corrupted the name half of the split, so this tier was
    effectively dead for exactly the folders it's now needed for. Tries, in
    order, against the version-stripped folder name:
      1. Split on the first dash: exact owner+name match.
      2. The WHOLE (version-stripped) name as an exact match against a
         package's own `name` field (covers the no-owner-prefix case).
    This is why a folder like "AAA_Crafting" (or "AAA_Crafting-2.1.10")
    resolves correctly even though Mods.yaml's own cosmetic `name` field
    ("AzuAntiArthriticCrafting") has zero textual relationship to it — the
    folder name was never the problem; matching against the wrong field
    was. Returns (package_or_None, ambiguous_candidates) — same shape as
    find_package()."""
    parts = folder_name.split("-")
    if len(parts) >= 3 and re.match(r"^\d+(\.\d+){1,3}$", parts[-1]):
        folder_no_version = "-".join(parts[:-1])
    else:
        folder_no_version = folder_name

    idx = folder_no_version.find("-")
    if idx > 0:
        owner_norm = normalize(folder_no_version[:idx])
        name_norm = normalize(folder_no_version[idx + 1:])
        exact = [
            p for p in packages
            if not p.get("is_deprecated")
            and normalize(p.get("owner", "")) == owner_norm
            and normalize(p.get("name", "")) == name_norm
        ]
        if exact:
            return pick_best_candidate(exact), (exact if len(exact) > 1 else [])

    whole_norm = normalize(folder_no_version)
    if not whole_norm:
        return None, []
    exact = [p for p in packages if not p.get("is_deprecated") and normalize(p.get("name", "")) == whole_norm]
    if not exact:
        return None, []
    if len(exact) == 1:
        return exact[0], []
    # Multiple owners publish a package under this exact name — same
    # GUID-prefix disambiguation find_package() already uses below.
    owner_hint = normalize(guid_hint.split(".")[0]) if guid_hint else None
    if owner_hint:
        hinted = [p for p in exact if normalize(p.get("owner", "")) == owner_hint]
        if len(hinted) == 1:
            return hinted[0], []
    return pick_best_candidate(exact), exact


def parse_folder_strict(folder_name):
    """Try to split an installed BepInEx/plugins folder name into
    (owner, name, version) using Thunderstore/Hexium/Gale's own extraction
    convention: "Owner-PackageName-Version" (e.g.
    "denikson-BepInExPack_Valheim-5.4.2350"). The trailing dash-separated
    segment is only trusted as a version if it actually LOOKS like one
    (dotted digits, 2-4 parts) — a folder with no such suffix (predates the
    GUI's install-folder-naming fix, or was renamed by hand) returns
    version=None so the caller knows not to trust a specific version, just
    the owner/name split; fewer than two segments at all returns
    (None, None, None) entirely. Package names themselves can contain
    dashes, so the middle is rejoined rather than split a fixed number of
    times — same approach parse_dependency_string() uses for pins above."""
    parts = folder_name.split("-")
    version = None
    if len(parts) >= 3 and re.match(r"^\d+(\.\d+){1,3}$", parts[-1]):
        version = parts[-1]
        parts = parts[:-1]
    if len(parts) < 2:
        return None, None, version
    owner = parts[0]
    name = "-".join(parts[1:])
    return owner, name, version


def resolve_folder_strict(folder, packages, recorded_hash=None):
    """The fast, deterministic resolution path: parse the folder's own name
    for an exact owner+name+version and trust it OUTRIGHT once confirmed to
    actually exist upstream — no guessing across candidates, no downloading
    every published version of every plausibly-named package to find a hash
    match (that exhaustive search, done per Mods.yaml entry, is what made a
    generate-codes.py run slow enough to hit the GUI's 3-minute connection
    timeout on a ~40-mod server). This only works at all because a fresh
    install now always writes its folder in the full
    "Owner-PackageName-Version" form (see the GUI's install-folder-naming
    fix) — an older folder that predates that fix, or has no parseable
    version suffix, simply returns (None, None) here and falls through
    untouched to the existing slower hash-verification path in
    resolve_entries() below, exactly as before this function existed.
    When recorded_hash is given (Mods.yaml's acceptedHashes for this entry),
    does exactly ONE confirmatory download of this specific owner/name/
    version — never a scan of other versions — and checks the DLL hash
    actually matches, catching the rare case of a folder hand-renamed to
    merely look like a real package/version it isn't. Returns
    (package, version_number) or (None, None)."""
    owner, name, version = parse_folder_strict(folder)
    if not owner or not name or not version:
        return None, None

    # A package can be published under the IDENTICAL owner+name on BOTH
    # Thunderstore and Hexium, independently versioned — a confirmed real
    # case: OdinHorse (Thunderstore 1.7.0, Hexium 1.7.1), and Smoothbrain's
    # own mods (e.g. TargetPortal) show the same pattern. find_package_by_
    # owner_name(source=None) only ever returns the FIRST such match it
    # finds — always Thunderstore, since packages is built Thunderstore-
    # then-Hexium — so checking only that one match's version list used to
    # both (a) print a misleading "not published" diagnostic when the
    # version genuinely IS published, just on the OTHER platform, and (b)
    # needlessly fall through to the slow hash-verification path for every
    # dual-published package instead of resolving instantly here. Check
    # every platform that has an exact owner+name match, not just whichever
    # one happens to come first.
    exact_matches = [p for p in packages if p.get("owner") == owner and p.get("name") == name]
    if not exact_matches:
        # Case-insensitive exact owner+name (Hexium/Thunderstore can differ
        # in capitalization from the installed folder name).
        exact_matches = [
            p for p in packages
            if (p.get("owner") or "").lower() == owner.lower() and (p.get("name") or "").lower() == name.lower()
        ]
    if not exact_matches:
        # The community feed doesn't list everything installable by
        # dependency string — ask Thunderstore for this exact package
        # directly before giving up. NOTE: deliberately NOT falling back to
        # find_package_by_owner_name()'s normalized name-only match here — that
        # is what let a clean Owner-Name-Version folder resolve to an
        # unrelated package.
        direct = fetch_exact_thunderstore_package(owner, name)
        if direct and direct.get("versions"):
            packages.append(direct)  # cache in the pool for later lookups
            exact_matches = [direct]
            print(f"    [strict-folder] '{folder}': {owner}-{name} wasn't in the community feed, but exists on Thunderstore — resolved via direct lookup", file=sys.stderr)
    if not exact_matches:
        _STRICT_NOT_FOUND.add(folder)
        # Printed even though this is still just a "fall through", not a
        # final failure — a folder that DOES parse as Owner-Name-Version but
        # can't be found anywhere in `packages` almost always means the
        # combined Thunderstore+Hexium pool this run fetched is genuinely
        # missing that package (e.g. a partial Hexium chunk-fetch failure —
        # see fetch_hexium_packages()) rather than the folder itself being
        # wrong, and the later fallbacks (lenient/hash/fuzzy match) will
        # also just fail silently the same way if that's the real cause —
        # this is the one place that can say so plainly.
        print(f"    [strict-folder] '{folder}' parses as {owner}-{name} v{version}, but no package with that exact owner+name exists in this run's combined Thunderstore+Hexium pool ({len(packages)} packages) — falling back to lenient/hash/fuzzy matching, which will likely also fail if the pool is genuinely missing it", file=sys.stderr)
        return None, None

    pkg = None
    version_entry = None
    for candidate in exact_matches:
        ve = next((v for v in candidate["versions"] if v["version_number"] == version), None)
        if ve:
            pkg, version_entry = candidate, ve
            break
    if not pkg:
        # Genuinely not published under this exact version on ANY platform
        # that has this owner+name — list every platform actually checked
        # so the diagnostic can't be misread as "Hexium doesn't have it"
        # when only Thunderstore (or vice versa) was actually missing it.
        per_source = "; ".join(
            f"{p.get('source', 'Thunderstore')}: " + (", ".join(v["version_number"] for v in p["versions"][:8]) or "(none)") + ("..." if len(p["versions"]) > 8 else "")
            for p in exact_matches
        )
        print(f"    [strict-folder] '{folder}' parses as {owner}-{name}, but v{version} isn't in the published version list on any platform that has this owner+name ({per_source}) — falling back", file=sys.stderr)
        return None, None
    # pkg/version_entry now point at the SPECIFIC source-entry whose version
    # list actually contains `version` (set inside the loop above).
    if recorded_hash:
        try:
            zip_bytes = download_package_zip(pkg["owner"], pkg["name"], version, pkg.get("source", "Thunderstore"))
            if recorded_hash.lower() not in compute_dll_hashes(zip_bytes):
                print(
                    f"    [strict-folder] '{folder}' parses as {pkg['owner']}-{pkg['name']} v{version}, but its "
                    f"published DLL hash doesn't match Mods.yaml's recorded hash for this entry — not trusting the "
                    f"folder name here, falling back to full hash verification.",
                    file=sys.stderr,
                )
                return None, None
        except Exception as ex:
            print(f"    [strict-folder] couldn't verify {pkg['owner']}-{pkg['name']} v{version}: {ex} — falling back", file=sys.stderr)
            return None, None
    return pkg, version


def download_package_zip(owner, name, version, source="Thunderstore"):
    if source == "Hexium":
        url = f"https://cdn.hexium.gg/uploads/{owner}/{name}/{version}.zip"
    else:
        url = f"https://thunderstore.io/package/download/{owner}/{name}/{version}/"
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def compute_dll_hashes(zip_bytes):
    """Every .dll inside the zip, hashed — a package can ship several, and
    Mods.yaml's recorded hash could be for any one of them depending on
    which specific plugin ValheimEnforcer actually loaded."""
    hashes = set()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            if info.filename.lower().endswith(".dll"):
                hashes.add(hashlib.sha256(zf.read(info.filename)).hexdigest())
    return hashes


def verify_by_hash(candidates, recorded_version, recorded_hash):
    """The only fully deterministic way to resolve a name collision: a
    byte-identical DLL can only come from one real package release.

    Two phases:
      1. FAST, sequential: any candidate whose Mods.yaml version string
         matches one of its own published version_numbers directly gets
         checked with exactly one download (works for any mod whose
         Mods.yaml version matches its Thunderstore version_number as-is).
      2. SLOW, PARALLEL: only for candidates that had no such direct match
         at all — some mods (Valheim Plus's Grantapher fork among them)
         record a different version scheme in Mods.yaml (the in-game
         AssemblyVersion, e.g. "0.10.1.1") than their Thunderstore
         version_number ("10.1.1", three-part as Thunderstore requires), so
         the strings will never match even though it's the right package —
         hash verification doesn't need the labels to agree, only the file
         contents. This phase downloads every version of every remaining
         candidate to find the one whose DLL hash actually matches, which
         for a generic mod name with several unrelated same-named
         candidates (a confirmed real case: "Sailing", 8 candidates) can
         mean 30+ zip downloads — done concurrently here instead of one at
         a time, since this is entirely network-latency-bound, not
         CPU-bound, and this used to be sequential enough on its own to
         help blow past the GUI's 3-minute connection timeout.

    Returns (package, actual_version_number) or (None, None)."""
    if not recorded_hash:
        return None, None
    recorded_hash = recorded_hash.lower()

    exhaustive_candidates = []
    for p in candidates:
        version_entry = next((v for v in p["versions"] if v["version_number"] == recorded_version), None)
        if not version_entry:
            exhaustive_candidates.append(p)
            continue
        try:
            zip_bytes = download_package_zip(p["owner"], p["name"], recorded_version, p.get("source", "Thunderstore"))
            if recorded_hash in compute_dll_hashes(zip_bytes):
                return p, recorded_version
        except Exception as ex:
            print(f"    [hash-check] couldn't check {p['owner']}-{p['name']} v{recorded_version}: {ex}", file=sys.stderr)

    if not exhaustive_candidates:
        return None, None

    jobs = []
    for p in exhaustive_candidates:
        print(f"    [hash-check] {p['owner']}-{p['name']} has no version string matching '{recorded_version}' — trying all {len(p['versions'])} published versions instead (in parallel)", file=sys.stderr)
        for v in p["versions"]:
            jobs.append((p, v["version_number"]))

    def try_one(job):
        p, version_number = job
        try:
            zip_bytes = download_package_zip(p["owner"], p["name"], version_number, p.get("source", "Thunderstore"))
            return p, version_number, recorded_hash in compute_dll_hashes(zip_bytes), None
        except Exception as ex:
            return p, version_number, False, str(ex)

    with concurrent.futures.ThreadPoolExecutor(max_workers=HASH_CHECK_WORKERS) as pool:
        futures = [pool.submit(try_one, job) for job in jobs]
        for fut in concurrent.futures.as_completed(futures):
            p, version_number, matched, err = fut.result()
            if err:
                print(f"    [hash-check] couldn't check {p['owner']}-{p['name']} v{version_number}: {err}", file=sys.stderr)
                continue
            if matched:
                for pending in futures:
                    pending.cancel()  # best-effort — anything already running still finishes, just gets ignored
                return p, version_number
    return None, None


def find_package(entry_name, packages, guid_hint=None):
    """Match a Mods.yaml entry's display name against Thunderstore packages.
    Returns (best_match, ambiguous_candidates) — the second is non-empty
    when multiple different packages scored equally well, since silently
    picking one of several plausible matches (e.g. a forked mod's short
    name matching both the original and the fork) is exactly how the wrong
    mod ends up in a generated code.

    If guid_hint is given (the mod's own GUID, e.g. "advize.PlantEverything"),
    any candidate whose owner matches the GUID's first segment is preferred
    outright over an equally-plausible name match from an unrelated owner —
    the one disambiguator a name search alone can't provide."""
    target = normalize(entry_name)
    if not target:
        return None, []

    owner_hint = normalize(guid_hint.split(".")[0]) if guid_hint else None

    exact_matches = []
    substring_candidates = []  # (score, package)
    for p in packages:
        if p.get("is_deprecated"):
            continue
        pname = normalize(p.get("name", ""))
        if not pname:
            continue
        if pname == target:
            exact_matches.append(p)
            continue
        if len(target) >= MIN_SUBSTRING_LEN and len(pname) >= MIN_SUBSTRING_LEN:
            if pname in target or target in pname:
                substring_candidates.append((abs(len(pname) - len(target)), p))

    all_candidates = [(0, p) for p in exact_matches] + substring_candidates

    if owner_hint and all_candidates:
        hint_matches = [(score, p) for score, p in all_candidates if normalize(p.get("owner", "")) == owner_hint]
        if hint_matches:
            hint_matches.sort(key=lambda c: c[0])
            best_score = hint_matches[0][0]
            tied = [p for score, p in hint_matches if score == best_score]
            tied_unique = list({(p["owner"], p["name"]): p for p in tied}.values())
            if len(tied_unique) == 1:
                return tied_unique[0], []
            return pick_best_candidate(tied_unique), tied_unique

    if len(exact_matches) == 1:
        return exact_matches[0], []
    if len(exact_matches) > 1:
        return pick_best_candidate(exact_matches), exact_matches  # multiple packages share this exact name — genuinely ambiguous

    if not substring_candidates:
        return None, []
    substring_candidates.sort(key=lambda c: c[0])
    best_score = substring_candidates[0][0]
    tied = [p for score, p in substring_candidates if score == best_score]
    # Dedup by owner+name in case the same package matched via both guid/name paths elsewhere
    tied_unique = list({(p["owner"], p["name"]): p for p in tied}.values())
    if len(tied_unique) > 1:
        return pick_best_candidate(tied_unique), tied_unique
    return tied_unique[0], []


def build_mod_entry(package, target_version):
    """Prefer the EXACT version recorded in Mods.yaml, matched against this
    package's version history — NOT just the latest published version.
    Handing players a newer version than the server actually has loaded
    means their file's hash won't match what ValheimEnforcer expects to
    see, which is exactly the thing this code is supposed to prevent."""
    versions = package["versions"]
    chosen = next((v for v in versions if v["version_number"] == target_version), None)
    fell_back = chosen is None
    if fell_back:
        chosen = versions[0]  # latest, as a last resort — see the warning this triggers below
    version_number = chosen["version_number"]
    parts = (version_number.split(".") + ["0", "0", "0"])[:3]
    major, minor, patch = (int(p) if p.isdigit() else 0 for p in parts)
    # `source` matches Gale's own R2Mod.source field exactly (its Backend
    # enum serializes as the plain variant name, "Thunderstore"/"Hexium") —
    # a code containing a source: Hexium entry tells Gale to fetch that one
    # mod from Hexium instead of Thunderstore when the player imports it.
    entry = {
        "name": f"{package['owner']}-{package['name']}",
        "enabled": True,
        "version": {"major": major, "minor": minor, "patch": patch},
        "source": package.get("source", "Thunderstore"),
    }
    return entry, fell_back, version_number, chosen


# Framework/dependency packages ValheimEnforcer's Mods.yaml can never track,
# by its own design (confirmed in its docs): every list is keyed by a real
# BepInEx plugin GUID, and none of these have one.
#   - BepInExPack_Valheim: the framework itself, not a plugin
#   - JsonDotNET: a raw dependency DLL other mods reference — no BepInPlugin
#     class at all, so no GUID exists to key an entry with
# There's no way to represent these inside Mods.yaml itself, so they're
# seeded here explicitly instead — the same honest fix already applied to
# BepInExPack, just widened to the other one you actually need.
#
# HookGenPatcher was previously seeded here too (it's a *patcher*, not a
# plugin — patchers use an entirely separate ValheimEnforcer mechanism,
# allowedPatchers keyed by file path, never the required/optional/admin/
# server mod lists) and was removed on request. Note what that means in
# practice: a generated code no longer ships it to players at all. Any mod
# that genuinely needs it now has to pull it in as its own declared
# dependency at import time, so if a mod ever starts failing on a client
# with a missing-MMHOOK-assembly error, this is the first thing to check —
# re-add the ("ValheimModding", "HookGenPatcher") tuple below to restore
# the old behavior.
ALWAYS_INCLUDE = [
    ("denikson", "BepInExPack_Valheim"),
    ("ValheimModding", "JsonDotNET"),
]


def find_package_by_owner_name(owner, name, packages, source=None):
    """source, when given, restricts the match to that one source (used by
    thunderstorePackage/hexiumPackage pins, which are unambiguous about
    which platform they mean) — otherwise searches the combined list."""
    candidates = [p for p in packages if source is None or p.get("source", "Thunderstore") == source]
    for p in candidates:
        if p.get("owner") == owner and p.get("name") == name:
            return p
    # fallback: normalized name match in case of a typo/rename, same owner preferred
    target = normalize(name)
    for p in candidates:
        if normalize(p.get("name", "")) == target:
            return p
    return None


# JsonDotNET ships a small detector plugin (GUID
# com.ValheimModding.NewtonsoftJsonDetector — seen live in a ValheimEnforcer
# "Non-allowed mods found" rejection), so ValheimEnforcer DOES see it on a
# client. If the server doesn't have it installed, a player who imports a code
# containing it is turned away. It is therefore only seeded when the server
# really has a JsonDotNET folder (then Enforcer lists it and clients with it
# pass); on a server without it, leaving it out is what keeps players joinable.
ONLY_IF_INSTALLED = {"jsondotnet"}


def resolve_always_include(packages, installed_folders=None):
    """Always the latest version — Mods.yaml never tracks these at all, so
    there's no recorded version to match against like there is for real
    required/admin mods."""
    resolved = []
    installed_norm = [normalize(f) for f in (installed_folders or [])]
    for owner, name in ALWAYS_INCLUDE:
        if normalize(name) in ONLY_IF_INSTALLED and installed_folders is not None \
                and not any(normalize(name) in f for f in installed_norm):
            print(f"  - {owner}-{name} left out: not installed on this server, and ValheimEnforcer would turn players away for having it", file=sys.stderr)
            continue
        # Always resolved from Thunderstore specifically — these are core
        # framework packages, not something to accidentally pick up a
        # same-named Hexium package for.
        pkg = find_package_by_owner_name(owner, name, packages, source="Thunderstore")
        if not pkg:
            print(f"  [warn] could not find {owner}-{name} on Thunderstore — skipped (codes may not import correctly without it)", file=sys.stderr)
            continue
        entry, _, used_version, _ = build_mod_entry(pkg, pkg["versions"][0]["version_number"])
        print(f"  - {owner}-{name} v{used_version} (framework/dependency, always included)", file=sys.stderr)
        resolved.append((pkg, used_version, entry))
    return resolved


def normalize_uuid_code(key):
    """
    Reformat a profile key into the canonical dashed UUID form
    (8-4-4-4-12), whatever form the backend handed back.

    Confirmed by reading Gale's own source (ImportProfileDialog.svelte):
    the "Import profile from code" dialog decides whether a pasted string
    is a legacy Thunderstore/Hexium code or one of Gale's own native
    sync-profile IDs using `uuidRegex.test(key.trim())`, where that regex
    ONLY matches the dashed 8-4-4-4-12 form. Gale's *backend* is fully
    lenient about this (it parses the key with Rust's uuid crate, which
    accepts both forms) — but the frontend check runs first, so a
    hyphen-less key gets misclassified as a sync-profile ID and sent to
    the wrong API (gale.kesomannen.com's own hosted "Sync" backend)
    instead of the legacy Thunderstore/Hexium importer, which 400s since
    that ID was never registered there.

    Thunderstore's own legacyprofile/create endpoint already returns keys
    in the dashed form, so this has only ever bitten Hexium-hosted codes
    in practice — confirmed live: this exact bug produced
    "Failed to read sync profile: HTTP status client error (400 Bad
    Request)" for a PLAYER_CODE this script generated. Normalizing here
    means every code this script prints just works when pasted into Gale,
    regardless of which backend issued it.
    """
    try:
        return str(uuid.UUID(key))
    except (ValueError, AttributeError, TypeError):
        return key  # not UUID-shaped at all — leave it untouched


def upload_profile(profile_name, mod_entries):
    # Same choice Gale itself makes when exporting a profile: host the code
    # on Hexium if any mod in it is Hexium-sourced, Thunderstore otherwise.
    # The uploaded r2x content is identical either way (every mod's own
    # `source` field is what actually tells Gale where to fetch it from on
    # import) — this only decides which platform's create endpoint stores
    # the code itself.
    has_hexium_mod = any(m.get("source") == "Hexium" for m in mod_entries)
    create_url = HEXIUM_CREATE_URL if has_hexium_mod else THUNDERSTORE_CREATE_URL
    host_label = "Hexium" if has_hexium_mod else "Thunderstore"

    profile = {"profileName": profile_name, "mods": mod_entries}
    r2x = yaml.dump(profile, sort_keys=False)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("export.r2x", r2x)
    payload = b"#r2modman\n" + base64.b64encode(buf.getvalue())
    req = urllib.request.Request(
        create_url,
        data=payload,
        headers={"Content-Type": "application/octet-stream", "User-Agent": "curl/8.5.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"{host_label} rejected the upload: {e.code} {e.reason}", file=sys.stderr)
        print(e.read().decode(errors="replace"), file=sys.stderr)
        sys.exit(1)
    key = result.get("key")
    if not key:
        print(f"Unexpected response, no 'key' field: {result}", file=sys.stderr)
        sys.exit(1)
    key = normalize_uuid_code(key)
    print(f"  (code hosted on {host_label})", file=sys.stderr)
    return key


def resolve_package_for_folder(folder, guid, entry, packages, overrides, installed_from):
    """Resolves the real downloadable Thunderstore/Hexium package for ONE
    installed BepInEx/plugins folder, already known (via classify_folder())
    to belong to `entry` (a Mods.yaml entry dict, possibly {} if this folder
    doesn't correlate to anything in Mods.yaml at all — see resolve_from_
    plugins() below for why hash/fuzzy matching still needs a real entry to
    work against, and is skipped when there isn't one). Tries, in order:
      1. A thunderstorePackage/hexiumPackage pin (Mods.overrides.yaml, set
         via move-mod.py or the GUI's Pin package identity dialog) — trusted
         outright, no candidate search.
      2. An installedFrom record for this exact folder (Mods.installedFrom
         .yaml, written automatically by the GUI on every install/update) —
         the exact source+package+version that was actually downloaded.
      3. Strict "Owner-PackageName-Version" parse of the folder's own name —
         the PRIMARY path per this script's plugins-folder-first flow (see
         the module docstring): a folder like "Azumatt-AAA_Crafting-2.1.10"
         already IS a complete, unique dependency string, so there's only
         ever one possible package this can resolve to — no guessing, no
         candidate list, just one confirmatory lookup (and, when Mods.yaml
         has a recorded hash for this entry, one confirmatory DLL-hash
         download).
      4. A lenient exact match on the folder name alone (no version
         suffix trusted) — covers a folder that predates the GUI's
         Owner-PackageName-Version install-naming fix.
      5. Hash verification against every plausible name-match candidate —
         only possible when this folder correlates to a real Mods.yaml
         entry with a recorded acceptedHashes value.
      6. Fuzzy name matching, as an absolute last resort.
    In every case except the pin/installedFrom paths, the target version is
    the entry's own recorded_version — the exact version Mods.yaml/
    ValheimEnforcer says is actually loaded — never just "whatever's
    published latest" (see build_mod_entry()).
    Returns (package, version_number, r2x_entry) or (None, None, None)."""
    name = entry.get("name") or guid or folder
    recorded_version = entry.get("version")
    accepted_hashes = entry.get("acceptedHashes") or []
    recorded_hash = accepted_hashes[0] if accepted_hashes else None
    override = (overrides.get(guid) if guid else None) or {}

    pinned_ts = override.get("thunderstorePackage")
    pinned_hex = override.get("hexiumPackage")
    pinned = pinned_ts or pinned_hex
    if pinned:
        # The version in the pin string is deliberately IGNORED — a pin
        # exists to settle package identity once, not to freeze the mod to
        # whatever version it happened to be on the day it was pinned.
        # Always resolve against Mods.yaml's own live recorded_version
        # instead, so a pinned mod keeps updating normally forever after.
        pin_source = "Hexium" if (pinned_hex and not pinned_ts) else "Thunderstore"
        pin_owner, pin_name, _pin_version_at_pin_time = parse_dependency_string(pinned)
        pkg = find_package_by_owner_name(pin_owner, pin_name, packages, source=pin_source)
        if pkg:
            r2x_entry, fell_back, used_version, _c = build_mod_entry(pkg, recorded_version)
            pin_field = "hexiumPackage" if pin_source == "Hexium" else "thunderstorePackage"
            print(f"  - {name} -> {pkg['owner']}-{pkg['name']} v{used_version} (pinned identity via {pin_field} on folder '{folder}' — version tracked live, not frozen to the pin)", file=sys.stderr)
            if fell_back:
                print(f"  [WARNING] {name}: Mods.yaml has v{recorded_version}, but that exact version wasn't found for pinned package {pkg['owner']}-{pkg['name']} — used latest (v{used_version}) instead. This mod's hash may not match what the server expects; double-check it manually.", file=sys.stderr)
            return pkg, used_version, r2x_entry
        print(f"  [warn] pinned package '{pinned}' for '{name}' (folder '{folder}') not found on {pin_source} — falling through to automatic matching", file=sys.stderr)

    rec = installed_from.get(folder)
    if rec and rec.get("owner") and rec.get("name") and rec.get("version"):
        rec_source = "Hexium" if rec.get("source") == "hexium" else "Thunderstore"
        rec_pkg = find_package_by_owner_name(rec["owner"], rec["name"], packages, source=rec_source)
        if rec_pkg:
            r2x_entry, fell_back, used_version, _c = build_mod_entry(rec_pkg, rec["version"])
            print(f"  - {name} -> {rec_pkg['owner']}-{rec_pkg['name']} v{used_version} ({rec_source}, matched via installedFrom record for folder '{folder}')", file=sys.stderr)
            if fell_back:
                print(f"  [WARNING] {name}: installedFrom recorded v{rec['version']} from {rec_source}, but that exact version wasn't found for {rec_pkg['owner']}-{rec_pkg['name']} anymore — used latest (v{used_version}) instead. Double-check this manually.", file=sys.stderr)
            return rec_pkg, used_version, r2x_entry

    strict_pkg, strict_version = resolve_folder_strict(folder, packages, recorded_hash)
    if strict_pkg:
        r2x_entry, _fell_back, used_version, _c = build_mod_entry(strict_pkg, strict_version)
        confirm_note = " + DLL-hash confirmed" if recorded_hash else ""
        print(f"  - {name} -> {strict_pkg['owner']}-{strict_pkg['name']} v{used_version} (strict folder-name parse of '{folder}'{confirm_note} — one exact lookup, no candidate search)", file=sys.stderr)
        return strict_pkg, used_version, r2x_entry

    folder_pkg, folder_ambiguous = find_package_by_folder_name(folder, packages, guid_hint=guid)
    if folder_pkg:
        if folder_ambiguous:
            candidates = ", ".join(
                f"{p['owner']}-{p['name']} ({p.get('source', 'Thunderstore')}, latest "
                f"v{p['versions'][0]['version_number'] if p.get('versions') else '?'})"
                for p in folder_ambiguous
            )
            sources_seen = {p.get("source", "Thunderstore") for p in folder_ambiguous}
            why = (
                "the SAME package is published on both platforms, independently versioned — there is no "
                "installedFrom record for this folder, so which one you actually installed isn't known here"
                if len(sources_seen) > 1
                else "several owners publish under this exact name"
            )
            print(
                f"  [AMBIGUOUS] folder '{folder}' ({name}) matches multiple packages: {candidates} — {why}. "
                f"Used {folder_pkg['owner']}-{folder_pkg['name']} ({folder_pkg.get('source', 'Thunderstore')}), "
                f"but VERIFY this is actually right. To settle it permanently: "
                f"move-mod.py Mods.yaml {guid or folder} pin-hexium|pin-thunderstore Owner-Name-Version",
                file=sys.stderr,
            )
        r2x_entry, fell_back, used_version, _c = build_mod_entry(folder_pkg, recorded_version)
        print(f"  - {name} -> {folder_pkg['owner']}-{folder_pkg['name']} v{used_version} (lenient folder-name match on '{folder}')", file=sys.stderr)
        if fell_back:
            print(f"  [WARNING] {name}: Mods.yaml has v{recorded_version}, but that exact version wasn't found for {folder_pkg['owner']}-{folder_pkg['name']} — used latest (v{used_version}) instead. This mod's hash may not match what the server expects; double-check it manually.", file=sys.stderr)
        return folder_pkg, used_version, r2x_entry

    if folder in _STRICT_NOT_FOUND:
        print(
            f"  [ERROR] installed folder '{folder}' ({name}) is a clean Owner-Name-Version dependency string "
            f"but that package was found on neither Thunderstore nor Hexium — refusing to guess a different "
            f"package by fuzzy name. Skipped. Pin it if it lives elsewhere: "
            f"move-mod.py Mods.yaml {guid or folder} pin-thunderstore|pin-hexium Owner-Name-Version",
            file=sys.stderr,
        )
        return None, None, None

    if recorded_hash:
        candidates = find_all_candidates(name, packages)
        verified_pkg, verified_version = verify_by_hash(candidates, recorded_version, recorded_hash)
        if verified_pkg:
            r2x_entry, _fell_back, used_version, _c = build_mod_entry(verified_pkg, verified_version)
            print(f"  - {name} -> {verified_pkg['owner']}-{verified_pkg['name']} v{used_version} (hash-verified from folder '{folder}' — proven correct, not just name-matched)", file=sys.stderr)
            return verified_pkg, used_version, r2x_entry
        elif candidates:
            print(f"    [hash-check] no candidate matched the recorded hash for '{name}' — falling back to fuzzy name matching", file=sys.stderr)

    pkg, ambiguous = find_package(name, packages, guid_hint=guid)
    if not pkg:
        print(f"  [warn] could not resolve a real package for installed folder '{folder}' ({name}) on either platform — skipped", file=sys.stderr)
        return None, None, None
    if ambiguous:
        candidates = ", ".join(f"{p['owner']}-{p['name']}" for p in ambiguous)
        print(
            f"  [AMBIGUOUS] '{name}' (folder '{folder}') matches multiple packages equally well: {candidates} — "
            f"used {pkg['owner']}-{pkg['name']}, but VERIFY this is actually right. Once you know the correct "
            f"one, pin it: move-mod.py Mods.yaml {guid or folder} pin-thunderstore|pin-hexium Owner-Name-Version",
            file=sys.stderr,
        )
    r2x_entry, fell_back, used_version, _c = build_mod_entry(pkg, recorded_version)
    print(f"  - {name} -> {pkg['owner']}-{pkg['name']} v{used_version} (fuzzy name match on folder '{folder}')", file=sys.stderr)
    if fell_back:
        print(f"  [WARNING] {name}: Mods.yaml has v{recorded_version}, but that exact version wasn't found for {pkg['owner']}-{pkg['name']} — used latest (v{used_version}) instead. This mod's hash may not match what the server expects; double-check it manually.", file=sys.stderr)
    return pkg, used_version, r2x_entry


def resolve_from_plugins(installed_folders, dlls_by_folder, enforcer_index, packages, overrides, installed_from):
    """The main resolution pass, driven by the actual installed BepInEx/
    plugins folders (ground truth) rather than by Mods.yaml — see the module
    docstring for the full rationale. For every installed folder:
      1. classify_folder() works out which Mods.yaml entry (if any) it
         belongs to, and which status bucket that entry is in.
      2. optional/serverOnly/unlisted folders are skipped outright — never
         part of either generated code (optional is the player's own choice
         to add; serverOnly must never reach a client at all; unlisted means
         nothing in Mods.yaml correlates to this folder yet).
      3. required/adminOnly folders get resolved to a real downloadable
         package via resolve_package_for_folder()'s priority cascade.
    Returns a list of (package, version_number, r2x_entry, guid, status)
    tuples — status lets main() slice this ONE resolved pass into the
    player list (status == 'required') and admin list (status in
    ('required', 'adminOnly')) without resolving anything twice."""
    resolved = []
    matched_by = {}  # (owner, name) -> list of folders that resolved there
    overrides = overrides or {}
    installed_from = installed_from or {}
    for folder in installed_folders:
        guid, status, entry = classify_folder(folder, dlls_by_folder, enforcer_index, overrides)
        if status == "optional":
            print(f"  [skip] '{folder}' is optionalMods — the player's own choice to add, never auto-included", file=sys.stderr)
            continue
        if status == "serverOnly":
            print(f"  [skip] '{folder}' is serverOnlyMods — must never reach a client, excluded from both codes", file=sys.stderr)
            continue
        if status == "unlisted":
            print(f"  [skip] '{folder}' doesn't correlate to any Mods.yaml entry yet — not included in either code", file=sys.stderr)
            continue
        pkg, version, r2x_entry = resolve_package_for_folder(folder, guid, entry, packages, overrides, installed_from)
        if not pkg:
            continue
        resolved.append((pkg, version, r2x_entry, guid, status))
        matched_by.setdefault((pkg["owner"], pkg["name"]), []).append(folder)

    # Two DIFFERENT installed folders resolving to the SAME real package is a
    # strong signal that at least one of them is actually a different mod
    # whose folder/DLL naming just looks similar (a fork keeping its
    # original's product name is exactly this) — the per-folder warnings
    # above don't distinguish that from an ordinary ambiguous match, so call
    # it out explicitly here.
    for (owner, pkg_name), folders in matched_by.items():
        if len(folders) > 1:
            print(
                f"  [CONFLICT] {len(folders)} different installed folders all matched to {owner}-{pkg_name}: "
                f"{', '.join(folders)} — at least one of these is probably a DIFFERENT mod that name/folder "
                f"matching couldn't tell apart (e.g. an abandoned original and its fork). Check each folder's "
                f"real identity and consider removing whichever one is actually stale.",
                file=sys.stderr,
            )
    return resolved


def build_profile(seed_resolved, always_include_resolved, label):
    """Combines the top-level Mods.yaml-resolved mods with the fixed
    framework/dependency list, deduplicated by owner+name (a required mod
    that happens to also be one of the always-include ones — unlikely, but
    possible — keeps its Mods.yaml-matched version rather than being
    duplicated), and returns the final flat list of r2x mod entries."""
    seen = {(p["owner"], p["name"]) for p, _v, _e in seed_resolved}
    combined = list(seed_resolved)
    for pkg, version, entry in always_include_resolved:
        key = (pkg["owner"], pkg["name"])
        if key in seen:
            continue
        seen.add(key)
        combined.append((pkg, version, entry))
    return [entry for _pkg, _ver, entry in combined]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = sys.argv[1:]
    if len(args) < 1:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    yaml_path = args[0]

    mode = "both"
    community = "valheim"
    plugins_dir = None
    profile_name = "Valheim"
    for i, a in enumerate(flags):
        if a == "--mode" and i + 1 < len(flags):
            mode = flags[i + 1]
        if a == "--community" and i + 1 < len(flags):
            community = flags[i + 1]
        if a == "--plugins-dir" and i + 1 < len(flags):
            plugins_dir = flags[i + 1]
        if a == "--profile-name" and i + 1 < len(flags):
            profile_name = flags[i + 1]
    dry_run = "--dry-run" in flags

    with open(yaml_path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    enforcer_index = build_enforcer_index(doc)
    overrides = load_overrides(yaml_path)
    installed_from = load_installed_from(yaml_path)
    # Printed unconditionally, even when empty, specifically so a run's own
    # output says whether this mechanism is live at all. Absent line = this
    # VPS copy of the script predates installedFrom support (upload the new
    # one). "0 records" = the script is current but the GUI hasn't written
    # any yet (its server.js half needs the GUI process restarted, and a
    # record only appears once a mod is installed/updated THROUGH the GUI
    # after that restart). Both were real, indistinguishable-from-the-output
    # confusions the first time this shipped.
    print(
        f"Loaded {len(installed_from)} installedFrom record(s) from {INSTALLED_FROM_FILENAME} "
        f"(records the exact Thunderstore/Hexium source each mod was installed from).",
        file=sys.stderr,
    )

    # --plugins-dir is now the PRIMARY source of truth this script resolves
    # from (see the module docstring) — the installed folder for each mod is
    # what actually gets downloaded and hashed, with Mods.yaml only used
    # afterward to decide which of the two codes (if either) it belongs in.
    # That means, unlike before, it's required, not an optional enhancement.
    if not plugins_dir:
        print(
            "generate-codes.py now resolves directly from the installed BepInEx/plugins folder "
            "(each folder's own name is the unique 'Owner-PackageName-Version' dependency string to "
            "download) and only uses Mods.yaml afterward to split player vs admin — pass "
            "--plugins-dir <path to BepInEx/plugins>.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Scans recursively (not just the top level) because several real mods
    # here nest their DLL a level or two deeper (e.g. a patcher's own
    # patchers/<name>/ subfolder, or a mod that ships an extra BepInEx/
    # plugins/ layer inside its own folder) — dlls_by_folder is keyed by the
    # TOP-LEVEL folder name regardless of how deep the actual .dll sits.
    try:
        installed_folders = [
            f for f in os.listdir(plugins_dir)
            if os.path.isdir(os.path.join(plugins_dir, f))
        ]
    except OSError as ex:
        print(f"  [error] could not read --plugins-dir '{plugins_dir}': {ex}", file=sys.stderr)
        sys.exit(1)
    dlls_by_folder = {}
    total_dlls = 0
    for top in installed_folders:
        names = []
        for root, _dirs, files in os.walk(os.path.join(plugins_dir, top)):
            for fn in files:
                if fn.lower().endswith(".dll"):
                    names.append(fn[:-4])
        dlls_by_folder[top] = names
        total_dlls += len(names)
    print(
        f"Found {len(installed_folders)} installed plugin folders under '{plugins_dir}' "
        f"({total_dlls} DLLs scanned) — this is the full set of folders that will be resolved and "
        f"then split into player/admin by comparing each one against Mods.yaml.",
        file=sys.stderr,
    )

    print(f"Fetching Thunderstore package list for community '{community}'...", file=sys.stderr)
    ts_packages = fetch_packages(community)
    print(f"  -> {len(ts_packages)} Thunderstore packages", file=sys.stderr)
    print(f"Fetching Hexium package list for community '{community}'...", file=sys.stderr)
    hex_packages = fetch_hexium_packages(community)
    print(f"  -> {len(hex_packages)} Hexium packages", file=sys.stderr)
    packages = ts_packages + hex_packages

    print("\nResolving always-included framework/dependency packages:", file=sys.stderr)
    always_include_resolved = resolve_always_include(packages, installed_folders)

    codes = {}

    # One pass over every installed folder resolves everything this script
    # could ever need for ANY mode — each folder's status (required/
    # adminOnly/optional/serverOnly/unlisted) already comes straight out of
    # classify_folder(), so unlike the old Mods.yaml-driven approach there's
    # no separate "resolve the union, then slice by guid" step needed: the
    # single resolve_from_plugins() pass below IS the union, and slicing by
    # `status` (computed once per folder) is free. This also means a mode
    # that only needs the player code no longer has to walk adminOnly-only
    # folders at all.
    print("\nResolving installed plugin folders against Thunderstore/Hexium, then against Mods.yaml for player/admin separation:", file=sys.stderr)
    all_resolved = resolve_from_plugins(installed_folders, dlls_by_folder, enforcer_index, packages, overrides, installed_from)

    if mode == "player":
        player_seed = [(p, v, e) for p, v, e, g, status in all_resolved if status == "required"]
        admin_seed = None
    elif mode == "admin":
        admin_seed = [(p, v, e) for p, v, e, g, status in all_resolved if status in ("required", "adminOnly")]
        player_seed = None
    else:  # both
        player_seed = [(p, v, e) for p, v, e, g, status in all_resolved if status == "required"]
        admin_seed = [(p, v, e) for p, v, e, g, status in all_resolved if status in ("required", "adminOnly")]

    # Each code is uploaded and printed IMMEDIATELY once it's ready, rather
    # than batching both prints to the very end after everything finishes —
    # a real run showed why this matters: the player code had already
    # uploaded successfully to Hexium, but the connection got cut mid-way
    # through the admin pass, and the old batched-print-at-the-end code
    # meant that already-successful upload's key never printed at all. Now
    # even a run that gets cut short still hands back whatever it already
    # finished.
    if player_seed is not None:
        print("\nBuilding PLAYER code (requiredMods):", file=sys.stderr)
        entries = build_profile(player_seed, always_include_resolved, "player")
        if dry_run:
            print("[dry run] not uploading player code.", file=sys.stderr)
        else:
            codes["player"] = upload_profile(f"{profile_name} (Player)", entries)
            print(f"PLAYER_CODE={codes['player']}")

    if admin_seed is not None:
        print("\nBuilding ADMIN code (requiredMods + adminOnlyMods):", file=sys.stderr)
        entries = build_profile(admin_seed, always_include_resolved, "admin")
        if dry_run:
            print("[dry run] not uploading admin code.", file=sys.stderr)
        else:
            codes["admin"] = upload_profile(f"{profile_name} (Admin)", entries)
            print(f"ADMIN_CODE={codes['admin']}")

    if not dry_run and codes:
        print("Use Gale Mod Manager when importing codes: File > Import profile > From code.")


if __name__ == "__main__":
    main()
