#!/usr/bin/env bash
# One-time setup on the Raspberry Pi 5 (Raspberry Pi OS Bookworm, 64-bit).
# Run from the repo root:  bash scripts/setup_pi.sh
set -euo pipefail

sudo apt update
# gpiozero drives the warning LEDs; on the Pi 5 it needs the lgpio backend (RP1 GPIO).
sudo apt install -y python3-picamera2 python3-gpiozero python3-lgpio python3-venv

# --system-site-packages lets the venv see picamera2 and gpiozero installed by apt.
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

python -c "import picamera2, gpiozero, ultralytics; print('imports OK')"
echo "Test the camera with:   rpicam-hello -t 5000"
echo "Run COOPER with:        source .venv/bin/activate && python -m cooper.main"
echo "Run it as a service:    sudo bash scripts/install_service.sh"
