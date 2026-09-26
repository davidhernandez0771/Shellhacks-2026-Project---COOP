# COOP
**Computer-vision Object Observation & Prediction**

> COOP is an AI tracking camera on a Raspberry Pi 5 that spots people and cars, predicts where they're heading, and turns on stepper motors to keep them in frame, streamed live to your browser.

Built for **ShellHacks 2026**. Devpost submission text lives in [docs/DEVPOST.md](docs/DEVPOST.md).

```
Pi Camera ─► YOLO detect + ByteTrack IDs ─► pick target ─► Kalman prediction ─► pan stepper
                                                      │
                                                      └──► annotated MJPEG stream + status API ─► web dashboard
```

## Team
| Who | Area |
|---|---|
| David Hernandez | Software: vision, tracking, prediction, web |
| _(teammate)_ | Design & hardware: enclosure, mount, steppers, wiring |

## Hardware
- Raspberry Pi 5 (8 GB)
- 5 MP OV5647 camera, 3.6 mm lens, 75° diagonal FOV (needs a **15→22 pin Pi 5 camera cable**)
- NEMA 17 steppers on TMC2209 drivers, controlled by an **Arduino Uno** connected to the Pi over USB
- 12 V supply for the motors

Wiring, pinout and BOM: [hardware/README.md](hardware/README.md).

## Repo layout
```
coop/
  main.py       main loop: capture → detect → predict → aim → stream
  config.py     every tunable value (pins, FOV, model, speeds)
  camera.py     Picamera2 on the Pi, webcam fallback for laptop dev
  detector.py   YOLO11n + ByteTrack (person, car, motorcycle, bus, truck)
  predictor.py  constant-velocity Kalman filter in world-angle space
  motors.py     sends target angles to the Arduino over serial; e-stop, zero, idle power-down; mock mode without it
  control.py    operator state behind the API: mode, lock, manual aim, e-stop, event log
  settings.py   coop.toml loading/validation/saving, and live tuning (/api/settings)
  diag.py       CPU temperature, throttling, serial link state for /api/status.diag
  stream.py     Flask MJPEG stream + the JSON API (docs/API.md)
firmware/       Arduino Uno sketch (AccelStepper → TMC2209)
tools/          bench tools: fake_uno (firmware emulator), jog, camera_check, bench_fps, rehearsal
coop.example.toml  every setting at its default; copy to coop.toml (gitignored) to override
web/            dashboard (served by the Pi)
hardware/       wiring, BOM, CAD / 3D-print files
scripts/        Pi setup, systemd services, Cloudflare Tunnel
site/           public one-page project showcase (static; see site/README.md)
tests/          pytest suite (pixel math, Kalman, control, serial protocol, emulator e2e, Flask API)
```

## Run it

### On the Pi
```bash
git clone https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOP coop
cd coop
bash scripts/setup_pi.sh
source .venv/bin/activate
python -m coop.main            # add --no-motors to test without steppers
```
Then open `http://<pi-hostname>.local:8000` from the laptop.

- **Run on boot:** `sudo bash scripts/install_service.sh` installs a systemd service that starts COOP at boot and restarts it if it crashes.
- **Remote access:** to reach the dashboard over HTTPS from anywhere, with an email login in front, see [scripts/setup_tunnel.md](scripts/setup_tunnel.md).

### On a laptop (no Pi, no motors)
```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (source .venv/bin/activate on Mac/Linux)
pip install -r requirements.txt
python -m coop.main --source webcam --no-motors
```
Open `http://localhost:8000`.

## How tracking works
1. **Detect + ID:** YOLO finds people and vehicles; ByteTrack gives each one a stable ID across frames.
2. **Choose a target:** keep following the current ID. If it's gone, pick by class priority (person before car), then by size.
3. **Convert to world angle:** gimbal angle + the target's angular offset in the frame. Working in world angles means the camera's own rotation doesn't look like the target moving.
4. **Predict:** a Kalman filter estimates angular velocity and aims `lead_time_s` ahead to cover processing latency.
5. **Move:** the Pi sends target positions to the Arduino over USB serial. The Arduino runs AccelStepper, which smoothly accelerates each motor toward its target. If the Pi stops talking, the Arduino stops the motors after 2 seconds.

The laptop can drive the real motors too: plug the Uno into the laptop and it's found automatically.

## Settings
Every tunable lives in `coop/config.py`. To change one without editing code, copy `coop.example.toml` to `coop.toml` in the repo root and edit it (it's gitignored, so the Pi and each laptop keep their own). Unknown keys and wrong types stop COOP at startup with the key named. `--config other.toml` picks another file.

The values you tune with the hardware in front of you (`lead_time_s`, `deadband_deg`, `conf`, `max_steps_per_sec`, `accel_steps_per_sec2`, `pan_invert`) can also be changed live with `GET/POST /api/settings`, and saved back to `coop.toml` with `"save": true` (comments are kept). See [docs/API.md](docs/API.md).

## Safety
- **E-STOP** (`POST /api/estop`): brakes, then powers the driver down once the shaft is still (cutting power mid-ramp would make the Uno lose count). Everything that would move the camera is refused until `POST /api/arm`.
- **Zero** (`POST /api/zero`): the current direction becomes 0°. There's no homing switch, and opening the serial port resets the Uno, so **each start of COOP (or `tools.jog`) makes the current direction 0°**: point the camera forward first.
- **Idle power-down:** in Stop mode the driver is switched off after `idle_disable_s` (20 s) so the motor doesn't heat up; it comes back on when motion resumes.
- **Watchdog:** the Uno stops the motor if the Pi goes quiet for 2 s.

## Bench tools (no vision needed)
Run from the repo root. Each also works as `python tools/<name>.py`.

| Tool | What it's for |
|---|---|
| `python -m tools.fake_uno --port 5555` | Emulates the Uno firmware on a TCP port. Point anything at it with `--motor-port socket://localhost:5555` (or `port = "socket://localhost:5555"` in `coop.toml`). |
| `python -m tools.rehearsal` | The whole app with no hardware: a synthetic walker seen by a camera that turns with the emulated motor. Open `http://localhost:8000`. `--invert` shows what a wrong motor direction looks like. |
| `python -m tools.jog [--port P]` | Jog the pan motor from the keyboard (arrows, `[` `]` step, `0` home, `z` zero, `e` e-stop, `q` quit), or `--goto 90` / `--by -10` / `--zero`. Uses `coop.toml`. |
| `python -m tools.camera_check [--source picamera]` | Delivered resolution and FPS, plus a saved still for the colour and orientation check. |
| `python -m tools.bench_fps [--export]` | YOLO speed, PyTorch vs NCNN at imgsz 256/320/416, timing the same `track()` call COOP makes; `--export` builds the NCNN models. Prints a Markdown table. |

The first-hardware checklist in [docs/HARDWARE_TEST.md](docs/HARDWARE_TEST.md) uses them in order: emulator → jog → camera check → FPS bench → full run.

## Testing
```bash
pip install -r requirements-dev.txt
pytest
```
Covers the pixel-to-angle math, the Kalman predictor, target selection, the control state machine, the settings file, the Arduino serial protocol (against a fake serial port), the real `Gimbal` and then the whole app against `tools/fake_uno.py` (e-stop, zero, reconnects, closed-loop tracking of a synthetic walker), and the Flask API. Runs anywhere `requirements.txt` does — no Pi, camera, or Arduino required.

## Performance tips (Pi 5)
- Export the model to NCNN for a big CPU speed-up: `python -m tools.bench_fps --export` (then `python -m tools.bench_fps` to compare), and set `model = "yolo11n_imgsz320_ncnn_model"` and `imgsz = 320` under `[detector]` in `coop.toml`. An NCNN model must run at the size it was exported at.
- `/api/status` → `diag` shows `fps`, `capture_fps`, `infer_ms`, `latency_ms`, the CPU temperature and throttle flags. Set `lead_time_s` to roughly the latency plus the motor's lag.
- Keep `imgsz` at 320 and the capture resolution at 640×480 unless you have headroom.

## Troubleshooting
- **Camera not detected:** check the ribbon cable orientation and that it's the 22-pin Pi 5 cable. Test with `rpicam-hello`.
- **`numpy.dtype size changed` when importing picamera2:** pip replaced the system numpy. Run `pip uninstall numpy` inside the venv so it uses the apt version again.

## License
MIT
