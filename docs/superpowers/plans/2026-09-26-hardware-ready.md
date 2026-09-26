> **Outdated: from the motorized-gimbal era.** COOPER is now a fixed dashcam; see README.md and docs/MATH.md.

# Hardware-ready backend implementation plan

> Written with the `writing-plans` skill for the unattended overnight session (Part A of
> `docs/CLOUD_PLAN.md`). Executed natively in the same session, task by task, TDD.

**Goal:** make the backend ready for tomorrow's first hardware session: pan-only control path,
an Arduino emulator, a settings file, bench tools, e-stop/zero/idle-disable, a capture thread
with latency measurement, diagnostics, and live tuning.

**Architecture:** the serial wire protocol stays byte-for-byte what `firmware/coop_motors`
already implements (tilt is always sent as `0`), so no firmware change is needed. Safety state
(e-stop, driver enable, frame-of-reference epoch) lives in `Gimbal`, which owns the serial
link; `Control` owns operator state and calls the gimbal outside its own lock. Live settings
go through one `LiveSettings` object that validates, applies and optionally saves.

**Tech stack:** Python 3.11+ stdlib (`tomllib`, `threading`, `socketserver`), pyserial URL
handlers (`socket://`), Flask, pytest.

**Spec:** `docs/CLOUD_PLAN.md` Part A; wire contract `docs/API.md`.

## Global constraints
- `pytest` green on every commit; tests never import `ultralytics`/`picamera2`.
- Pan-only, permanently. `/api/status` keeps `gimbal.tilt: 0`, `gimbal.tilt_enabled: false`.
- Every tunable in `coop/config.py`; hardware imports lazy; runs on a laptop without hardware.
- Serial protocol changes must update both `coop/motors.py` and the `.ino` (none planned).
- Never push to `dev`/`main`. Commit only own paths. Keep `docs/DEVPOST.md` in sync.

## Review focus (failure modes no single feature test covers)
1. A `T` sent while the drivers are disabled: AccelStepper counts steps the rotor never makes,
   and the Pi's position silently desyncs. → emulator tracks counter *and* rotor; e2e asserts
   they agree after e-stop, idle-disable and re-arm.
2. E-stop mid-move: `S` then an immediate `E 0` lets the counter run through the decel ramp
   with no torque (up to 75° at defaults). → disable only after the worst-case decel time.
3. A reconnect while e-stopped: the Uno reboots with drivers enabled. → `_connect` re-sends `E 0`.
4. `zero` or an invert flip while the loop is mid-iteration: a stale-frame aim moves the
   camera in the new frame. → gimbal `frame_epoch`; `aim()` drops commands from an old epoch.
5. A typo in `coop.toml` silently ignored. → unknown keys and wrong types fail loudly at startup.

---

### Task 0: API contract first
Write every new field and endpoint into `docs/API.md` and push, so the dashboard session can
build against it. Names below are final.

### Task 1: Pan-only control path
- `MotorConfig`: drop `tilt_gear_ratio`, `tilt_enabled`, `tilt_limits_deg`; add
  `pan_invert: bool = False`, `idle_disable_s: float = 20.0`.
- `Gimbal`: `pan` property (deg), `aim(pan_deg, deadband_deg=0.0, epoch=None)`, wire lines
  `T <steps> 0`, `Z <steps> 0`; `P a b` parses `a`. `steps_per_deg` property.
- `Control`: `manual_pan` (float) replaces `manual_aim`; `set_aim(pan)`, `nudge(dpan)`.
  `/api/aim` and `/api/nudge` accept but ignore `tilt`/`dtilt` (now optional).
- `main.py`: world tilt = in-frame offset only (gimbal tilt fixed at 0); predictor stays 2-D.
- Tests: update `test_motors`, `test_reconnect`, `test_control`, `test_stream`; add
  `test_aim_accepts_missing_tilt`, `test_status_keeps_tilt_fields`.

### Task 2: Fake Arduino (`tools/fake_uno.py`)
- `UnoModel`: pure state machine (`feed(bytes)`, `advance(dt)`, `drain_output()`), mirrors the
  .ino: 48-byte line buffer, `\r` ignored, `sscanf`-style parsing (so `Z 5` zeroes, like the
  real one), watchdog 2 s, 50 ms `P` reports, AccelStepper-style trapezoid, `stop()` target
  = position + stopping distance. Tracks `counter` (what it reports) and `rotor` (physical,
  moves only while enabled).
- `FakeUnoServer(host, port, boot_delay_s)`: TCP; each accepted connection = a DTR reset
  (counter → 0, drivers enabled, default limits, `READY` after boot delay). `unplug()` /
  `replug()` for reconnect tests. CLI: `python -m tools.fake_uno --port 5555`.
- `Gimbal._connect`: ports containing `://` open via `serial.serial_for_url`.
- `main.py --motor-port`.
- Tests: `tests/test_fake_uno.py` (model unit tests), `tests/test_gimbal_e2e.py` (real Gimbal
  over TCP: handshake, aim reaches target, watchdog, reconnect restores position with
  `counter == rotor`).

### Task 3: Settings file (`coop/settings.py`)
- `load_config(path=None) -> Config` (defaults ← `coop.toml` ← CLI), `validate_config(cfg)`,
  `SettingsError`. Unknown sections/keys and wrong types raise with the valid names listed.
- `save_settings(path, {section: {key: value}})`: in-place line edits that keep comments,
  verified by re-parsing.
- `coop.example.toml` committed; `coop.toml` gitignored; `main.py --config`.

### Task 4: Safety (e-stop, arm, zero, idle disable)
- `Gimbal.estop()`: `S` now, `E 0` after `max_speed/accel + 0.2 s`; `arm()`: `E 1`;
  `zero()`: `Z`, epoch++; idle: `E 0` after `idle_disable_s` of `stop()`; `aim()` re-enables
  with `E 1` before `T`; `aim()` is ignored while e-stopped; `_connect` re-sends `E 0`.
- `Control.estop()/arm()/zero()`, `bind_gimbal()`, e-stop blocks auto/manual/lock/home.
  Entering manual holds the current pan.
- Routes `POST /api/estop`, `/api/arm`, `/api/zero`. Events `estop`, `armed`, `zeroed`,
  `motors_idle`.

### Task 5: Capture thread + latency
- `FrameGrabber(camera)` in `coop/camera.py`: newest-frame handoff, stale frames dropped,
  camera exceptions re-raised in the consumer *after* any pending frame.
- `diag.fps`, `diag.capture_fps`, `diag.infer_ms`, `diag.latency_ms` (capture → publish).

### Task 6: Diagnostics (`coop/diag.py`)
- `read_cpu_temp_c()`, `read_throttled()`, `SystemMonitor.snapshot()` (2 s cache).
- `/api/status.diag` always has every key (null when unknown); `serial` from
  `Gimbal.link_state`; `uptime_s` = process uptime.

### Task 7: Live tuning
- `LiveSettings` + `GET/POST /api/settings`; atomic validation; `pan_invert` only in `stop`;
  speed/accel re-sent to the Uno with `C`; `save: true` writes `coop.toml`.

### Task 8: Bench tools + docs
- `tools/jog.py`, `tools/camera_check.py`, `tools/bench_fps.py`, `tools/rehearsal.py`
  (full app with synthetic camera/detector against the fake Uno).
- `docs/HARDWARE_TEST.md` order: emulator → jog → camera check → FPS bench → full run.
- README, DEVPOST, `docs/MORNING_REPORT.md`.
