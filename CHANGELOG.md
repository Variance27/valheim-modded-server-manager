# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Optional Discord `/codes` bot, installed from the GUI.** Settings has a Discord bot card that installs the bot as a systemd service (own virtualenv, root-only token file), with start, stop, restart, log, refresh and remove. `/codes` has a `world` option fed by the GUI's world list, which updates when worlds are added or deleted. The public post and profile names use the world's own name instead of a hard-coded one. A bot service that the GUI did not create is never touched.
- **Discord webhooks in the GUI.** Settings has a Discord notifications card for the changes and status channels, with test buttons, masked display and validation. Saving a new status URL refreshes the backup and update-check jobs and each world's `valheim-notify.conf` on the VPS. URLs are stored in the git-ignored `notifications.json` and win over `config.json`.
- **Firewall handling.** When the VPS runs an active `ufw`, the GUI opens a world's UDP game ports (port to port+2) when the port is saved in Setup step 3 or Settings and before the first start in step 8, moves the rule when the port changes, and closes it when the world is uninstalled. It never enables or disables `ufw` and never touches other rules. A new Setup checklist item shows the state.
- **Uninstall a world from the VPS.** Removing an extra world can now also stop its processes, remove its cron jobs and files, and delete its game account and home folder, optionally keeping a copy of the saves and backups first. Guarded by a typed `DELETE` confirmation, a size preview, and strict checks that only `vhserver-<id>` for that world can be touched.

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
