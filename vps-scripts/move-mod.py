#!/usr/bin/env python3
"""
move-mod.py — move a mod between requiredMods / optionalMods / adminOnlyMods /
serverOnlyMods in ValheimEnforcer's Mods.yaml, or delete its entry entirely,
without hand-editing the file.

Uses ruamel.yaml in round-trip mode specifically because plain PyYAML would
silently strip the big header comment block (and any notes you've added) on
every write. This preserves them.

Requires: pip install ruamel.yaml --break-system-packages

Usage:
  # See how every known mod is currently categorized:
  python3 move-mod.py Mods.yaml --list

  # Move a mod (matched by GUID or by its display name) to a bucket:
  python3 move-mod.py Mods.yaml <mod> required
  python3 move-mod.py Mods.yaml <mod> optional
  python3 move-mod.py Mods.yaml <mod> admin
  python3 move-mod.py Mods.yaml <mod> server

  # Remove its entry entirely (e.g. after uninstalling the mod). Also drops
  # its entry from Mods.overrides.yaml if it has one, since there's nothing
  # left for a folderName/pin/ignore-updates override to apply to.
  python3 move-mod.py Mods.yaml <mod> delete

  # Pin an installed plugin folder name to an existing entry, so the GUI's
  # matcher can find it even when the folder name has no textual relationship
  # to the GUID/display name (e.g. an acronym like "AAA_Crafting" for
  # "AzuAntiArthriticCrafting"). Does not move the entry between buckets.
  python3 move-mod.py Mods.yaml <mod> pin-folder <installed-folder-name>

  # Pin a mod's real Thunderstore/Hexium package identity directly — for a
  # mod whose display name matches nothing on either platform, or matches
  # the WRONG thing (a generic name shared by several unrelated packages).
  # Same "Owner-PackageName-Version" format either way.
  python3 move-mod.py Mods.yaml <mod> pin-thunderstore <Owner-Name-Version>
  python3 move-mod.py Mods.yaml <mod> pin-hexium <Owner-Name-Version>

  # Stop / resume showing an "update available" badge for this mod in the
  # GUI — useful for something like a bundled dependency-probe plugin that
  # always reads a stale internal version number even when it's genuinely
  # current, so it would otherwise flag a false/uninteresting update forever.
  python3 move-mod.py Mods.yaml <mod> ignore-updates
  python3 move-mod.py Mods.yaml <mod> unignore-updates

  # Preview without writing:
  python3 move-mod.py Mods.yaml <mod> admin --dry-run

Examples:
  python3 move-mod.py Mods.yaml AzuClock optional
  python3 move-mod.py Mods.yaml MidnightsFX.NetworkPerformanceSystem server
  python3 move-mod.py Mods.yaml OldUnusedMod delete
  python3 move-mod.py Mods.yaml Azumatt.AzuAntiArthriticCrafting pin-folder AAA_Crafting
  python3 move-mod.py Mods.yaml ValheimModding.YamlDotNetDetector ignore-updates

Where pin-folder / pin-thunderstore / pin-hexium / ignore-updates /
unignore-updates actually get stored:

  These are NOT written into Mods.yaml itself. ValheimEnforcer deserializes
  Mods.yaml into its own internal model and rewrites the whole file from
  that model on its own (confirmed: happens on every VPS/GUI restart) — it
  only knows its own fields, so any extra key added directly to an entry
  gets silently dropped the next time it does that. Real symptom this
  caused: a folderName pin and an ignoreUpdates flag both vanishing on
  every restart, with no error anywhere.

  Instead, these four fields live in a separate sidecar file next to
  Mods.yaml: Mods.overrides.yaml, a flat "GUID: {field: value}" map that
  ValheimEnforcer never touches at all, so nothing it does can ever wipe it.
  Every script/GUI code path that used to read these fields off a Mods.yaml
  entry now reads them from here instead. Safe to hand-edit directly too if
  you prefer — see its own header comment, written the first time this
  script creates it.
"""
import os
import re
import sys
import shutil
from pathlib import Path

try:
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap
except ImportError:
    print("Missing dependency: pip install ruamel.yaml --break-system-packages", file=sys.stderr)
    sys.exit(1)

BUCKETS = {
    "required": "requiredMods",
    "optional": "optionalMods",
    "admin": "adminOnlyMods",
    "server": "serverOnlyMods",
}
# Mods.yaml only ever has these four buckets — ValheimEnforcer itself drops a
# newly installed mod straight into requiredMods, there's no separate
# activeMods bucket to worry about (an earlier version of this script briefly
# added one, based on a wrong assumption about the schema — reverted).
MOVABLE_BUCKET_KEYS = list(BUCKETS.values())

MIN_SUBSTRING_LEN = 4  # avoid short fragments matching everything

OVERRIDES_FILENAME = "Mods.overrides.yaml"

OVERRIDES_HEADER = """\
GUI/script-owned overrides for Mods.yaml entries, keyed by GUID:
  folderName          - installed BepInEx/plugins folder name, for mods the
                         fuzzy GUID/name matcher can't correlate on its own
                         (e.g. an acronym like AAA_Crafting for
                         AzuAntiArthriticCrafting).
  ignoreUpdates        - true to stop showing an "update available" badge
                         for this mod (e.g. a detector plugin that always
                         reads a stale bundled version).
  thunderstorePackage  - pin this mod's real Thunderstore package identity
  hexiumPackage        - pin this mod's real Hexium package identity
                         (both: "Owner-PackageName-Version" — the Version
                         part only confirms you're pinning a real, existing
                         package at the time you set this; generate-codes.py
                         always resolves the VERSION to actually use from
                         Mods.yaml's own live record for this mod, not from
                         what you type here, so a pinned mod keeps updating
                         normally — you never need to re-pin it just
                         because it updated)

Deliberately kept in a SEPARATE file from Mods.yaml itself. ValheimEnforcer
deserializes Mods.yaml into its own internal model and rewrites the whole
file from that model on its own (confirmed: happens on every VPS/GUI
restart) - it only knows its own fields, so any extra key added directly to
an entry gets silently dropped the next time it does that. This file is
never touched by ValheimEnforcer, so nothing it does can ever wipe it.

Normally managed via:
  move-mod.py Mods.yaml <mod> pin-folder <folder-name>
  move-mod.py Mods.yaml <mod> pin-thunderstore <Owner-Name-Version>
  move-mod.py Mods.yaml <mod> pin-hexium <Owner-Name-Version>
  move-mod.py Mods.yaml <mod> ignore-updates / unignore-updates
Safe to hand-edit directly too - same simple "GUID: {field: value}" shape.
"""


def normalize(s):
    # Strip everything but letters/digits — a query like "Owner-Package_Name"
    # (how BepInEx/plugins folders are actually named) and a Mods.yaml GUID
    # like "owner.package_name" should match despite the different
    # punctuation. Mirrors the same normalize() used for status badges in
    # the GUI (server.js) — keeping both matchers consistent matters, since
    # a mod that shows a category badge should always be reachable by name.
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def overrides_path(yaml_path):
    return yaml_path.parent / OVERRIDES_FILENAME


def load_overrides(yaml, yaml_path):
    """Loads Mods.overrides.yaml (the sidecar override file — never
    Mods.yaml itself, see the module docstring for why). Returns an empty,
    header-commented CommentedMap if the file doesn't exist yet; the first
    write creates it."""
    path = overrides_path(yaml_path)
    if not path.exists():
        data = CommentedMap()
        data.yaml_set_start_comment(OVERRIDES_HEADER)
        return data
    with path.open("r", encoding="utf-8") as f:
        data = yaml.load(f)
    if data is None:
        data = CommentedMap()
        data.yaml_set_start_comment(OVERRIDES_HEADER)
    return data


def match_owner(path, reference):
    """Give `path` the same owner/group as `reference`. This script is normally run as root
    (by the GUI) inside a folder owned by the game account, and LinuxGSM refuses to start the
    server if any file under serverfiles/ is owned by someone else, so a root-owned backup or
    sidecar file would stop the next start."""
    try:
        st = os.stat(reference)
        os.chown(path, st.st_uid, st.st_gid)
    except (OSError, AttributeError):
        pass

def save_overrides(yaml, yaml_path, overrides):
    path = overrides_path(yaml_path)
    if path.exists():
        backup_path = path.with_suffix(path.suffix + ".bak")
        shutil.copy2(path, backup_path)
        match_owner(backup_path, path)
        print(f"Backed up {path.name} to {backup_path}")
    with path.open("w", encoding="utf-8") as f:
        yaml.dump(overrides, f)
    match_owner(path, yaml_path)


def find_mod(doc, query):
    """Find a mod by exact GUID/name (normalized) or by the closest
    bidirectional substring match. Returns (bucket_key, guid) or exits with a
    helpful message on no-match/ambiguity."""
    query_norm = normalize(query)

    # Exact match (either direction of GUID/name, once normalized) wins immediately.
    for bucket_key in MOVABLE_BUCKET_KEYS:
        bucket = doc.get(bucket_key) or {}
        for guid, entry in bucket.items():
            name = (entry.get("name") or "") if entry else ""
            if normalize(guid) == query_norm or normalize(name) == query_norm:
                return bucket_key, guid

    # Otherwise, closest-length substring match across GUID and name, in
    # either direction — same scoring approach as the GUI's badge matcher.
    candidates = []  # (score, bucket_key, guid, name)
    for bucket_key in MOVABLE_BUCKET_KEYS:
        bucket = doc.get(bucket_key) or {}
        for guid, entry in bucket.items():
            name = (entry.get("name") or "") if entry else ""
            guid_norm = normalize(guid)
            name_norm = normalize(name)
            if len(query_norm) >= MIN_SUBSTRING_LEN and len(guid_norm) >= MIN_SUBSTRING_LEN:
                if guid_norm in query_norm or query_norm in guid_norm:
                    candidates.append((abs(len(guid_norm) - len(query_norm)), bucket_key, guid, name))
            if len(query_norm) >= MIN_SUBSTRING_LEN and len(name_norm) >= MIN_SUBSTRING_LEN:
                if name_norm in query_norm or query_norm in name_norm:
                    candidates.append((abs(len(name_norm) - len(query_norm)), bucket_key, guid, name))

    if not candidates:
        print(f"No mod found matching '{query}'. Check the GUID/name, or run --list.", file=sys.stderr)
        sys.exit(1)

    candidates.sort(key=lambda c: c[0])
    best_score = candidates[0][0]
    best_ties = {(b, g, n) for score, b, g, n in candidates if score == best_score}
    if len(best_ties) > 1:
        print(f"Ambiguous: '{query}' matches multiple mods equally well:", file=sys.stderr)
        for bucket_key, guid, name in best_ties:
            print(f"  - {guid} ({name})  (currently in {bucket_key})", file=sys.stderr)
        sys.exit(1)

    bucket_key, guid, _ = next(iter(best_ties))
    return bucket_key, guid


def list_mods(doc, overrides):
    for bucket_key in MOVABLE_BUCKET_KEYS:
        bucket = doc.get(bucket_key) or {}
        print(f"\n{bucket_key} ({len(bucket)}):")
        if not bucket:
            print("  (empty)")
        for guid, entry in bucket.items():
            name = (entry.get("name") or "") if entry else ""
            version = (entry.get("version") or "") if entry else ""
            ov = overrides.get(guid) or {}
            notes = []
            if ov.get("folderName"):
                notes.append(f"pinned folder: {ov['folderName']}")
            if ov.get("ignoreUpdates"):
                notes.append("updates ignored")
            if ov.get("thunderstorePackage"):
                notes.append(f"thunderstore pin: {ov['thunderstorePackage']}")
            if ov.get("hexiumPackage"):
                notes.append(f"hexium pin: {ov['hexiumPackage']}")
            note_str = f"  ({'; '.join(notes)})" if notes else ""
            print(f"  - {guid}  [{name}]  v{version}{note_str}")


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]

    if len(args) < 1:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    yaml_path = Path(args[0])
    if not yaml_path.exists():
        print(f"File not found: {yaml_path}", file=sys.stderr)
        sys.exit(1)

    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=2, offset=0)

    with yaml_path.open("r", encoding="utf-8") as f:
        doc = yaml.load(f)

    overrides = load_overrides(yaml, yaml_path)

    if "--list" in args:
        list_mods(doc, overrides)
        return

    if len(args) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    query, target = args[1], args[2].lower()
    override_targets = ("pin-folder", "pin-thunderstore", "pin-hexium", "ignore-updates", "unignore-updates")
    special_targets = ("delete",) + override_targets
    if target not in special_targets and target not in BUCKETS:
        print(f"Unknown target '{target}'. Use one of: {', '.join(BUCKETS)}, {', '.join(special_targets)}", file=sys.stderr)
        sys.exit(1)

    if target in ("pin-folder", "pin-thunderstore", "pin-hexium") and len(args) < 4:
        arg_hint = {
            "pin-folder": "<installed-folder-name>",
            "pin-thunderstore": "<Owner-Name-Version>",
            "pin-hexium": "<Owner-Name-Version>",
        }[target]
        print(f"{target} requires an argument: move-mod.py Mods.yaml <mod> {target} {arg_hint}", file=sys.stderr)
        sys.exit(1)

    current_bucket, guid = find_mod(doc, query)
    entry = doc[current_bucket][guid]
    name = (entry.get("name") or guid) if entry else guid

    if target in override_targets:
        field_by_target = {
            "pin-folder": "folderName",
            "pin-thunderstore": "thunderstorePackage",
            "pin-hexium": "hexiumPackage",
        }
        if target in field_by_target:
            field = field_by_target[target]
            value = args[3]
            print(f"Setting {field} = '{value}' for '{name}' ({guid}) in Mods.overrides.yaml")
            if dry_run:
                print("[dry run] not writing any changes.")
                return
            overrides.setdefault(guid, CommentedMap())[field] = value
            save_overrides(yaml, yaml_path, overrides)
            print(f"Done. '{name}' now resolves via {field} = '{value}'.")
        else:
            ignoring = target == "ignore-updates"
            verb = "Ignoring" if ignoring else "Re-enabling"
            print(f"{verb} update checks for '{name}' ({guid}) in Mods.overrides.yaml")
            if dry_run:
                print("[dry run] not writing any changes.")
                return
            if ignoring:
                overrides.setdefault(guid, CommentedMap())["ignoreUpdates"] = True
            elif guid in overrides and "ignoreUpdates" in overrides[guid]:
                del overrides[guid]["ignoreUpdates"]
            save_overrides(yaml, yaml_path, overrides)
            if ignoring:
                print(f"Done. '{name}' will no longer be checked for updates.")
            else:
                print(f"Done. '{name}' will be checked for updates again.")
        print(
            "Stored in Mods.overrides.yaml, a file ValheimEnforcer never touches — "
            "it survives VPS/GUI restarts, unlike writing it directly into Mods.yaml."
        )
        return

    if target == "delete":
        print(f"Deleting entry for '{name}' ({guid}) from {current_bucket}")
        if dry_run:
            print("[dry run] not writing any changes.")
            return
        backup_path = yaml_path.with_suffix(yaml_path.suffix + ".bak")
        shutil.copy2(yaml_path, backup_path)
        match_owner(backup_path, yaml_path)
        print(f"Backed up original to {backup_path}")
        del doc[current_bucket][guid]
        with yaml_path.open("w", encoding="utf-8") as f:
            yaml.dump(doc, f)
        if guid in overrides:
            del overrides[guid]
            save_overrides(yaml, yaml_path, overrides)
            print(f"Also removed '{name}'s entry from Mods.overrides.yaml.")
        print(f"Done. '{name}' removed from Mods.yaml entirely.")
        return

    target_key = BUCKETS[target]

    if current_bucket == target_key:
        print(f"'{name}' ({guid}) is already in {target_key} — nothing to do.")
        return

    print(f"Moving '{name}' ({guid}): {current_bucket} -> {target_key}")

    if dry_run:
        print("[dry run] not writing any changes.")
        return

    # Pull the entry out, dropping it into an empty bucket if needed (ValheimEnforcer
    # writes empty buckets as a blank/null value, not {}).
    if doc[target_key] is None:
        doc[target_key] = type(doc[current_bucket])()  # same CommentedMap type, keeps formatting consistent
    doc[target_key][guid] = entry
    del doc[current_bucket][guid]

    backup_path = yaml_path.with_suffix(yaml_path.suffix + ".bak")
    shutil.copy2(yaml_path, backup_path)
    match_owner(backup_path, yaml_path)
    print(f"Backed up original to {backup_path}")

    with yaml_path.open("w", encoding="utf-8") as f:
        yaml.dump(doc, f)

    print(f"Done. '{name}' is now in {target_key}.")
    print("ValheimEnforcer re-reads Mods.yaml within its ConfigPollIntervalSeconds — no restart needed.")
    print("(Any folderName/ignoreUpdates/pin overrides on this mod, in Mods.overrides.yaml, are unaffected by the move.)")


if __name__ == "__main__":
    main()
