#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  LiteLayer — one-shot installer
#  Works on Raspberry Pi 3 → Pi 5 (ARM64 + ARMv7), Raspberry Pi OS Bullseye+
#
#  One-liner install (preserves stdin for interactive prompts):
#    bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
#
#  Pre-set choices via env vars for fully non-interactive use:
#    LITELAYER_VPN=tailscale LITELAYER_PASSWORD=mypass bash <(curl ...)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Auto-escalate to root ────────────────────────────────────────────────────
# When run via bash <(curl ...) we can't just tell the user to add sudo to a
# local file, so we re-download and exec under sudo automatically.
if [[ $EUID -ne 0 ]]; then
  echo "[→] Installer needs root — re-running with sudo (password may be required)..."
  _TMP=$(mktemp /tmp/litelayer-install.XXXXXXXX.sh)
  curl -fsSL "https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh" > "$_TMP"
  exec sudo -E bash "$_TMP" "$@"
fi

# ── Constants ────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/MeridianAlgo/LiteLayer.git"
BRANCH="main"
INSTALL_DIR="/opt/litelayer"
CONFIG_DIR="/etc/litelayer"
LOG_DIR="/var/log/litelayer"
MOUNT_ROOT="/srv/litelayer/mounts"
SERVICE_FILE="/etc/systemd/system/litelayer.service"
UPDATE_SVC="/etc/systemd/system/litelayer-update.service"
UPDATE_TMR="/etc/systemd/system/litelayer-update.timer"

# ── Colors ───────────────────────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; C='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${G}[✓]${NC} $*"; }
step()    { echo -e "${B}[→]${NC} $*"; }
warn()    { echo -e "${Y}[!]${NC} $*"; }
die()     { echo -e "${R}[✗]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${C}── $* ──${NC}"; }

# ── Pre-flight ───────────────────────────────────────────────────────────────
ARCH=$(uname -m)
header "LiteLayer Installer"
echo "  Architecture : $ARCH"
echo "  OS           : $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  Kernel       : $(uname -r)"
echo ""

# Warn on 32-bit — still works, but ntfs3 may fall back to ntfs-3g
[[ "$ARCH" == "armv7l" ]] && warn "32-bit OS detected. ntfs3 kernel driver may not be available; ntfs-3g fallback will be used."

# Python version check — need 3.9+; 3.11 on Bookworm
PYTHON_BIN=""
for bin in python3.11 python3.10 python3.9 python3; do
  if command -v "$bin" &>/dev/null; then
    VER=$("$bin" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    MAJ=${VER%%.*}; MIN=${VER##*.}
    if [[ $MAJ -ge 3 && $MIN -ge 9 ]]; then
      PYTHON_BIN="$bin"
      break
    fi
  fi
done

if [[ -z "$PYTHON_BIN" ]]; then
  warn "Python 3.9+ not found. Attempting to install python3.11…"
  apt-get update -qq
  apt-get install -y --no-install-recommends python3.11 python3.11-venv python3.11-dev 2>/dev/null \
    || die "Cannot install Python 3.11. Please upgrade to Raspberry Pi OS Bookworm:\n  https://www.raspberrypi.com/software/"
  PYTHON_BIN="python3.11"
fi
info "Using $PYTHON_BIN ($("$PYTHON_BIN" --version))"

# ── System packages ──────────────────────────────────────────────────────────
header "System packages"
step "Updating package lists…"
apt-get update -qq

PKGS=(
  git curl ca-certificates
  python3-venv
  caddy
  util-linux udev
  ntfs-3g           # fallback for kernels without ntfs3
  exfatprogs        # exfat (kernel 5.7+)
  dosfstools        # vfat/fat32
  e2fsprogs         # ext4
  btrfs-progs       # btrfs
  xfsprogs          # xfs
  hfsprogs          # hfsplus (read-only)
  rsync
)

# exfatprogs not available on Bullseye, use exfat-utils
apt-get install -y --no-install-recommends "${PKGS[@]}" 2>/dev/null \
  || apt-get install -y --no-install-recommends \
       "${PKGS[@]/exfatprogs/exfat-utils}" 2>/dev/null \
  || warn "Some filesystem packages failed — they'll fall back to kernel auto-detect"

info "System packages installed"

# ── Create directories early so VPN functions can write to CONFIG_DIR ────────
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$MOUNT_ROOT" "$LOG_DIR"
chmod 700 "$CONFIG_DIR"
chmod 755 "$MOUNT_ROOT" "$LOG_DIR"

# ── VPN mesh selection ───────────────────────────────────────────────────────
header "VPN / Mesh Network"

if [[ -z "${LITELAYER_VPN:-}" ]]; then
  echo "  LiteLayer binds on all interfaces. Any VPN that routes to this Pi works"
  echo "  automatically — but we can install and configure one for you now."
  echo ""
  echo "  1) None    — LAN only (add VPN later, docs/vpn.md)"
  echo "  2) Tailscale  — easiest; 100 devices free; managed by Tailscale"
  echo "  3) ZeroTier   — self-hostable; 25 devices free on managed"
  echo "  4) Netbird    — open-source WireGuard-based; self-hostable"
  echo "  5) WireGuard  — manual config; most control"
  echo ""
  read -rp "  Your choice [1-5, default 1]: " VPN_RAW
  case "${VPN_RAW:-1}" in
    2) LITELAYER_VPN="tailscale" ;;
    3) LITELAYER_VPN="zerotier"  ;;
    4) LITELAYER_VPN="netbird"   ;;
    5) LITELAYER_VPN="wireguard" ;;
    *) LITELAYER_VPN="none"      ;;
  esac
fi

_install_tailscale() {
  step "Installing Tailscale…"
  curl -fsSL https://tailscale.com/install.sh | sh
  info "Tailscale installed."
  echo ""
  echo "  Next: run  sudo tailscale up  and follow the auth URL."
  echo "  Then expose LiteLayer over Tailscale HTTPS:"
  echo "    sudo tailscale serve --bg https / http://localhost:8000"
  echo ""
  echo "LITELAYER_VPN_TYPE=tailscale" >> "$CONFIG_DIR/env"
}

_install_zerotier() {
  step "Installing ZeroTier…"
  curl -fsSL https://install.zerotier.com | bash
  info "ZeroTier installed."
  echo ""
  echo "  Next: run  sudo zerotier-cli join <network-id>"
  echo "  Find your network ID at https://my.zerotier.com"
  echo ""
  echo "LITELAYER_VPN_TYPE=zerotier" >> "$CONFIG_DIR/env"
}

_install_netbird() {
  step "Installing Netbird…"
  curl -fsSL https://pkgs.netbird.io/install.sh | bash
  info "Netbird installed."
  echo ""
  echo "  Next: run  sudo netbird up  and follow the setup URL."
  echo ""
  echo "LITELAYER_VPN_TYPE=netbird" >> "$CONFIG_DIR/env"
}

_install_wireguard() {
  step "Installing WireGuard…"
  apt-get install -y --no-install-recommends wireguard wireguard-tools
  info "WireGuard installed. Configure /etc/wireguard/wg0.conf manually."
  echo "  See docs/vpn.md for setup guidance."
  echo "LITELAYER_VPN_TYPE=wireguard" >> "$CONFIG_DIR/env"
}

case "$LITELAYER_VPN" in
  tailscale) _install_tailscale ;;
  zerotier)  _install_zerotier  ;;
  netbird)   _install_netbird   ;;
  wireguard) _install_wireguard ;;
  *)         info "Skipping VPN — LAN-only. Add later per docs/vpn.md"
             echo "LITELAYER_VPN_TYPE=none" >> "$CONFIG_DIR/env" 2>/dev/null || true ;;
esac

# ── Application files ────────────────────────────────────────────────────────
header "Application"

# Is this a git repo (direct clone) or a tarball/curl install?
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
REPO_ROOT=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../VERSION" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [[ -n "$REPO_ROOT" ]]; then
  # Came from a local clone — rsync in place
  step "Copying from local clone ($REPO_ROOT)…"
  rsync -a --delete \
    --exclude '__pycache__' --exclude '*.pyc' --exclude '.git' \
    --exclude 'tests' \
    "$REPO_ROOT/" "$INSTALL_DIR/"
else
  # Curl-piped install — clone from GitHub
  step "Cloning from GitHub…"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull origin "$BRANCH" --ff-only
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
fi

chmod +x "$INSTALL_DIR/installer/update.sh"

# ── Python virtualenv ────────────────────────────────────────────────────────
header "Python environment"
if [[ ! -d "$INSTALL_DIR/venv" ]]; then
  step "Creating virtualenv…"
  "$PYTHON_BIN" -m venv "$INSTALL_DIR/venv"
fi

step "Installing Python dependencies…"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"
info "Python environment ready"

# ── Admin credentials ────────────────────────────────────────────────────────
header "Admin account"
CREDS="$CONFIG_DIR/credentials.json"

if [[ ! -f "$CREDS" ]]; then
  if [[ -n "${LITELAYER_PASSWORD:-}" ]]; then
    PASS="$LITELAYER_PASSWORD"
  else
    echo "  Set the admin password (min 8 characters)."
    while true; do
      read -rsp "  Password: " PASS1; echo
      read -rsp "  Confirm:  " PASS2; echo
      [[ "$PASS1" == "$PASS2" ]] || { warn "Passwords don't match."; continue; }
      [[ ${#PASS1} -ge 8 ]]      || { warn "Must be at least 8 characters."; continue; }
      break
    done
    PASS="$PASS1"
  fi

  "$INSTALL_DIR/venv/bin/python" - "$PASS" <<'PYEOF'
import sys
sys.path.insert(0, '/opt/litelayer')
from auth.store import set_password
set_password('admin', sys.argv[1])
PYEOF

  chmod 600 "$CREDS"
  info "Credentials saved"
else
  info "Credentials already exist — skipping"
fi

# ── Env file ─────────────────────────────────────────────────────────────────
ENV_FILE="$CONFIG_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
cat > "$ENV_FILE" <<EOF
LITELAYER_MOUNT_ROOT=$MOUNT_ROOT
LITELAYER_CREDENTIALS=$CREDS
LITELAYER_SESSION_TTL=24
# Comma-separated CORS origins for the separate UI repo's dev server:
LITELAYER_CORS_ORIGINS=http://localhost:3000,http://localhost:5173
EOF
fi
# Append VPN type if not already there
grep -q LITELAYER_VPN_TYPE "$ENV_FILE" 2>/dev/null || echo "LITELAYER_VPN_TYPE=${LITELAYER_VPN:-none}" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── systemd: main service ────────────────────────────────────────────────────
header "systemd services"
cp "$INSTALL_DIR/installer/litelayer.service"        "$SERVICE_FILE"
cp "$INSTALL_DIR/installer/litelayer-update.service" "$UPDATE_SVC"
cp "$INSTALL_DIR/installer/litelayer-update.timer"   "$UPDATE_TMR"
systemctl daemon-reload
systemctl enable --now litelayer
systemctl enable --now litelayer-update.timer
info "litelayer.service started"
info "litelayer-update.timer enabled (daily at 03:00)"

# ── Caddy ────────────────────────────────────────────────────────────────────
header "Caddy (HTTPS)"
cp "$INSTALL_DIR/Caddyfile" /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy
info "Caddy running"

# ── Summary ──────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I | awk '{print $1}')
HOSTNAME=$(hostname)
VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "dev")

echo ""
echo -e "${C}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${C}║         LiteLayer $VERSION — Ready!                     ║${NC}"
echo -e "${C}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${G}Local UI${NC}     https://${LOCAL_IP}"
echo -e "  ${G}API docs${NC}     https://${LOCAL_IP}/docs"
echo -e "  ${G}Username${NC}     admin"
echo ""

case "${LITELAYER_VPN:-none}" in
  tailscale)
    echo -e "  ${Y}Tailscale${NC}    run: sudo tailscale up"
    echo "             then: sudo tailscale serve --bg https / http://localhost:8000"
    ;;
  zerotier)
    echo -e "  ${Y}ZeroTier${NC}     run: sudo zerotier-cli join <network-id>"
    ;;
  netbird)
    echo -e "  ${Y}Netbird${NC}      run: sudo netbird up"
    ;;
  wireguard)
    echo -e "  ${Y}WireGuard${NC}    configure: /etc/wireguard/wg0.conf"
    echo "             then: sudo wg-quick up wg0"
    ;;
esac

echo ""
echo -e "  ${G}Logs${NC}         journalctl -u litelayer -f"
echo -e "  ${G}Update now${NC}   sudo $INSTALL_DIR/installer/update.sh"
echo -e "  ${G}OTA status${NC}   GET https://${LOCAL_IP}/api/ota/status"
echo ""
echo -e "  Plug in a USB drive and open the UI to browse it."
echo ""
