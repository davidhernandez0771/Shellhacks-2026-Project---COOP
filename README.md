# COOP
**Computer-vision Object Observation & Prediction**

> COOP is an AI tracking camera on a Raspberry Pi 5 that spots people and cars, predicts where they're heading, and turns on stepper motors to keep them in frame, streamed live to your browser.

Built for **ShellHacks 2026**. Devpost submission text lives in [docs/DEVPOST.md](docs/DEVPOST.md).

```
Pi Camera ─► YOLO detect + ByteTrack IDs ─► pick target ─► Kalman prediction ─► stepper pan/tilt
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
  motors.py     sends target angles to the Arduino over serial; mock mode without it
  stream.py     Flask MJPEG stream + /api/status
firmware/       Arduino Uno sketch (AccelStepper → TMC2209)
web/            dashboard (served by the Pi)
hardware/       wiring, BOM, CAD / 3D-print files
scripts/        Pi setup, systemd services, Cloudflare Tunnel
site/           public one-page project showcase (static; see site/README.md)
tests/          pytest suite (pixel math, Kalman, control, serial protocol, Flask API)
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

## Testing
```bash
pip install -r requirements-dev.txt
pytest
```
Covers the pixel-to-angle math, the Kalman predictor, target selection, the control state machine, the Arduino serial protocol (against a fake serial port, no hardware needed), and the Flask API (via Flask's test client). Runs anywhere `requirements.txt` does — no Pi, camera, or Arduino required.

## Performance tips (Pi 5)
- Export the model to NCNN for a big CPU speed-up:
  `yolo export model=yolo11n.pt format=ncnn imgsz=320`, then set `DetectorConfig.model = "yolo11n_ncnn_model"`.
- Keep `imgsz` at 320 and the capture resolution at 640×480 unless you have headroom.

## Troubleshooting
- **Camera not detected:** check the ribbon cable orientation and that it's the 22-pin Pi 5 cable. Test with `rpicam-hello`.
- **`numpy.dtype size changed` when importing picamera2:** pip replaced the system numpy. Run `pip uninstall numpy` inside the venv so it uses the apt version again.

## License
MIT
