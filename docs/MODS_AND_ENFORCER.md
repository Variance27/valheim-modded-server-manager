# Mods and ValheimEnforcer

ValheimEnforcer reads the mods each connecting client has and compares them with the server's `Mods.yaml`. This GUI manages the plugin folder and `Mods.yaml` together, so you never edit YAML by hand.

## Categories

| Category | Meaning |
| --- | --- |
| **Required** | Players must have it. |
| **Admin-only** | Only admins may have it. |
| **Server-only** | Runs on the server; clients must not have it. |
| **Optional** | Allowed, but not needed. The only category where "client has it" and "client does not" are both fine. |
| **Unlisted** | In the plugins folder but not yet categorized. |

ValheimEnforcer can only record a mod's real hash after it loads the mod once, so a new mod becomes categorized after the next restart. If you picked a category when installing, an **Apply** button appears afterward to move it in one step.

**Disable vs Remove.** Remove deletes the plugin folder and its `Mods.yaml` entry. Disable moves the folder to `paths.disabledModsDir` and the entry to Optional. Deleting plugin files without touching `Mods.yaml` does not stop enforcing the mod: a stale Required entry still demands players have it.

## Dependencies

ValheimEnforcer needs **Jotunn** (and what Jotunn needs). If a plugin's dependency is missing, BepInEx logs `Could not load [ValheimEnforcer ...] because it has missing dependencies` and Enforcer never writes `Mods.yaml`. Setup step 6 installs Enforcer's whole dependency chain and repairs a server that has Enforcer but not its dependencies. In the Mods tab, installing a mod warns about missing dependencies but does not install them for you.

## How a folder is matched to a Mods.yaml entry and a package

Enforcer's `name` field is the compiled product name, which can be unrelated to the published package name (for example a folder `AAA_Crafting` containing `AzuAntiArthriticCrafting.dll`). The GUI correlates each installed folder to its entry using, in order:

1. a `folderName` pin in `Mods.overrides.yaml`;
2. the exact GUID or name;
3. every DLL name inside the folder;
4. a fuzzy match on names as a last resort.

For update checks and code generation, the real package is resolved in this order:

1. an explicit `thunderstorePackage` or `hexiumPackage` pin in `Mods.overrides.yaml`;
2. `Mods.installedFrom.yaml`, which records which source each mod was last installed or updated from;
3. the folder's own `Owner-Name` split, or an exact name or DLL match;
4. hash verification against Enforcer's accepted hashes;
5. fuzzy display-name matching.

Update checks prefer **Hexium** and fall back to **Thunderstore** for mods that are not on Hexium. Deprecated packages are never matched. Installing a new mod searches both sources.

### Sidecar files

Enforcer rewrites the whole `Mods.yaml` from its own model on every restart, so any extra field written on an entry is wiped. The GUI therefore keeps its own data in files Enforcer never touches, next to `Mods.yaml`:

- **`Mods.overrides.yaml`**, keyed by GUID: `folderName`, `ignoreUpdates`, `thunderstorePackage`, `hexiumPackage`. Plain YAML, safe to hand-edit.
- **`Mods.installedFrom.yaml`**, keyed by installed folder name and written automatically: `{source, owner, name, version}`. It matters because the same mod can exist on both platforms under the same owner and name with different versions.

A mod that shows "Unlisted" can be fixed from the row with **Link to existing entry**, which writes a `folderName` pin. **Ignore Updates** hides the badge for a mod whose bundled version differs from its package tag (for example a detector plugin that reads its version from a bundled DLL).

## Player codes

**Generate codes** builds Gale profile codes from the installed mods, split into a **player** code (Required mods) and an **admin** code (Required plus Admin-only), and prints them in the output. Players import one in [Gale](https://hexium.gg/mod-manager) with **File, Import profile, From code**. Codes are named `<world name> (Player)` and `<world name> (Admin)`.

Every code also includes the framework package **BepInExPack_Valheim**. It includes **JsonDotNET** only when the server has it installed: that package ships a small detector plugin (`com.ValheimModding.NewtonsoftJsonDetector`), so ValheimEnforcer rejects a player who has it when the server does not ("Non-allowed mods found").

Generate codes from the world you want players to join: with several worlds, switch to that world first, because each world has its own mods.

If you prefer no codes, the **Current Requirements** list gives per-mod links and `gale://install/...` links, and a "Copy as text" button for Discord.

## Command-line helper

The GUI drives `vps-scripts/move-mod.py` on the server. You can use it directly:

```bash
python3 move-mod.py Mods.yaml --list
python3 move-mod.py Mods.yaml <mod> required|optional|admin|server|delete
python3 move-mod.py Mods.yaml <mod> pin-folder <installed-folder-name>
python3 move-mod.py Mods.yaml <mod> ignore-updates
```

See the header of the script for every command.
