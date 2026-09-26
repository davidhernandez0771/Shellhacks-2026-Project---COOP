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
    "pan_limits": [-170, 170], "tilt_limits": [-30, 45],
    "tilt_enabled": false,
    "mock": true
  },
  "velocity_deg_s": [8.1, 0.0]
}
```
- `mode`: `"auto"` (track automatically) | `"manual"` (operator aims) | `"stop"` (motors hold still)
- `server_time`: stamped per request, so it is always fresh; it does **not** tell you the vision loop is alive. Don't compare it to the client's clock (Pi and phone clocks differ).
- `frame_seq`: increments once per frame the main loop publishes (`SharedState._seq`). The dashboard shows "stale" when it stops advancing for 2 s, timed on the client's own clock. *Added for the connection banner; if absent the dashboard never reports stale.*
- Before the first frame is published the payload is just `{server_time, mode}`; clients must tolerate missing fields.
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
