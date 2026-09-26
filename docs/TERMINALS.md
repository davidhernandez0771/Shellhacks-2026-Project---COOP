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
| 3 | **Control API & hardware link** | `coop/stream.py`, `coop/control.py`, `coop/motors.py`, `firmware/**`, `scripts/**` | Implement every endpoint in `docs/API.md`: the mode, lock and aim state in `control.py`, plus the event log. Harden the serial link (reconnect). Pi deploy: a systemd service and a Cloudflare Tunnel guide. |
| 4 | **Quality & ship** | `tests/**`, `docs/DEVPOST.md`, `README.md`, `site/**` | pytest suite (pixel math, Kalman, target choice, serial protocol with a fake port, API with the Flask test client). Keep the docs current. Later: a landing page for the domain. |

**Lane 1 ↔ 3 handoff:** lane 3 builds `coop/control.py` (a thread-safe object holding mode, locked ID, manual aim and events). Lane 1 wires it into `main.py`'s loop. Agree on its interface here before coding it.

**Fewer terminals?** With 3, fold lane 4 into lanes 1 and 3. With 2, run lane 1, and have the second terminal do lanes 2 and 3 together.

## Requests
_(cross-lane asks: "lane X → lane Y: need ...". Delete when done.)_
