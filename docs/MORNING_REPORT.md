# Morning report (2026-09-26)

Two overnight cloud sessions, merged. Part A is the backend (`cloud/hardware-ready`); Parts B and C are the showcase and dashboard (`cloud/showcase`).

---

## Morning report: `cloud/hardware-ready` (Part A)

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

## Integration check with `cloud/showcase` (local only, nothing pushed)

I merged both branches in a throwaway worktree. The only conflicts are docs, as expected: each branch has its own `docs/MORNING_REPORT.md`, and both edited `docs/DEVPOST.md`, so keep both sets of additions. The code merges cleanly and all 310 tests pass on the merge. I then ran `tools.rehearsal` with the **new dashboard** and drove it in headless Chromium at 1440 px:
- It used the real backend (not its mock). The diagnostics strip showed live `fps`, `capture_fps`, `infer_ms`, `latency_ms`, `serial: connected` and `uptime`, with CPU/Power as "–" (no `/sys` here, as designed).
- Clicking **E-stop** gave `estop: true`, `mode: stop`, `drivers_enabled: false`, and the banner's **Arm** released it. The tuning panel read `/api/settings` (it converts steps/s to 450°/s using `steps_per_deg`).
- No console errors, no failed requests.
- **One observation for the dashboard lane:** with a moving target, the drawn box trails the video by about 50 px. Boxes come from `/api/status` (polled ~300 ms) while `/video` is live, and at 12°/s that lag is 3–4°. Not a backend bug; a faster status poll, or drawing only boxes whose `frame_seq` is close to the displayed frame, would tighten it.

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

---

## Morning report: `cloud/showcase` (Parts B and C)

Overnight cloud session, 2026-09-26. Branch **`cloud/showcase`** (from `dev`), pushed; nothing went to `dev` or `main`. Part A is on `cloud/hardware-ready` with its own report.

## TL;DR
- **Showcase (`site/`)**: rebuilt from scratch as a cinematic WebGL site: dotted-ring loader with an Enter `>>>` gate, the "COOP" scrambleText decode (→ full name → tagline), and seven scroll-driven chapters in one persistent three.js scene. Reduced-motion and no-WebGL versions, phones, docs. **Preview:** `https://cloud-showcase.coop-224.pages.dev` (Cloudflare Pages branch alias for `cloud/showcase`; see "Previewing").
- **Dashboard (`web/`)**: same black/white/orange identity; pan-only with the pan gauge as the hero instrument (click or drag it to aim), leader-line detection labels that decode in, E-stop / Arm / Zero, a diagnostics strip, live tuning, and a designed state for every failure. **Tested end to end against Part A's real backend** (`tools/rehearsal.py`: real loop + fake Uno + synthetic camera).
- Screenshots of everything: `docs/screenshots/` (39 JPEGs: site at 1440 and 390 px, reduced motion, no WebGL; dashboard live, manual and every state).

## What was done

### Part B: the showcase
| Chapter | What happens |
|---|---|
| Loader | 48-dot ring filled by real load progress (fonts → anime.js → three.js + scene → shaders compiled), reticle ticks, "Locked", then **Enter `>>>`** (click or Enter key). |
| Intro | Brackets close in like autofocus; **"COOP" decodes out of noise** letter by letter with anime.js `scrambleText` (cursor `░▒▓█`), brackets snap orange (lock), the line below decodes into "Computer-vision Object Observation & Prediction", then re-scrambles into "COOP keeps an eye on the coop." while the full name settles above the word. |
| 01 See | A street of ~20k points (people walking, cars, lamps, facades) forms out of the intro's noise. COOP's own 4:3 viewfinder with a live frame counter, and a band sweeping down the frame like the OV5647's rolling shutter. |
| 02 Detect | Corner brackets snap onto each figure in turn with leader lines and mono labels (`PERSON #3 · CONF 0.87`) that scramble in; the target locks (orange). |
| 03 Predict | The camera follows with lead; velocity arrow, orange ghost at *t*+1.6 s with a fading trail and aim reticle, angular rate label. Mid-chapter the copy hands over to the typeset equations (pixel→world angle and the lead aim), with annotated terms. |
| 04 Move | Third-person view: the rig turns to follow, its field-of-view frustum fades out from the lens, a dashed aim ray, and a ±170° arc gauge (pan, aim, limits). |
| 05 Build | Exploded, to-scale technical drawing: 12 V supply → buck, NEMA 17, TMC2209, Uno, Pi 5, OV5647, with aligned leader-line labels. |
| 06 Gallery | A 3D ring of 8 cards that turns card by card with scroll, plus drag with inertia. Placeholder cards until media is added. |
| 07 Team | David + teammate placeholder, GitHub and Devpost links, and a closing portrait of the rig slowly scanning. |

Also: a floating pill nav (collapses to "07 Menu" on phones), the chapter scrubber (`03 / 07`) and a **bearing tape** along the bottom that slides with the camera's pan angle (the design's signature: in COOP, scroll *is* panning), word-by-word reveals scrubbed by scroll, and a desktop cursor that turns into lock brackets over links and says "Drag" over the gallery.

**Quality bar, measured:**
- Console: 0 errors and 0 warnings across every run (1440, 390, reduced motion, no WebGL).
- No horizontal overflow at 1440 or 390.
- Load before the first interaction: about **1.16 MB raw / 450 KB gzipped** (three.js is 742 KB of that, behind the loader). Gallery media loads only near the gallery; GLTFLoader only if a model is set; the equation fonts are ~50 KB.
- 60 fps: **not verifiable here** (the container renders WebGL on the CPU through SwiftShader: 12–25 fps there). The scene is built for it: one draw call for all points with the animation in the vertex shader, capped point sizes, DPR capped at 1.75, and adaptive resolution that drops the pixel ratio if frames stay slow. Please check on a real laptop.
- Reduced motion: a still version with no gate; chapters cut between static compositions.
- No WebGL: the same scene is rendered as still frames on a 2D canvas; the gallery becomes a grid.

`site/README.md` explains editing copy, adding photos/videos (one `<li>` per item), swapping in the real camera `.glb` (one constant in `js/stage/solids.js`; tested with a generated test model), and deploying. `site/CREDITS.md` lists licenses.

### Part C: the dashboard
- **Identity:** `web/tokens.css` now matches the showcase; `docs/DESIGN_BRIEF.md` rewritten. No red or green: severity is orange plus shape (hazard stripes, fill vs. outline).
- **Pan-only:** the tilt D-pad is gone. The gauge shows pan (needle), aim (orange mark) and limits, with ◀ Home ▶ and click/drag-to-aim in Manual.
- **Detections:** corner brackets with leader-line mono labels that flip at the frame edge; a newly seen or newly acquired target's label decodes in.
- **Safety:** one-click **E-stop** (also key `X`, fires before anything re-renders), **Arm** from the banner, **Zero here** with a 3 s confirm click.
- **Diagnostics strip:** CPU °C, power/throttling (decoded bits in the tooltip), vision fps, camera fps, inference ms, latency ms, Arduino link, uptime. Missing values show "–".
- **Tuning panel** (collapsed): lead time, deadband, confidence, max speed and acceleration (shown in °/s), pan invert (only in Stop), Apply or Apply and save.
- **Designed states:** no camera, Arduino reconnecting, signed out (Access expired), offline, stale, e-stop, drivers powered down, no target (four variants). Preview any of them with mock data: `web/index.html?demo=nocam|reconnecting|expired|offline|stale|estop|notarget|hot`.
- **`web/mock.js`** implements the whole new contract (estop/arm/zero/settings, diag, drivers idle, events).

## Review passes (what each one caught)

### Showcase
1. **Correctness (first screenshots):** leader lines from the Build chapter stayed on screen through Gallery and Team. Diagnosed: `clearRect` on the overlay canvas did not clear it (reproduced with an explicit clear + readback; a bitmap reset did). The overlay now resets its bitmap per drawn frame and skips drawing when idle. Also: people walked behind the copy, labels ran off the right edge, the equations overlapped the target, the exploded view was too big and clipped, the gauge's labels collided, the carousel sat between cards, and the orange cursor was stuck at (0,0) after the gate.
2. **Retest:** fixed the above: an off-centre camera (subject right of the copy on desktop, above it on phones), a shader fade for anything passing behind the copy, labels that flip left at the edge, the copy→equations hand-off in 03, a smaller exploded view with aligned labels, a gauge moved out of the scene, and the carousel dwelling card by card. The target now paces back and forth instead of wrapping around, so every chapter reliably has it in frame and the prediction visibly flips when it turns. On phones: the wordmark clipped and the narrow aspect cropped the scene out entirely; fixed with a phone-sized wordmark and a minimum horizontal FOV.
3. **Art direction:** every chapter was the same template, and 01 See had no moment of its own, so See got the viewfinder, frame counter and rolling-shutter sweep. The ghost read as a smear (moved further ahead, trail made fainter). Labels re-scrambled on every number tick (now only when their subject changes).
4. **Final pass, weakest section:** 07 Team ended on a generic particle field. It now closes on a portrait of the rig scanning (dimmed on phones, where it would sit behind text).

### Dashboard
1. **Correctness:** with no gimbal data (no camera / signed out) the gauge was blank; the "Arduino reconnecting" chip was unreadable on hazard stripes; on phones the diagnostics came before the pan instrument (a CSS ordering bug); labels clipped at the right edge on phones.
2. **Retest against the real backend** (`tools/rehearsal.py` from `cloud/hardware-ready`, driven by Playwright): mode switches, nudge (+10°), dial click (→ −85° as expected), Home, E-stop (drivers off, banner), a mode change blocked with a clear message, Arm, two-step Zero, a settings change applied server-side, pan-invert locked outside Stop, and the event log showing every step. 0 console errors.
3. **Art direction:** a filled orange "Lock target" was the loudest thing on the page and competed with E-stop; it's now an orange outline, so E-stop is the only filled orange control. Removed a middle-dot hint row that wrapped badly.

## Decisions I made (please check)
1. **Design direction "Bearing"** out of three (`docs/DESIGN_DIRECTIONS.md`): Archivo at its widest for display, Martian Mono for telemetry, STIX Two for the equations only. Orange means lock.
2. **Libraries are vendored, not loaded from a CDN.** jsdelivr/esm.sh were blocked from the container, and self-hosting is faster and has no third-party dependency on demo day anyway. three.js was minified with esbuild once (documented in `site/README.md`); there's still no build step.
3. **The dashboard does not load anime.js**: the label scramble is ~30 lines in `app.js`, so the Pi serves no extra 118 KB.
4. **The dashboard now depends on Part A's API** (`estop`, `diag`, `/api/estop|arm|zero|settings`), with field names taken from `docs/API.md` on `cloud/hardware-ready` (it was already there). I did not edit `docs/API.md` on this branch, to avoid a conflict. **Merge `cloud/hardware-ready` first**, then this branch. Against an old backend it degrades: diagnostics show "–", and E-stop/Zero/Tuning report "This COOP build doesn't support that yet."
5. **Devpost "Built with"** was already at 25 tags; I swapped `libcamera` (covered by `picamera2`) and `computer-vision` (a topic, not a tool) for `three.js` and `anime.js`. Part A also edits `docs/DEVPOST.md`, so expect a small merge conflict there.
6. **Numbers on the showcase:** real where they describe COOP (FOV, frame size, 150 ms lead, ±170° limits, parts). The detection confidences, walking figures and frame counter are an illustration; `site/README.md` says so. The ghost is drawn 1.6 s ahead (labelled `AIM · t + 1.6 s`) because 150 ms would be invisible.
7. **E-stop keyboard shortcut is `X`** (not Space or Escape, which scroll or close things).

## What's not done / needs you
- ✏️ Placeholders: teammate name and line, the Devpost URL, gallery photos and videos, the real hostname in `<head>`, and a `.glb` of the camera if you want it (all listed in `site/README.md`).
- Real-GPU performance check (see above).
- Cloudflare Pages: if project `coop-224` isn't connected to the repo yet, connect it (framework None, no build command, output `site`), then the preview URL above works.
- `docs/API.md` on this branch is the old version until `cloud/hardware-ready` is merged.

## Previewing
- **Cloudflare Pages:** `https://cloud-showcase.coop-224.pages.dev` (branch alias = branch name lowercased, `/` → `-`).
- **Locally:** `python -m http.server 8765 --directory site`, then `/`, `/?still` (reduced motion), `/?nogl` (no WebGL), `/#build` (deep link).
- **Dashboard without hardware:** `python -m http.server 8767 --directory web` and open `/?demo=estop` (or any state above). With Part A merged: `python -m tools.rehearsal` and open http://localhost:8000.

## Tomorrow's hardware session (dashboard side)
Follow `docs/HARDWARE_TEST.md` on `cloud/hardware-ready` for the bench order (emulator → jog → camera check → FPS bench → full run). On the dashboard:
1. Open the dashboard; the header should say **Live · N fps** (no "mock") and the Pan chip **Motors live**. The diagnostics strip should show a real CPU temperature and **Arduino: connected**.
2. **Before anything moves, find E-stop** (top right, or `X`). Press it once: the banner says the drivers are off and the shaft should turn freely by hand. Press **Arm**.
3. Switch to **Manual** (`2`), press ▶ once. If the camera turns left, open **Tuning**, switch to **Stop**, tick **Invert pan**, **Apply and save**.
4. Point the camera straight ahead by hand (during E-stop if needed), then **Zero here** twice.
5. Click the dial at +30° and −30°: the camera should follow the needle. If it overshoots or crawls, adjust **Max speed** / **Acceleration** in Tuning.
6. **Auto** (`1`), walk across the room: the brackets should lock (orange when you click your box), and the orange aim mark should lead you. Tune **Lead time** so the aim sits just ahead, and **Deadband** if it jitters while you stand still.
7. Unplug the Uno's USB: the banner should say **Arduino reconnecting** and the camera should hold still; plug it back in and it resumes.
8. Watch **Power** and **CPU**: anything other than "OK", or ≥ 80 °C, turns orange. Hover for the decoded throttle bits (under-voltage usually means the buck is set too low or the cable is too thin).
