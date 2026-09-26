#!/usr/bin/env bash
# Install COOPER as a systemd service on the Pi: starts on boot, restarts on crash or on a
# USB brownout (camera). Run from the repo root after scripts/setup_pi.sh:
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

# Before the rename the unit was coop.service; two copies would fight over the camera and port 8000.
if [ -f /etc/systemd/system/coop.service ]; then
  echo "Removing the old coop.service (replaced by cooper.service)."
  systemctl disable --now coop.service || true
  rm -f /etc/systemd/system/coop.service
fi

sed \
  -e "s|__WORKDIR__|$REPO_DIR|g" \
  -e "s|__USER__|$RUN_USER|g" \
  -e "s|__PYTHON__|$VENV_PYTHON|g" \
  "$REPO_DIR/scripts/cooper.service" > /etc/systemd/system/cooper.service

systemctl daemon-reload
systemctl enable --now cooper.service

echo "COOPER is running as a service (user: $RUN_USER, dir: $REPO_DIR)."
echo "Status:      systemctl status cooper"
echo "Logs:        journalctl -u cooper -f"
echo "Restart:     sudo systemctl restart cooper"
echo "Uninstall:   sudo systemctl disable --now cooper && sudo rm /etc/systemd/system/cooper.service"
