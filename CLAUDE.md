# COOP: project context

ShellHacks 2026 hackathon project. A two-person team: David (software) and a teammate (design/hardware).

## What it is
A Raspberry Pi 5 (8 GB) tracking camera. It detects people and cars, predicts their motion, rotates on stepper motors to follow the target, and streams live video to a browser on the laptop.

## Hardware facts
- Camera: OV5647 5 MP, 3.6 mm lens, 75° diagonal (≈63°×49° at 4:3), no IR. Uses Picamera2/libcamera. Needs the 15→22 pin Pi 5 cable.
- Motors: NEMA 17 on TMC2209 (standalone STEP/DIR, 8 microsteps by default), driven by an Arduino Uno running `firmware/coop_motors` (AccelStepper). The Pi talks to the Uno over USB serial using the ASCII protocol documented in the .ino header. The Pi does NOT drive motor GPIO directly.
- No Jetson, no ESP32-CAM, no accelerator: all inference runs on the Pi 5 CPU. Keep models small (YOLO11n, imgsz 320, NCNN export).

## Code conventions
- Python package `coop/`; entry point `python -m coop.main`.
- Every tunable value lives in `coop/config.py` dataclasses. Don't hardcode pins or thresholds elsewhere.
- Everything must run on a laptop without Pi hardware: camera falls back to the webcam, motors fall back to mock mode (`--source webcam --no-motors`).
- Hardware imports (`picamera2`, `serial`) happen lazily inside functions.
- If you change the serial protocol, update both `coop/motors.py` and the .ino file.
- Tracking and prediction work in world-angle space (gimbal angle + in-frame offset), not pixels.
- The dev machine is Windows; the Pi runs Raspberry Pi OS Bookworm. Keep shell scripts LF (enforced by .gitattributes).
