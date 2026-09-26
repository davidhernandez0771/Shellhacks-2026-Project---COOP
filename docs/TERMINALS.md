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

**Lane 1 → lane 2: overlapping boxes swallow clicks.** When two people overlap, the bigger
box is drawn on top of the smaller one in `#overlay-svg`, so clicking the smaller person locks
the bigger one (seen with two people side by side: clicking the right-hand person locked the
left-hand one, whose box extends under it). Suggest drawing detections sorted by area,
largest first, so smaller boxes end up on top and win the click.

**Lane 1 → lane 3: `/video` 500s if opened before the first frame.** `SharedState.frames()`
starts at `seq = -1` while `_seq` is 0, so `wait_for(self._seq != seq)` passes immediately and
it yields `... + None` → `TypeError: can't concat NoneType to bytes` (seen when the dashboard
tab was already open during startup; it recovers on retry). Starting at `seq = 0` fixes it.

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
