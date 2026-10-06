# Moving to a new VPS

The Migration page (sidebar, under Operations) moves your worlds, settings, mods and mod configs to another VPS. It works in two steps: export a bundle while the GUI is connected to the old VPS, then connect the GUI to the new VPS and import it.

## What is moved

For every world you pick (the main world and any extra worlds), the bundle can hold:

- **Worlds and settings:** the save folder (`worlds_local`, plus the admin, banned and permitted lists) and the LinuxGSM config folder (server name, password, port, launch options and world modifiers, and the `common.cfg` wiring for BepInEx).
- **Mods and configs:** BepInEx `plugins`, `config` (including ValheimEnforcer's `Mods.yaml`, overrides and the installed-from record) and `patchers`, plus the `disabled-mods` and `mod-snapshots` folders when they exist.

It does not move: existing backup archives, cron jobs and helper scripts (Setup step 7 installs them on the new VPS), Discord webhooks, health-alert settings, the Discord bot, firewall rules, or the GUI's own `config.json` and `instances.json`.

## Step by step

1. **Export.** On the Migration page, Export tab: tick the worlds, choose what to include, and press **Build bundle**. Stop each world first (Dashboard) so its save is consistent; if you export a running world anyway you are warned. The GUI packs everything into a staging folder on the old VPS under `/var/tmp/vgui-migration`, then **Download bundle** saves a `.tar` file on your computer. **Remove from VPS** deletes the staged copy.
2. **Point the GUI at the new VPS.** Edit `ssh.host` (and the key or password if they differ) in `config.json` and restart the GUI. Extra worlds are listed in `instances.json`; the import can add any that are missing.
3. **Set up the new VPS.** For each world run **Setup steps 1, 2 and 4** (LinuxGSM, the Valheim server, BepInEx). They create the game account and install BepInEx, which the import needs. Running the other steps first is fine too; the import overwrites their results with the bundle's.
4. **Import.** Import tab: choose the `.tar` file and press **Upload**. The GUI shows what is in it and what is ready on the new VPS (account exists, BepInEx installed, world stopped, already has saves). **Check integrity** compares every part with its checksum, and **Import selected** unpacks it. Worlds that already have saves ask before replacing them.
5. **Finish.** Run **Setup step 7** (backups, update checks, health alerts), open the world's UDP ports in the firewall (Worlds page, and your provider's panel), start the server, and give players the new address.

## Safety

- The old VPS is never changed except for the staging folder, and nothing on the new VPS is deleted: anything an import replaces is moved to `pre-migration-<time>` in that world's home folder.
- Each part has a SHA-256 checksum, checked before anything is unpacked, so a cut-off upload is caught.
- Archives with absolute paths, `..`, or links pointing outside their folder are refused.
- The bundle holds the server password and the mod configuration. Keep the file private and delete it (and the staged copies on both VPSes) when you are done.
- Paths inside the LinuxGSM config that point at the old home folder are rewritten to the new one, so a different account name or home folder still works.

## Limits and good to know

- Disk: the staging folder needs about as much free space as the data being exported (the page shows the free space). A big world with many mods can be several GB.
- The upload goes through the GUI to the VPS in one request. It has no time limit, but a connection that drops starts the upload again from the beginning.
- Both VPSes should run the same Valheim and BepInEx versions, or the new one should be newer. Run **Updates** on the new VPS if the game updated since the old one was set up.
- To move back, export from the new VPS and import into the old one the same way.
