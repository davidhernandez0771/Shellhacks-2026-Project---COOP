# First hardware bring-up checklist

Work through this top to bottom on the real Pi 5, camera, Uno, TMC2209s and motors. Each step has a checkbox and the result to expect; if you get something else, stop and write it in the findings log at the bottom before moving on. Commands run on the Pi from the repo root unless marked **laptop**.

**Status as of 2026-09-26: nothing below has run on real hardware yet.** Every step is tagged **`[never run]`**. When a step passes on the real thing, change its tag to **`[ok YYYY-MM-DD]`** in the same commit as any fix it needed.

What *has* been verified, off hardware only:
- The pytest suite (pixel→angle math, Kalman, target choice, `Control`, the serial protocol and reconnects against a fake port, the Flask API, and a startup smoke test that runs one real `main()` iteration with a fake camera and detector), on Windows with only the minimal CI dependencies installed. The GitHub Actions workflow itself hasn't run yet, because it hasn't been pushed.
- The `Gimbal` class in mock mode and with a nonexistent port (it falls back to mock and keeps retrying).
- Nothing has touched the Pi camera, a real serial port, the firmware (never even compiled: there's no `arduino-cli` on the dev machine), systemd, or Cloudflare.

**Safety rules for the whole session**
- Set each TMC2209's current limit (Vref) **before** connecting a motor, and never plug or unplug a motor while the drivers have 12 V (see `hardware/README.md`).
- Do the first motor tests **without the camera mounted** and with the pan axis free to spin, so a wrong direction or a runaway can't wrap cables.
- Keep a hand on the 12 V switch during every closed-loop test. The dashboard's **Stop** and killing COOP also work: the Uno's watchdog stops the motors 2 s after the Pi goes quiet.

---

## 0. Prerequisites

- [ ] **The Pi has a commit that includes the startup fix and the reconnect fix.** `[never run]`
  Before `90f7811`, `coop/main.py` called `serve_in_background` with the wrong arguments and crashed at startup. `tests/test_smoke.py` now runs one real `main()` loop iteration, so CI catches that kind of break. The reconnect fix needs the firmware re-flashed too (section 4); it adds `Z <pan> <tilt>`.
  **Expect:** `git log` on the Pi includes `90f7811` and the "Fix serial reconnect" commit.
- [ ] **CI is green on the commit you're testing.** `[never run]` **Expect:** the `tests` workflow passes on GitHub for that commit.
- [ ] **Bring:** a multimeter, a small screwdriver for the Vref pots, a phone on mobile data (for the tunnel test), and tape to mark 0° / ±90° on the base. `[never run]`

## 1. Power

- [ ] **Buck converter set to 5.1 V** with the multimeter, before the Pi is connected. `[never run]` **Expect:** 5.05–5.15 V with no load.
- [ ] **Pi boots from the 12 V supply through the buck.** `[never run]`
  **Expect:** it boots. A "power supply" notice about USB current is expected and harmless (see `hardware/README.md`).
- [ ] **No undervoltage under load.** Run `vcgencmd get_throttled` after section 8's FPS run. `[never run]` **Expect:** `throttled=0x0`.

## 2. Pi software

- [ ] **Clone and set up:** `bash scripts/setup_pi.sh`, then log out and back in (the script adds you to `dialout` for the serial port). `[never run]`
  **Expect:** the script ends with `imports OK`, and `groups` now lists `dialout`.
- [ ] **Download the model once, while online.** `yolo11n.pt` is gitignored, so the first run downloads it. `[never run]`
  Run `source .venv/bin/activate && python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"`.
  **Expect:** `yolo11n.pt` (≈5.4 MB) appears in the repo root. After this, COOP starts without internet access.

## 3. Camera

- [ ] **Camera detected:** `rpicam-hello --list-cameras`. `[never run]`
  **Expect:** one camera listed as `ov5647`.
  If there's none, check the 22-pin end is in a Pi 5 CAM port with the contacts facing the right way. If auto-detect still fails, add `dtoverlay=ov5647,cam0` (or `cam1`, depending on the port) to `/boot/firmware/config.txt` and reboot.
- [ ] **Live preview:** `rpicam-hello -t 5000` (needs a monitor), or `rpicam-still -o test.jpg` and copy the file to the laptop. `[never run]` **Expect:** a sharp, correctly exposed image.
- [ ] **COOP uses the Pi camera:** `python -m coop.main --source picamera --no-motors`, then open `http://<pi>.local:8000` on the laptop. `[never run]`
  **Expect:**
  - The log says `Using Pi camera at 640x480`.
  - Skin tones look normal, not blue. If they're blue, the red/blue channels are swapped; see the `RGB888` comment in `coop/camera.py`.
- [ ] **Orientation matches the world.** Hold up text, and stand on the camera's right. `[never run]`
  **Expect:**
  - The text reads normally (not mirrored or upside down).
  - Something on the camera's right appears on the right of the frame.
  If not, **stop here**: a flipped image inverts the pan/tilt signs and tracking will run away. The fix goes in lane 1's `camera.py` (a Picamera2 `Transform`) or in how the camera is mounted.
- [ ] **People get detected:** walk into view. `[never run]` **Expect:** a `person` box with a track ID follows you on the dashboard, and `/api/status` shows `"mock": true`.

## 4. Flash the Uno and check the serial link

- [ ] **Compile and upload** `firmware/coop_motors/coop_motors.ino` from the Arduino IDE (board: Arduino Uno; library: AccelStepper). Drivers powered off for now. `[never run]`
  **Expect:** it compiles with no errors (this sketch has never been compiled) and uploads.
- [ ] **Firmware talks.** Open the Serial Monitor at 115200 baud with the line ending set to "Newline". `[never run]`
  **Expect:** `READY`, then `P 0 0` every 50 ms. Send `Z 400 0` → the reports change to `P 400 0` and nothing moves. Send `Z` → back to `P 0 0`.
- [ ] **The Pi sees the Uno:** plug it into the Pi, then run `ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null` and `python -c "from coop.motors import find_arduino_port as f; print(f())"`. `[never run]`
  **Expect:** `/dev/ttyACM0`, or `/dev/ttyUSB0` on a CH340 clone. If the helper prints `None`, check the board's USB vendor ID with `lsusb` and add it to `ARDUINO_USB_VIDS` in `coop/motors.py`.
- [ ] **Python handshake:** `python -m coop.main --source picamera` with the motor drivers still unpowered. `[never run]`
  **Expect:**
  - The log says `Motor controller connected on /dev/ttyACM0`.
  - The dashboard shows the motors as live (`"mock": false` in `/api/status`).
  - `/api/events` has a `motor_connected` event.
  There should be no `retrying` warnings.

## 5. Motors, one axis at a time (camera NOT mounted)

The pan axis uses 200 steps × 8 microsteps = **1600 microsteps per motor turn**, times `pan_gear_ratio`. The Serial Monitor tests below talk to the Uno directly, so close COOP first; only one program can hold the port.

- [ ] **Vref set** on each driver for about 0.8–1.0 A RMS (the formula depends on the module), with no motor connected. `[never run]` **Expect:** the measured Vref matches your calculated target.
- [ ] **Holding torque:** connect the motor with power off, power the drivers, then send `E 1`. `[never run]`
  **Expect:** the shaft resists turning by hand, with no buzzing or getting hot within a minute.
- [ ] **Direction:** send `T 400 0` (+90° at a 1:1 gear ratio). `[never run]`
  **Expect:** looking the way the camera will look, the pan axis turns **right** (clockwise seen from above), because +pan = right.
  If it turns left, power off and swap one coil pair (A1↔A2). Or tell lane 3 to invert DIR in the firmware (`pan.setPinsInverted(true)`).
  Then send `T 0 0`. **Expect:** it returns to the tape mark.
- [ ] **Scale:** send `T 400 0`. `[never run]`
  **Expect:** exactly 90° of camera rotation. If it's 45° or 180°, the MS1/MS2 wiring doesn't match `MotorConfig.microsteps`, or `pan_gear_ratio` is wrong.
- [ ] **Watchdog:** send `T 16000 0` (10 turns), then send nothing more. `[never run]`
  **Expect:** it decelerates to a stop about 2 s after the command. Then send `T 0 0`.
- [ ] **Tilt** (only if `tilt_enabled`): repeat direction and scale with `T 0 400`. `[never run]` **Expect:** + turns the camera **up**.
- [ ] **Motion from Python:** mount nothing yet. Start `python -m coop.main --source picamera`, switch the dashboard to **Manual**, and aim to 90, −90, then Home. `[never run]`
  **Expect:**
  - The axis goes to the tape marks.
  - The dashboard's pan reading tracks the real angle.
  - Switching to **Stop** mid-move halts it.

## 6. Limits and cables (camera mounted)

- [ ] **Soft limits:** in Manual, aim to 170, then −170. `[never run]`
  **Expect:**
  - The axis stops at ±170°. Asking for 200 still stops at 170: both `Control` and `Gimbal` clamp.
  - The camera ribbon and wiring have slack at both ends, with no pulling or rubbing. If not, narrow `MotorConfig.pan_limits_deg` (lane 1's `coop/config.py`).
- [ ] **Power-on position is 0°.** Stop COOP, turn the camera to face forward by hand with the drivers off, then start COOP. `[never run]`
  **Expect:** 0° points forward. There's no homing switch, so this is how the zero gets set.

## 7. First closed-loop tracking

For this test only, edit `coop/config.py` on the Pi (don't commit): `pan_limits_deg = (-45.0, 45.0)` and `max_steps_per_sec = 800.0`.

- [ ] **Auto mode follows a slow walker.** Walk slowly across the room. `[never run]`
  **Expect:**
  - The camera turns *toward* you and keeps you near the center.
  - The dashboard gets a `target_acquired` event.
  If it swings *away* from you to a limit, that's a sign error (section 3 orientation or section 5 direction): hit Stop.
- [ ] **No oscillation when you stand still.** `[never run]`
  **Expect:** the camera settles; it doesn't hunt back and forth. Small jitters should be absorbed by `deadband_deg = 1.0`.
- [ ] **Prediction leads.** Walk at a steady pace. `[never run]`
  **Expect:** you stay roughly centered rather than always trailing behind the center. If it overshoots at direction changes, lower `lead_time_s`.
- [ ] **Lock and loss.** Click a detection box, then walk out of frame. `[never run]`
  **Expect:**
  - The box turns to the accent color (`"locked": true`).
  - After `lost_timeout_s`, the log shows `target_lost` and the lock clears.
- [ ] **Restore full limits and speed**, repeat the walk once. `[never run]` **Expect:** the same behavior at full speed, with no missed steps (it returns exactly to 0 on Home).

## 8. FPS on the Pi

- [ ] **Baseline FPS (PyTorch model):** track a person for 30 s, then read the fps field with `curl -s localhost:8000/api/status | python3 -c "import json,sys; print(json.load(sys.stdin)['fps'])"`. `[never run]`
  **Expect:** there is no measured number yet; record it here. The goal is ≥10 fps at `imgsz=320`.
- [ ] **NCNN export:** run `yolo export model=yolo11n.pt format=ncnn imgsz=320`, set `DetectorConfig.model = "yolo11n_ncnn_model"`, and measure again. `[never run]` **Expect:** clearly higher fps than the baseline. Record both.
- [ ] **Thermals after 10 minutes of tracking:** `vcgencmd measure_temp; vcgencmd get_throttled`. `[never run]` **Expect:** below about 80 °C with the active cooler, and `throttled=0x0`.

## 9. Resilience

- [ ] **Watchdog on crash:** in Manual, start a long move, then `pkill -f coop.main`. `[never run]` **Expect:** the motors stop within about 2 s.
- [ ] **USB unplug and replug of the Uno while COOP runs.** Do this in Manual after **Home**, with the gimbal at 0°. `[never run]`
  **Expect:**
  - On unplug: `Motor link lost` in the log, `motor_disconnected` in the event log, and the dashboard shows mock motors.
  - On replug: `motor_connected` within about 3–8 s, and the motors respond again.
- [ ] **Position survives a reconnect** (the reconnect fix). Do this only after the previous step passes. `[never run]`
  In Manual, aim to 45° and wait until it arrives. Unplug the Uno's USB, wait 5 s, and plug it back in.
  **Expect:**
  - While unplugged, the dashboard's pan stays at 45°; it doesn't drift.
  - After reconnecting, it still reads 45°, and the axis doesn't move.
  - Aim to 0°: the camera returns to the forward tape mark, which proves the Uno's counter was restored.
  **Before the fix**, the dashboard read 0° after reconnecting and the next move overshot by 45°. If you see that, the Uno is running old firmware: bare `Z` ignores the position arguments. Keep a hand on the power switch for this test.
  - Covered in software by `tests/test_reconnect.py`.

## 10. systemd service

- [ ] **Install:** `sudo bash scripts/install_service.sh`. `[never run]`
  **Expect:** `systemctl status coop` shows `active (running)`, and `journalctl -u coop -f` shows the same startup lines as a manual run (camera, motor controller connected).
- [ ] **Starts on boot:** `sudo reboot`, then open the dashboard from the laptop without logging in to the Pi. `[never run]` **Expect:** the dashboard is live within about 60 s of power-on.
- [ ] **Restarts after a crash:** `sudo systemctl kill -s SIGKILL coop`. `[never run]` **Expect:** it's back to `active (running)` within about 3 s, and the motors stop in the gap (watchdog).
- [ ] **Cold start from the 12 V switch** (the demo-day scenario): flip power off and on. `[never run]` **Expect:** everything comes back on its own with no laptop involved, including the tunnel once section 11 is done.

## 11. Cloudflare Tunnel and Access

Follow `scripts/setup_tunnel.md`. DNS must already be on Cloudflare and the Access app created (steps 1–2) before the installer runs.

- [ ] **Install the tunnel:** `bash scripts/install_tunnel.sh coop-live.example.com` (your domain). `[never run]`
  **Expect:**
  - cloudflared installs as arm64.
  - `ingress validate` passes.
  - The final check prints `OK: unauthenticated requests get HTTP 302`.
  - `journalctl -u coop-tunnel` shows 4× `Registered tunnel connection`.
- [ ] **Blocked without a login:** from the laptop, `curl -s -o /dev/null -w "%{http_code}" https://coop-live.example.com/video`. `[never run]` **Expect:** `302`, never `200`.
- [ ] **Unapproved email is refused:** on the login page, try an address that isn't in the policy. `[never run]` **Expect:** no one-time PIN arrives, or access is denied.
- [ ] **Approved email gets in, from a phone on mobile data** (not the venue Wi-Fi). `[never run]`
  **Expect:**
  - The dashboard loads over HTTPS.
  - `/video` plays smoothly, with the frame rate close to what the LAN shows.
  - Mode switches and D-pad nudges work, and the motors respond.
- [ ] **Stream is unbuffered:** in DevTools → Network, open `/video`. `[never run]` **Expect:** one long-running request whose transferred size grows steadily; no stall and no 524 error after 100 s.
- [ ] **Survives a reboot:** after section 10's reboot, `systemctl status coop-tunnel`. `[never run]` **Expect:** `active (running)`, and the public URL works again with no manual steps.

---

## Findings log

| Date | Step | What happened | Fix / commit |
|---|---|---|---|
| | | | |
