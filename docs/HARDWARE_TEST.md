# First hardware bring-up checklist

Work through this top to bottom on the real Pi 5, camera and LEDs. Each step has a checkbox and the result to expect; if you get something else, stop and write it in the findings log at the bottom before moving on. Commands run on the Pi from the repo root (with `source .venv/bin/activate`) unless marked **laptop**.

**The order is deliberate: rehearsal → camera → FPS bench → LEDs → lane calibration → risk test.** Each stage only adds one new thing that can go wrong.

**Status as of 2026-09-26: nothing below has run on real hardware yet.** Every step is tagged **`[never run]`**. When a step passes on the real thing, change its tag to **`[ok YYYY-MM-DD]`** in the same commit as any fix it needed.

What *has* been verified, off hardware only:
- The pytest suite (filter, risk rules, LEDs against a fake board, settings, lane API, Flask API, diagnostics, capture thread, and the rehearsal's full 20 s loop). It runs with only the minimal CI dependencies.
- `python -m tools.rehearsal` serving the dashboard with every risk state; `python -m cooper.main --source webcam` on a laptop (YOLO11n + ByteTrack at about 14 ms per frame, LEDs mocked).
- Nothing has touched the Pi camera, GPIO, systemd or Cloudflare.

**Safety rules for the whole session**
- **Do every car test parked first.** The driver never looks at or touches the dashboard while driving; a passenger does, or nobody.
- COOPER is a warning light, not a safety system. Drive as if it weren't there.
- Wire the LEDs with the Pi powered off, and never without their resistors.

---

## 0. Prerequisites

- [ ] **The Pi has a commit that includes the dashcam refactor** (`refactor/cooper-dashcam` or later). `[never run]`
  **Expect:** `ls cooper/` shows `risk.py leds.py predictor.py`, and `cooper.example.toml` exists.
- [ ] **CI is green on the commit you're testing.** `[never run]` **Expect:** the `tests` workflow passes on GitHub for that commit.
- [ ] **Bring:** the car charger and cable, two LEDs, two 330 Ω resistors, jumper wires, a multimeter, and a phone on mobile data (for the tunnel test and as a hotspot). `[never run]`

## 1. Rehearsal (laptop, no hardware)

This proves the software end to end before anything is wired.

- [ ] **Tests:** `python -m pytest -q`. `[never run]` **Expect:** all pass, none skipped.
- [ ] **One loop's timeline:** `python -m tools.rehearsal --timeline`. `[never run]`
  **Expect** (20 s loop, times ±0.1 s):
  - clear until the cut-in: yellow at ~4.7 s, red at ~5.7 s, clear at ~8.5 s;
  - the pedestrian: yellow at ~10.6 s, red at ~12.1 s, clear at ~13.4 s;
  - the braking lead car: yellow at ~18.3 s, red at ~19.0 s;
  - never a line mentioning `#4xx` (the car in the next lane).
- [ ] **Dashboard:** `python -m tools.rehearsal`, open `http://localhost:8000`. `[never run]`
  **Expect:** predicted paths on every object, the lane tinting yellow and red in step with the LED lamps, and **LEDs · mock** in the risk panel.

## 2. Pi software

- [ ] **Clone and set up:** `bash scripts/setup_pi.sh`. `[never run]`
  **Expect:** the script ends with `imports OK` (picamera2, gpiozero and ultralytics all import).
- [ ] **Download the model once, while online.** `yolo11n.pt` is gitignored, so the first run downloads it. `[never run]`
  Run `python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"`.
  **Expect:** `yolo11n.pt` (≈5.4 MB) appears in the repo root. After this, COOPER starts without internet access.
- [ ] **Settings file:** `cp cooper.example.toml cooper.toml`, and delete the lines you won't change. `[never run]`
  **Expect:** `python -c "from cooper.settings import load_config; print(load_config().leds)"` prints your pins. A typo fails loudly with the key named.
- [ ] **Diagnostics read the Pi:** `python -c "from cooper.diag import read_cpu_temp_c, read_throttled; print(read_cpu_temp_c(), hex(read_throttled()))"`. `[never run]`
  **Expect:** a temperature around 40–60 and `0x0`. (`None` means the path or `vcgencmd` isn't where `cooper/diag.py` looks; note it in the log.)

## 3. Camera

- [ ] **Camera detected:** `rpicam-hello --list-cameras`. `[never run]`
  **Expect:** one camera listed as `ov5647`.
  If there's none, check the 22-pin end is in a Pi 5 CAM port with the contacts facing the right way. If auto-detect still fails, add `dtoverlay=ov5647,cam0` (or `cam1`, depending on the port) to `/boot/firmware/config.txt` and reboot.
- [ ] **COOPER's camera path:** `python -m tools.camera_check --source picamera`, then copy `camera_check.jpg` to the laptop. `[never run]`
  **Expect:**
  - `Resolution: 640x480 (configured 640x480)` and `Delivered: ~30 fps`.
  - Skin tones look normal, not blue. If they're blue, the red/blue channels are swapped; see the `RGB888` comment in `cooper/camera.py`.
- [ ] **Orientation matches the world.** Take the still with text held up and something on the camera's right. `[never run]`
  **Expect:** the text reads normally (not mirrored or upside down), and something on the camera's right appears on the right of the image. If not, fix it before calibrating the lane: a Picamera2 `Transform` in `camera.py`, or how the camera is mounted.

## 4. FPS bench

- [ ] **Export NCNN models** (once, online): `python -m tools.bench_fps --export`. `[never run]`
  **Expect:** `yolo11n_imgsz256_ncnn_model/`, `…320…`, `…416…` folders in the repo root.
- [ ] **Benchmark:** `python -m tools.bench_fps`. Paste the printed table into the findings log. `[never run]`
  **Expect:** NCNN clearly faster than PyTorch at each size. The goal is ≥10 fps at 320.
- [ ] **Use the winner:** in `cooper.toml` under `[detector]`, set `model = "yolo11n_imgsz320_ncnn_model"` and `imgsz = 320` (an NCNN model must run at its export size). `[never run]`

## 5. LEDs

Wire them with the Pi **off**, as in `hardware/README.md`: GPIO → 330 Ω → LED long leg, short leg → GND. The default pins (BCM 17 yellow, 27 red) are placeholders: if you wire others, set them under `[leds]` in `cooper.toml` first.

- [ ] **Each LED lights on its own**, with COOPER not running (it would hold the pins): `[never run]`
  ```bash
  python - <<'EOF'
  import time
  from cooper.leds import Leds
  from cooper.settings import load_config
  leds = Leds(load_config().leds)
  print("mode:", leds.mode, "|", leds.mode_reason)
  for level in ("warning", "danger", "clear"):
      print(level); leds.set(level); time.sleep(2)
  leds.close()
  EOF
  ```
  **Expect:** `mode: gpio | GPIO17 yellow, GPIO27 red`, then yellow alone for 2 s, red alone for 2 s, both off. If it says `mock`, the reason is printed (not a Pi, gpiozero or lgpio missing, pin busy). If the colours are swapped, swap the pins in `cooper.toml`. If one never lights, the LED is probably in backwards (long leg towards the resistor).
- [ ] **Visible in daylight** from the driver's seat, at a glance. `[never run]` If not, drop the resistors to 150 Ω or use brighter LEDs.
- [ ] **COOPER drives them:** `python -m cooper.main --source picamera`. `[never run]`
  **Expect:** the log says `LEDs: gpio (GPIO17 yellow, GPIO27 red)`, and the dashboard's risk panel and diagnostics say **GPIO**. Walk in front of the camera (on the bench, the "lane" is the bottom middle of the frame): red lights when you're in it, then goes off about ½ s after you leave. Ctrl+C turns both off.

## 6. Mount and calibrate the lane (parked)

- [ ] **Mount** the camera centred behind the windshield, level, looking straight down the road; power the Pi from the car charger. `[never run]`
  **Expect:** it boots; the dashboard's Power reading is **OK** (`throttled: 0`). Not OK: the charger can't deliver 5 A.
- [ ] **Calibrate:** park on a straight, flat road or a car park with lane markings. Open the dashboard from a phone on the same network (or the tunnel), **Edit lane**, and drag the corners: the bottom corners on your lane's edges at the bottom of the frame (or your car's width if the markings are wider), the top corners on the same lane about 15 m ahead. **Apply and save.** `[never run]`
  **Expect:** a `Lane changed and saved` event, and `[risk] lane = [...]` in `cooper.toml`. Restart COOPER: the lane is still there.

## 7. Risk test (parked, a helper walking)

The car stays parked with the engine off for all of these; a helper walks, you watch the LEDs and the dashboard.

- [ ] **Crossing in front:** the helper walks across in front of the car, about 8–10 m ahead, at a normal pace. `[never run]`
  **Expect:** yellow while they're still outside the lane and heading in ("person #… heading into your lane in …"), red while they're in it, then off about ½ s after they leave it. Their predicted path points across the lane on the dashboard.
- [ ] **Walking alongside, in the next lane:** the helper walks towards the car along the next lane. `[never run]`
  **Expect:** nothing lights (they're neither in nor heading into your lane). If yellow lights, the lane is too wide: narrow it.
- [ ] **Approaching head-on:** the helper walks straight towards the car down the middle of the lane, starting beyond its far end (~20 m). `[never run]`
  **Expect:** yellow before they reach the lane's top edge (path or TTC; the reason says which), red once they're in it.
- [ ] **Standing still in the lane:** the helper stands in the lane for 10 s. `[never run]`
  **Expect:** a steady red, no flicker. Standing still just outside the lane: nothing, and no stray yellow from box jitter.
- [ ] **Tune if needed**, live from the dashboard's Tuning panel: a longer `horizon_s` warns earlier (and more often), a longer `hold_s` holds the LEDs longer. Keep good values with **Apply and save**. Record what you changed here. `[never run]`

## 8. On the road (a passenger watches, the driver drives)

- [ ] **Following traffic:** drive normally behind other cars. `[never run]`
  **Expect:** clear most of the time; yellow when the car ahead brakes hard or a car merges in front; the LEDs don't flicker. Note every surprising light in the findings log with the time; the dashboard's event log has the reason.
- [ ] **FPS and thermals after 10 minutes:** `curl -s localhost:8000/api/status | python3 -c "import json,sys; print(json.load(sys.stdin)['diag'])"`. `[never run]`
  **Expect:** `fps` close to the bench number, `capture_fps` ≈ 30, `cpu_temp_c` below about 80 °C, `throttled: 0`. Non-zero: see the bit list in `docs/API.md` (`0x1`/`0x10000` = under-voltage: the charger).

## 9. systemd service

- [ ] **Install:** `sudo bash scripts/install_service.sh`. `[never run]`
  **Expect:** `systemctl status cooper` shows `active (running)`, and `journalctl -u cooper -f` shows the same startup lines as a manual run, including `Settings: /home/…/cooper.toml` and `LEDs: gpio`.
- [ ] **Starts with the car:** turn the ignition off and on (the Pi loses and regains power). `[never run]` **Expect:** the dashboard is live within about 60 s, the LEDs work, and the saved lane is back.
- [ ] **Restarts after a crash:** `sudo systemctl kill -s SIGKILL cooper`. `[never run]` **Expect:** back to `active (running)` within about 3 s, and `diag.uptime_s` restarts from ~0.

## 10. Cloudflare Tunnel and Access

Follow `scripts/setup_tunnel.md`. DNS must already be on Cloudflare and the Access app created (steps 1–2) before the installer runs. In the car, the Pi needs internet: a phone hotspot works.

- [ ] **Install the tunnel:** `bash scripts/install_tunnel.sh cooper-live.example.com` (your domain). `[never run]`
  **Expect:**
  - cloudflared installs as arm64.
  - `ingress validate` passes.
  - The final check prints `OK: unauthenticated requests get HTTP 302`.
  - `journalctl -u cooper-tunnel` shows 4× `Registered tunnel connection`.
- [ ] **Blocked without a login:** from the laptop, `curl -s -o /dev/null -w "%{http_code}" https://cooper-live.example.com/video`. `[never run]` **Expect:** `302`, never `200`. Also try `-X POST …/api/lane`: `302`.
- [ ] **Unapproved email is refused:** on the login page, try an address that isn't in the policy. `[never run]` **Expect:** no one-time PIN arrives, or access is denied.
- [ ] **Approved email gets in, from a phone on mobile data.** `[never run]`
  **Expect:** the dashboard loads over HTTPS, `/video` plays smoothly, and the risk panel follows the LEDs.
- [ ] **Stream is unbuffered:** in DevTools → Network, open `/video`. `[never run]` **Expect:** one long-running request whose transferred size grows steadily; no stall and no 524 error after 100 s.

---

## Findings log

| Date | Step | What happened | Fix / commit |
|---|---|---|---|
| | | | |
