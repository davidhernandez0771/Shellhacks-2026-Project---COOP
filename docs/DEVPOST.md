# Devpost submission: COOP

Copy each section into the matching Devpost field. This file is kept up to date as the project changes; see "Keeping this current" at the bottom.

**Status legend:** ✏️ = needs your personal input before submitting.

---

## Project name
```
COOP
```

## Elevator pitch
_(max 200 characters, currently 191)_
```
COOP is an AI tracking camera on a Raspberry Pi 5 that spots people and cars, predicts where they're heading, and turns on stepper motors to keep them in frame, streamed live to your browser.
```

---

## About the project
_(paste everything inside the box. Devpost supports Markdown and LaTeX)_

````markdown
## Inspiration
✏️ _What made you want to build this? A problem you've seen, a use case (security, sports filming, traffic monitoring, wildlife), or just wanting to make hardware and AI work together. Write 2–4 sentences in your own words._

## What it does
COOP is a self-aiming camera. A Raspberry Pi 5 watches the scene, detects **people and vehicles** in real time, locks onto a target, and physically rotates the camera on stepper motors to keep that target centered, even as it moves. Instead of chasing where the target *was*, COOP **predicts where it's going** and aims ahead of it.

Everything streams live to a web dashboard: the annotated video feed with bounding boxes and track IDs, the current target, the camera's pan/tilt angle, and the target's estimated velocity.

## How we built it
**Vision (Raspberry Pi 5).** Frames come from a 5 MP OV5647 camera through Picamera2. A YOLO11n model (Ultralytics) detects people, cars, motorcycles, buses and trucks, and ByteTrack gives each object a persistent ID so COOP doesn't jump between targets.

**Target selection.** COOP sticks with its current track ID for as long as it's visible. When it loses the target, it picks a new one by class priority (people first), then by size.

**Motion prediction.** We convert each detection from pixels into a *world angle*, combining the camera's own pan/tilt with the target's angular offset in the frame (pinhole model):

$$\theta_{target} = \theta_{gimbal} + \arctan\left(\frac{x - w/2}{w/2}\,\tan\frac{\text{FOV}_h}{2}\right)$$

Working in world angles means the camera's own rotation doesn't look like target motion. A constant-velocity **Kalman filter** tracks the state \\( [\theta_{pan}, \theta_{tilt}, \dot\theta_{pan}, \dot\theta_{tilt}] \\), and we aim at the predicted position \\( \theta + \dot\theta \cdot t_{lead} \\) to cancel out the processing latency.

**Motion control (Arduino Uno).** The Pi sends target positions over USB serial to an Arduino Uno. The Uno uses AccelStepper to drive two NEMA 17 steppers through TMC2209 drivers, with smooth acceleration ramps. A heartbeat watchdog stops the motors if the Pi goes silent.

**Streaming.** A Flask server on the Pi serves an MJPEG video stream and a JSON status API to a lightweight HTML/JS dashboard that any device on the network can open.

**Dev without hardware.** With motors mocked, a virtual gimbal (`coop/sim.py`) crops a panning window out of the laptop webcam's frame, centered wherever the simulated pan/tilt currently points, so tracking is visibly following a person on a laptop with no motors or Pi camera attached.

**Hardware.** One 12 V supply powers everything: the motors directly, and the Pi through a 5.1 V buck converter. The mount and enclosure were designed and built by our hardware lead.

## Challenges we ran into
- **Running AI with no accelerator.** All inference runs on the Pi 5's CPU, so we used the smallest YOLO model at a reduced input size and kept the rest of the pipeline lightweight.
- **The camera moves itself.** When the camera turns, everything in the frame appears to move. Tracking in world angles instead of pixels fixed this.
- **Latency.** By the time a frame is processed and the motors move, the target has already moved on. The Kalman predictor aims ahead to compensate.
- **Real-time stepping.** Python on Linux can't produce reliably timed step pulses, so we moved step generation to an Arduino and kept the Pi focused on vision.
- ✏️ _Add anything that actually went wrong during the hackathon (wiring, power, calibration, time pressure). Judges like real stories._

## Accomplishments that we're proud of
- A full loop from camera to AI to prediction to motors, running on a single Pi 5
- Prediction that leads moving targets instead of lagging behind them
- The whole system runs on a laptop without any hardware (webcam + simulated motors), which let software and hardware be built in parallel
- ✏️ _Add your own._

## What we learned
- ✏️ _In your own words: e.g. Kalman filters, stepper drivers and current limits, real-time constraints, splitting work between a Pi and a microcontroller._

## What's next for COOP
- Night vision with an IR camera module
- Homing with limit switches, and a slip ring for continuous 360° pan
- Manual control and target selection from the dashboard
- Event recording and alerts (e.g. a person detected in a zone after hours)
- Faster inference with an NCNN export or an AI accelerator HAT
````

---

## Built with
_(up to 25 tags, currently 23. Type each one into the tag box)_
```
python
raspberry-pi
arduino
c++
yolo
ultralytics
pytorch
bytetrack
opencv
numpy
kalman-filter
flask
pyserial
picamera2
libcamera
accelstepper
tmc2209
nema-17
stepper-motor
computer-vision
html
css
javascript
```

---

## "Try it out" links
```
https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOP
```

---

## Image gallery
_(JPG/PNG/GIF, ≤5 MB each, 3:2 ratio works best, up to 15 images)_

Shot list:
- [ ] Hero photo of the finished COOP unit (first image = thumbnail)
- [ ] Dashboard screenshot while tracking a person (bounding boxes and aim crosshair visible)
- [ ] Dashboard tracking a car
- [ ] Inside the build: Pi, Uno, TMC2209s, buck converter
- [ ] Wiring or architecture diagram (see `hardware/README.md`)
- [ ] The team working on it

## Video demo link
_(YouTube / Vimeo / Facebook / Youku link; embedded at the top of the page)_

Suggested 1–2 minute outline:
1. **(0:00–0:10)** Hook: someone walks across the room and COOP turns to follow them.
2. **(0:10–0:30)** What it is: the one-line pitch, over a shot of the hardware.
3. **(0:30–1:10)** Live demo: the dashboard side by side with the camera, then switching targets and tracking a car.
4. **(1:10–1:40)** How it works: the pipeline diagram (camera → YOLO → Kalman → Arduino → steppers).
5. **(1:40–2:00)** What's next, and the team.

```
✏️ paste video URL here
```

---

## Keeping this current
Claude sessions in this repo are instructed (via `CLAUDE.md`) to update this file whenever:
- a library, tool, language or hardware part is added or removed → **Built with** and **How we built it**
- a feature is added or changed → **What it does**
- a real problem gets solved → **Challenges**
