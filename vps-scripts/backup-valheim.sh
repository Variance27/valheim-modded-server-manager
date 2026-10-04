#!/bin/bash
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Valheim backup script for a LinuxGSM-managed server (installed by the GUI's
# Setup tab, which fills in the path values just below).
#
# What it does: stops the server (so the world is saved), archives the world
# data + BepInEx folder, restarts the server, verifies the archive, keeps the
# newest N archives locally, and (only if CLOUD_REMOTE is set) uploads to an
# rclone remote and keeps the newest N there.
#
# Settings that are not paths live in the notify file ($CONF_FILE), e.g.
#   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
#   CLOUD_REMOTE=MyRemote:Valheim-Backups     # empty/unset = local backups only
#   WORLD_NAME=...                            # normally NOT needed (see below)
# ---------------------------------------------------------------------------

LGSM_USER="__LGSM_USER__"
LGSM_SERVER="__LGSM_SERVER__"
LGSM_HOME="__LGSM_HOME__"
LGSM_SCRIPT="__LGSM_SCRIPT__"
SERVER_DIR="__SERVER_DIR__"
# Unity's default save location (LinuxGSM's default savedir) — ".../Valheim".
DATA_ROOT="__DATA_ROOT__/Valheim"
BACKUP_DIR="__BACKUP_DIR__"
CONF_DIR="$(dirname "__COMMON_CFG__")"

CONF_FILE="$LGSM_HOME/.config/valheim-notify.conf"
# shellcheck source=/dev/null
[ -f "$CONF_FILE" ] && source "$CONF_FILE"   # may set DISCORD_WEBHOOK_URL, CLOUD_REMOTE, WORLD_NAME

# The world name is a server setting (worldname=... in LinuxGSM's cfg files; its
# default is the instance name). Read it fresh on every run so renaming the world
# in the GUI never breaks backups.
resolve_world() {
    local w="" f v
    if [ -n "${WORLD_NAME:-}" ]; then echo "$WORLD_NAME"; return; fi
    for f in "$CONF_DIR/_default.cfg" "$CONF_DIR/common.cfg" "$CONF_DIR/$LGSM_SERVER.cfg"; do
        [ -f "$f" ] || continue
        v="$(grep -E '^[[:space:]]*worldname=' "$f" | tail -n1 | sed -E 's/^[^=]*=//; s/^"([^"]*)".*$/\1/; s/^'"'"'([^'"'"']*)'"'"'.*$/\1/')" || true
        if [ -n "$v" ]; then w="$v"; fi
    done
    w="${w//\$\{selfname\}/$LGSM_SERVER}"
    w="${w//\$selfname/$LGSM_SERVER}"
    echo "${w:-$LGSM_SERVER}"
}
WORLD_NAME="$(resolve_world)"
case "$WORLD_NAME" in *[!A-Za-z0-9._-]* | "") echo "[error] unsupported world name: '$WORLD_NAME'"; exit 1 ;; esac
WORLD_DIR="$DATA_ROOT/worlds_local/${WORLD_NAME}"
DATE="$(date +%F-%H%M)"

ARCHIVE="$BACKUP_DIR/${WORLD_NAME}-$DATE.tar.gz"
MANIFEST="$BACKUP_DIR/${WORLD_NAME}-$DATE-plugins.txt"

RCLONE_LOG="$LGSM_HOME/rclone-backup.log"
FAIL_LOG="$LGSM_HOME/backup-failures.log"
LOCK_FILE="$LGSM_HOME/.backup-valheim.lock"
MAINTENANCE_FLAG="$LGSM_HOME/.maintenance"

CLOUD_KEEP=3          # newest N archives kept on remote
LOCAL_KEEP=7          # newest N archives kept locally (count-based, not age-based)
MIN_BYTES=51200       # 50 KiB floor (catches empty/truncated archives) — raise it once you know your real archive size
SAVE_MAX_AGE=600      # seconds: after stop, newest world file must be at least this fresh

mkdir -p "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# Locking — prevent overlapping runs
# ---------------------------------------------------------------------------
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "$(date -Is) Backup already running, exiting." >> "$FAIL_LOG"
    exit 75   # EX_TEMPFAIL: "busy" — the cron wrapper treats this as skipped, not failed
fi

# ---------------------------------------------------------------------------
# Notification helpers
# ---------------------------------------------------------------------------
notify() {
    local message="[${WORLD_NAME:-Valheim}] $1"   # world name first, so several worlds can share one Discord channel
    local color="${2:-3066993}"   # green default
    [ -z "${DISCORD_WEBHOOK_URL:-}" ] && return 0
    curl -sf -H "Content-Type: application/json" \
        -d "{\"embeds\":[{\"description\":\"${message}\",\"color\":${color}}]}" \
        "$DISCORD_WEBHOOK_URL" >/dev/null || true
}

SERVER_STOPPED=0      # 1 while WE have the server down and owe it a restart
RESTART_FAILED=0
ARCHIVE_STATE=none    # none -> writing -> good ; anything but "good" is junk on failure

# Run a command with every inherited fd above 2 closed. Without this the game
# server (started via su/tmux) inherits our lock fd (200) and holds the backup
# lock for as long as it runs, so every later backup exits "already running".
run_clean() {
    (
        for f in /proc/self/fd/*; do
            n=${f##*/}
            if [ "$n" -gt 2 ] 2>/dev/null; then eval "exec $n>&-" 2>/dev/null || true; fi
        done
        "$@"
    )
}

start_server() {
    run_clean su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" start"
}

fail() {
    trap - ERR            # never recurse if something below fails too
    local reason="$1"
    echo "[error] $reason"
    echo "$(date -Is) FAILED: $reason" >> "$FAIL_LOG"
    local tail_note=""
    if [ "$ARCHIVE_STATE" = "writing" ]; then rm -f "$ARCHIVE"; fi   # never keep a half-written/unverified archive
    # Bring the server back if this script took it down — a failed backup
    # must never leave the world offline. (SKIP_RESTART=1: the caller restarts.)
    if [ "$SERVER_STOPPED" = "1" ] && [ "${SKIP_RESTART:-0}" != "1" ]; then
        SERVER_STOPPED=0      # one attempt only (the EXIT trap must not retry)
        if start_server; then
            tail_note=" Server was restarted automatically."
        else
            tail_note=" **Server could NOT be restarted — start it manually.**"
        fi
    fi
    notify "❌ **Valheim backup failed**: ${reason}.${tail_note}" 15158332  # red
    rm -f "$MAINTENANCE_FLAG"
    exit 1
}

trap 'fail "unexpected error on line $LINENO"' ERR

# Safety net for anything that ends the script while the server is down
# (kill, cron timeout, `exit` from an unexpected place): bring it back.
# SIGHUP is ignored so an SSH drop during a manual run cannot kill the script
# halfway (children tar/rclone inherit the ignore). SIGKILL cannot be caught.
on_exit() {
    local rc=$?
    trap - EXIT ERR
    if [ "$SERVER_STOPPED" = "1" ] && [ "${SKIP_RESTART:-0}" != "1" ]; then
        SERVER_STOPPED=0
        if [ "$ARCHIVE_STATE" = "writing" ]; then rm -f "$ARCHIVE"; fi
        echo "$(date -Is) Backup interrupted (exit $rc) while the server was stopped - restarting it" >> "$FAIL_LOG"
        if start_server; then
            notify "⚠️ **Valheim backup was interrupted** (exit $rc). Server was restarted automatically." 15105570
        else
            notify "❌ **Valheim backup was interrupted and the server could NOT be restarted — start it manually.**" 15158332
        fi
    fi
    rm -f "$MAINTENANCE_FLAG"
}
trap on_exit EXIT
trap '' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Tell the crash/liveness monitors we're intentionally taking the server
# down — they should not treat this as a crash. Removed at the very end.
# ---------------------------------------------------------------------------
touch "$MAINTENANCE_FLAG"

# ---------------------------------------------------------------------------
# Pre-flight: make sure there's actually a world to back up. Newer Valheim saves
# the world as a DIRECTORY (worlds_local/<name>/...); older versions wrote a flat
# <name>.fwl/<name>.db pair. Either counts.
# ---------------------------------------------------------------------------
if { [ ! -d "$WORLD_DIR" ] || [ -z "$(find "$WORLD_DIR" -maxdepth 1 -type f -print -quit)" ]; } \
    && [ ! -f "$DATA_ROOT/worlds_local/${WORLD_NAME}.fwl" ]; then
    fail "no world named '${WORLD_NAME}' found under $DATA_ROOT/worlds_local (has the server been started once?)"
fi

# ---------------------------------------------------------------------------
# Capture BepInEx plugin manifest (useful for restore/version-matching)
# ---------------------------------------------------------------------------
if [ -d "$SERVER_DIR/BepInEx/plugins" ]; then
    find "$SERVER_DIR/BepInEx/plugins" -maxdepth 2 -type f \( -iname '*.dll' -o -iname 'manifest.json' \) \
        > "$MANIFEST" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Stop server, archive
#
# LGSM's own control script must run AS the game account (not root), so we hop
# over via `su`.
# ---------------------------------------------------------------------------
SERVER_STOPPED=1
run_clean su - "$LGSM_USER" -c "\"$LGSM_SCRIPT\" stop"

# ---------------------------------------------------------------------------
# Was the world actually saved? Valheim writes the world on shutdown, so the
# newest world file should be seconds old right now. If it is not, the world
# on disk is stale (the day-10 -> day-1 rollback pattern): still archive it,
# but do NOT report a green success.
# ---------------------------------------------------------------------------
SAVE_WARN=""
NEWEST_WORLD_TS=$(find "$DATA_ROOT/worlds_local" -type f -path "*${WORLD_NAME}*" \
        -not -path '*/backups/*' -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1 || true)
if [ -z "${NEWEST_WORLD_TS:-}" ]; then
    SAVE_WARN="could not read world file timestamps"
else
    SAVE_AGE=$(( $(date +%s) - NEWEST_WORLD_TS ))
    if [ "$SAVE_AGE" -gt "$SAVE_MAX_AGE" ]; then
        SAVE_WARN="newest world file is $((SAVE_AGE / 60)) min old after stop — the last shutdown save may not have been written"
        echo "$(date -Is) WARNING: $SAVE_WARN" >> "$FAIL_LOG"
    fi
fi

ARCHIVE_STATE=writing
TAR_EXTRA=()
if [ -d "$SERVER_DIR/BepInEx" ]; then TAR_EXTRA=(-C "$SERVER_DIR" BepInEx); fi
tar -czf "$ARCHIVE" \
    -C "$(dirname "$DATA_ROOT")" \
    --exclude="$(basename "$DATA_ROOT")/worlds_local/*/backups" \
    --exclude="$(basename "$DATA_ROOT")/backups" \
    "$(basename "$DATA_ROOT")" \
    "${TAR_EXTRA[@]}"

chown "$LGSM_USER:$LGSM_USER" "$ARCHIVE"
if [ -f "$MANIFEST" ]; then chown "$LGSM_USER:$LGSM_USER" "$MANIFEST"; fi

# ---------------------------------------------------------------------------
# Restart NOW, before the slow parts (integrity check, upload, retention), so
# downtime is just stop + tar and an upload problem can never keep it down.
# Skipped when a caller (update-valheim.sh) sets SKIP_RESTART=1.
# ---------------------------------------------------------------------------
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    if start_server; then
        SERVER_STOPPED=0
        rm -f "$MAINTENANCE_FLAG"
    else
        RESTART_FAILED=1
        notify "⚠️ **Backup archive created but the server failed to restart.** Check \`su - $LGSM_USER -c \"$LGSM_SCRIPT details\"\` on the VPS." 15105570
    fi
fi

# ---------------------------------------------------------------------------
# Integrity check — never trust a tar exit code alone
# ---------------------------------------------------------------------------
ARCHIVE_STATE=writing   # not trusted until it passes both checks below
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
    fail "archive failed integrity check (tar -tzf), deleted corrupt file"
fi

# ---------------------------------------------------------------------------
# Size floor — catch suspiciously small/empty archives before they replace good backups
# ---------------------------------------------------------------------------
ARCHIVE_BYTES=$(stat -c%s "$ARCHIVE")
if [ "$ARCHIVE_BYTES" -lt "$MIN_BYTES" ]; then
    fail "archive too small (${ARCHIVE_BYTES} bytes < ${MIN_BYTES} floor), refusing to upload"
fi

ARCHIVE_STATE=good

# ---------------------------------------------------------------------------
# Local retention — keep newest $LOCAL_KEEP archives, delete the rest
# (count-based: works regardless of how often backups run)
# ---------------------------------------------------------------------------
mapfile -t OLD_LOCAL_ARCHIVES < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "${WORLD_NAME}-*.tar.gz" -printf '%T@ %p\n' \
        | sort -rn \
        | awk -v keep="$LOCAL_KEEP" 'NR>keep {print $2}'
)
for old_archive in "${OLD_LOCAL_ARCHIVES[@]:-}"; do
    [ -z "$old_archive" ] && continue
    rm -f "$old_archive"
    old_manifest="${old_archive%.tar.gz}-plugins.txt"
    rm -f "$old_manifest"
    echo "$(date -Is) Pruned old local backup: $old_archive" >> "$FAIL_LOG"
done

# ---------------------------------------------------------------------------
# Upload + cloud retention (only when CLOUD_REMOTE is set in the notify file;
# otherwise this is a local-only backup and that is reported as such)
# ---------------------------------------------------------------------------
CLOUD_NOTE="local only (no CLOUD_REMOTE set)"
if [ -n "${CLOUD_REMOTE:-}" ]; then
    RCLONE="$(command -v rclone || true)"
    [ -n "$RCLONE" ] || fail "CLOUD_REMOTE is set but rclone is not installed"

    if ! "$RCLONE" copy \
        "$ARCHIVE" \
        "$CLOUD_REMOTE" \
        --transfers 1 \
        --checkers 4 \
        --log-file "$RCLONE_LOG" \
        --log-level INFO; then
        fail "rclone copy failed, see $RCLONE_LOG"
    fi

    if [ -f "$MANIFEST" ]; then
        "$RCLONE" copy "$MANIFEST" "$CLOUD_REMOTE" \
            --log-file "$RCLONE_LOG" --log-level INFO || true
    fi

    # Keep the newest $CLOUD_KEEP archives on the remote, via lsjson (robust vs lsl+sed)
    OLD_BACKUPS=$("$RCLONE" lsjson "$CLOUD_REMOTE" \
        | python3 -c "
import json, sys
items = json.load(sys.stdin)
files = [f for f in items if f['Name'].startswith('${WORLD_NAME}-') and f['Name'].endswith('.tar.gz')]
files.sort(key=lambda f: f['ModTime'], reverse=True)
for f in files[$CLOUD_KEEP:]:
    print(f['Name'])
")

    if [ -n "$OLD_BACKUPS" ]; then
        while IFS= read -r old_backup; do
            [ -z "$old_backup" ] && continue
            "$RCLONE" deletefile \
                "$CLOUD_REMOTE/$old_backup" \
                --log-file "$RCLONE_LOG" \
                --log-level INFO || true
        done <<< "$OLD_BACKUPS"
    fi
    CLOUD_NOTE="cloud retention: newest ${CLOUD_KEEP}"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
HUMAN_SIZE=$(numfmt --to=iec-i --suffix=B "$ARCHIVE_BYTES")
SUMMARY="$(basename "$ARCHIVE") (${HUMAN_SIZE}), local retention: newest ${LOCAL_KEEP}, ${CLOUD_NOTE}."
echo "Backup saved: $ARCHIVE ($HUMAN_SIZE)"
echo "Local retention: newest $LOCAL_KEEP backups"
echo "Cloud: ${CLOUD_NOTE}"

if [ "${SKIP_RESTART:-0}" = "1" ]; then
    echo "Server left stopped — SKIP_RESTART=1 set, caller is responsible for restarting."
    if [ -n "$SAVE_WARN" ]; then
        notify "⚠️ **Valheim backup finished, but check the world save**: $SAVE_WARN. $SUMMARY Server left stopped (caller will restart it)." 15105570
    else
        notify "✅ **Valheim backup succeeded**: $SUMMARY Server left stopped (caller will restart it)."
    fi
    rm -f "$MAINTENANCE_FLAG"
    exit 0
fi

if [ "$RESTART_FAILED" = "1" ]; then
    # Archive is safely uploaded, but the server is down — exit non-zero so cron/monitors notice.
    rm -f "$MAINTENANCE_FLAG"
    exit 1
fi

if [ -n "$SAVE_WARN" ]; then
    notify "⚠️ **Valheim backup finished, but check the world save**: $SAVE_WARN. $SUMMARY Server restarted automatically." 15105570
    echo "WARNING: $SAVE_WARN"
else
    notify "✅ **Valheim backup succeeded**: $SUMMARY Server restarted automatically."
fi
echo "Server restarted automatically."

rm -f "$MAINTENANCE_FLAG"
