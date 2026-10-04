#!/bin/bash
# update-valheim.sh
#
# Wraps the update with a mandatory backup gate. If the backup fails for
# any reason, the update is aborted — you never want an update running
# over the only good copy of the world with no fresh backup behind it.
#
# Uses LinuxGSM's own `update` command, which is what LinuxGSM expects to manage
# its install/appmanifest state. Installed by the GUI's Setup tab, which fills in
# the path values just below.
set -uo pipefail

LGSM_USER="__LGSM_USER__"
LGSM_SCRIPT="__LGSM_SCRIPT__"

# Self-locating, same pattern as before — both scripts always ship together
# in the same directory, so this can't drift out of sync no matter where
# that directory ends up.
BACKUP_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-valheim.sh"
CONF_FILE="__LGSM_HOME__/.config/valheim-notify.conf"

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
touch "__LGSM_HOME__/.maintenance"
trap 'rm -f "__LGSM_HOME__/.maintenance"' EXIT
# Server is still stopped here (SKIP_RESTART=1 kept it down, and
# backup-valheim.sh already stopped it via `./vhserver stop` to take the
# backup) — LGSM's update needs it stopped to safely validate/overwrite
# server files. LGSM's own script must run AS the game account, not root.
if su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" update"; then
    if su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" start"; then
        notify "✅ **Valheim server updated** via LGSM, backup taken beforehand, server restarted. Verify mod compatibility now that it's live." 3066993
        echo "Update complete and server restarted. Verify mod compatibility."
    else
        notify "⚠️ **Update succeeded but the server failed to restart afterward**. Backup is safe — check \`su - $LGSM_USER -c \"$LGSM_SCRIPT details\"\` on the VPS." 15105570
        echo "Update complete but restart failed — check \`details\` of the LinuxGSM script as $LGSM_USER."
        exit 1
    fi
else
    notify "❌ **LGSM update command failed** — but a fresh backup was taken beforehand, so the world is safe. Server was left stopped; check output above before restarting." 15158332
    echo "LGSM update failed. Backup is intact. Server left stopped — check the output above, then start manually once resolved."
    exit 1
fi
