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
| 3 | **Control API & hardware link** | `coop/stream.py`, `coop/control.py`, `coop/motors.py`, `firmware/**`, `scripts/**`, `.github/**`, `docs/HARDWARE_TEST.md`, `tests/test_smoke.py`, `tests/test_reconnect.py` | Implement every endpoint in `docs/API.md`: the mode, lock and aim state in `control.py`, plus the event log. Harden the serial link (reconnect). Pi deploy: a systemd service and a Cloudflare Tunnel guide. CI (pytest on GitHub Actions) and the first-hardware checklist. |
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

**Lane 3 → lane 2: handle an expired Cloudflare Access session.** Through the tunnel
(`scripts/setup_tunnel.md`), once the Access session expires (24 h), every `fetch("/api/...")`
gets redirected to the cross-origin Access login and rejects with a `TypeError` (no HTTP
status). Today that looks like a silently stale dashboard. Suggest: after a few consecutive
`TypeError`s from the real source, show a "Session expired — reload to sign in" state
(`--danger`) with a reload button, rather than falling back to mock. Relative URLs are
already right; keep them (no `http://localhost` anywhere).

**Lane 3 → lane 4: `tests/test_stream.py` asserts the pre-`frame_seq` contract.**
`SharedState.publish` now adds `frame_seq` (per `docs/API.md`), so
`test_publish_updates_status_and_frame_sequence` fails on line 25. The fix is one line:
`assert state.status == {"fps": 12.3, "frame_seq": 1}`. Until then CI is red on that
test only.

**Lane 3 → lane 4: record the hostname decision in `site/README.md`.** David decided
(2026-09-26): the showcase keeps `coop.<domain>`, and the live dashboard moves to
`coop-live.<domain>` (`scripts/setup_tunnel.md` and `install_tunnel.sh` are updated;
the installer now refuses `coop.*`). The "Hostname clash" note there can become a
one-line pointer.

**Lane 3 → lane 1: gate the virtual-gimbal crop on "no motors configured", not
`gimbal.mock`.** `main.py` crops through `VirtualGimbal` whenever `gimbal.mock and
cfg.sim.enabled`. On the Pi with motors enabled, `mock` is also true for the first
seconds before the Uno connects and during any USB outage, so the real camera frame
gets cropped as if it were a 100° webcam, and angles computed from it are wrong. Suggest
`if not cfg.motors.enabled and cfg.sim.enabled:`. During an outage `gimbal.angles` now
holds the last reported position (the motors are stopped), so no simulated motion is
needed there.
