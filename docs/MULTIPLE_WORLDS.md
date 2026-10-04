# Running more than one world

Valheim runs one world per server process, so extra worlds are extra server instances on the same VPS. Your first server stays the **main world**, exactly as `config.json` describes it. Everything about the other worlds lives in `instances.json` next to `server.js`; the GUI writes it and never touches `config.json`.

![Worlds page](images/worlds.png)

## Add a world

1. Open **Worlds, then Add world** and type a name. The GUI reserves a game port (2466, then 2476 and so on) and opens that world's Setup tab.
2. Run the eight Setup steps for it. Step 1 creates the game account `vhserver-<id>`, step 3 saves its server name, world name, password and **its own game port**, and step 8 starts it. Each world installs its own copy of the server (about 2 GB) and its own mods.
3. Open the UDP range for the new port, for example `sudo ufw allow 2466:2468/udp`, and the same range in your provider's firewall.
4. Use the sidebar **World** switcher, or **Manage** on the Worlds page, to work on a world. Mods, Backups, Updates, Settings, Logs and the Dashboard then show that world.

Adding or setting up a world does not touch any existing world. Before Setup on a new world, check the World switcher and the "Setting up: <label>" chip at the top of the Setup tab to be sure you are on the world you mean. Take a backup of important worlds first, as with any change.

## Ports

A Valheim server uses its port, the next one (Steam query) and the one after, so worlds are spaced 10 apart: 2456, 2466, 2476. Two worlds conflict if their ports are within 2 of each other. **Start is refused** for a world with no saved port or one that overlaps another world.

## How worlds stay separate

- Each world has its own Linux account, LinuxGSM instance, server files, BepInEx folder, mods, `Mods.yaml`, backups and game port.
- Caches, pending-change lists, cron jobs (`valheim-gui-backup-<id>` and so on, at staggered minutes) and process checks (`pgrep -u <account>`) are per world.
- Discord alerts for extra worlds start with `[<world label>]`, and the generic backup script prefixes every message with the world name.

## Capacity

Each world needs its own RAM and about 2 GB of disk. As a rough guide, a 12 GB, 6-core VPS with no swap fits two to four worlds, depending on mods and player count. Watch memory on the Dashboard, and consider adding swap before running several worlds on a small VPS.

## Removing a world

Stop the world first, then press **Remove** on the Worlds page. You get three choices:

- **Remove from GUI only** makes the GUI forget the world and removes its scheduled jobs. The game account, files and backups stay on the VPS.
- **Delete everything** uninstalls the world from the VPS. It stops any leftover processes of the world's game account, removes its cron jobs, wrapper scripts, lock and status files, then deletes the account `vhserver-<id>` together with its home folder (game files, mods, saves and backups). This cannot be undone.
- **Delete, keep a copy** does the same but first copies the world saves, the admin, ban and permitted lists, and the backups to `/var/lib/valheim-removed-worlds/<id>-<timestamp>/` on the VPS (readable by root only).

The delete buttons stay disabled until you type `DELETE`, and the dialog shows how much disk the world uses and how many saves and backups it has. The main world cannot be uninstalled from the GUI, and the GUI refuses to delete anything that is not the `vhserver-<id>` account it created for that world. If an uninstall fails, the world stays listed so you can retry.

Uninstalling does not close firewall ports. Remove the world's UDP rules yourself (for example `sudo ufw delete allow 2466:2468/udp`).

## Things to know

- If you upgraded from a version without multi-world support, re-save the main world's backup schedule once so its wrapper only looks at its own game process.
- The selected world is remembered in a browser cookie, so two tabs of the same browser share it.
