#!/usr/bin/env bash
# Expose the COOPER dashboard at https://<hostname> through a Cloudflare Tunnel, run by
# systemd as cooper-tunnel.service. Full guide: scripts/setup_tunnel.md.
# Run from the repo root as your normal user (not sudo); re-running is safe:
#   bash scripts/install_tunnel.sh cooper-live.example.com
set -euo pipefail

HOST="${1:-}"
# The Cloudflare tunnel (and its /etc/cloudflared/coop.yml) keep the pre-rename name "coop" on
# purpose: renaming would create a second tunnel on a Pi that is already set up, and the old one
# would keep its DNS route. Only the systemd unit took the COOPER name.
TUNNEL_NAME="${TUNNEL_NAME:-coop}"
ORIGIN="http://127.0.0.1:8000"  # not "localhost": Flask binds IPv4 only
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_DIR="$HOME/.cloudflared"
ETC_DIR=/etc/cloudflared
CONFIG="$ETC_DIR/coop.yml"

if [ -z "$HOST" ]; then
  echo "Usage: bash scripts/install_tunnel.sh cooper-live.example.com" >&2
  exit 1
fi
if [[ "$HOST" == coop.* ]]; then
  # --overwrite-dns below would silently repoint the showcase's record at the tunnel.
  echo "coop.<domain> is the public showcase (site/); the dashboard goes on cooper-live.<domain>." >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as your normal user; the script calls sudo itself." >&2
  exit 1
fi

echo "== 1/6 cloudflared"
if ! command -v cloudflared >/dev/null; then
  arch="$(dpkg --print-architecture)"  # arm64 on 64-bit Raspberry Pi OS
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/cloudflared.deb" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  sudo dpkg -i "$tmp/cloudflared.deb"
  rm -rf "$tmp"
fi
cloudflared --version

echo "== 2/6 Cloudflare login"
if [ ! -f "$USER_DIR/cert.pem" ]; then
  echo "Open the URL below on any device, sign in, and pick your domain's zone."
  cloudflared tunnel login
fi

echo "== 3/6 tunnel '$TUNNEL_NAME'"
tunnel_id() {
  cloudflared tunnel list --name "$TUNNEL_NAME" --output json 2>/dev/null |
    python3 -c 'import json, sys; t = json.loads(sys.stdin.read() or "null"); print(t[0]["id"] if t else "")'
}
ID="$(tunnel_id)"
if [ -z "$ID" ]; then
  cloudflared tunnel create "$TUNNEL_NAME"
  ID="$(tunnel_id)"
fi
CREDS="$USER_DIR/$ID.json"
if [ ! -f "$CREDS" ] && ! sudo test -f "$ETC_DIR/$ID.json"; then
  echo "Tunnel '$TUNNEL_NAME' ($ID) exists but its credentials file is missing." >&2
  echo "Copy $ID.json from the machine that created it into $USER_DIR, or delete the" >&2
  echo "tunnel (cloudflared tunnel delete $TUNNEL_NAME) and re-run this script." >&2
  exit 1
fi
echo "Tunnel ID: $ID"

echo "== 4/6 config in $ETC_DIR"
sudo install -d -m 755 "$ETC_DIR"
if [ -f "$CREDS" ]; then
  sudo install -m 600 "$CREDS" "$ETC_DIR/$ID.json"
fi
sudo tee "$CONFIG" >/dev/null <<EOF
tunnel: $ID
credentials-file: $ETC_DIR/$ID.json
ingress:
  - hostname: $HOST
    service: $ORIGIN
  - service: http_status:404
EOF
sudo cloudflared tunnel --config "$CONFIG" ingress validate

echo "== 5/6 DNS record for $HOST"
echo "Creating the DNS record makes $HOST reachable from the internet."
read -r -p "Is the Cloudflare Access application for $HOST already set up (guide step 2)? [y/N] " answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
  echo "Set up Access first (scripts/setup_tunnel.md, step 2), then re-run this script." >&2
  exit 1
fi
cloudflared tunnel route dns --overwrite-dns "$ID" "$HOST"

echo "== 6/6 cooper-tunnel.service"
if [ -f /etc/systemd/system/coop-tunnel.service ]; then
  echo "Removing the old coop-tunnel.service (replaced by cooper-tunnel.service, same tunnel)."
  sudo systemctl disable --now coop-tunnel.service || true
  sudo rm -f /etc/systemd/system/coop-tunnel.service
fi
sed -e "s|__CLOUDFLARED__|$(command -v cloudflared)|g" \
    -e "s|__CONFIG__|$CONFIG|g" \
    "$REPO_DIR/scripts/cooper-tunnel.service" | sudo tee /etc/systemd/system/cooper-tunnel.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable cooper-tunnel.service
sudo systemctl restart cooper-tunnel.service  # restart, not start, so re-runs pick up config changes

echo "Checking that $HOST is behind Access..."
sleep 5
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$HOST/api/status" || true)"
case "$code" in
  200) echo "WARNING: $HOST answered 200 without a login. Cloudflare Access is NOT in front of it." >&2
       echo "Fix the Access application now (guide step 2), or stop the tunnel: sudo systemctl stop cooper-tunnel" >&2
       exit 1 ;;
  301|302|303|401|403) echo "OK: unauthenticated requests get HTTP $code (Access login)." ;;
  *) echo "Got HTTP '$code'. DNS may still be propagating; check again in a minute:"
     echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://$HOST/api/status" ;;
esac

echo
echo "Dashboard: https://$HOST  (sign in with an approved email)"
echo "Status:    systemctl status cooper-tunnel"
echo "Logs:      journalctl -u cooper-tunnel -f"
