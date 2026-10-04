#!/bin/bash
# check-valheim-update.sh
#
# Checks whether Steam has a newer Valheim dedicated server build (app
# 896660, public branch) than what's currently installed. Does NOT touch
# any server files or stop the server — read-only query via steamcmd's
# app_info_print, safe to run anytime, including while the server is live.
#
# Always prints its result to stdout (up to date / update available / an
# error), regardless of Discord config — this is what the GUI's Updates tab
# streams straight through to its console, so silent success here just
# looked like nothing happened when run from there. Discord is a SEPARATE,
# once-per-new-version alert on top of that (via the state file below) —
# it does not gate what gets printed here.
#
# Opt-in auto-apply: set AUTO_APPLY_UPDATE=true in valheim-notify.conf (the
# same file DISCORD_WEBHOOK_URL lives in) to have this script run
# update-valheim.sh itself the moment it finds a new build, instead of just
# notifying — useful because Steam auto-updates players' game CLIENTS
# regardless of what the server is running, so a manually-gated server can
# end up stuck on an old build unable to accept newer clients. Off by
# default (unset/false), matching this script's original manual-apply-only
# design — turning it on trades "verify mod compatibility before updating"
# for "stay in lockstep with Steam automatically." update-valheim.sh's own
# mandatory pre-update backup still runs either way, so the world itself is
# never at risk from this — only mod compatibility is the traded-off part.
#
# Installed by the GUI's Setup tab, which fills in the path values just below.
set -uo pipefail

LGSM_USER="__LGSM_USER__"
LGSM_HOME="__LGSM_HOME__"
MANIFEST="__SERVER_DIR__/steamapps/appmanifest_896660.acf"
STATE_FILE="$LGSM_HOME/.config/last-known-buildid"
CONF_FILE="$LGSM_HOME/.config/valheim-notify.conf"

# steamcmd: the distro package (/usr/games/steamcmd) or the copy LinuxGSM downloads
# from Valve into the game account's home — whichever exists.
STEAMCMD=""
for candidate in "$(command -v steamcmd 2>/dev/null)" /usr/games/steamcmd \
    "$LGSM_HOME/.local/share/Steam/steamcmd/steamcmd.sh" "$LGSM_HOME/.steam/steamcmd/steamcmd.sh" \
    "$LGSM_HOME/steamcmd/steamcmd.sh"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then STEAMCMD="$candidate"; break; fi
done
# Sibling script, not a second hardcoded absolute path — resolved from
# wherever THIS script actually lives, so it can't drift out of sync with
# check-valheim-update.sh's own real deployed location the way the two
# separately-hardcoded paths already have once (see update-valheim.sh's own
# BACKUP_SCRIPT fix, and this project's applyUpdateScript config mismatch).
APPLY_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/update-valheim.sh"

# shellcheck source=/dev/null
[ -f "$CONF_FILE" ] && source "$CONF_FILE"

AUTO_APPLY=false
case "${AUTO_APPLY_UPDATE:-}" in
    1 | true | TRUE | True | yes | YES) AUTO_APPLY=true ;;
esac

notify() {
    local message="$1"
    local color="${2:-3447003}"
    [ -z "${DISCORD_WEBHOOK_URL:-}" ] && return 0
    curl -sf -H "Content-Type: application/json" \
        -d "{\"embeds\":[{\"description\":\"${message}\",\"color\":${color}}]}" \
        "$DISCORD_WEBHOOK_URL" >/dev/null || true
}

# Prints to stdout (what the GUI sees) AND appends to the failure log (what
# unattended cron runs leave behind) — previously this only went to the log
# file, so an error here was invisible when run from the GUI too.
log_error() {
    local message="$1"
    echo "[error] $message"
    echo "$(date -Is) ERROR: $message" >> "$LGSM_HOME/backup-failures.log"
}

# ---------------------------------------------------------------------------
# Currently installed buildid, from the local Steam app manifest
# ---------------------------------------------------------------------------
if [ ! -f "$MANIFEST" ]; then
    log_error "manifest not found at $MANIFEST"
    exit 1
fi
if [ -z "$STEAMCMD" ]; then
    log_error "steamcmd was not found (looked for the steamcmd command and the copy LinuxGSM downloads)"
    exit 1
fi
INSTALLED_BUILDID="$(grep -m1 '"buildid"' "$MANIFEST" | grep -oE '[0-9]+')"

# ---------------------------------------------------------------------------
# Latest public buildid, from Steam directly (read-only info query)
# ---------------------------------------------------------------------------
LATEST_BUILDID="$(sudo -u "$LGSM_USER" "$STEAMCMD" \
    +@sSteamCmdForcePlatformType linux \
    +login anonymous \
    +app_info_update 1 \
    +app_info_print 896660 \
    +quit 2>/dev/null \
    | awk '/"branches"/{f=1} f && /"public"/{p=1} p && /"buildid"/{print; exit}' \
    | grep -oE '[0-9]+')"

if [ -z "$LATEST_BUILDID" ]; then
    log_error "could not determine latest buildid from Steam"
    exit 1
fi

# ---------------------------------------------------------------------------
# Report current status (always, every run — this is what the GUI shows).
# When an update exists: either auto-apply it (if enabled) or fall back to
# the once-per-new-version Discord notify (the state file only gates THAT
# notify, never the stdout report itself).
# ---------------------------------------------------------------------------
if [ "$LATEST_BUILDID" != "$INSTALLED_BUILDID" ]; then
    echo "Update available: installed build ${INSTALLED_BUILDID}, Steam has ${LATEST_BUILDID}."

    APPLIED=false
    if $AUTO_APPLY; then
        if [ -f "$APPLY_SCRIPT" ]; then
            echo "AUTO_APPLY_UPDATE is on — applying now via $APPLY_SCRIPT."
            echo "(Mod compatibility is NOT verified automatically — check it after this restarts.)"
            bash "$APPLY_SCRIPT"
            APPLY_EC=$?
            if [ "$APPLY_EC" -ne 0 ]; then
                echo "[error] update-valheim.sh exited with code $APPLY_EC — see its own output/Discord messages above for what went wrong."
            fi
            # update-valheim.sh already sends its own Discord notification
            # for the actual outcome (success, backup failure, LGSM update
            # failure, restart failure) — no separate notify() call here,
            # that would just double up the same news in two messages.
            APPLIED=true
            echo "$LATEST_BUILDID" > "$STATE_FILE"
        else
            log_error "AUTO_APPLY_UPDATE is on but $APPLY_SCRIPT wasn't found — falling back to manual notification instead of applying."
        fi
    fi

    if ! $APPLIED; then
        echo "Check mod compatibility (Thunderstore/BepInEx) before updating."
        echo "Run update-valheim.sh (or the GUI's Apply Update button) when ready."

        LAST_ALERTED=""
        [ -f "$STATE_FILE" ] && LAST_ALERTED="$(cat "$STATE_FILE")"
        if [ "$LATEST_BUILDID" != "$LAST_ALERTED" ]; then
            notify "🆕 **Valheim server update available**: installed build \`${INSTALLED_BUILDID}\`, Steam has \`${LATEST_BUILDID}\`.
Check mod compatibility (Thunderstore/BepInEx) before updating.
Run \`bash $APPLY_SCRIPT\` when ready." 3447003
            echo "$LATEST_BUILDID" > "$STATE_FILE"
        else
            echo "(Discord was already notified about this build — not re-notifying.)"
        fi
    fi
else
    echo "Up to date: installed build ${INSTALLED_BUILDID} matches Steam's current public build."
fi
