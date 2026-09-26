# COOP web API contract

The contract between the Pi backend (`coop/stream.py`, `coop/control.py`) and the dashboard (`web/`). Both sides build against this file. **If you change it, change it here first**, then the code on both sides.

Base URL: `http://<pi>:8000` (or `http://localhost:8000` on the laptop). All JSON. Angles in degrees; +pan = right, +tilt = up. Boxes are `[x1, y1, x2, y2]` in frame pixels.

## Read

### `GET /video`
MJPEG stream (`multipart/x-mixed-replace`) of the annotated frame. Use as `<img src="/video">`.

### `GET /api/status`
Polled by the dashboard (~300 ms).
```json
{
  "server_time": 1790000000.12,
  "fps": 14.2,
  "mode": "auto",
  "frame": { "w": 640, "h": 480 },
  "target": { "id": 3, "label": "person", "conf": 0.87, "box": [210, 80, 330, 400], "locked": false },
  "detections": [
    { "id": 3, "label": "person", "conf": 0.87, "box": [210, 80, 330, 400] },
    { "id": 7, "label": "car", "conf": 0.66, "box": [400, 250, 620, 380] }
  ],
  "gimbal": {
    "pan": 12.4, "tilt": 0.0,
    "target_pan": 15.0, "target_tilt": 0.0,
    "pan_limits": [-170, 170], "tilt_limits": [-30, 45],
    "tilt_enabled": false,
    "mock": true
  },
  "velocity_deg_s": [8.1, 0.0]
}
```
- `mode`: `"auto"` (track automatically) | `"manual"` (operator aims) | `"stop"` (motors hold still)
- `target`: `null` when nothing is being tracked. `locked: true` when the operator picked it through `POST /api/target`.

### `GET /api/events?since=<seq>`
Recent event log, newest last. `since` returns only events with `seq > since`.
```json
{ "events": [ { "seq": 41, "t": 1790000000.1, "type": "target_acquired", "id": 3, "label": "person" } ] }
```
Event types: `target_acquired`, `target_lost`, `mode_changed`, `motor_connected`, `motor_disconnected`.

## Control
All return `{"ok": true, ...}`, or `{"ok": false, "error": "..."}` with HTTP 400.

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/mode` | `{"mode": "auto" \| "manual" \| "stop"}` | Switch mode. `stop` also halts the motors. |
| `POST /api/target` | `{"id": 7}` or `{"id": null}` | Lock onto a track ID (switches to `auto`), or clear the lock. |
| `POST /api/aim` | `{"pan": 20.0, "tilt": 0.0}` | Absolute aim. Only in `manual`. |
| `POST /api/nudge` | `{"dpan": -5.0, "dtilt": 0.0}` | Relative aim. Only in `manual`. |
| `POST /api/home` | `{}` | Aim at 0/0 (switches to `manual`). |
