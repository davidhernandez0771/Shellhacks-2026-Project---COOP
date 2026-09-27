# COOPER
✏️ _The story behind the name COOPER goes here (the team's to write)._

> COOPER is a Raspberry Pi 5 dashcam that spots people and cars, predicts where each one is heading, and lights a yellow or red LED before something cuts into your lane.

Built for **ShellHacks 2026**. The showcase site is live at [coop.davidhernandez.work](https://coop.davidhernandez.work); the Devpost submission text lives in [docs/DEVPOST.md](docs/DEVPOST.md).

```
Pi camera ─► YOLO11n + ByteTrack ─► Kalman filter per object ─► lane risk ─► yellow / red LED
                                                   │
                                                   └──► MJPEG stream + status API ─► web dashboard
```

## Team
| Who | Area |
|---|---|
| David Hernandez | Backend, vision, tracking, prediction |
| Diego Avila | CAD and hardware; assembled and wired the finished project |
| Diego Tabares | Presentation, pitch, and elements of website design |

## What it does
COOPER is a fixed, car-mounted dashcam: a Raspberry Pi 5 and an OV5647 camera behind the windshield, powered by the car. Nothing on it moves. Every frame, it:

1. **Detects** people, cars, motorcycles, buses and trucks with YOLO11n, and gives each one a stable ID with ByteTrack. All on the Pi 5's CPU, no accelerator.
2. **Predicts** where each object is going with its own Kalman filter, 1.5 s ahead.
3. **Judges the risk** against "my lane", a trapezoid of the road in front of the car:
   - **Red LED (danger):** something is in your lane right now.
   - **Yellow LED (warning):** something's predicted path enters your lane within 1.5 s (a car about to cut in, a pedestrian stepping out), or its time to contact is short (it's closing on you fast).
   - **Both off:** clear. Red overrides yellow.
4. **Streams** the video to a web dashboard that draws every predicted path, the lane (which you can drag to fit your car), the risk level and the LED state, and can beep in step with the LEDs.

## How it works (the math)
The car moves, so COOPER works on motion **relative to the camera**, in image pixels: that's what decides a collision, and it needs no map or speed sensor. [docs/MATH.md](docs/MATH.md) has the full derivation; the short version:

- **Where an object touches the road** is the bottom-centre of its box, (u, v). **How close it is** shows in the box height h, which is proportional to 1/distance.
- **A constant-velocity Kalman filter per object** tracks x = [u, v, h, u̇, v̇, ḣ] from measurements z = [u, v, h]:
  - F = [[I, Δt·I], [0, I]], H = [I 0].
  - Q is white-noise acceleration per axis, σ²·[[Δt⁴/4, Δt³/2], [Δt³/2, Δt²]], with σ = 400 px/s² for u, v and 150 px/s² for h.
  - R = diag(3², 3², 3²) px².
  - Predict: x̂⁻ = F·x̂, P⁻ = F·P·Fᵀ + Q. Update: K = P⁻Hᵀ(HP⁻Hᵀ + R)⁻¹, x̂ = x̂⁻ + K(z − Hx̂⁻), P = (I − KH)P⁻.
  - Because every matrix is block-diagonal per axis, it runs as three exact 2-state filters: a fraction of a millisecond for 10 objects.
- **Track lifetime:** a track unseen for 0.5 s is forgotten, and a track needs 3 measurements before its velocity is trusted for warnings.
- **Occlusion:** a box cut short by a nearer car would put the "ground point" on that car's roof. Measurements more than 4σ from the prediction are rejected and the filter coasts (v and h together, since they share the bottom edge), for at most 1 s.
- **Red:** at least 20 % of the object's bottom edge is inside the lane now.
- **Yellow:**
  - Path: the filter's path is sampled every 0.1 s out to 1.5 s, and a predicted bottom edge passes the same lane test.
  - Time to contact: τ = h / ḣ is below 2.0 s (it releases above 2.5 s) while the object is in the lane's corridor (the lane extended towards the vanishing point, widened by 25 % each side). That counts only when ḣ is more than 2 of its own standard deviations above zero, so detector jitter isn't read as closing, and only for boxes at least 24 px tall.
- **No flicker:** a level lights after 2 frames in a row and stays on 0.5 s after its condition ends.

## Hardware
- Raspberry Pi 5 (8 GB) with the active cooler
- OV5647 5 MP camera, 3.6 mm lens, 75° diagonal FOV (≈63°×49° at 4:3), no IR, on the Pi 5 camera port (needs the **15→22 pin Pi 5 cable**)
- A yellow and a red LED, each with a 330 Ω resistor, on Pi GPIO
- Power from the car: a USB-C PD car charger rated for the Pi 5 (5 V, 5 A / 27 W)
- microSD card (32 GB+) with Raspberry Pi OS Bookworm, 64-bit
- A windshield mount and enclosure for the Pi, camera and LEDs (designed in Fusion 360)

✏️ _Total parts cost: to fill in._

Wiring, pinout and the full BOM: [hardware/README.md](hardware/README.md).

### Wiring
| LED | GPIO (BCM) | Physical pin | Through | To |
|---|---|---|---|---|
| Yellow (warning) | GPIO17 ✏️ | 11 | 330 Ω → LED anode (long leg) | cathode → GND (pin 9) |
| Red (danger) | GPIO27 ✏️ | 13 | 330 Ω → LED anode (long leg) | cathode → GND (pin 14) |

✏️ **These pins are placeholders, still to confirm** against the real wiring. Set them as `yellow_pin` / `red_pin` under `[leds]` in `cooper.toml` (BCM numbers, not physical pin numbers). At 3.3 V with a ~2.0 V LED drop, 330 Ω gives about 4 mA per LED. gpiozero drives them through the lgpio backend (the Pi 5's GPIO is on the RP1 chip).

## Run it

### On a laptop (no Pi, no LEDs)
```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (source .venv/bin/activate on Mac/Linux)
pip install -r requirements.txt
python -m cooper.main --source webcam
```
Open `http://localhost:8000`. Off a Pi the LEDs are mocked automatically (`--no-leds` forces it anywhere): the dashboard shows what they would do, and gpiozero isn't needed. The first run downloads `yolo11n.pt`.

**No camera pointed at a road?** Run the rehearsal: the real app watching a synthetic road through a fixed dashcam (a car cutting in, a pedestrian crossing, the lead car braking, a car in the next lane that must never light anything).
```bash
python -m tools.rehearsal             # then open http://localhost:8000
python -m tools.rehearsal --timeline  # no dashboard: print one 20 s loop's risk and LED changes
```

### On the Pi
Flash Raspberry Pi OS Bookworm (64-bit) and, in Raspberry Pi Imager's settings, set the hostname, a user and **enable SSH**. Then, on the Pi:
```bash
git clone https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOPER cooper
cd cooper
bash scripts/setup_pi.sh          # apt: picamera2, gpiozero, lgpio; a .venv that can see them; pip requirements
source .venv/bin/activate
python -m cooper.main --source picamera   # add --no-leds to keep the LEDs off
```
`setup_pi.sh` creates the venv with `--system-site-packages`, because Picamera2 and gpiozero come from apt, not pip. Test the camera alone with `rpicam-hello -t 5000`.

**Getting onto the Pi:**
- **SSH** from a laptop on the same network: `ssh <user>@<pi-hostname>.local`, or `ssh <user>@<Pi IP>`. `hostname -I` on the Pi prints its IP.
- **Raspberry Pi Connect** when you're not on the same network, or want the Pi's screen in a browser: `sudo apt install rpi-connect` (`rpi-connect-lite` on OS Lite), `rpi-connect on`, `rpi-connect signin`, then open [connect.raspberrypi.com](https://connect.raspberrypi.com) for a remote shell.

**Open the dashboard** from a laptop or phone on the same network: `http://<Pi IP>:8000` (or `http://<pi-hostname>.local:8000`).

- **Run on boot:** `sudo bash scripts/install_service.sh` installs `cooper.service` (systemd), which starts COOPER when the car powers the Pi and restarts it if it crashes. Check on it with `systemctl status cooper` and `journalctl -u cooper -f`; restart with `sudo systemctl restart cooper`.
- **Remote access:** to reach the dashboard over HTTPS from anywhere, with an email login in front (Cloudflare Tunnel + Access), see [scripts/setup_tunnel.md](scripts/setup_tunnel.md).
- **Calibrate the lane** once the camera is mounted: in the dashboard, **Edit lane**, drag the corners onto your lane out to about 15 m, then **Apply and save**. Step by step: [docs/HARDWARE_TEST.md](docs/HARDWARE_TEST.md).

## The dashboard
Served by the Pi at port 8000 (`web/`, plain HTML, CSS and JS; the API is in [docs/API.md](docs/API.md)).

- **Live feed** with, on one canvas: the lane (tinted yellow or red with the risk), every object's corner brackets, its predicted path with a tick every 0.5 s, and the bottom edge the lane test uses.
- **Risk panel:** the level and the reason ("car #201 heading into your lane in 0.8 s"), the two LEDs and whether they're real (GPIO) or mocked, every object by risk, and the event log.
- **Lane editor:** drag the four corners; **Apply** updates the risk rules on the next frame, **Apply and save** also writes it to `cooper.toml`.
- **Tuning:** confidence, horizon, time-to-contact thresholds and hold time, live.
- **Beep:** a sound that follows the same risk level as the LEDs, like a parking sensor: yellow is one short beep a second, red is rapid high beeps. It's off until you turn it on (the speaker button or the **S** key), because browsers block audio until the page is interacted with; the choice is remembered.
- **Diagnostics:** CPU temperature, throttling, vision and camera fps, inference time, camera-to-LED latency.
- **Keys:** **L** edit lane, **Esc** cancel, **F** fullscreen, **S** sound.

With no backend it plays a mock of the same road (`?demo=warning`, `?demo=danger`, …, listed in `web/mock.js`).

## Settings
Every tunable lives in `cooper/config.py`. To change one without editing code, copy `cooper.example.toml` to `cooper.toml` in the repo root and edit it (it's gitignored, so the Pi and each laptop keep their own). Unknown keys and wrong types stop COOPER at startup with the key named. `--config other.toml` picks another file.

Live from the dashboard (`GET/POST /api/settings`, saved back to `cooper.toml` with `"save": true`, comments kept): `conf`, `horizon_s`, `ttc_warn_s`, `ttc_clear_s`, `hold_s`. The lane is live too (`POST /api/lane`). See [docs/API.md](docs/API.md).

Command-line flags for `python -m cooper.main`: `--source auto|picamera|webcam`, `--port`, `--no-leds`, `--annotate` (burn boxes into `/video`), `--config`.

## Bench tools
Run from the repo root. Each also works as `python tools/<name>.py`.

| Tool | What it's for |
|---|---|
| `python -m tools.rehearsal` | The whole app on a synthetic road, no hardware. `--timeline` prints one loop's risk and LED changes instead. |
| `python -m tools.camera_check [--source picamera]` | Delivered resolution and FPS, plus a saved still for the colour and orientation check. |
| `python -m tools.bench_fps [--export]` | YOLO speed, PyTorch vs NCNN at imgsz 256/320/416, timing the same `track()` call COOPER makes; `--export` builds the NCNN models. Prints a Markdown table. |

The first-hardware checklist in [docs/HARDWARE_TEST.md](docs/HARDWARE_TEST.md) uses them in order: rehearsal → camera check → FPS bench → LEDs → lane calibration → risk test.

## Testing
```bash
pip install -r requirements-dev.txt
python -m pytest -q
```
Covers the Kalman filter (against the full 6×6 matrix form, occlusion gating, time to contact), every risk rule and the hysteresis, the LEDs (gpio vs mock, only writing on a change), the settings file and live settings, the lane API, the Flask API, diagnostics, the capture thread, the bench tools, and the rehearsal's whole 20 s loop (each scripted event warns before it's danger, the car in the next lane never lights an LED, no LED flickers). Runs anywhere `requirements.txt` does: no Pi, camera or GPIO needed. GitHub Actions runs it on every push and pull request.

## Performance tips (Pi 5)
- Export the model to NCNN for a big CPU speed-up: `python -m tools.bench_fps --export` (then `python -m tools.bench_fps` to compare), and set `model = "yolo11n_imgsz320_ncnn_model"` and `imgsz = 320` under `[detector]` in `cooper.toml`. An NCNN model must run at the size it was exported at.
- `/api/status` → `diag` shows `fps`, `capture_fps`, `infer_ms`, `latency_ms`, the CPU temperature and throttle flags.
- Keep `imgsz` at 320 and the capture resolution at 640×480 unless you have headroom. Prediction and risk cost well under a millisecond per frame.

## Troubleshooting
- **Camera not detected:** check the ribbon cable orientation and that it's the 22-pin Pi 5 cable. Test with `rpicam-hello`.
- **`numpy.dtype size changed` when importing picamera2:** pip replaced the system numpy. Run `pip uninstall numpy` inside the venv so it uses the apt version again.
- **LEDs say "mock" on the Pi:** the log line `LEDs: mock (...)` gives the reason. Usually gpiozero or lgpio isn't installed (re-run `scripts/setup_pi.sh`), or another process holds the pins.
- **Under-voltage (`throttled` not 0):** the car charger can't deliver 5 A. Use a 27 W USB-C PD charger.
- **No sound from the dashboard:** click the page once (or press **S**); the button reads "Click to enable" while the browser is still blocking audio.

## The website
[coop.davidhernandez.work](https://coop.davidhernandez.work) is the public showcase: a one-page, scroll-driven story (See, Detect, Predict, Warn, Build, Gallery, Team) in one persistent three.js scene, with COOPER's real CAD model pulled apart in the Build chapter. It lives in `site/`, has no build step and deploys to Cloudflare Pages; see [site/README.md](site/README.md) and [site/PERFORMANCE.md](site/PERFORMANCE.md).

## Repo layout
```
cooper/
  main.py       main loop: capture → detect/track → predict → risk → LEDs → stream
  config.py     every tunable value (camera, model, prediction, risk, lane, LED pins)
  camera.py     Picamera2 on the Pi, webcam fallback for laptop dev
  detector.py   YOLO11n + ByteTrack (person, car, motorcycle, bus, truck)
  predictor.py  constant-velocity Kalman filter per tracked object, in image space
  risk.py       lane geometry, path and time-to-contact rules, hysteresis → clear/warning/danger
  leds.py       the two LEDs: gpiozero on the Pi, a mock everywhere else
  control.py    the event log behind /api/events
  settings.py   cooper.toml loading/validation/saving, live tuning (/api/settings) and the lane (/api/lane)
  diag.py       CPU temperature, throttling, LED mode, fps for /api/status.diag
  stream.py     Flask MJPEG stream + the JSON API (docs/API.md)
cooper.example.toml  every setting at its default; copy to cooper.toml (gitignored) to override
web/            the dashboard (served by the Pi)
tools/          rehearsal, camera_check, bench_fps; cad_to_glb.py (Fusion 360 → the site's .glb); site_perf/ (site measurements)
scripts/        setup_pi.sh, install_service.sh + cooper.service, Cloudflare Tunnel (setup_tunnel.md, install_tunnel.sh)
hardware/       wiring, pinout, BOM, power and mounting notes
site/           the public showcase site (static; see site/README.md)
tests/          pytest suite
docs/           MATH.md (filter and risk rules), API.md, HARDWARE_TEST.md, DEVPOST.md, DESIGN_BRIEF.md
```

## License
MIT
