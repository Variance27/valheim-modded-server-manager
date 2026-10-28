#!/bin/bash
# update-zomboid.sh
#
# Updates the Project Zomboid dedicated server (Steam app 380870) safely. The GUI fills in the
# placeholder values below and runs this as root over SSH, so nothing needs to be installed on the VPS.
#
#   1. Finds SteamCMD, and the branch the server is installed from (the manifest's BetaKey).
#   2. Asks Steam for the newest build on that branch. If it is the build already installed,
#      it stops here and the server is never touched. (The old update always stopped the server.)
#   3. Stops the service, takes a backup of the whole data folder, and refuses to go on if the
#      backup is not readable.
#   4. Refreshes Steam's app info in its own SteamCMD run, then runs app_update. (Doing both in one
#      run can make SteamCMD report "already up to date" while a newer build exists.)
#   5. Starts the service again, whatever happened: after a failed update the old build is still
#      there, so the server comes back on it.
#
# The last line it prints is "RESULT: <outcome>", which the GUI reads for its Discord message.
set -uo pipefail

SERVICE="__PZ_SERVICE__"
INSTALL_DIR="__PZ_INSTALL_DIR__"
DATA_DIR="__PZ_DATA_DIR__"
BACKUP_DIR="__PZ_BACKUP_DIR__"
FORCE="__PZ_FORCE__"
APP_ID=380870
MANIFEST="$INSTALL_DIR/steamapps/appmanifest_${APP_ID}.acf"

NEED_START=0
finish() {
    # Last line of defence: if the service was stopped by this script and nothing started it
    # again (a dropped SSH connection, a signal), start it now.
    if [ "$NEED_START" = "1" ]; then
        echo "Starting $SERVICE again..."
        systemctl start "$SERVICE" >/dev/null 2>&1 || true
    fi
}
trap finish EXIT

result() { echo "RESULT: $*"; }

if [ ! -d "$INSTALL_DIR" ]; then
    echo "The install folder $INSTALL_DIR does not exist. Nothing was stopped or changed."
    result aborted
    exit 1
fi

# --- who owns the install (SteamCMD should run as that user, not as root, unless root owns it) ---
OWNER="$(stat -c %U "$INSTALL_DIR" 2>/dev/null || echo root)"
OWNER_HOME="$(getent passwd "$OWNER" 2>/dev/null | cut -d: -f6)"
[ -n "$OWNER_HOME" ] || OWNER_HOME="$HOME"
# TMO=<seconds> as_owner ... runs the command with a time limit (used for the quick Steam lookups).
as_owner() {
    local t=()
    [ -n "${TMO:-}" ] && t=(timeout "$TMO")
    if [ "$(id -u)" = "0" ] && [ "$OWNER" != "root" ] && command -v runuser >/dev/null 2>&1; then
        ${t[@]+"${t[@]}"} runuser -u "$OWNER" -- env HOME="$OWNER_HOME" "$@"
    else
        ${t[@]+"${t[@]}"} "$@"
    fi
}

# --- SteamCMD: the copies kept in the owner's home first, then the distro wrapper ---
STEAMCMDS=()
for candidate in "$OWNER_HOME/.steam/steamcmd/steamcmd.sh" "$OWNER_HOME/.local/share/Steam/steamcmd/steamcmd.sh" \
    "$OWNER_HOME/steamcmd/steamcmd.sh" "$(command -v steamcmd 2>/dev/null)" /usr/games/steamcmd; do
    [ -n "$candidate" ] || continue
    case " ${STEAMCMDS[*]:-} " in *" $candidate "*) continue ;; esac
    [ -x "$candidate" ] && STEAMCMDS+=("$candidate")
done
if [ "${#STEAMCMDS[@]}" -eq 0 ]; then
    echo "SteamCMD was not found, so no update can run. Nothing was stopped or changed."
    echo "Fix: as root, run 'apt install steamcmd' (see the setup guide), then try again."
    result aborted
    exit 1
fi

# --- installed build and branch ---
INSTALLED=""
BETA=""
if [ -f "$MANIFEST" ]; then
    INSTALLED="$(grep -m1 '"buildid"' "$MANIFEST" | grep -oE '[0-9]+' | head -n1)"
    BETA="$(grep -m1 '"BetaKey"' "$MANIFEST" | sed -E 's/.*"BetaKey"[[:space:]]+"([^"]*)".*/\1/')"
fi
[ "$BETA" = "public" ] && BETA=""
BRANCH="${BETA:-public}"
echo "Installed build: ${INSTALLED:-unknown}, branch: $BRANCH"

# --- newest build on that branch, straight from Steam ---
LATEST=""
for attempt in 1 2 3; do
    for cmd in "${STEAMCMDS[@]}"; do
        OUT="$(TMO=180 as_owner "$cmd" +@NoPromptForPassword 1 +login anonymous +app_info_update 1 +app_info_print "$APP_ID" +quit 2>&1)"
        LATEST="$(printf '%s\n' "$OUT" | awk -v b="\"$BRANCH\"" '/"branches"/{f=1} f && $1==b{p=1} p && /"buildid"/{print $2; exit}' | tr -dc '0-9')"
        [ -n "$LATEST" ] && break 2
    done
    [ "$attempt" -lt 3 ] && sleep "${PZ_RETRY_WAIT:-5}"
done

if [ -z "$LATEST" ] && [ "$FORCE" != "1" ]; then
    echo "Could not ask Steam for the newest build (3 attempts). Nothing was stopped or changed."
    echo "Last lines SteamCMD printed:"
    printf '%s\n' "${OUT:-}" | grep -v '^\s*$' | tail -n 6 | sed 's/^/  | /'
    echo "If you know there is an update, use 'Update anyway', which skips this check."
    result aborted
    exit 1
fi

if [ -n "$LATEST" ]; then
    echo "Steam's newest build on $BRANCH: $LATEST"
    if [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$LATEST" ] && [ "$FORCE" != "1" ]; then
        echo "Up to date: build $INSTALLED is the newest. The server was not stopped."
        result uptodate "$INSTALLED"
        exit 0
    fi
    echo "Update available: $INSTALLED -> $LATEST."
else
    echo "Updating anyway (check skipped)."
fi

# --- stop, back up, gate ---
echo
echo "== Step 1/3: stopping $SERVICE and backing up =="
NEED_START=1
if ! systemctl stop "$SERVICE"; then
    echo "Could not stop $SERVICE. Nothing was changed."
    result aborted
    exit 1
fi
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/zomboid-preupdate-$(date +%Y%m%d-%H%M%S).tar.gz"
if tar -czf "$BACKUP_FILE" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" && tar -tzf "$BACKUP_FILE" >/dev/null 2>&1; then
    echo "Backup saved: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
else
    rm -f "$BACKUP_FILE"
    echo "The backup failed, so the update was not run. Starting $SERVICE again."
    if systemctl start "$SERVICE"; then NEED_START=0; result aborted; else result failed-down; fi
    exit 1
fi

# --- update: refresh Steam's info in its own run, then app_update ---
echo
echo "== Step 2/3: updating =="
BETA_ARGS=()
[ -n "$BETA" ] && BETA_ARGS=(-beta "$BETA")
UPDATED=0
for cmd in "${STEAMCMDS[@]}"; do
    echo "-- SteamCMD: $cmd"
    as_owner "$cmd" +@NoPromptForPassword 1 +login anonymous +app_info_update 1 +app_info_print "$APP_ID" +quit >/dev/null 2>&1
    OUT="$(as_owner "$cmd" +@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 +force_install_dir "$INSTALL_DIR" +login anonymous +app_update "$APP_ID" ${BETA_ARGS[@]+"${BETA_ARGS[@]}"} validate +quit 2>&1)"
    printf '%s\n' "$OUT" | grep -v '^\s*$' | tail -n 12
    if printf '%s\n' "$OUT" | grep -qE "Success! App '$APP_ID' (fully installed|already up to date)"; then
        UPDATED=1
        break
    fi
done

# --- start again, whatever happened ---
echo
echo "== Step 3/3: starting $SERVICE =="
STARTED=0
if systemctl start "$SERVICE"; then
    NEED_START=0
    STARTED=1
fi
NOW="$(grep -m1 '"buildid"' "$MANIFEST" 2>/dev/null | grep -oE '[0-9]+' | head -n1)"

if [ "$UPDATED" = "1" ] && [ "$STARTED" = "1" ]; then
    echo "Update complete (build ${NOW:-unknown}) and the server was started. Check your Workshop mods."
    result updated "${INSTALLED:-?}" "${NOW:-?}"
    exit 0
elif [ "$UPDATED" = "1" ]; then
    echo "The update finished but $SERVICE did not start. Check: systemctl status $SERVICE"
    result updated-not-started "${INSTALLED:-?}" "${NOW:-?}"
    exit 1
elif [ "$STARTED" = "1" ]; then
    echo "The update failed. $SERVICE was started again on the build it already had, and the backup is intact."
    result failed-restarted
    exit 1
else
    echo "The update failed and $SERVICE did not start. The backup is intact: $BACKUP_FILE"
    result failed-down
    exit 1
fi
