# Overnight cloud plan (2026-09-26)

A brief for a Claude Code cloud session working unattended overnight. David is asleep. **Hardware (Pi 5, Uno, TMC2209, NEMA 17, OV5647) is assembled tomorrow.** When he wakes up he should find: the backend ready for hardware, and a showcase site that looks like a professional studio built it.

Read first: `CLAUDE.md`, `docs/API.md`, `docs/TERMINALS.md`, `docs/HARDWARE_TEST.md`, `README.md`.

## Ground rules
- Work on **two branches off `dev`**: `cloud/hardware-ready` (Part A) and `cloud/showcase` (Parts B and C). Push them to GitHub. **Never push to `dev` or `main`**; David reviews and merges in the morning.
- Commit small and often, with descriptive messages, so the morning review can follow what changed.
- `pytest` must pass on every commit to `cloud/hardware-ready`. Keep tests free of `ultralytics`/`picamera2` imports (CI installs only `.github/requirements-ci.txt`).
- **The build is pan-only**, permanently. Tilt is never used.
- Libraries must be properly licensed (MIT/Apache/ISC). Use references for *inspiration*; never copy another site's code, 3D assets, images or text. Credit anything borrowed in `site/CREDITS.md`.
- Never invent content: no fake team members, photos, quotes or metrics. Use clearly marked placeholders (`✏️ PLACEHOLDER`).
- Keep `docs/DEVPOST.md` in sync (see `CLAUDE.md`).
- Finish with a morning report (see the end).

---

## Part A: hardware-ready backend (`cloud/hardware-ready`), do this FIRST
In priority order. Stop and report if anything would change the serial protocol in a way the flashed firmware doesn't support. Protocol changes must update both `coop/motors.py` and the `.ino`.

1. **Pan-only cleanup.** Remove tilt from the control path where that simplifies things (config, control, motors, status), but keep the `/api/status` fields that the dashboard reads (`tilt: 0`, `tilt_enabled: false`) so `docs/API.md` stays valid. Update tests.
2. **Fake Arduino emulator** (`tools/fake_uno.py`): speaks the exact firmware protocol (READY, P reports at 20 Hz, T/C/Z/S/E/H, the 2 s watchdog, AccelStepper-like accel/decel) and attaches through a virtual serial port (e.g. `socket://` via pyserial's URL handlers, or a pty on Linux). Add `MotorConfig.port` support for it. Add an end-to-end test that runs the real `Gimbal` against it, including a reconnect.
3. **Settings file** so nobody edits Python on the Pi: `coop.toml` (or JSON) next to the repo, overriding `coop/config.py` defaults, loaded at startup; an example file is committed and the real one gitignored. It includes **`pan_invert`** (motors often spin the wrong way the first time), `microsteps`, `pan_gear_ratio`, limits, speed/accel, lead time, deadband, and the confidence threshold.
4. **Bench tools** in `tools/`:
   - `jog.py`: keyboard or CLI pan jog over serial, no vision. Shows the position; sets zero.
   - `camera_check.py`: grab frames, report resolution and FPS, save a still.
   - `bench_fps.py`: YOLO FPS at imgsz 256/320/416, PyTorch vs NCNN, and an NCNN export helper. Document it in the README.
5. **Safety:**
   - `POST /api/estop` (immediate `S`, then drivers disabled with `E 0`, mode → stop; needs an explicit re-arm), plus `POST /api/zero` ("set zero here" → `Z`).
   - Disable the drivers after N seconds in stop mode. The steppers otherwise hold current and heat up.
   - Document both in `docs/API.md`. Add tests.
6. **Latency and threading:** capture in its own thread and always process the newest frame (drop stale ones). Measure the end-to-end latency and expose it.
7. **Diagnostics in `/api/status`:** `diag: {cpu_temp_c, throttled, fps, infer_ms, latency_ms, serial: "connected|reconnecting|mock", uptime_s}`. Read the temperature and throttling from `vcgencmd` or `/sys` when available, and report null otherwise.
8. **Live tuning:** `GET/POST /api/settings` for lead time, deadband, confidence, max speed and invert, applied without a restart and optionally saved to the settings file.
9. Update `docs/HARDWARE_TEST.md` so tomorrow uses these tools, in order: emulator → jog → camera check → FPS bench → full run.

---

## Part B: the showcase (`site/`, branch `cloud/showcase`)
**Bar:** Active Theory (activetheory.net), in feel. An immersive, cinematic WebGL site with a loader and enter gesture, soft blooms on a near-black stage, and motion driven by scroll and the pointer. It must not read as a template. Design decisions are yours; the references are a starting point, not a spec. Research more if it helps (Awwwards-level studio sites, anime.js docs and examples).

**Identity**
- **Colors: black, white and orange only.** Near-black stage (`#0A0A0A`-ish), off-white text, one orange accent (signal or safety orange). Greys only as tints of those. Put every value as a token in `site/tokens.css`.
- **Type:** a large display face for headlines (a free Google font; choose one with character, serif or grotesk), a clean sans for body text, and a mono for labels and telemetry.
- The name is **COOP: Computer-vision Object Observation & Prediction**. Tagline idea: "COOP keeps an eye on the coop."

**Tech:** no build step, so it deploys as-is on Cloudflare Pages (project `coop-224`, output directory `site`, no build command). Use native ES modules with an import map from `cdn.jsdelivr.net` or `esm.sh`: three.js, anime.js v4 (scrambleText, onScroll, timelines, stagger). If you want an OriginKit component (e.g. Round Carousel), check its license and how it's built. If it's React-only, reimplement the effect in three.js/vanilla instead.

**Structure:** one persistent WebGL scene behind the page that transforms as you scroll (anime.js `onScroll`), chapter by chapter.
1. **Loader and enter gesture:** a dotted progress ring, then an "enter" prompt (a nod to Active Theory's `>>>`).
2. **Intro:** **"COOP" decodes out of noise with anime.js `scrambleText`** (cursor `░▒▓█`), then re-scrambles into "Computer-vision Object Observation & Prediction", then into the tagline. It should feel like a camera acquiring a lock. See Julian Garnier's CodePen `vEyYdXN` for the API; write your own timeline.
3. **01 SEE:** a particle field forms a street scene: people and cars as point clouds, moving.
4. **02 DETECT:** boxes snap onto the figures, with thin leader lines and tiny mono labels (`PERSON #3 · CONF 0.87`).
5. **03 PREDICT:** a velocity vector, and a ghost of the future position with a fading trail. The two real equations (pixel→angle, Kalman lead aim, from `docs/DEVPOST.md`) are typeset as an elegant figure, not a code block.
6. **04 MOVE:** a camera on a pan base rotates to follow; an arc gauge sweeps. **Use a procedural or placeholder camera model and structure the code so a real `.glb` of the actual camera can be dropped in later** (`site/models/`, one constant to switch).
7. **05 BUILD:** an exploded view of the hardware stack with leader-line labels: OV5647 camera, Pi 5, Arduino Uno, TMC2209, NEMA 17, 12 V supply → buck.
8. **06 GALLERY:** a round 3D carousel of build photos and videos (placeholders for now; an easy way to add media).
9. **07 TEAM + links:** GitHub and Devpost; the team as placeholders except David.

Also: word-by-word reveal of body copy on scroll, a chapter scrubber (`03 / 07`), a floating pill nav, custom cursor states on desktop.

**Quality bar (non-negotiable):**
- 60 fps on a mid-range laptop.
- Lazy-load heavy parts.
- Keep the initial load light (target under about 1.5 MB before the first interaction).
- `prefers-reduced-motion` → a static, still-beautiful version.
- Fallback when WebGL is unavailable.
- Works on phones: the touch scroll must feel right, and there is no horizontal overflow.
- Accessible text contrast.
- No console errors.
- `site/README.md` explains how to edit copy, add media, swap in the `.glb` model, and deploy.

## Part C: the dashboard (`web/`, branch `cloud/showcase`), after Part B
Same black/white/orange identity, but it's a tool: calm, legible, fast.
- **Pan-only:** remove the tilt UI. ◀ HOME ▶ plus a big pan gauge as the hero instrument.
- Detection tags become leader-line mono labels; a newly acquired target's label scrambles in.
- A diagnostics strip (from Part A's `diag`), plus E-STOP and ZERO controls. **Keep every endpoint in `docs/API.md` working, and coordinate field names with Part A through `docs/API.md`.**
- Designed states: no camera, Arduino reconnecting, Access session expired, no target.
- Keep `web/mock.js` in sync so the dashboard demos without a backend.

---

## Verification before the report
- `pytest` passes on `cloud/hardware-ready`.
- Run the full app headless against the fake Uno and a fake camera/detector: modes, jog, E-stop and reconnect all work.
- Serve `site/` and `web/` locally and check with a headless browser if one is available (Playwright/Chromium): screenshots at 1440 and 390 px, the console clean, reduced-motion mode. Save screenshots in `docs/screenshots/` on the showcase branch.

## Morning report
Write `docs/MORNING_REPORT.md` on each branch:
- what was done and what wasn't, and why
- how to preview it: Cloudflare Pages builds a preview URL for every pushed branch, so give the expected branch alias
- anything that needs David's decision
- a step-by-step for tomorrow's hardware session
