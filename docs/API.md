# COOPER web API contract

The contract between the Pi backend (`cooper/stream.py`, `cooper/settings.py`) and the dashboard (`web/`). Both sides build against this file. **If you change it, change it here first**, then the code on both sides.

Base URL: `http://<pi>:8000` (or `http://localhost:8000` on the laptop). All JSON. Boxes are `[x1, y1, x2, y2]` and points `[u, v]` in frame pixels, origin top-left. The lane is in **normalized** frame coordinates (0..1), so it survives a resolution change.

## Read

### `GET /video`
MJPEG stream (`multipart/x-mixed-replace`) of the camera frame. Use as `<img src="/video">`. The frame is **clean by default**: the dashboard draws the boxes, predicted paths and lane client-side from `/api/status`. `python -m cooper.main --annotate` burns boxes into the frame for debugging without the dashboard.

### `GET /api/status`
Polled by the dashboard (~300 ms).
```json
{
  "server_time": 1790000000.12,
  "frame_seq": 18234,
  "fps": 14.2,
  "frame": { "w": 640, "h": 480 },
  "objects": [
    {
      "id": 201, "label": "car", "conf": 0.9, "box": [412, 230, 506, 308],
      "level": "warning", "kind": "path",
      "reason": "car #201 heading into your lane in 0.8 s",
      "path": [[455.1, 308.0], [448.9, 308.0], "... 15 points ..."],
      "velocity": [-61.8, 0.4],
      "ttc_s": null,
      "time_to_lane_s": 0.8
    }
  ],
  "risk": { "level": "warning", "reason": "car #201 heading into your lane in 0.8 s" },
  "leds": { "yellow": true, "red": false, "mode": "mock" },
  "lane": [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]],
  "diag": {
    "cpu_temp_c": 61.3,
    "throttled": 0,
    "fps": 14.2,
    "capture_fps": 30.0,
    "infer_ms": 48.5,
    "latency_ms": 71.0,
    "leds": "gpio",
    "uptime_s": 3605.2
  }
}
```
- Before the first frame is published the payload is just `{server_time, diag}`; clients must tolerate missing fields.
- `server_time`: stamped per request, so it is always fresh; it does **not** tell you the vision loop is alive. Don't compare it to the client's clock (Pi and phone clocks differ).
- `frame_seq`: increments once per frame the main loop publishes. The dashboard shows "stale" when it stops advancing for 2 s, timed on the client's own clock.
- `objects`: every object ByteTrack has given an ID this frame (unconfirmed detections have no ID and are left out). Detected classes: person, car, motorcycle, bus, truck.
  - `level`: `"clear"`, `"warning"` or `"danger"`, this object on this frame, before hysteresis.
  - `kind`: which rule set the level: `"in_lane"` (danger: its bottom edge is in the lane now), `"path"` (warning: its predicted path enters the lane), `"ttc"` (warning: short time to contact inside the lane's corridor), or `null`.
  - `reason`: human-readable, `""` when clear.
  - `path`: the predicted **bottom-centre** (where it meets the road), every `step_s` (0.1 s) out to `horizon_s` (1.5 s): 15 points by default. The first point is 0.1 s ahead, not now.
  - `velocity`: `[u', v']` of the bottom-centre in px/s, from the object's Kalman filter.
  - `ttc_s`: time to contact from the box's scale growth, `h / h'`, in seconds, or `null` when the box isn't growing significantly. Present whatever the object's level.
  - `time_to_lane_s`: seconds until the predicted path enters the lane (`kind: "path"` only), else `null`.
- `risk`: what the LEDs show, **after** hysteresis: a level lights after `enter_frames` (2) frames in a row and stays `hold_s` (0.5 s) after its condition ends. `reason` is that of the object that set it (the nearest for danger, the soonest for warning). docs/MATH.md has the rules.
- `leds`: the LED state. Only one is ever lit (red overrides yellow). `mode` is `"gpio"` (real LEDs on the Pi) or `"mock"` (anywhere else, or `--no-leds`).
- `lane`: "my lane", the four corners top-left, top-right, bottom-right, bottom-left, normalized. Change it with `POST /api/lane`.
- `diag`: health readouts. **Every key is always present; a value is `null` when unknown** (e.g. before the first frame, or `cpu_temp_c` on a laptop without `/sys`). Computed fresh on each request except the four pipeline timings, which the vision loop publishes per frame.
  - `cpu_temp_c` (number | null): SoC temperature in °C from `/sys/class/thermal/thermal_zone0/temp`. Pi 5 soft-throttles at 80–85 °C.
  - `throttled` (integer | null): the `vcgencmd get_throttled` bit field as an integer; **`0` means healthy**. Bits: `0x1` under-voltage now, `0x2` ARM frequency capped now, `0x4` throttled now, `0x8` soft temperature limit now; the same four shifted by 16 (`0x10000`…`0x80000`) mean "has happened since boot". Show it as hex (`0x50005`).
  - `fps` (number | null): vision-loop frames processed per second (same value as top-level `fps`): 1 / the moving average of the interval between processed frames' capture times.
  - `capture_fps` (number | null): frames per second the camera delivers. When it's well above `fps`, inference is the bottleneck and stale frames are being dropped (always the newest frame is processed).
  - `infer_ms` (number | null): YOLO + tracker time per frame, smoothed.
  - `latency_ms` (number | null): from the moment the frame was captured until its status/JPEG was published, smoothed. The LEDs are set just before publishing, so this is the camera-to-LED latency.
  - `leds` (`"gpio"` | `"mock"` | null): how the LEDs are driven (same as `leds.mode`).
  - `uptime_s` (number): seconds since COOPER started (not since the Pi booted), so a jump back to ~0 means the service restarted.

### `GET /api/events?since=<seq>`
Recent event log (the last 200), newest last. `since` returns only events with `seq > since`.
```json
{ "events": [ { "seq": 41, "t": 1790000000.1, "type": "risk_changed", "level": "danger", "reason": "car #201 in your lane" } ] }
```
Event types:
- `risk_changed`: the LED level changed. Extra fields `level` and `reason` (`""` when clear).
- `lane_changed`: the lane was changed and/or saved. Extra fields `lane` (the four corners) and `saved` (bool).
- `settings_changed`: live settings changed and/or were saved. Extra fields `changed` (object of the values this request changed; `{}` for a bare save) and `saved` (bool).

## Control
All return `{"ok": true, ...}`, or `{"ok": false, "error": "..."}` with HTTP 400 (HTTP 404 if the server runs without live settings). Validation is all-or-nothing: on an error nothing is applied or saved.

### `POST /api/lane`
Body: `{"lane": [[x, y], [x, y], [x, y], [x, y]], "save": false}`: corners top-left, top-right, bottom-right, bottom-left, each 0..1. The top edge must be above the bottom edge and each left corner left of its right corner. Applied on the next frame. With `"save": true` it's also written to `cooper.toml` (`[risk] lane`), so it survives a restart.

Returns `{"ok": true, "lane": [...], "saved": false}`.

## Live settings

### `GET /api/settings`
```json
{
  "settings": { "conf": 0.4, "horizon_s": 1.5, "ttc_warn_s": 2.0, "ttc_clear_s": 2.5, "hold_s": 0.5 },
  "ranges": {
    "conf": [0.05, 0.95],
    "horizon_s": [0.1, 5.0],
    "ttc_warn_s": [0.1, 10.0],
    "ttc_clear_s": [0.1, 10.0],
    "hold_s": [0.0, 5.0]
  },
  "lane": [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]],
  "lane_default": [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]],
  "file": "/home/pi/cooper/cooper.toml"
}
```
- `conf`: YOLO confidence threshold. `horizon_s`: how far ahead each path is predicted. `ttc_warn_s` / `ttc_clear_s`: a time to contact below `ttc_warn_s` starts a warning, which ends only above `ttc_clear_s`. `hold_s`: how long a level stays lit after its condition ends.
- `ranges`: inclusive `[min, max]` for each setting (use them for slider bounds).
- `lane` / `lane_default`: the current lane and the built-in one (for a "reset" button).
- `file`: the settings file `save` writes to.

### `POST /api/settings`
Body: any subset of the `settings` keys (JSON numbers), plus optional `"save": true`.
```json
{ "horizon_s": 2.0, "save": true }
```
Returns `{"ok": true, "settings": {...all current values...}, "saved": true}`. Applied on the next frame, no restart. With `"save": true`, **all five live settings** (their values after this request) are written to `cooper.toml`; other settings and the comments in the file are kept. So `{"save": true}` on its own means "persist what's live now". Without it, changes last until COOPER restarts.

Rules between settings are checked on the result: `ttc_warn_s` must stay below `ttc_clear_s` (change both in one request to move the pair past each other).
