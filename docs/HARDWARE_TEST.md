# First hardware bring-up checklist

Work through this top to bottom on the real Pi 5, camera, Uno, TMC2209 and motor. Each step has a checkbox and the result to expect; if you get something else, stop and write it in the findings log at the bottom before moving on. Commands run on the Pi from the repo root (with `source .venv/bin/activate`) unless marked **laptop**.

**The order is deliberate: emulator → jog → camera check → FPS bench → full run.** Each stage only adds one new thing that can go wrong.

**Status as of 2026-09-26: nothing below has run on real hardware yet.** Every step is tagged **`[never run]`**. When a step passes on the real thing, change its tag to **`[ok YYYY-MM-DD]`** in the same commit as any fix it needed.

What *has* been verified, off hardware only:
- The pytest suite: pixel→angle math, Kalman, target choice, `Control` (including e-stop/arm/zero), the settings file, the Flask API, diagnostics, the capture thread, the serial protocol against a line-recording fake port, the real `Gimbal` against `tools/fake_uno.py` (a real-time emulator of the firmware that tracks the step counter and the physical shaft separately), and the **whole app** against the emulator with a synthetic camera (`tests/test_app_e2e.py`: tracking, manual, e-stop, zero, arm, live settings, unplug/replug). It runs with only the minimal CI dependencies.
- `python -m tools.jog` driven through a real terminal against the emulator; `python -m tools.rehearsal` serving the dashboard.
- The firmware **compiles** for the Uno (2026-09-26, avr-gcc 7.3 with the Arduino AVR core 1.8.6 and AccelStepper 1.64, `-Wall -Wextra`: no warnings; 10,882 bytes flash = 33%, 451 bytes RAM = 22%). It has never been flashed or run.
- Nothing has touched the Pi camera, a real serial port, systemd, or Cloudflare.

**The build is pan-only.** The firmware still has a tilt axis in its protocol; the Pi always sends `0` for it. Nothing needs to be connected to the Y/tilt driver.

**Safety rules for the whole session**
- Set the TMC2209's current limit (Vref) **before** connecting the motor, and never plug or unplug a motor while the driver has 12 V (see `hardware/README.md`).
- Do the first motor tests **without the camera mounted** and with the pan axis free to spin, so a wrong direction or a runaway can't wrap cables.
- Keep a hand on the 12 V switch during every closed-loop test. Also available: the dashboard's **E-STOP** (`curl -X POST localhost:8000/api/estop`), `e` in `tools.jog`, and killing COOP (the Uno's watchdog stops the motor 2 s after the Pi goes quiet).
- **Opening the serial port resets the Uno, and the Uno counts from 0 wherever the shaft is.** Every time you start COOP or `tools.jog`, the camera's current direction becomes 0°. Point it forward first (or jog it forward and press `z` / `POST /api/zero`).

---

## 0. Prerequisites

- [ ] **The Pi has a commit that includes the `cloud/hardware-ready` work** (or later). `[never run]`
  **Expect:** `ls tools/` shows `fake_uno.py jog.py camera_check.py bench_fps.py rehearsal.py`, and `coop.example.toml` exists.
- [ ] **CI is green on the commit you're testing.** `[never run]` **Expect:** the `tests` workflow passes on GitHub for that commit.
- [ ] **Bring:** a multimeter, a small screwdriver for the Vref pot, a phone on mobile data (for the tunnel test), and tape to mark 0° / ±90° on the base. `[never run]`

## 1. Emulator rehearsal (laptop or Pi, no hardware)

This proves the software end to end before anything can spin.

- [ ] **Tests:** `pytest -q`. `[never run]` **Expect:** all pass (about 280 tests, ~35 s).
- [ ] **Full app on a fake Uno:** `python -m tools.rehearsal`, then open `http://localhost:8000`. `[never run]`
  **Expect:**
  - The log says `Motor controller connected on socket://127.0.0.1:…`; the dashboard shows the motor live (`diag.serial: "connected"` in `/api/status`).
  - A `person` box appears and the view follows it: the walker stays near the centre as it sweeps ±25°.
  - **E-STOP** stops it and `gimbal.drivers_enabled` goes `false` about ½ s later; Auto is refused until you **arm** (`curl -X POST localhost:8000/api/arm`).
- [ ] **What a wrong motor direction looks like:** `python -m tools.rehearsal --invert`. `[never run]`
  **Expect:** the camera runs *away* from the walker to a limit. Hit E-STOP. That's the signature to recognise in section 7.
- [ ] **Jog against the emulator:** terminal 1 `python -m tools.fake_uno --port 5555`; terminal 2 `python -m tools.jog --port socket://localhost:5555`. `[never run]`
  **Expect:** →/← move the target, the emulator's status line shows `pan counter` and `rotor` following; `e` shows `drivers OFF`.

## 2. Power

- [ ] **Buck converter set to 5.1 V** with the multimeter, before the Pi is connected. `[never run]` **Expect:** 5.05–5.15 V with no load.
- [ ] **Pi boots from the 12 V supply through the buck.** `[never run]`
  **Expect:** it boots. A "power supply" notice about USB current is expected and harmless (see `hardware/README.md`).

## 3. Pi software

- [ ] **Clone and set up:** `bash scripts/setup_pi.sh`, then log out and back in (the script adds you to `dialout` for the serial port). `[never run]`
  **Expect:** the script ends with `imports OK`, and `groups` now lists `dialout`.
- [ ] **Download the model once, while online.** `yolo11n.pt` is gitignored, so the first run downloads it. `[never run]`
  Run `python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"`.
  **Expect:** `yolo11n.pt` (≈5.4 MB) appears in the repo root. After this, COOP starts without internet access.
- [ ] **Settings file:** `cp coop.example.toml coop.toml`. Delete the lines you won't change; keep `[motors]` `microsteps` and `pan_gear_ratio` matching the real build. `[never run]`
  **Expect:** `python -c "from coop.settings import load_config; print(load_config().motors)"` prints your values. A typo fails loudly with the key named.
- [ ] **Diagnostics read the Pi:** `python -c "from coop.diag import read_cpu_temp_c, read_throttled; print(read_cpu_temp_c(), hex(read_throttled()))"`. `[never run]`
  **Expect:** a temperature around 40–60 and `0x0`. (`None` means the path or `vcgencmd` isn't where `coop/diag.py` looks; note it in the log.)

## 4. Flash the Uno, then jog the motor (camera NOT mounted)

The pan axis uses 200 steps × 8 microsteps = **1600 microsteps per motor turn**, times `pan_gear_ratio`. `tools.jog` and the Serial Monitor both hold the port, so close one before using the other, and close both before starting COOP.

- [ ] **Compile and upload** `firmware/coop_motors/coop_motors.ino` from the Arduino IDE (board: Arduino Uno; library: AccelStepper). Driver 12 V off for now. `[never run]`
  **Expect:** it compiles with no errors (it compiled off-hardware; see the top) and uploads.
- [ ] **Firmware talks.** Serial Monitor at 115200 baud, line ending "Newline". `[never run]`
  **Expect:** `READY`, then `P 0 0` every 50 ms. Send `Z 400 0` → the reports change to `P 400 0` and nothing moves. Send `Z` → back to `P 0 0`.
- [ ] **The Pi sees the Uno:** plug it into the Pi, then `ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null` and `python -c "from coop.motors import find_arduino_port as f; print(f())"`. `[never run]`
  **Expect:** `/dev/ttyACM0` (or `/dev/ttyUSB0` on a CH340 clone). If the helper prints `None`, check the board's USB vendor ID with `lsusb` and add it to `ARDUINO_USB_VIDS` in `coop/motors.py`, or set `port` in `coop.toml`.
- [ ] **Vref set** for about 0.8–1.0 A RMS (the formula depends on the module), with no motor connected. `[never run]` **Expect:** the measured Vref matches your calculated target.
- [ ] **Python handshake, drivers still unpowered:** `python -m tools.jog`. `[never run]`
  **Expect:** `Connected on /dev/ttyACM0. 8 microsteps, gear 1:1, 4.444 microsteps/deg, …` and a live status line `[connected]`. `q` to quit.
- [ ] **Holding torque:** power off, connect the motor, power the driver, run `python -m tools.jog`. `[never run]`
  **Expect:** the shaft resists turning by hand, with no buzzing or getting hot within a minute.
Do the next three steps in **one** interactive `python -m tools.jog` session: every new jog run re-opens the port, which resets the Uno and makes wherever the shaft is the new 0.

- [ ] **Direction:** press → twice (+10° at the default 5° step). `[never run]`
  **Expect:** looking the way the camera will look, the pan axis turns **right** (clockwise seen from above), because +pan = right.
  Press `0` to return. If it turned left: quit, set `pan_invert = true` under `[motors]` in `coop.toml` (or swap one coil pair with the power off), hand-turn the shaft back to the tape mark with the driver unpowered, and repeat. **Do not continue until + is right.**
- [ ] **Scale:** press `]` until the step reads 45°, then → twice. `[never run]`
  **Expect:** exactly 90° of rotation, and `0` brings it back to the tape mark. If it's 45° or 180°, the MS1/MS2 wiring doesn't match `microsteps`, or `pan_gear_ratio` is wrong: fix `coop.toml`.
- [ ] **E-stop from jog:** start a long move (step 45°, → three times quickly), press `e` mid-move. `[never run]`
  **Expect:** it decelerates (it doesn't stop dead), then the shaft goes limp (drivers off) within about ½ s. Press `e` again to re-arm, `0` to go home: it returns to the tape mark, which proves the Uno didn't lose count during the e-stop.
- [ ] **Watchdog:** quit jog. In the Serial Monitor send `T 16000 0` (10 turns), then nothing more. `[never run]`
  **Expect:** it decelerates to a stop about 2 s after the command. Then send `T 0 0`.

## 5. Camera check

- [ ] **Camera detected:** `rpicam-hello --list-cameras`. `[never run]`
  **Expect:** one camera listed as `ov5647`.
  If there's none, check the 22-pin end is in a Pi 5 CAM port with the contacts facing the right way. If auto-detect still fails, add `dtoverlay=ov5647,cam0` (or `cam1`, depending on the port) to `/boot/firmware/config.txt` and reboot.
- [ ] **COOP's camera path:** `python -m tools.camera_check --source picamera`, then copy `camera_check.jpg` to the laptop. `[never run]`
  **Expect:**
  - `Resolution: 640x480 (configured 640x480)` and `Delivered: ~30 fps`.
  - Skin tones look normal, not blue. If they're blue, the red/blue channels are swapped; see the `RGB888` comment in `coop/camera.py`.
- [ ] **Orientation matches the world.** Take the still with text held up and something on the camera's right. `[never run]`
  **Expect:** the text reads normally (not mirrored or upside down), and something on the camera's right appears on the right of the image.
  If not, **stop here**: a flipped image inverts the pan sign and tracking will run away. The fix goes in `camera.py` (a Picamera2 `Transform`) or in how the camera is mounted.

## 6. FPS bench

- [ ] **Export NCNN models** (once, online): `python -m tools.bench_fps --export`. `[never run]`
  **Expect:** `yolo11n_imgsz256_ncnn_model/`, `…320…`, `…416…` folders in the repo root.
- [ ] **Benchmark:** `python -m tools.bench_fps`. Paste the printed table into the findings log. `[never run]`
  **Expect:** NCNN clearly faster than PyTorch at each size. The goal is ≥10 fps at 320.
- [ ] **Use the winner:** in `coop.toml` under `[detector]`, set `model = "yolo11n_imgsz320_ncnn_model"` and `imgsz = 320` (an NCNN model must run at its export size). `[never run]`

## 7. Full run

### 7a. First start, camera still NOT mounted

- [ ] **COOP connects:** `python -m coop.main --source picamera`, open `http://<pi>.local:8000`. `[never run]`
  **Expect:**
  - The log says `Using Pi camera at 640x480` and `Motor controller connected on /dev/ttyACM0`; there are no `retrying` warnings.
  - `curl -s localhost:8000/api/status | python3 -m json.tool` shows `"estop": false`, `gimbal.mock: false`, and `diag` with `serial: "connected"`, a `cpu_temp_c`, `throttled: 0`, and `latency_ms`.
- [ ] **Manual moves:** switch the dashboard to **Manual**, aim to 90, −90, then Home. `[never run]`
  **Expect:** the axis goes to the tape marks, the dashboard's pan reading tracks the real angle, and switching to **Stop** mid-move halts it.
- [ ] **Idle power-down:** leave it in **Stop** for `idle_disable_s` (20 s default). `[never run]`
  **Expect:** a `motors_idle` event, `gimbal.drivers_enabled: false`, and the shaft turns freely by hand (don't turn it; that loses the position). Switching to Manual re-energises it without moving.

### 7b. Limits and cables (camera mounted)

- [ ] **Soft limits:** in Manual, aim to 170, then −170. `[never run]`
  **Expect:**
  - The axis stops at ±170°. Asking for 200 still stops at 170: both `Control` and `Gimbal` clamp.
  - The camera ribbon and wiring have slack at both ends, with no pulling or rubbing. If not, narrow `pan_limits_deg` in `coop.toml`.
- [ ] **Zero:** point the camera forward by hand with the drivers off (E-STOP), `POST /api/zero`, then arm. `[never run]`
  **Expect:** the dashboard reads 0°, nothing moved, and Home keeps it facing forward.

### 7c. First closed-loop tracking

For this test only, in `coop.toml`: `pan_limits_deg = [-45.0, 45.0]` and `max_steps_per_sec = 800.0`. Restart COOP.

- [ ] **Auto mode follows a slow walker.** Walk slowly across the room. `[never run]`
  **Expect:**
  - The camera turns *toward* you and keeps you near the centre.
  - The dashboard gets a `target_acquired` event.
  If it swings *away* from you to a limit (what `tools.rehearsal --invert` showed): **E-STOP**, then flip `pan_invert` (live: `curl -X POST localhost:8000/api/settings -H 'Content-Type: application/json' -d '{"pan_invert": true}'` while in Stop mode after arming), and re-check section 5's orientation.
- [ ] **No oscillation when you stand still.** `[never run]`
  **Expect:** the camera settles and doesn't hunt. If it does, raise `deadband_deg` live: `-d '{"deadband_deg": 1.5}'`.
- [ ] **Prediction leads.** Walk at a steady pace. `[never run]`
  **Expect:** you stay roughly centred rather than trailing. `lead_time_s` should be about `diag.latency_ms` plus the motor's own lag; tune it live (`-d '{"lead_time_s": 0.2}'`). If it overshoots at direction changes, lower it. Keep good values with `"save": true`.
- [ ] **Lock and loss.** Click a detection box, then walk out of frame. `[never run]`
  **Expect:** the box turns to the accent colour (`"locked": true`); after `lost_timeout_s` the log shows `target_lost` and the lock clears.
- [ ] **Restore full limits and speed** in `coop.toml`, restart, repeat the walk once. `[never run]` **Expect:** the same behaviour at full speed, with no missed steps (it returns exactly to the tape mark on Home).

### 7d. FPS and thermals in the real loop

- [ ] **FPS while tracking:** after 30 s of tracking, `curl -s localhost:8000/api/status | python3 -c "import json,sys; d=json.load(sys.stdin)['diag']; print(d)"`. `[never run]`
  **Expect:** `fps` close to the bench number, `capture_fps` ≈ 30 (if it's much higher than `fps`, inference is the bottleneck and stale frames are being dropped, which is intended), and a `latency_ms` to record here.
- [ ] **Thermals after 10 minutes of tracking:** `diag.cpu_temp_c` and `diag.throttled`. `[never run]` **Expect:** below about 80 °C with the active cooler, and `throttled: 0`. Non-zero: see the bit list in `docs/API.md` (`0x1`/`0x10000` = under-voltage: check the buck).

## 8. Resilience and safety

- [ ] **E-STOP mid-move in the full app:** in Manual, aim 90 → −90 and hit **E-STOP** halfway. `[never run]`
  **Expect:** it brakes, the drivers go off within about ½ s, `estop: true`, and Auto/Manual/Home are refused with `e-stop engaged; POST /api/arm first`. After arming and Home it returns exactly to the tape mark.
- [ ] **Watchdog on crash:** in Manual, start a long move, then `pkill -f coop.main`. `[never run]` **Expect:** the motor stops within about 2 s.
- [ ] **USB unplug and replug of the Uno while COOP runs**, in Manual after **Home** (gimbal at 0°). `[never run]`
  **Expect:**
  - On unplug: `Motor link lost` in the log, `motor_disconnected` in the event log, `diag.serial: "reconnecting"`.
  - On replug: `motor_connected` within about 3–8 s, and the motor responds again.
- [ ] **Position survives a reconnect.** Only after the previous step passes. In Manual, aim to 45° and wait until it arrives. Unplug the Uno's USB, wait 5 s, plug it back in. `[never run]`
  **Expect:**
  - While unplugged, the dashboard's pan stays at 45°; it doesn't drift.
  - After reconnecting it still reads 45°, and the axis doesn't move.
  - Aim to 0°: the camera returns to the forward tape mark.
  If it reads 0° after reconnecting and the next move overshoots by 45°, the Uno is running old firmware (bare `Z` ignores the position arguments). Keep a hand on the power switch.
  - Known limit: an unplug *mid-move* can leave the restored position off by up to `max_steps_per_sec × 50 ms` (the last report's age). Re-zero after one.
- [ ] **Reconnect during an e-stop keeps the drivers off:** E-STOP, unplug and replug the Uno. `[never run]` **Expect:** after `motor_connected`, the shaft is still limp (the Pi re-sent `E 0`; the Uno boots with its drivers on).

## 9. systemd service

- [ ] **Install:** `sudo bash scripts/install_service.sh`. `[never run]`
  **Expect:** `systemctl status coop` shows `active (running)`, and `journalctl -u coop -f` shows the same startup lines as a manual run, including `Settings: /home/…/coop.toml`.
- [ ] **Starts on boot:** `sudo reboot`, then open the dashboard from the laptop without logging in to the Pi. `[never run]` **Expect:** the dashboard is live within about 60 s of power-on.
- [ ] **Restarts after a crash:** `sudo systemctl kill -s SIGKILL coop`. `[never run]` **Expect:** back to `active (running)` within about 3 s, the motor stops in the gap (watchdog), and `diag.uptime_s` restarts from ~0. **Note:** the restart re-opens the port, so the Uno's 0 becomes wherever the camera was. Home before stopping COOP when you can (see the morning report's open decision on this).
- [ ] **Cold start from the 12 V switch** (the demo-day scenario): flip power off and on. `[never run]` **Expect:** everything comes back on its own with no laptop involved, including the tunnel once section 10 is done.

## 10. Cloudflare Tunnel and Access

Follow `scripts/setup_tunnel.md`. DNS must already be on Cloudflare and the Access app created (steps 1–2) before the installer runs.

- [ ] **Install the tunnel:** `bash scripts/install_tunnel.sh coop-live.example.com` (your domain). `[never run]`
  **Expect:**
  - cloudflared installs as arm64.
  - `ingress validate` passes.
  - The final check prints `OK: unauthenticated requests get HTTP 302`.
  - `journalctl -u coop-tunnel` shows 4× `Registered tunnel connection`.
- [ ] **Blocked without a login:** from the laptop, `curl -s -o /dev/null -w "%{http_code}" https://coop-live.example.com/video`. `[never run]` **Expect:** `302`, never `200`. Also try `-X POST …/api/estop`: `302`.
- [ ] **Unapproved email is refused:** on the login page, try an address that isn't in the policy. `[never run]` **Expect:** no one-time PIN arrives, or access is denied.
- [ ] **Approved email gets in, from a phone on mobile data** (not the venue Wi-Fi). `[never run]`
  **Expect:**
  - The dashboard loads over HTTPS.
  - `/video` plays smoothly, with the frame rate close to what the LAN shows.
  - Mode switches, nudges and E-STOP work, and the motor responds.
- [ ] **Stream is unbuffered:** in DevTools → Network, open `/video`. `[never run]` **Expect:** one long-running request whose transferred size grows steadily; no stall and no 524 error after 100 s.
- [ ] **Survives a reboot:** after section 9's reboot, `systemctl status coop-tunnel`. `[never run]` **Expect:** `active (running)`, and the public URL works again with no manual steps.

---

## Findings log

| Date | Step | What happened | Fix / commit |
|---|---|---|---|
| | | | |
