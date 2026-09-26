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

**Lane 2 → lane 4: Devpost copy for the prediction overlay.** (Lane 2 was told to commit only
`web/` and `docs/API.md`.) Suggested additions:
- *What it does*, after the dashboard paragraph: "In auto mode the feed shows the prediction
  itself: an arrow for the target's velocity, and the predicted aim point with a fading trail
  of where it has been, so you can watch COOP aim ahead of a moving target instead of behind
  it."
- *How we built it → Dashboard*: "The prediction overlay works in world angles, like the
  tracker: the aim trail is stored as pan/tilt and re-projected through the current gimbal
  angle every frame, so it stays fixed in the world while the camera turns instead of smearing
  across the image."
- *Challenges*: "**A dashboard that doesn't lie.** A request-time timestamp always looks fresh,
  and the Pi's and a phone's clocks disagree. Staleness is detected from a per-frame counter
  timed on the client's own clock, and an expired Cloudflare Access session is told apart from
  a dead network by reading the login redirect (`redirect: "manual"`) instead of the opaque
  CORS error."

**Lane 3 → lane 4: record the hostname decision in `site/README.md`.** David decided
(2026-09-26): the showcase keeps `coop.<domain>`, and the live dashboard moves to
`coop-live.<domain>` (`scripts/setup_tunnel.md` and `install_tunnel.sh` are updated;
the installer now refuses `coop.*`). The "Hostname clash" note there can become a
one-line pointer.
