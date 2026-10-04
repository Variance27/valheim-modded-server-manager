#!/bin/bash
# Setup step 2 (runs as root, drops to the game account): LinuxGSM downloads and installs
# the Valheim dedicated server (Steam app 896660) and creates its config files.
# Safe to run again: LinuxGSM refuses to overwrite an existing install, so a repeat
# just validates the files.
set -u
LGSM_USER="__LGSM_USER__"
LGSM_SERVER="__LGSM_SERVER__"
HOME_DIR="__LGSM_HOME__"
SERVER_DIR="__SERVER_DIR__"

fail() { echo "[error] $1"; exit 1; }

[ -x "$HOME_DIR/$LGSM_SERVER" ] || fail "LinuxGSM is not installed yet — run the previous step first."
echo "[step] Installing the Valheim dedicated server with LinuxGSM (a download of about 1-2 GB; this can take several minutes)..."
if [ -f "$SERVER_DIR/valheim_server.x86_64" ]; then
  echo "[note] the server files are already there — validating them instead"
  runuser -l "$LGSM_USER" -c "cd \"$HOME_DIR\" && ./$LGSM_SERVER validate" 2>&1 | sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tr '\r' '\n'
  RC=${PIPESTATUS[0]}
else
  runuser -l "$LGSM_USER" -c "cd \"$HOME_DIR\" && ./$LGSM_SERVER auto-install" 2>&1 | sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' | tr '\r' '\n'
  RC=${PIPESTATUS[0]}
fi
[ -f "$SERVER_DIR/valheim_server.x86_64" ] || fail "LinuxGSM finished (exit $RC) but valheim_server.x86_64 is not in $SERVER_DIR — read the output above."
CFGDIR="$HOME_DIR/lgsm/config-lgsm/$LGSM_SERVER"
[ -f "$CFGDIR/common.cfg" ] || fail "the install finished but $CFGDIR/common.cfg is missing — LinuxGSM's config files were not created."
echo "[done] Valheim server files are in $SERVER_DIR. Next: set the server name, world name and password."
