# Morning report: `cloud/hardware-ready` (Part A)

Overnight cloud session, 2026-09-26. Branch `cloud/hardware-ready`, cut from `dev` at `101856e`, pushed. **Nothing was pushed to `dev` or `main`.** The dashboard and showcase (Parts B and C) are on `cloud/showcase`, from the parallel session.

**TL;DR.** All nine Part A items are done and tested. The serial protocol is unchanged, so the firmware needs no change beyond what `dev` already has. For the first time it has also been **compiled** (no warnings) and **run in an AVR simulator**, which confirmed the e-stop design against the real AccelStepper. 310 tests pass (on a fresh clone with only the CI dependencies, and under single-core stress), including the whole app running against an emulator of the firmware. The review passes found and fixed the problems listed below; 3 decisions are waiting for you.

---

## What was done

| # | Plan item | Where | Status |
|---|---|---|---|
| 1 | Pan-only cleanup | `coop/config.py`, `motors.py`, `control.py`, `main.py`, `stream.py` | ✅ The tilt fields are gone from the config and the control path. `/api/status` still reports `tilt: 0`, `tilt_enabled: false`, `tilt_limits: [0, 0]`. The wire format is unchanged (the tilt field is always `0`), so the firmware is untouched apart from a comment. |
| 2 | Fake Arduino | `tools/fake_uno.py` | ✅ A real-time emulator of the `.ino` over TCP (`socket://` via pyserial's URL handlers, cross-platform). Each connection is a DTR reset (READY), 50 ms `P` reports, T/C/Z/S/E/H with the sketch's exact parsing quirks, the 2 s watchdog, and an AccelStepper-style trapezoid. **It tracks the step counter and the physical shaft separately**, so tests can see lost steps. `MotorConfig.port` / `--motor-port` accept `socket://host:port`. |
| 3 | Settings file | `coop/settings.py`, `coop.example.toml` | ✅ `coop.toml` (gitignored) overrides the defaults; `coop.example.toml` lists every key at its default, and a test keeps it in sync. Unknown keys and wrong types stop startup with "did you mean". `--config` picks another file. Includes `pan_invert`, `microsteps`, `pan_gear_ratio`, limits, speed and accel, lead time, deadband, `conf`, and the new `idle_disable_s`. |
| 4 | Bench tools | `tools/jog.py`, `camera_check.py`, `bench_fps.py`, plus `rehearsal.py` | ✅ Documented in the README table. `jog` was driven through a real pseudo-terminal against the emulator. `bench_fps` was run for real here with ultralytics 8.4 (the PyTorch and NCNN export plus benchmark), and COOP's own `Detector` loaded the exported NCNN folder. `rehearsal` is the whole app with no hardware. |
| 5 | Safety | `POST /api/estop`, `/api/arm`, `/api/zero`; idle power-down | ✅ See "Safety design" below. |
| 6 | Latency and threading | `FrameGrabber` in `coop/camera.py` | ✅ Capture runs on its own thread and the loop always gets the newest frame (stale ones are dropped and counted). Frames carry their capture timestamp, which the **Kalman filter now uses** (it used to use processing time). Exposed as `diag.fps`, `capture_fps`, `infer_ms`, `latency_ms`. |
| 7 | Diagnostics | `coop/diag.py` | ✅ `diag: {cpu_temp_c, throttled, fps, capture_fps, infer_ms, latency_ms, serial, uptime_s}`. Every key is always present, `null` when unknown. The temperature comes from `/sys`, throttling from `vcgencmd get_throttled` (falling back to the firmware sysfs node), cached for 2 s. |
| 8 | Live tuning | `GET/POST /api/settings` | ✅ `lead_time_s`, `deadband_deg`, `conf`, `max_steps_per_sec`, `accel_steps_per_sec2`, `pan_invert`. Changes are validated all-or-nothing; speed and accel are re-sent to the Uno as one `C`; `pan_invert` changes only in stop mode; `"save": true` writes `coop.toml`, keeping its comments. |
| 9 | `docs/HARDWARE_TEST.md` | | ✅ Rewritten in the order emulator → jog → camera check → FPS bench → full run, using `coop.toml` instead of editing `config.py`. |

The API contract for all of this was written into `docs/API.md` **first** (the first commit) so the dashboard session could build against it. I checked `cloud/showcase`'s `web/app.js` and `web/mock.js` afterwards: they use exactly these names (`estop`, `/api/arm`, `/api/zero`, `gimbal.drivers_enabled`, every `diag` key, the throttle bits, `/api/settings` with `ranges` and `steps_per_deg`).

Beyond the plan: `tools/firmware_sim/` runs the **real compiled firmware** in simavr and counts its actual STEP pulses. It agrees with `tools/fake_uno.py` within ~2% on every scripted scenario, and it confirms with the real AccelStepper that "S then E 0" loses 334 steps (75°) while COOP's sequence loses none. Numbers are in `tools/firmware_sim/README.md`.

Also: `README.md` (settings, safety, bench tools), `docs/TERMINALS.md` (the new files go to lane 3), `docs/DEVPOST.md` (What it does, How we built it, a new Challenge, Testing), `hardware/README.md` (pan-only note, `coop.toml`), and the plan in `docs/superpowers/plans/2026-09-26-hardware-ready.md`.

## Safety design (worth reading before tomorrow)

- **E-stop ≠ "S then E 0".** AccelStepper keeps counting the steps of its braking ramp even with the drivers disabled, so cutting power right after `S` would leave the Uno's counter ahead of the shaft by up to v²/2a ≈ 333 microsteps ≈ **75°** at the defaults. `estop()` sends `S` at once, then `E 0` as soon as the reported position has been still for 0.25 s, with the worst-case braking time + 0.3 s as a hard deadline. The e2e test stops the emulator at full speed and asserts counter == shaft; a mutation test that cuts power immediately makes 4 tests fail.
- **Never a `T` while the drivers are off.** `aim()` refuses during an e-stop and sends `E 1` before any `T` after an idle power-down (even when the aim is inside the deadband).
- **The Uno boots with its drivers enabled**, so the reconnect handshake re-sends `E 0` when e-stopped or idle.
- **E-stop is serialized** against arm/zero: an e-stop pressed during an in-flight arm can't be undone by it (this was a real race, with a test).
- **`frame_epoch`**: `zero()` and a `pan_invert` flip change what every angle means; aims computed from the old frame are dropped, and the loop resets the Kalman filter.
- **Entering manual now holds the current pan** instead of jumping back to an old manual setpoint (e.g. auto has moved the camera to −30°, the last manual aim was +40°, and switching to manual used to swing it 70°).

## How each item was reviewed, and what the passes caught

Every item went through TDD (test first, watched fail) plus three passes: (1) correctness against the plan and `docs/API.md`, with an eye on motor safety; (2) testing: the full suite, the e2e runs, coverage, mutation checks; (3) rethink: is there a simpler or safer design?

| Pass | What it caught | Fix |
|---|---|---|
| 1 correctness (item 1) | Python's JSON parser accepts `NaN`; a NaN aim would reach `round(nan)` inside the vision loop and crash it. | Finite-number checks in the API, in `Control`, and in `Gimbal.aim` |
| 2 testing (item 2) | Mutation testing showed the emulator's line-truncation test couldn't fail (both behaviours gave the same answer). | Rewrote the test so truncation changes the outcome |
| 2 testing (item 2) | The emulator's `replug()` resumed the old in-flight move instead of power-cycling. | Replug is now a power-on reset, with a test |
| 2 testing (item 4) | The replug e2e test failed about 1 run in 6. The root cause: the emulator's braking used the integer step counter and ignored the fractional step, overshooting one step, and the test's ±0.3° tolerance hid a stale report. | Fixed the braking maths, added a no-overshoot test over five speed/accel combos, and made the test wait for the exact settled reading. 60/60 trials clean |
| 3 rethink (item 5) | The e-stop design itself: an immediate `E 0` loses position (above). | Stillness-based power-down with a deadline, and a generation counter so a stale watcher from an earlier e-stop can't cut power mid-ramp of a later one |
| 1 correctness (item 5) | Race: an e-stop landing inside `Control.arm()` between its check and its effect was silently undone. | `_safety_lock` serializes estop/arm/zero; the test reproduces the interleaving |
| 1 final pass | A `P` report the Uno sent just before processing `Z` could arrive after `zero()` and restore the old position (and the reconnect restore point). | Reports are ignored for 150 ms after a zero |
| 2 testing (item 8 e2e) | The whole-app test's manual-hold check was flaky. The cause was the test reading a pre-switch published status, not the app. | Reads `target_pan` from a frame after the switch; 10/10 clean |
| 1 final pass | Any POST with a JSON array or string body raised in `.get()` → **500** (partly pre-existing). | `_json_object()`, with a 40-case test |
| 1 final pass | The capture thread started before the YOLO model loaded, outside `try/finally`, so it leaked on a model-load failure. | Started last |
| 1 final pass | An unwritable or undecodable `coop.toml` raised `OSError`/`UnicodeDecodeError` → a 500 or a startup traceback. | Now a `SettingsError` (a 400, or the one-line startup error) |
| 3 rethink (contract) | Cross-checking the dashboard: it posts only changed keys, so "Apply", then "Save" answered `saved: false`, and an applied-but-unsaved change was lost on restart. | `save: true` now writes all six live values; `docs/API.md` updated; no dashboard change needed |
| 2 testing | Coverage review: the `--annotate` path, lock → loss on the new capture timestamps, the save re-parse safety net, and `bench_fps`'s export/rename flow never ran under test. | Tests added (a stand-in `ultralytics` module for CI) |
| 3 rethink (docs) | `HARDWARE_TEST.md`'s first draft used separate `tools.jog --goto` runs for the direction and scale checks. But every jog run re-opens the port, which resets the Uno and silently moves the zero. | Those checks now happen in one interactive session, with a warning |
| 3 rethink (validation) | The emulator's fidelity was only my reading of AccelStepper. | Ran the real firmware in simavr (above); it matches |
| 2 testing (final) | Running the committed `firmware_sim/build_and_run.sh` from a clean directory: it linked `-lelf`, which Ubuntu's libsimavr doesn't need and isn't installed. | Links without it, falling back to `-lelf` |
| 1 final pass | `camera_check` printed a raw traceback when no camera opens, the most likely failure tomorrow. | A one-line hint (`rpicam-hello --list-cameras`), with a test |
| 2 final pass | I had described `rehearsal --invert` as "runs to a limit" without running it. Running it: it turns away until it loses the walker (~60°). | Wording fixed in three places |
| 2 testing | A few of my own test bugs (10° isn't a whole number of microsteps; the uptime rounding; a TCP write race). | Fixed in the tests; no app change |

## How to preview it

- **Backend changes have no Cloudflare Pages preview worth opening.** Pages serves only `site/`, which this branch doesn't touch. If the project builds every branch, its alias would be `cloud-hardware-ready.coop-224.pages.dev`, identical to `dev`'s site. Preview the backend by running it:
  ```bash
  git fetch && git checkout cloud/hardware-ready
  pip install -r requirements.txt        # nothing new is required; tomllib is stdlib (Python ≥ 3.11)
  pytest -q                              # 310 passed, about 35 s
  python -m tools.rehearsal              # open http://localhost:8000: tracking, E-STOP, ZERO, settings
  ```
- To see the new dashboard driving this backend, merge both branches locally (they touch disjoint files except `docs/DEVPOST.md`, which may need a trivial merge) and run `python -m tools.rehearsal`.

## Decisions for you

1. **A COOP restart moves the zero.** This is pre-existing and not new tonight, but it matters more now that systemd restarts on crash. Opening the serial port resets the Uno, whose counter restarts at 0 wherever the shaft is. After a crash-restart with the camera at 60°, "0°" is 60° off and the ±170° limits no longer protect the cables. Options:
   - (a) persist the last reported position to a file and restore it with `Z <pos>` on the first connect. This is right after a crash; wrong if the shaft was turned by hand while the drivers were off or unpowered.
   - (b) stop the Uno resetting on open (DTR handling). This is unreliable on Linux, and the handshake relies on `READY`.
   - (c) a homing switch.
   - (d) status quo plus the procedure (Home before stopping; E-STOP, turn by hand, ZERO after anything odd).

   **Recommendation: (d) for tomorrow and the demo, (c) if time allows.** I didn't implement (a) because a wrong restore is worse than a known reset.
2. **`idle_disable_s = 20`.** The TMC2209 in standalone mode may already reduce standstill current (I couldn't verify the OTP default here), so you may prefer a longer value or `0` (never), since while disabled the camera can be pushed by hand and lose its position. It's one line in `coop.toml`.
3. **NCNN in "Built with".** The Devpost list is at 25/25 tags. If NCNN wins the bench on the Pi, swap a tag (e.g. `html` or `css`) for `ncnn`. I didn't, because it isn't used until you choose it.

## Not done / limits (and why)

- **Nothing ran on real hardware** (there is none here). `docs/HARDWARE_TEST.md` still tags every step `[never run]`.
- **Firmware:** compiled and simulated, never flashed. It was compiled by hand with avr-gcc 7.3, the Arduino AVR core 1.8.6 and AccelStepper 1.64 (the Arduino package index is blocked from this sandbox, so `arduino-cli` couldn't install the core). The Arduino IDE may use a newer core; that's fine, the sketch uses nothing version-specific.
- **`tools/jog.py`'s Windows key reader** (`msvcrt`) wasn't exercised; only the POSIX path ran through a real pty. On Windows, `--goto/--by/--zero` don't use it.
- **Bench numbers here are x86 and meaningless for the Pi** (both backends ran at about 55 fps). Tomorrow's section 6 produces the real ones.
- **Known limit:** an unplug *mid-move* can leave the restored position off by up to `max_steps_per_sec × 50 ms` (the last report's age, 22° at defaults). A test documents the bound. Re-zero after one.
- CI (`.github/workflows/tests.yml`) runs on pushes to `dev`/`main` and on PRs, so it hasn't run on this branch; it will on the PR. The suite only needs `.github/requirements-ci.txt`.

## Tomorrow's hardware session, step by step

Full checklist with the expected results: `docs/HARDWARE_TEST.md`. In short:

1. **Laptop, before touching hardware:** `pytest -q`, then `python -m tools.rehearsal` (watch it track; try E-STOP, ZERO, arm), then `python -m tools.rehearsal --invert` to see what a wrong motor direction looks like.
2. **Pi setup:** `bash scripts/setup_pi.sh`, re-login, download `yolo11n.pt`, `cp coop.example.toml coop.toml` and set `microsteps` and `pan_gear_ratio` to the real build.
3. **Flash the Uno**, Serial Monitor sanity check (`READY`, `P 0 0`, `Z 400 0`).
4. **Motor, camera NOT mounted:** set Vref, then in **one** `python -m tools.jog` session check holding torque, direction (→ must turn right; else `pan_invert = true`), scale (45° step ×2 = 90°), and e-stop mid-move (`e`, then `e`, then `0` returns to the tape mark).
5. **Camera:** `rpicam-hello --list-cameras`, then `python -m tools.camera_check --source picamera`; check the still for colours and orientation.
6. **FPS:** `python -m tools.bench_fps --export`, then `python -m tools.bench_fps`; put the winner in `coop.toml` `[detector]`.
7. **Full run:** `python -m coop.main --source picamera`, Manual moves, Stop → idle power-down, limits with the camera mounted, then closed-loop tracking at reduced limits/speed. Tune `lead_time_s` / `deadband_deg` live from the dashboard and **Save**.
8. **Resilience:** E-STOP mid-move, `pkill`, USB unplug/replug, then systemd and the tunnel.
