# Parallel work plan (multiple Claude terminals)

Every terminal works in the same folder on its **own files**. Shared contracts are in `docs/API.md` (backend ↔ web), `docs/MATH.md` (the filter and risk rules) and `docs/DESIGN_BRIEF.md` (look).

## Rules for every terminal
1. Only edit files in your lane. If you need a change in another lane's file, write it in the **Requests** section at the bottom of this file instead.
2. Commit **only your own paths** (`git add <your paths>`); never use `git add -A` or `git commit -a`, because other terminals have uncommitted work in the same folder.
3. Pull before you push; push small commits often.
4. Update `docs/DEVPOST.md` when you add a library, a feature, or solve a real problem (see `CLAUDE.md`).

## Lanes

| # | Lane | Owns | Goal |
|---|---|---|---|
| 1 | **Vision, prediction & risk** | `cooper/main.py`, `cooper/camera.py`, `cooper/detector.py`, `cooper/predictor.py`, `cooper/risk.py`, `cooper/config.py`, `docs/MATH.md` | The main loop, the per-object Kalman filter and the lane rules. Measure and tune FPS and the risk thresholds on real footage. Keep `docs/MATH.md` matching the code. |
| 2 | **Web dashboard** | `web/**` | The dashboard against `docs/API.md` and `docs/DESIGN_BRIEF.md`. Use the mock (`web/mock.js`) until an endpoint exists. |
| 3 | **API, LEDs & deploy** | `cooper/stream.py`, `cooper/control.py`, `cooper/settings.py`, `cooper/diag.py`, `cooper/leds.py`, `cooper.example.toml`, `tools/**`, `scripts/**`, `.github/**`, `hardware/README.md`, `docs/HARDWARE_TEST.md`, `docs/API.md` | Every endpoint in `docs/API.md`, live settings and the lane, the LEDs on GPIO, Pi deploy (systemd, Cloudflare Tunnel), CI, and the first-hardware checklist. |
| 4 | **Quality & ship** | `tests/**`, `docs/DEVPOST.md`, `README.md`, `site/**` | The pytest suite, the docs and the Devpost copy, and the showcase site. |

**Lane 1 ↔ 3 handoff:** `cooper/main.py` (lane 1) publishes the status that `cooper/stream.py` (lane 3) serves; the shape is in `docs/API.md`. The lane lives in `cfg.risk.lane`: lane 3's `/api/lane` writes it, lane 1's risk judge reads it every frame.

**Fewer terminals?** With 3, fold lane 4 into lanes 1 and 3. With 2, run lane 1, and have the second terminal do lanes 2 and 3 together.

## Requests
_(cross-lane asks: "lane X → lane Y: need ...". Delete when done.)_
