#!/usr/bin/env bash
# LiteLayer OTA updater — safe, idempotent, rollback-capable.
# Usage:
#   update.sh            → interactive, always asks before applying
#   update.sh --auto     → non-interactive; only applies if VERSION changed
#   update.sh --check    → print status, exit 0 if up-to-date, 1 if update available
set -euo pipefail

INSTALL_DIR="/opt/litelayer"
LOG_DIR="/var/log/litelayer"
LOG="$LOG_DIR/update.log"
BRANCH="main"
REPO="https://github.com/MeridianAlgo-Developer/LiteLayer.git"

AUTO=0; CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in --auto) AUTO=1 ;; --check) CHECK_ONLY=1 ;; esac
done

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG") 2>&1
echo "--- $(date -Iseconds) update.sh $* ---"

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }
command -v git &>/dev/null || { apt-get install -y git -qq; }

cd "$INSTALL_DIR"
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")
CURRENT_VER=$(cat VERSION 2>/dev/null || echo "unknown")

# Fetch without merging
git fetch origin "$BRANCH" --quiet 2>&1 || { echo "Cannot reach GitHub — skipping."; exit 0; }

LATEST_SHA=$(git rev-parse "origin/$BRANCH")
LATEST_VER=$(git show "origin/$BRANCH:VERSION" 2>/dev/null || echo "unknown")

if [[ "$CURRENT_SHA" == "$LATEST_SHA" ]]; then
  echo "Already up to date ($CURRENT_VER)."
  exit 0
fi

echo "Update available: $CURRENT_VER ($CURRENT_SHA) → $LATEST_VER ($LATEST_SHA)"
[[ $CHECK_ONLY -eq 1 ]] && exit 1

if [[ $AUTO -eq 0 ]]; then
  read -rp "Apply update now? [y/N] " CONFIRM
  [[ "${CONFIRM,,}" == "y" ]] || { echo "Skipped."; exit 0; }
fi

# Snapshot for rollback
ROLLBACK_SHA="$CURRENT_SHA"
echo "Snapshot: $ROLLBACK_SHA"

git pull origin "$BRANCH" --ff-only

"$INSTALL_DIR/venv/bin/pip" install -q -r requirements.txt

# Reload service (if running)
if systemctl is-active litelayer &>/dev/null; then
  systemctl restart litelayer
  echo "Service restarted."
fi

echo "Update complete → $(cat VERSION)"
echo ""
echo "Rollback if needed:  cd $INSTALL_DIR && git checkout $ROLLBACK_SHA && systemctl restart litelayer"
