#!/usr/bin/env bash
# Install COOP as a systemd service on the Pi: starts on boot, restarts on crash or on a
# USB brownout (camera/Arduino). Run from the repo root after scripts/setup_pi.sh:
#   sudo bash scripts/install_service.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash scripts/install_service.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
VENV_PYTHON="$REPO_DIR/.venv/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "No venv at $REPO_DIR/.venv; run scripts/setup_pi.sh first" >&2
  exit 1
fi

sed \
  -e "s|__WORKDIR__|$REPO_DIR|g" \
  -e "s|__USER__|$RUN_USER|g" \
  -e "s|__PYTHON__|$VENV_PYTHON|g" \
  "$REPO_DIR/scripts/coop.service" > /etc/systemd/system/coop.service

systemctl daemon-reload
systemctl enable --now coop.service

echo "COOP is running as a service (user: $RUN_USER, dir: $REPO_DIR)."
echo "Status:      systemctl status coop"
echo "Logs:        journalctl -u coop -f"
echo "Restart:     sudo systemctl restart coop"
echo "Uninstall:   sudo systemctl disable --now coop && sudo rm /etc/systemd/system/coop.service"
