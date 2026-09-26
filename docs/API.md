# COOP web API contract

The contract between the Pi backend (`coop/stream.py`, `coop/control.py`) and the dashboard (`web/`). Both sides build against this file. **If you change it, change it here first**, then the code on both sides.

Base URL: `http://<pi>:8000` (or `http://localhost:8000` on the laptop). All JSON. Angles in degrees; +pan = right, +tilt = up. Boxes are `[x1, y1, x2, y2]` in frame pixels.

## Read

### `GET /video`
MJPEG stream (`multipart/x-mixed-replace`) of the camera frame. Use as `<img src="/video">`. The frame is **clean by default**: the dashboard draws boxes, the reticle and the prediction overlay client-side from `/api/status`, so they stay clickable. `python -m coop.main --annotate` burns boxes into the frame for debugging without the dashboard (you'll then see them twice in the dashboard).

### `GET /api/status`
Polled by the dashboard (~300 ms).
```json
{
  "server_time": 1790000000.12,
  "frame_seq": 18234,
  "fps": 14.2,
  "mode": "auto",
  "frame": { "w": 640, "h": 480, "hfov_deg": 63.0, "vfov_deg": 49.0 },
  "target": { "id": 3, "label": "person", "conf": 0.87, "box": [210, 80, 330, 400], "locked": false },
  "detections": [
    { "id": 3, "label": "person", "conf": 0.87, "box": [210, 80, 330, 400] },
    { "id": 7, "label": "car", "conf": 0.66, "box": [400, 250, 620, 380] }
  ],
  "gimbal": {
    "pan": 12.4, "tilt": 0.0,
    "target_pan": 15.0, "target_tilt": 0.0,
    "pan_limits": [-170, 170], "tilt_limits": [0, 0],
    "tilt_enabled": false,
    "mock": true,
    "drivers_enabled": true
  },
  "velocity_deg_s": [8.1, 0.0],
  "estop": false,
  "diag": {
    "cpu_temp_c": 61.3,
    "throttled": 0,
    "fps": 14.2,
    "capture_fps": 30.0,
    "infer_ms": 48.5,
    "latency_ms": 71.0,
    "serial": "connected",
    "uptime_s": 3605.2
  }
}
```
- `mode`: `"auto"` (track automatically) | `"manual"` (operator aims) | `"stop"` (motors hold still)
- `server_time`: stamped per request, so it is always fresh; it does **not** tell you the vision loop is alive. Don't compare it to the client's clock (Pi and phone clocks differ).
- `frame_seq`: increments once per frame the main loop publishes (`SharedState._seq`). The dashboard shows "stale" when it stops advancing for 2 s, timed on the client's own clock. *Added for the connection banner; if absent the dashboard never reports stale.*
- Before the first frame is published the payload is just `{server_time, mode, estop, diag}`; clients must tolerate missing fields.
- **Pan-only build.** Tilt is permanently disabled: `gimbal.tilt`, `gimbal.target_tilt` are always `0`, `gimbal.tilt_limits` is `[0, 0]` and `gimbal.tilt_enabled` is `false`. They stay in the payload so older dashboards keep working. `velocity_deg_s[1]` is still reported (the target's vertical motion within the fixed-tilt frame).
- `estop`: `true` while the emergency stop is engaged (see `POST /api/estop`). Read fresh on every request, like `mode`.
- `gimbal.drivers_enabled`: `false` when the stepper drivers are powered down, either by the e-stop or by the idle timeout in `stop` mode (the motor then turns freely by hand and doesn't heat up). Leaving `stop` mode re-enables them automatically unless the e-stop is engaged.
- `diag`: health readouts. **Every key is always present; a value is `null` when unknown** (e.g. before the first frame, or `cpu_temp_c` on a laptop without `/sys`). Computed fresh on each request except the four pipeline timings, which the vision loop publishes per frame.
  - `cpu_temp_c` (number | null): SoC temperature in °C from `/sys/class/thermal/thermal_zone0/temp`. Pi 5 soft-throttles at 80–85 °C.
  - `throttled` (integer | null): the `vcgencmd get_throttled` bit field as an integer; **`0` means healthy**. Bits: `0x1` under-voltage now, `0x2` ARM frequency capped now, `0x4` throttled now, `0x8` soft temperature limit now; the same four shifted by 16 (`0x10000`…`0x80000`) mean "has happened since boot". Show it as hex (`0x50005`).
  - `fps` (number | null): vision-loop frames processed per second (same value as top-level `fps`).
  - `capture_fps` (number | null): frames per second the camera delivers. When it's well above `fps`, inference is the bottleneck and stale frames are being dropped (always the newest frame is processed).
  - `infer_ms` (number | null): YOLO + tracker time per frame, smoothed.
  - `latency_ms` (number | null): from the moment the frame was captured until its status/JPEG was published, smoothed. The motor command for that frame is sent just before publishing, so this is the camera-to-command latency; `tracking.lead_time_s` should roughly cover it plus the motors' own lag.
  - `serial`: `"connected"` (talking to the Uno), `"reconnecting"` (motors enabled but the Uno isn't connected: unplugged, resetting, or never found) or `"mock"` (motors disabled with `--no-motors`, simulated motion).
  - `uptime_s` (number): seconds since COOP started (not since the Pi booted), so a jump back to ~0 means the service restarted.
- `target`: `null` when nothing is being tracked. `locked: true` when the operator picked it through `POST /api/target`.
- `frame.hfov_deg` / `frame.vfov_deg`: field of view of the frame actually served on `/video` (in virtual-gimbal mode that's the crop, which `coop/sim.py` sizes to the camera FOV). Used by the prediction overlay; the dashboard assumes 63 × 49 if absent.
- `gimbal.target_pan` / `target_tilt`: the angle the gimbal is being driven to. In `auto` with a target this is the Kalman predictor's **lead aim** (`θ + θ̇·t_lead`), so it sits ahead of the target in its direction of travel.
- `velocity_deg_s`: the target's estimated `[pan, tilt]` angular velocity in world angles (not frame pixels), so the camera's own rotation isn't counted.

**Prediction overlay (computed client-side from the fields above).** The dashboard projects any world angle `(p, t)` into the current frame with the same pinhole model as `coop/main.py`:
`x = w/2 + (w/2)·tan(p − gimbal.pan) / tan(hfov/2)`, `y = h/2 − (h/2)·tan(t − gimbal.tilt) / tan(vfov/2)`.
It uses this for the predicted aim point (`target_pan/tilt`), its fading trail (stored as world angles and re-projected every frame, so it doesn't smear when the camera turns), and the velocity arrow (`velocity_deg_s` scaled by the local px-per-degree at the target's position).

### `GET /api/events?since=<seq>`
Recent event log, newest last. `since` returns only events with `seq > since`.
```json
{ "events": [ { "seq": 41, "t": 1790000000.1, "type": "target_acquired", "id": 3, "label": "person" } ] }
```
Event types: `target_acquired`, `target_lost`, `mode_changed`, `motor_connected`, `motor_disconnected`, plus:
- `estop`: the e-stop was engaged.
- `armed`: the e-stop was released (`POST /api/arm`).
- `zeroed`: the current position became pan 0 (`POST /api/zero`).
- `motors_idle`: drivers powered down after `motors.idle_disable_s` seconds in `stop` mode. Extra field `after_s`.
- `settings_changed`: live settings changed and/or were saved. Extra fields `changed` (object of the values this request changed; `{}` for a bare save) and `saved` (bool).

## Control
All return `{"ok": true, ...}`, or `{"ok": false, "error": "..."}` with HTTP 400.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/mode` | `{"mode": "auto" \| "manual" \| "stop"}` | Switch mode. `stop` also halts the motors. Entering `manual` holds the camera where it currently points (the manual setpoint starts at the current pan). |
| `POST /api/target` | `{"id": 7}` or `{"id": null}` | Lock onto a track ID (switches to `auto`), or clear the lock. |
| `POST /api/aim` | `{"pan": 20.0}` | Absolute aim. Only in `manual`. A `tilt` field is accepted and ignored (pan-only). |
| `POST /api/nudge` | `{"dpan": -5.0}` | Relative aim. Only in `manual`. A `dtilt` field is accepted and ignored. |
| `POST /api/home` | `{}` | Aim at pan 0 (switches to `manual`). |
| `POST /api/estop` | `{}` | **Emergency stop.** Sends `S` (decelerate) immediately, then powers the drivers down (`E 0`) as soon as the reported position has been still for 0.25 s, or at the latest after the worst-case braking time (`max_steps_per_sec / accel_steps_per_sec2 + 0.3` s, about 0.6 s at defaults). Cutting power mid-ramp would make the Uno's step count drift from the real position. `gimbal.drivers_enabled` turns `false` at that point. Mode → `stop`, target lock cleared, `estop: true`. Idempotent. |
| `POST /api/arm` | `{}` | Release the e-stop: drivers back on (`E 1`), `estop: false`. Mode **stays `stop`**: the operator picks a mode explicitly afterwards. No-op if not engaged. |
| `POST /api/zero` | `{}` | "Set zero here": the current physical position becomes pan 0 (`Z` to the Uno). Clears the target lock. Unless the e-stop is engaged, mode → `manual` aimed at 0, so nothing moves. Allowed during e-stop (power down, turn the camera by hand to face forward, zero, arm). |

**While the e-stop is engaged**, requests that would move the camera fail with HTTP 400 and `"error": "e-stop engaged; POST /api/arm first"`: `/api/mode` with `auto` or `manual`, `/api/target` with a non-null id, and `/api/home`. (`/api/aim` and `/api/nudge` already require `manual`.) `/api/mode` `stop`, `/api/target` `null`, `/api/zero` and `/api/settings` still work.

## Live settings

### `GET /api/settings`
```json
{
  "settings": {
    "lead_time_s": 0.15,
    "deadband_deg": 1.0,
    "conf": 0.4,
    "max_steps_per_sec": 2000.0,
    "accel_steps_per_sec2": 6000.0,
    "pan_invert": false
  },
  "ranges": {
    "lead_time_s": [0.0, 1.0],
    "deadband_deg": [0.0, 10.0],
    "conf": [0.05, 0.95],
    "max_steps_per_sec": [50.0, 4000.0],
    "accel_steps_per_sec2": [100.0, 50000.0]
  },
  "steps_per_deg": 4.444,
  "file": "/home/pi/coop/coop.toml"
}
```
- `lead_time_s`: how far ahead (s) the Kalman predictor aims. `deadband_deg`: aim changes smaller than this are ignored. `conf`: YOLO confidence threshold. `max_steps_per_sec` / `accel_steps_per_sec2`: motor speed and acceleration in **microsteps** (divide by `steps_per_deg` for °/s and °/s²). `pan_invert`: flip the pan direction if the motor turns the wrong way.
- `ranges`: inclusive `[min, max]` for each numeric setting (use them for slider bounds).
- `file`: the settings file `save` writes to.

### `POST /api/settings`
Body: any subset of the `settings` keys, plus optional `"save": true`.
```json
{ "lead_time_s": 0.2, "pan_invert": true, "save": true }
```
Returns `{"ok": true, "settings": {...all current values...}, "saved": true}`. Applied immediately, no restart: speed and acceleration are re-sent to the Uno at once. With `"save": true`, **all six live settings** (their values after this request) are written to `coop.toml`, so they survive a restart; other settings and the comments in the file are kept. So `{"save": true}` on its own means "persist what's live now", e.g. after earlier applies. Without it, changes last until COOP restarts.

Validation is all-or-nothing: if any key is unknown, has the wrong type (numbers must be JSON numbers, `pan_invert` a JSON boolean) or is out of range, nothing is applied and the response is HTTP 400 with `"error"`. **`pan_invert` can only change in `stop` mode** (flipping it reverses what every angle means, so changing it while aiming would swing the camera).
