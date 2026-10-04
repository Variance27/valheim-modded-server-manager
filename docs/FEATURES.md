# Features

A tour of each tab. The sidebar changes with context: the **Worlds** page and the **World** switcher appear once you have more than one world, and the Valheim/Zomboid switch appears when a `zomboid` block is configured.

## Setup

Takes a fresh Ubuntu or Debian VPS to a running modded server in eight steps with live output and a checklist. Safe to ignore on a server that already works. Full walkthrough: [Getting started](GETTING_STARTED.md).

## Dashboard

- **Start and Stop.** There is deliberately no Restart. Stop, wait for the status to show `inactive`, then Start, so the world is always saved first.
- **Server health, world saved, resources.** CPU, process CPU, memory and disk with rolling charts, and host details such as CPU steal, I/O wait, Valheim memory and swap.
- **World saved.** Shows when Valheim last wrote the world. Valheim saves only on its autosave timer and on a clean stop, so if this grows well past the autosave interval while the server runs, progress is only in memory. States: waiting for autosave, on schedule, late, not saving.
- **Players online.** Updated live from join and leave lines in the log. Valheim has no player API, so treat this as a hint: a crash with no clean disconnect can leave a stale name until the next log event.
- **Server info.** World, mods installed, connect address with a copy button, uptime and game port.
- **Recent activity** of actions and state changes from this browser.

## Mods

![Mods tab](images/mods.png)

Lists everything in `BepInEx/plugins`, tagged **Required**, **Admin-only**, **Server-only**, **Optional** or **Unlisted** by cross-checking ValheimEnforcer's `Mods.yaml`. Highlights:

- **Update badges** per mod, checked against Hexium first and Thunderstore as a fallback.
- **Install and update prompts** for Source, Author and Version before anything downloads, pre-filled with the best guess.
- **Categories.** Move a mod between Required, Optional, Admin-only and Server-only without editing YAML.
- **Disable and Remove.** Disable keeps the files and moves the mod to Optional; Remove deletes the folder and its `Mods.yaml` entry. Both ask you to type `FORCE` for Required or Admin-only mods.
- **Bulk actions** for update, remove and recategorize.
- **Dependency check** when installing a mod, with the option to continue anyway.
- **Current Requirements** list with links and one-click Gale install links, and a "Copy as text" button for Discord.
- **Generate codes.** Gale profile codes for players and admins, built from the installed mods.
- **Action log and Notify Discord.** Changes are collected and sent as one summary when you press the button.

How mods are matched and why: [Mods and ValheimEnforcer](MODS_AND_ENFORCER.md).

## Mod configs

Edits BepInEx `config/*.cfg` files. It reads each entry's description, type, default and allowed values from the comments BepInEx writes, shows the right input, validates before saving, changes only the value on the existing line, and keeps the newest five `.bak.<timestamp>` copies per file.

## Backups

Runs the backup script, lists archives, restores one, and sets the schedule. Details: [Backups and scheduling](BACKUPS_AND_SCHEDULING.md).

## Updates

Runs the update check and the update, and sets the scheduled check. An update always takes a backup first and aborts if the backup fails. The scheduled check only notifies; it never installs or restarts.

## Settings

Edits the LinuxGSM config (`common.cfg`, or the instance cfg if that is where a value is set): server name, password, port, listed or unlisted, autosave interval, Valheim's own backup settings, and world modifiers (preset, combat, death penalty, resource rate, raids, portals, world keys). A `.bak.<timestamp>` copy is made before every write, and values apply after Stop and Start. The password must be at least 5 characters, must not contain the world name, and very common passwords are flagged.

The admin, banned and permitted lists live in `adminlist.txt`, `bannedlist.txt` and `permittedlist.txt` next to the world data. IDs must be 17-digit SteamID64s. Valheim re-reads them while running, so no restart is needed.

## Logs

A snapshot of the LinuxGSM console log or `LogOutput.log`, plus a "Go Live" toggle that streams new lines until you stop it.

## Worlds

Run several worlds at the same time, and remove one cleanly (including deleting it from the VPS): [Multiple worlds](MULTIPLE_WORLDS.md).

![Worlds page](images/worlds.png)

## Restart-required banner

Changes that only take effect at launch (launch settings, world modifiers, mod config edits, mod install, remove, enable and disable) are noted per world. While the running server started before such a change, a banner on every page lists them. Stop and Start clears it automatically.

## Login

The GUI shows a sign-in page before anything else. Details are in [SECURITY.md](../SECURITY.md).
