# Exposing the dashboard with Cloudflare Tunnel

This guide makes the Pi's dashboard reachable at `https://coop.example.com` from anywhere, without opening a port on the venue's router. Cloudflare Access sits in front of it so only approved email addresses can see the camera or send it commands.

**Placeholder:** replace `example.com` with your domain everywhere below.

```
browser ──HTTPS──► Cloudflare edge ──(Access: email login)──► tunnel ──► cloudflared on the Pi ──HTTP──► 127.0.0.1:8000 (coop.service)
```

`cloudflared` makes **outbound** connections to Cloudflare (QUIC on UDP 7844, falling back to HTTP/2 over TCP 7844). Nothing listens on the internet side of the Pi, so it works behind NAT, CGNAT and hotel/venue Wi-Fi.

| Piece | Where it lives |
|---|---|
| Tunnel config | `/etc/cloudflared/coop.yml` (written by the script) |
| Tunnel credentials | `/etc/cloudflared/<tunnel-id>.json` (root-only, `chmod 600`) |
| systemd unit | `/etc/systemd/system/coop-tunnel.service`, from `scripts/coop-tunnel.service` |
| Zone login cert | `~/.cloudflared/cert.pem` (only needed to create/route tunnels, not to run one) |

Order matters: **move DNS → create the Access app → then create the tunnel and DNS record.** That way the hostname is never live without a login in front of it.

---

## 1. Move the domain's DNS to Cloudflare

Tunnels need the zone on Cloudflare's nameservers (a "full" setup; the CNAME-only "partial" setup is Business plan only). Registration can stay wherever it is.

1. In the Cloudflare dashboard, **Add a domain** → enter `example.com` → choose the **Free** plan.
2. Cloudflare scans the existing DNS records. **Check the import before continuing**, especially `MX` and `TXT` (SPF/DKIM) records if the domain has email, and any `A`/`CNAME` for an existing website. Anything missing here stops working when the nameservers change.
3. If **DNSSEC** is on at your registrar, turn it off first. Otherwise the old DS record won't match Cloudflare's signatures and the domain stops resolving. You can re-enable it through Cloudflare (DNS → Settings) once the zone is active.
4. At the registrar, replace the nameservers with the two Cloudflare assigned (`<name>.ns.cloudflare.com`).
5. Wait for the zone to show **Active** (usually minutes, sometimes a few hours). Check from the laptop:
   ```powershell
   nslookup -type=NS example.com 1.1.1.1
   ```

Don't create a DNS record for `coop` by hand; step 4 does it.

Stick to a single-level subdomain like `coop.example.com`: Cloudflare's free Universal SSL certificate covers `example.com` and `*.example.com`, but not `cam.coop.example.com`.

## 2. Put Cloudflare Access in front (before the hostname goes live)

1. Open the **Zero Trust** dashboard (from the Cloudflare dashboard sidebar). The first time, pick a team name (it becomes `<team>.cloudflareaccess.com`) and the **Free** plan (up to 50 users). If it asks for billing details, the Free plan is still $0.
2. Login method: **One-time PIN** is enabled by default. Approved users type their email and get a code. Optionally add Google or GitHub under Settings → Authentication.
3. **Access → Applications → Add an application → Self-hosted** (newer dashboards call the menu "Access controls → Applications"):
   - Name: `COOP`
   - Public hostname: subdomain `coop`, domain `example.com`, **path empty** so it covers `/`, `/video` and `/api/*`
   - Session duration: `24 hours`
4. Add a policy: **Action: Allow**, **Include → Emails** → the team's addresses (add judges' emails on demo day, or use "Emails ending in" for a whole domain).
5. In the application's cookie settings, set **SameSite = Lax** and keep **HttpOnly** on. The control endpoints (`POST /api/mode`, `/api/home`, ...) are authorized purely by the Access cookie, so `Lax` stops another website from firing cross-site POSTs at the camera with a logged-in user's cookie.
6. Save.

## 3. Install cloudflared, create the tunnel, run it as a service

On the Pi, from the repo root, as your normal user (the script calls `sudo` where needed, and the login cert must land in your home directory):

```bash
bash scripts/install_tunnel.sh coop.example.com
```

The script is idempotent; re-run it to change the hostname or rebuild the service. It:

1. Installs `cloudflared` from the official GitHub release `.deb` for the Pi's architecture (`arm64` on 64-bit Raspberry Pi OS), if it isn't already installed.
2. Runs `cloudflared tunnel login` once. It prints a URL; open it on the laptop, sign in, and pick the `example.com` zone. This writes `~/.cloudflared/cert.pem`.
3. Creates a named tunnel `coop` (`cloudflared tunnel create coop`), or reuses it if it exists.
4. Copies the tunnel credentials to `/etc/cloudflared/` and writes `/etc/cloudflared/coop.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /etc/cloudflared/<tunnel-id>.json
   ingress:
     - hostname: coop.example.com
       service: http://127.0.0.1:8000
     - service: http_status:404
   ```
   The origin is `127.0.0.1`, not `localhost`: Flask binds IPv4 `0.0.0.0`, and `localhost` can resolve to `::1` first. The catch-all `http_status:404` rule is required by cloudflared.
5. Asks you to confirm the Access app from step 2 exists, then creates the proxied DNS record `coop.example.com CNAME <tunnel-id>.cfargotunnel.com` (`cloudflared tunnel route dns`).
6. Installs `coop-tunnel.service` next to `coop.service` and starts it.
7. Requests `https://coop.example.com/api/status` without a login and warns loudly if it gets a `200`, which would mean Access isn't in front.

`coop-tunnel.service` is deliberately independent of `coop.service`. If COOP restarts, the tunnel stays up and visitors briefly see a Cloudflare 502 instead of a DNS error; if the tunnel restarts, the camera keeps running and the LAN dashboard still works.

We use our own unit instead of `cloudflared service install` so it has a COOP-specific name, lives in the repo, and reads an explicit config path. It matches the upstream unit otherwise (`Type=notify`, `--no-autoupdate`, restart on failure).

### Manual equivalent

If you'd rather not run the script:

```bash
# install (arm64 .deb from the official release)
curl -fsSLo /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i /tmp/cloudflared.deb

cloudflared tunnel login
cloudflared tunnel create coop                 # prints the tunnel ID, writes ~/.cloudflared/<ID>.json
sudo install -d /etc/cloudflared
sudo install -m 600 ~/.cloudflared/<ID>.json /etc/cloudflared/
sudoedit /etc/cloudflared/coop.yml             # contents as above
sudo cloudflared tunnel --config /etc/cloudflared/coop.yml ingress validate
cloudflared tunnel route dns coop coop.example.com
sed -e "s|__CLOUDFLARED__|$(command -v cloudflared)|" -e "s|__CONFIG__|/etc/cloudflared/coop.yml|" \
  scripts/coop-tunnel.service | sudo tee /etc/systemd/system/coop-tunnel.service
sudo systemctl daemon-reload && sudo systemctl enable --now coop-tunnel
```

The `.deb` doesn't auto-update. To track releases through apt instead, add Cloudflare's package repository (see pkg.cloudflare.com) and `apt install cloudflared`; the rest is the same.

## 4. The MJPEG stream through the tunnel

`GET /video` is a single, never-ending `multipart/x-mixed-replace` response. It works through the tunnel as is, and here is why, plus what to check:

- **No buffering.** cloudflared and the Cloudflare edge forward the response body as it arrives. Response buffering is an Enterprise-only setting and is off by default, so each JPEG part reaches the browser as soon as the Pi writes it.
- **Timeouts.** Cloudflare's 100 s limit (error 524) is for the origin to *start* responding. `/video` sends its headers with the first frame, then keeps streaming, so long sessions are fine as long as frames keep coming.
- **Caching.** Cloudflare never caches the stream or `/api/*` JSON. It *does* cache `.js`/`.css` by extension, which makes dashboard edits look like they didn't deploy. Add a **Cache Rule**: hostname equals `coop.example.com` → **Bypass cache**. Alternatively, purge the cache after changing `web/`.
- **Auth.** The dashboard loads `/video` with a same-origin `<img>`, so the browser sends the Access cookie automatically. Nothing in the app needs to know about Access.
- **Bandwidth.** Each viewer gets its own stream from the Pi (the edge doesn't fan out). A 640×480 JPEG at quality 70 is roughly 25–40 KB, so at 15 fps that's about 3–5 Mbit/s of **upload** per open tab. On weak venue Wi-Fi, lower `StreamConfig.jpeg_quality` in `coop/config.py` or keep the number of open tabs small.

Check it end to end:

```bash
# on the Pi: the origin streams (expect a few hundred KB after 2 s)
curl -sN --max-time 2 http://127.0.0.1:8000/video -o /dev/null -w '%{size_download} bytes\n'

# anywhere: no login -> Access redirect (302), never 200
curl -s -o /dev/null -w '%{http_code}\n' https://coop.example.com/video
```

Then open `https://coop.example.com` in a browser, sign in with an approved email, and confirm the feed moves. In DevTools → Network, `/video` should be a single pending request whose size keeps growing.

To test the stream through Access from a terminal (install cloudflared on the laptop with `winget install Cloudflare.cloudflared`):

```powershell
cloudflared access login https://coop.example.com
cloudflared access curl https://coop.example.com/video --max-time 5 -s -o NUL -w '%{size_download} bytes\n'
```

## 5. Everyday commands

```bash
systemctl status coop-tunnel            # is it connected?
journalctl -u coop-tunnel -f            # live logs ("Registered tunnel connection" x4 = healthy)
sudo systemctl restart coop-tunnel      # after editing /etc/cloudflared/coop.yml
cloudflared tunnel info coop            # active connections and which edge locations
```

Uninstall:

```bash
sudo systemctl disable --now coop-tunnel
sudo rm /etc/systemd/system/coop-tunnel.service
cloudflared tunnel cleanup coop && cloudflared tunnel delete coop
# then delete the coop CNAME in the Cloudflare DNS tab, and the Access application
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Cloudflare **502 Bad Gateway** | The tunnel is up but COOP isn't answering on port 8000. `systemctl status coop`, `curl http://127.0.0.1:8000/api/status`. |
| Cloudflare **error 1033** | No tunnel connected for this hostname. `journalctl -u coop-tunnel -e`. |
| Logs loop on `failed to dial to edge with quic` | The network blocks UDP 7844. cloudflared normally falls back to HTTP/2 on its own; to skip the QUIC attempts, add `protocol: http2` at the top level of `/etc/cloudflared/coop.yml` and restart. |
| Status updates but the video freezes or stutters | Upload bandwidth (see section 4). Close extra tabs, lower `jpeg_quality`. |
| Dashboard changes don't show up | Edge cache on `.js`/`.css`. Add the bypass Cache Rule, or purge. |
| Dashboard stops updating after many hours | The Access session expired. `/api/*` fetches are now redirected to the login page, which the browser blocks as cross-origin. Reload the page to sign in again. |
| `NXDOMAIN` / "server not found" | Zone not Active yet, or `route dns` never ran. Check the DNS tab for a `coop` CNAME to `<id>.cfargotunnel.com`. |
| SSL error | You used a two-level subdomain (`a.b.example.com`). Use `coop.example.com`. |

## Note: the LAN still bypasses Access

`coop.service` binds `0.0.0.0:8000`, so anyone on the same network can open `http://<pi>.local:8000` without logging in. That's useful during the demo (it keeps working if the venue's internet drops), but if the camera should *only* be reachable through Access, set `StreamConfig.host = "127.0.0.1"` in `coop/config.py`; the tunnel only needs loopback.
