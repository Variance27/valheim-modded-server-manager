# Backups and scheduling

## What a backup is

`backup-valheim.sh` stops the server so the world is saved, archives the world data and the BepInEx folder, restarts the server, verifies the archive, keeps the newest N archives locally, and, only if `CLOUD_REMOTE` is set, uploads to an [rclone](https://rclone.org) remote and keeps the newest N there. Retention is set by `LOCAL_KEEP` and `CLOUD_KEEP`.

Settings that are not paths live in `/home/<game account>/.config/valheim-notify.conf` on the VPS:

```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
CLOUD_REMOTE=MyRemote:Valheim-Backups     # empty or unset = local backups only
```

## Restore

The Backups tab can restore an archive. You type `RESTORE` to confirm, and it:

1. verifies the archive contains the world (`tar -tzf`) before touching anything;
2. stops the server;
3. saves a safety copy of the current world as `PRE-RESTORE-<world>-<date>.tar.gz` in the backup folder, so a bad restore can be undone;
4. deletes the current world files (newer Valheim saves number their files, and the highest number wins, so extracting over a newer save would leave the newer save in place);
5. extracts the world, fixes ownership and starts the server.

Only the world is restored; mods and configs are not touched. Restore assumes a plain `tar.gz` of the world folder. If your backups are in another format, restore by hand.

## Scheduled backups and update checks

Saving a schedule on the Backups or Updates page installs a real cron job on the VPS (`/etc/cron.d/valheim-gui-backup`, `/etc/cron.d/valheim-gui-update-check`, with `-<id>` suffixes for extra worlds) and a wrapper script in `/usr/local/bin`. After that, cron runs the jobs whether or not the GUI or your PC is on. Turning a schedule off removes both files. Times use the VPS clock. This needs the `cron` package and root SSH (or passwordless sudo).

- **Backup:** skipped when the server is stopped. "Only when nobody is online" postpones the run while players are connected and retries every 15 minutes for up to 12 hours. A lock shared with the dashboard's "Run backup now" prevents overlapping runs. If a backup fails after stopping the server, the wrapper starts the server again and says so on Discord. Valheim cannot warn players in game, and the player count comes from the log, so a player who joins just as a backup starts is disconnected. Pick a quiet hour.
- **Update check:** runs the check script and posts to Discord when a new build appears. It never installs or restarts. Mod updates cannot be cron-checked; use the Mods tab.
- **Server updates** always run a backup first and abort if it fails, so an update never runs over the only good copy of the world.

## Discord

Two channels are supported, and both are set in **Settings, then Discord notifications**:

- **Changes channel:** mod-change summaries from the Mods tab's "Notify Discord" button.
- **Status channel:** automatic alerts from the cron jobs (backup failed, server restarted after a backup, update available). If it is empty, these go to the changes channel.

Keeping them separate lets you mute or restrict the noisy one without losing the alerts that matter. Each field has a **Send test** button that also works on a URL you have typed but not saved yet. Once saved, the full URL is never shown again, only its last four characters.

When the status channel in effect changes, the GUI refreshes it on the VPS for every installed world: it regenerates the enabled backup and update-check wrapper scripts and updates `DISCORD_WEBHOOK_URL` in each world's `valheim-notify.conf` (other lines such as `CLOUD_REMOTE` are kept). You do not need to re-save the schedules. A "Notify Discord" send reports whether the message really went through; if the webhook is wrong, you get an alert and your pending changes stay queued.
