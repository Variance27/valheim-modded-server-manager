#!/bin/bash
# update-valheim.sh
#
# Wraps the update with a mandatory backup gate. If the backup fails for
# any reason, the update is aborted — you never want an update running
# over the only good copy of the world with no fresh backup behind it.
#
# Uses LinuxGSM's own `update` command, which is what LinuxGSM expects to manage
# its install/appmanifest state. If LinuxGSM's update fails (its "Checking remote
# build" step can break on its own, even when Steam and SteamCMD are fine), it
# falls back to SteamCMD's own app_update on the same install folder. Whatever
# happens after the server is stopped, the script tries to start it again.
# Installed by the GUI's Setup tab, which fills in the path values just below.
set -uo pipefail

LGSM_USER="__LGSM_USER__"
LGSM_SCRIPT="__LGSM_SCRIPT__"
LGSM_HOME="__LGSM_HOME__"
SERVER_DIR="__SERVER_DIR__"
APP_ID=896660

# Self-locating, same pattern as before — both scripts always ship together
# in the same directory, so this can't drift out of sync no matter where
# that directory ends up.
BACKUP_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-valheim.sh"
CONF_FILE="$LGSM_HOME/.config/valheim-notify.conf"

# shellcheck source=/dev/null
[ -f "$CONF_FILE" ] && source "$CONF_FILE"

notify() {
    local message="$1"
    local color="${2:-15105570}"
    [ -z "${DISCORD_WEBHOOK_URL:-}" ] && return 0
    curl -sf -H "Content-Type: application/json" \
        -d "{\"embeds\":[{\"description\":\"${message}\",\"color\":${color}}]}" \
        "$DISCORD_WEBHOOK_URL" >/dev/null || true
}

# steamcmd candidates, same order as check-valheim-update.sh: the copies kept in the
# game account's home first, then the distro's wrapper.
STEAMCMDS=()
for candidate in "$LGSM_HOME/.local/share/Steam/steamcmd/steamcmd.sh" "$LGSM_HOME/.steam/steamcmd/steamcmd.sh" \
    "$LGSM_HOME/steamcmd/steamcmd.sh" "$(command -v steamcmd 2>/dev/null)" /usr/games/steamcmd; do
    [ -n "$candidate" ] || continue
    case " ${STEAMCMDS[*]:-} " in *" $candidate "*) continue ;; esac
    [ -x "$candidate" ] && STEAMCMDS+=("$candidate")
done

# Check BEFORE stopping anything: with no SteamCMD at all there is no update to run,
# and stopping the server first would only cause downtime for nothing.
if [ "${#STEAMCMDS[@]}" -eq 0 ]; then
    echo "SteamCMD was not found, so no update can run. Nothing was stopped or changed."
    echo "Fix: as root, run 'apt install steamcmd' (or re-run Setup step 2), then try again."
    notify "🛑 **Update not started**: SteamCMD was not found on the VPS. The server was not stopped." 15158332
    exit 1
fi

start_server() {
    su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" start"
}

# SteamCMD straight onto the server folder (what LinuxGSM does underneath). Used only when
# LinuxGSM's own update fails. Success = SteamCMD says so, not just an exit code.
direct_update() {
    local cmd out
    # SteamCMD answers "already up to date" from cached app info; clear it so the refresh below is real
    # (LinuxGSM deletes this cache before its own checks for the same reason).
    find "$LGSM_HOME" -name appinfo.vdf -type f -delete 2>/dev/null
    for cmd in "${STEAMCMDS[@]}"; do
        echo "-- trying SteamCMD directly: $cmd"
        # Refresh Steam's app info in its OWN run first. With the refresh and app_update in one
        # run, SteamCMD can decide "already up to date" before the new info arrives.
        su - "$LGSM_USER" -c "\"$cmd\" +@NoPromptForPassword 1 +login anonymous +app_info_update 1 +app_info_print $APP_ID +quit" >/dev/null 2>&1
        out="$(su - "$LGSM_USER" -c "\"$cmd\" +@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 +@sSteamCmdForcePlatformType linux +force_install_dir \"$SERVER_DIR\" +login anonymous +app_update $APP_ID +quit" 2>&1)"
        printf '%s\n' "$out" | tail -n 12
        if printf '%s\n' "$out" | grep -qE "Success! App '$APP_ID' (fully installed|already up to date)"; then
            return 0
        fi
    done
    return 1
}

echo "== Step 1/2: running backup before update =="
# Invoked via `bash` explicitly rather than run directly — a fresh file
# transfer from Windows doesn't preserve the Unix execute bit, so running
# it directly can fail with "Permission denied" even though the file is fine.
if ! SKIP_RESTART=1 bash "$BACKUP_SCRIPT"; then
    echo "Backup failed — aborting update. Server was left however the backup script left it."
    notify "🛑 **Update aborted**: pre-update backup failed. Update was never run — check backup-failures.log." 15158332
    exit 1
fi

echo "== Step 2/2: backup OK, running LGSM update =="
# Tell the health check this downtime is on purpose (removed again however the script ends).
touch "$LGSM_HOME/.maintenance"
trap 'rm -f "$LGSM_HOME/.maintenance"' EXIT
# Server is still stopped here (SKIP_RESTART=1 kept it down, and
# backup-valheim.sh already stopped it via `./vhserver stop` to take the
# backup) — the update needs it stopped to safely overwrite server files.
# LGSM's own script must run AS the game account, not root.
METHOD="LinuxGSM"
UPDATED=false
if su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" update"; then
    UPDATED=true
else
    echo
    echo "LinuxGSM's update failed. Trying SteamCMD directly (same server folder, same app)..."
    if direct_update; then
        UPDATED=true
        METHOD="SteamCMD directly (LinuxGSM's own update step failed)"
    fi
fi

if $UPDATED; then
    if start_server; then
        notify "✅ **Valheim server updated** via ${METHOD}, backup taken beforehand, server restarted. Verify mod compatibility now that it's live." 3066993
        echo "Update complete (${METHOD}) and server restarted. Verify mod compatibility."
    else
        notify "⚠️ **Update succeeded but the server failed to restart afterward**. Backup is safe — check \`su - $LGSM_USER -c \"$LGSM_SCRIPT details\"\` on the VPS." 15105570
        echo "Update complete but restart failed — check \`details\` of the LinuxGSM script as $LGSM_USER."
        exit 1
    fi
else
    echo
    echo "Both update methods failed. Backup is intact. Starting the server again on the build it already had..."
    if start_server; then
        notify "❌ **Valheim update failed** (LinuxGSM and SteamCMD both). A fresh backup was taken beforehand and the server was **started again on the old build**. Check the update output in the GUI." 15158332
        echo "Update failed. The server is running again on its previous build; the backup is intact."
    else
        notify "❌ **Valheim update failed and the server could not be restarted.** A fresh backup was taken beforehand, so the world is safe. Check \`su - $LGSM_USER -c \"$LGSM_SCRIPT details\"\` on the VPS." 15158332
        echo "Update failed AND the restart failed. Backup is intact — check the output above, then start the server manually."
    fi
    exit 1
fi
