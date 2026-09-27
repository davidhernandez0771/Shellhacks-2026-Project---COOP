# COOPER: project context

ShellHacks 2026 hackathon project. A three-person team: David Hernandez Del Risco (software), Diego Tabares (presentation & story), and Diego Avila (design & hardware).

## What it is
**COOPER** is the name, written in all capitals everywhere a person reads it (docs, UI, page titles, log messages, comments); never "Cooper" or "COOPer". Lowercase `cooper` only where code requires it (package, imports, file names, CLI commands, config keys). There is no acronym; the story behind the name is the team's to write, so leave the ✏️ placeholders alone. The GitHub repo name and the README title are David's to change; keep the URLs `coop.davidhernandez.work` and `*.coop-224.pages.dev` as they are.

A static, car-mounted dashcam on a Raspberry Pi 5 (8 GB), powered by the car. It detects people and vehicles, predicts every tracked object's motion, and lights two LEDs: **yellow** = warning (an object's predicted path enters "my lane" within the horizon, or its time to contact is short), **red** = danger (something is in my lane now), both off = clear; red overrides yellow. The dashboard streams the video with every predicted path, the risk level, the LED state and an editable lane. There are no motors and no moving parts.

## Hardware facts
- Camera: OV5647 5 MP, 3.6 mm lens, 75° diagonal (≈63°×49° at 4:3), no IR. Uses Picamera2/libcamera. Needs the 15→22 pin Pi 5 cable. Fixed; it never rotates.
- LEDs: yellow and red on Pi GPIO through 330 Ω resistors, driven by gpiozero (lgpio backend on the Pi 5). Pins are placeholders (BCM 17 and 27, marked TODO in `cooper/config.py`).
- Power: the car, through a USB-C PD charger (5 V / 5 A).
- No accelerator: all inference runs on the Pi 5 CPU. Keep models small (YOLO11n, imgsz 320, NCNN export).

## Code conventions
- Python package `cooper/`; entry point `python -m cooper.main`.
- Every tunable value lives in `cooper/config.py` dataclasses (including the lane, thresholds and LED pins). Don't hardcode pins or thresholds elsewhere; `cooper.example.toml` must list every setting.
- Everything must run on a laptop without Pi hardware: the camera falls back to the webcam (`--source webcam`), and the LEDs are mocked automatically off a Pi (`--no-leds` forces it). `python -m tools.rehearsal` runs the whole app on a synthetic road.
- Hardware imports (`picamera2`, `gpiozero`) happen lazily inside functions; gpiozero comes from apt on the Pi, never from requirements.txt.
- Prediction and risk work in image space, on motion relative to the camera: a Kalman filter per object on the box's bottom-centre and height. `docs/MATH.md` is the reference; if you change the filter, the rules or a default, update it, `README.md` and `docs/DEVPOST.md` with the same numbers.
- If you change the API, update `docs/API.md` first, then `cooper/stream.py` and `web/`.

## Parallel terminals
Several Claude sessions may be working in this folder at once. Read `docs/TERMINALS.md` and stay in your lane's files. Commit only your own paths (never `git add -A`). The backend ↔ dashboard contract is `docs/API.md`; the look is `docs/DESIGN_BRIEF.md`.

## Owner preferences
David wants real technical explanations, not beginner simplifications. Propose options with a recommendation before big architecture or scope changes; once a direction is agreed, implement it without re-debating. Use small, descriptive commits.

## Devpost doc: keep it in sync
`docs/DEVPOST.md` holds the copy-paste-ready Devpost submission. In the same change as the code, update it whenever:
- a library, framework, language, tool or hardware part is added or removed → update "Built with" (max 25 tags, keep the count note accurate) and "How we built it"
- a feature is added, changed or removed → update "What it does" (and "What's next" if it was listed there)
- a notable technical problem gets solved → add it to "Challenges we ran into"
- the pitch changes → keep the elevator pitch ≤200 characters and update the count
Never fill in the ✏️ personal sections (inspiration, what we learned, the name's story) with invented content; those are the team's to write.
- The dev machine is Windows; the Pi runs Raspberry Pi OS Bookworm. Keep shell scripts LF (enforced by .gitattributes).
