#!/bin/bash
# Setup step 1 (runs as root on the VPS): game account + LinuxGSM + its dependencies.
# Safe to run again: every part checks what is already there first.
# The GUI fills in the account, instance and home values just below before this runs.
set -u
LGSM_USER="__LGSM_USER__"
LGSM_SERVER="__LGSM_SERVER__"
HOME_DIR="__LGSM_HOME__"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

fail() { echo "[error] $1"; exit 1; }
# apt without the per-package progress lines (errors and warnings still show); keeps apt's exit status
apt_run() { apt-get -o Dpkg::Use-Pty=0 "$@" 2>&1 | grep -vE '^\(Reading database|^(Selecting previously unselected package|Preparing to unpack|Unpacking|Setting up|Processing triggers for) '; return "${PIPESTATUS[0]}"; }

echo "[step] Checking the operating system..."
[ -r /etc/os-release ] || fail "cannot read /etc/os-release"
# shellcheck source=/dev/null
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "* | *" ubuntu "*) ;;
  *) fail "This setup supports Ubuntu and Debian only (found ${PRETTY_NAME:-unknown}). Install LinuxGSM by hand, then use the later steps." ;;
esac
command -v apt-get >/dev/null 2>&1 || fail "apt-get not found"
echo "[note] ${PRETTY_NAME:-$ID}"
[ "$(id -u)" = 0 ] || fail "this step must run as root"

echo "[step] Repairing any half-finished package installs..."
dpkg --configure -a >/dev/null 2>&1 || true
apt_run install -f -y -qq >/dev/null 2>&1 || true

echo "[step] Enabling 32-bit packages and refreshing package lists..."
dpkg --add-architecture i386 || fail "could not enable the i386 architecture"
apt_run update -y -qq || echo "[note] apt-get update reported problems (often a broken extra repository) — continuing"
if [ "${ID:-}" = ubuntu ]; then
  apt_run install -y -qq software-properties-common >/dev/null 2>&1 || true
  add-apt-repository -y multiverse >/dev/null 2>&1 || true
  apt_run update -y -qq || true
fi

echo "[step] Installing base tools (curl, sudo, unzip, tmux, cron, python3, iproute2)..."
apt_run install -y -qq curl wget ca-certificates sudo tar bzip2 gzip unzip xz-utils file jq tmux cron python3 util-linux iproute2 \
  || fail "base package install failed — see the output above"
# Scheduled backups/update checks use cron; start it now (ignored where there is no systemd).
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true
else
  service cron start >/dev/null 2>&1 || true
fi

echo "[step] Game account '$LGSM_USER'..."
if id -u "$LGSM_USER" >/dev/null 2>&1; then
  echo "[note] account already exists"
else
  useradd -m -d "$HOME_DIR" -s /bin/bash "$LGSM_USER" || fail "could not create the account $LGSM_USER"
  echo "[note] created account $LGSM_USER (no password, not reachable by SSH login)"
fi
ACTUAL_HOME="$(getent passwd "$LGSM_USER" | cut -d: -f6)"
if [ "$ACTUAL_HOME" != "$HOME_DIR" ]; then
  fail "the account $LGSM_USER has its home in $ACTUAL_HOME but the GUI expects $HOME_DIR — set lgsmHome in config.json to $ACTUAL_HOME"
fi
mkdir -p "$HOME_DIR" && chown "$LGSM_USER:$LGSM_USER" "$HOME_DIR"

echo "[step] Downloading LinuxGSM for '$LGSM_SERVER'..."
if [ -x "$HOME_DIR/$LGSM_SERVER" ]; then
  echo "[note] LinuxGSM script already present"
else
  # linuxgsm.sh is a redirect to the file in LinuxGSM's GitHub repository; try the short
  # address first and the repository directly if it is unreachable.
  runuser -l "$LGSM_USER" -c "cd \"$HOME_DIR\" && { curl -fsSL -o linuxgsm.sh https://linuxgsm.sh || curl -fsSL -o linuxgsm.sh https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/linuxgsm.sh; } && chmod +x linuxgsm.sh && ./linuxgsm.sh $LGSM_SERVER" \
    || fail "could not download LinuxGSM (https://linuxgsm.sh or its GitHub repository) — check the VPS can reach them"
  [ -x "$HOME_DIR/$LGSM_SERVER" ] || fail "LinuxGSM finished but $HOME_DIR/$LGSM_SERVER was not created — is lgsmServer set to a valid LinuxGSM server name (vhserver)?"
fi

echo "[step] Installing LinuxGSM's dependencies for this server..."
SHORTNAME="$(sed -n 's/^shortname="\(.*\)"/\1/p' "$HOME_DIR/$LGSM_SERVER" | head -n1)"
[ -n "$SHORTNAME" ] || SHORTNAME=vh
# LinuxGSM downloads the dependency table for the distro on first run.
CSV="$HOME_DIR/lgsm/data/${ID}-${VERSION_ID}.csv"
if [ ! -f "$CSV" ]; then
  runuser -l "$LGSM_USER" -c "cd \"$HOME_DIR\" && ./$LGSM_SERVER details" >/dev/null 2>&1 || true
fi
if [ ! -f "$CSV" ]; then
  for alt in $ID_LIKE; do
    [ -f "$HOME_DIR/lgsm/data/${alt}-${VERSION_ID}.csv" ] && CSV="$HOME_DIR/lgsm/data/${alt}-${VERSION_ID}.csv" && break
  done
fi
[ -f "$CSV" ] || fail "LinuxGSM has no dependency list for ${PRETTY_NAME:-this OS} ($CSV). Install the dependencies it names on https://linuxgsm.sh/servers/vhserver/ by hand, then continue with the next step."
PKGS="$(awk -F, -v s="$SHORTNAME" '$1=="all" || $1=="steamcmd" || $1==s { for (i = 2; i <= NF; i++) if ($i != "") print $i }' "$CSV" | sort -u | tr '\n' ' ')"
echo "[note] packages: $PKGS"
# The distro's steamcmd package asks you to accept Steam's license; answer it the way LinuxGSM's docs do.
echo steamcmd steam/question select "I AGREE" | debconf-set-selections 2>/dev/null || true
echo steamcmd steam/license note '' | debconf-set-selections 2>/dev/null || true
# shellcheck disable=SC2086
if ! apt_run install -y -qq $PKGS; then
  echo "[note] some package could not be installed — retrying without the steamcmd package (LinuxGSM downloads steamcmd from Valve itself)"
  dpkg --configure -a >/dev/null 2>&1 || true
  apt_run install -f -y -qq >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  apt_run install -y -qq $(echo "$PKGS" | tr ' ' '\n' | grep -vx steamcmd | tr '\n' ' ') \
    || fail "dependency install failed — see the output above"
fi

echo "[done] LinuxGSM is ready for $LGSM_USER. Next: install the Valheim server."
