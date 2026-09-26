# Parallel work plan (multiple Claude terminals)

Every terminal works in the same folder (`C:\dev\COOP`) on its **own files**. Shared contracts are in `docs/API.md` (backend ↔ web) and `docs/DESIGN_BRIEF.md` (look).

## Rules for every terminal
1. Only edit files in your lane. If you need a change in another lane's file, write it in the **Requests** section at the bottom of this file instead.
2. Commit **only your own paths** (`git add <your paths>`); never use `git add -A` or `git commit -a`, because other terminals have uncommitted work in the same folder.
3. Pull before you push; push small commits often.
4. Update `docs/DEVPOST.md` when you add a library, a feature, or solve a real problem (see `CLAUDE.md`).

## Lanes

| # | Lane | Owns | Goal |
|---|---|---|---|
| 1 | **Vision & tracking** | `coop/main.py`, `coop/camera.py`, `coop/detector.py`, `coop/predictor.py`, `coop/sim.py`, `coop/config.py` | Make it run on the laptop and fix bugs. Build the virtual gimbal (a crop window that pans with the simulated motors) so tracking is visible without hardware. Measure and tune FPS. |
| 2 | **Web dashboard** | `web/**` | Rebuild the dashboard to `docs/DESIGN_BRIEF.md` against `docs/API.md`. Use fake data until the endpoints exist. |
| 3 | **Control API & hardware link** | `coop/stream.py`, `coop/control.py`, `coop/motors.py`, `firmware/**`, `scripts/**`, `.github/**`, `docs/HARDWARE_TEST.md` | Implement every endpoint in `docs/API.md`: the mode, lock and aim state in `control.py`, plus the event log. Harden the serial link (reconnect). Pi deploy: a systemd service and a Cloudflare Tunnel guide. CI (pytest on GitHub Actions) and the first-hardware checklist. |
| 4 | **Quality & ship** | `tests/**`, `docs/DEVPOST.md`, `README.md`, `site/**` | pytest suite (pixel math, Kalman, target choice, serial protocol with a fake port, API with the Flask test client). Keep the docs current. Later: a landing page for the domain. |

**Lane 1 ↔ 3 handoff:** lane 3 builds `coop/control.py` (a thread-safe object holding mode, locked ID, manual aim and events). Lane 1 wires it into `main.py`'s loop. Agree on its interface here before coding it.

**Fewer terminals?** With 3, fold lane 4 into lanes 1 and 3. With 2, run lane 1, and have the second terminal do lanes 2 and 3 together.

## Requests
_(cross-lane asks: "lane X → lane Y: need ...". Delete when done.)_

**Lane 3 → lane 1: `coop/control.py` is built, please wire it into `main.py`.**

`Control` (in `coop/control.py`) is a thread-safe object: one instance lives in `main.py`
and is shared with `coop.stream`'s Flask app (which now takes it: `serve_in_background(state,
control, cfg.stream)` — the signature gained a `control` argument, update the call site).
Interface:

```python
class Control:
    def __init__(self, motors_cfg): ...          # e.g. Control(cfg.motors)

    # read every frame
    mode: str                        # "auto" | "manual" | "stop"
    locked_id: int | None            # set via POST /api/target; None = auto-choose
    manual_aim: tuple[float, float]  # (pan_deg, tilt_deg), meaningful only in "manual"

    # call to append to the event log (seq/t added automatically)
    def log_event(self, event_type: str, **fields) -> None: ...
```

What the loop needs to do with it, per `docs/API.md`:
- **`"auto"`** (current behavior): but pass `control.locked_id` as the "stick with this
  ID" seed for `choose_target` instead of the local `target_id`, so an operator's lock
  wins over auto-selection. When the locked target is lost past `lost_timeout_s`, call
  `control.set_target(None)` to release the lock and `control.log_event("target_lost",
  id=...)`. On a new/changed target, `control.log_event("target_acquired", id=...,
  label=...)`.
- **`"manual"`**: skip detection-driven aiming; call `gimbal.aim(*control.manual_aim)`
  instead of the predictor's output.
- **`"stop"`**: call `gimbal.stop()` instead of `gimbal.aim(...)` (cheap to call every
  frame; it just re-sends the current hold position).
- Build the status dict's `"mode"` from `control.mode` and `target.locked` as
  `target is not None and target.track_id == control.locked_id`.
- Construct the gimbal with `Gimbal(cfg.motors, on_event=control.log_event)` so
  `motor_connected` / `motor_disconnected` events land in the log.

`control.set_mode`, `.set_target`, `.set_aim`, `.nudge`, `.home` exist too (used by
`coop/stream.py`'s route handlers) but the loop only ever *reads* `mode` / `locked_id` /
`manual_aim` and calls `log_event` — it never needs to call the mutators itself, except
`set_target(None)` to release a lost lock as noted above. All raise `ControlError`
(`from .control import ControlError`) on bad input; `stream.py` already catches that.

**Lane 3 → lane 2: handle an expired Cloudflare Access session.** Through the tunnel
(`scripts/setup_tunnel.md`), once the Access session expires (24 h), every `fetch("/api/...")`
gets redirected to the cross-origin Access login and rejects with a `TypeError` (no HTTP
status). Today that looks like a silently stale dashboard. Suggest: after a few consecutive
`TypeError`s from the real source, show a "Session expired — reload to sign in" state
(`--danger`) with a reload button, rather than falling back to mock. Relative URLs are
already right; keep them (no `http://localhost` anywhere).

**Lane 3 → lane 4: add a startup smoke test.** CI (`.github/workflows/tests.yml`) runs
the suite with only flask/numpy/pyserial/opencv-headless/pytest installed, so keep tests free
of `ultralytics` and `picamera2` imports. Gap it can't see: nothing calls `coop.main.main()`,
so the committed `main.py` calling `serve_in_background(state, cfg.stream)` against the
new 3-argument signature passes CI but crashes at startup. Suggest a test that runs one loop
iteration with `Camera`/`Detector` monkeypatched to fakes, `--no-motors`, and the web
thread stubbed.

**Lane 4 → lane 3 (and David): hostname clash on `coop.<domain>`.** `scripts/setup_tunnel.md`
routes the dashboard to `coop.example.com`, and the new public showcase (`site/`) was asked
for at `coop.<domain>` too. One hostname can't serve both. Suggest the showcase keeps `coop.`
(the public link for judges) and the tunnel moves to `cam.` (update `setup_tunnel.md`, the
`install_tunnel.sh` example and the Access app). Needs David's call before either DNS record
is created; see `site/README.md` → "Hosting it free".
