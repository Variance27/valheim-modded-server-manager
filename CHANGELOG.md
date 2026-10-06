# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Dependencies when installing a mod.** If the mod needs other mods that are not installed, the install prompt lists them (including their own dependencies, resolved in order) and offers **Install with dependencies**, **Install only this mod**, or Cancel. Dependencies are installed first, and if one fails the mod itself is not installed.
- **Dependencies when removing a mod.** Removing a mod now checks the other installed mods. If some need it, you are asked whether to remove them as well; if it has libraries that nothing else installed uses, you are asked whether to remove those too. Libraries still used by other mods are kept. Bulk remove does the same for the whole selection.

- **Dependencies when updating a mod.** If the new version needs mods that are not installed, the update (single, manual or bulk) lists them, with which mod needs each, and offers **Update with dependencies**, **Update only** or Cancel. Dependencies are installed first, and if one fails the update is not applied.
- **Mod history and rollback (Mods > History).** The installed mod list (folder, package, version, source) is saved automatically before every install, update or removal (the newest 30 are kept), and the nightly backup also writes a `<world>-<date>-mods.txt` record. **Restore** shows a plan first (go back to a version, reinstall, remove; Required mods start unticked) and only touches mod folders, never configs or the world. A safety snapshot is taken before a restore, so it can be undone. **Save snapshot now** takes one on demand. Re-run Setup step 7 so the updated backup script is installed.

- **Migration to a new VPS (Migration page).** Export one or more worlds as a single bundle (saves, LinuxGSM settings, BepInEx plugins and configs, disabled mods, snapshots), download it, point the GUI at the new VPS, and import it there. The bundle is checksummed and verified before anything is unpacked, nothing on either VPS is deleted (replaced files go to `pre-migration-<time>`), and the GUI shows what is ready on the new VPS. See [docs/MIGRATION.md](docs/MIGRATION.md).

### Fixed

- The Discord notifications, Health alerts and Discord bot cards in Settings have a cleaner layout: aligned panels and rows, consistent buttons, and no extra indentation. Password and number fields now use the same styling as other inputs instead of the browser's grey default.
- The Backups lists (Valheim and Project Zomboid) no longer show `.txt` files such as the `-plugins.txt` mod-list records, which had a Restore button that could not work, and they no longer use up the 50 listed entries. Only real backups are listed and can be restored.

## [1.1.0] - 2026-10-05

### Added

- **Health alerts.** Settings has a Health alerts card. A small cron job on the VPS posts to the status channel when the server is down, or when disk space or free memory crosses a threshold, with re-alert throttling. It keeps working when the GUI is closed. A server stopped from the GUI, or stopped by a backup, update or restore, is treated as deliberate and does not alert.
- **Restore a kept copy.** When a world is uninstalled with "keep a copy", the Worlds page lists the copy and can restore it into an existing world you choose, or delete it.
- **Automated tests and CI.** `npm test` runs API and script tests in temporary directories, `npm run test:py` tests the bot and code generator, and a GitHub Actions workflow runs both. A `package-lock.json` is included.
- **Optional Discord `/codes` bot, installed from the GUI.** Settings has a Discord bot card that installs the bot as a systemd service (own virtualenv, root-only token file), with start, stop, restart, log, refresh and remove. `/codes` has a `world` option fed by the GUI's world list, which updates when worlds are added or deleted. The public post and profile names use the world's own name instead of a hard-coded one. A bot service that the GUI did not create is never touched.
- **Discord webhooks in the GUI.** Settings has a Discord notifications card for the changes and status channels, with test buttons, masked display and validation. Saving a new status URL refreshes the backup and update-check jobs and each world's `valheim-notify.conf` on the VPS. URLs are stored in the git-ignored `notifications.json` and win over `config.json`.
- **Firewall handling.** When the VPS runs an active `ufw`, the GUI opens a world's UDP game ports (port to port+2) when the port is saved in Setup step 3 or Settings and before the first start in step 8, moves the rule when the port changes, and closes it when the world is uninstalled. It never enables or disables `ufw` and never touches other rules. A new Setup checklist item shows the state.
- **Uninstall a world from the VPS.** Removing an extra world can now also stop its processes, remove its cron jobs and files, and delete its game account and home folder, optionally keeping a copy of the saves and backups first. Guarded by a typed `DELETE` confirmation, a size preview, and strict checks that only `vhserver-<id>` for that world can be touched.

### Fixed

- The uninstall preview now counts world saves correctly and says whether the world has ever been saved.
- Running as a non-root SSH user: reads of game account homes (mode 750) and the Setup status checks now go through sudo, so they no longer report false "missing" results.
- The Updates tab check no longer fails with "could not determine latest buildid" when Debian's `steamcmd` wrapper is broken: it prefers the SteamCMD copies in the game account's home, tries each in turn, retries, and prints SteamCMD's last lines on failure.
- The Health alerts card no longer gets overwritten by dashboard status updates (a duplicate function name), and disk/memory thresholds are only validated where they apply.
- `update-valheim.sh` sets the maintenance flag for the whole update, so health alerts stay quiet while the server is deliberately down.

## [1.0.0] - 2026-10-05

First public release.

### Added

- **Setup tab** that takes a fresh Ubuntu or Debian VPS to a running modded Valheim server in eight steps with live output and a checklist: LinuxGSM, the Valheim server, name/world/password/port, BepInEx, `common.cfg` wiring with preview and backup, ValheimEnforcer with its dependencies, helper scripts, and start-and-verify.
- **Multiple worlds** on one VPS: the Worlds page, a sidebar world switcher, per-world game accounts, ports, mods, backups, cron jobs and Discord labels, and refusal to start overlapping ports.
- **Mods tab** with update badges across Hexium and Thunderstore, install/update prompts, categories, disable/remove, bulk actions, dependency checks, Gale links and Gale profile code generation.
- **Backups and updates** with restore (safety copy first), cron schedules on the VPS, an "only when nobody is online" option, a backup gate before every server update, and optional rclone off-site copies.
- **Dashboard, logs, settings, mod config editor, player lists and restart-required banner.**
- **Login** with a scrypt-hashed password, rate limiting and CSRF protection.
- Optional Project Zomboid tab.

### Behavior notes

- The world name and Gale profile names follow the server's own world name (the generic name "Valheim" is shown until the world exists).
- Generated player codes include JsonDotNET only when the server has it installed, because ValheimEnforcer rejects clients that have mods the server does not list.
- Setup step 6 installs ValheimEnforcer's dependency chain (for example Jotunn); without it BepInEx cannot load Enforcer.
