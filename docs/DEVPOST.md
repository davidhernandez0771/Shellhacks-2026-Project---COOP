# Devpost submission: COOP

Copy each section into the matching Devpost field. This file is kept up to date as the project changes; see "Keeping this current" at the bottom.

**Status legend:** ✏️ = needs your personal input before submitting.

---

## Project name
```
COOP
```
**Stands for:** Computer-vision Object Observation & Prediction.
**Tagline for the video and pitch:** "COOP keeps an eye on the coop."

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
COOP (**C**omputer-vision **O**bject **O**bservation & **P**rediction) is a self-aiming camera. A Raspberry Pi 5 watches the scene, detects **people and vehicles** in real time, locks onto a target, and physically rotates the camera on stepper motors to keep that target centered, even as it moves. Instead of chasing where the target *was*, COOP **predicts where it's going** and aims ahead of it.

Everything streams live to a web dashboard: the annotated video feed with clickable bounding boxes (click a detection to lock onto it), the current target's confidence and velocity, a pan dial showing the gimbal's live and predicted angle against its physical limits, and a scrolling event log. An operator can also take over: flip the Auto/Manual/Stop switch, drive the gimbal with a D-pad in manual mode, or lock onto a specific track — every mode change and target lock/loss is written to that event log. A hardware-style **E-STOP** brakes the motor and then cuts driver power until someone explicitly re-arms it, **ZERO** makes wherever the camera points the new 0°, and in Stop mode the drivers power down after a while so the motor doesn't sit there heating up. It's a glassy, dark control-room look that works down to phone width, since judges open it on their own devices.

The dashboard is reachable from anywhere over HTTPS at the team's own subdomain, behind an email login, so only approved people can watch the feed or take control.

## How we built it
**Vision (Raspberry Pi 5).** Frames come from a 5 MP OV5647 camera through Picamera2. A YOLO11n model (Ultralytics) detects people, cars, motorcycles, buses and trucks, and ByteTrack gives each object a persistent ID so COOP doesn't jump between targets. Capture runs on its own thread and the vision loop always takes the newest frame, dropping the ones that arrived during inference instead of queueing them, so the tracker never aims from a backlog. Each frame carries its capture timestamp: the Kalman filter is updated at the moment the photo was taken, and the dashboard shows the measured capture-to-motor-command latency.

**Target selection.** COOP sticks with its current track ID for as long as it's visible. When it loses the target, it picks a new one by class priority (people first), then by size.

**Motion prediction.** We convert each detection from pixels into a *world angle*, combining the camera's own pan/tilt with the target's angular offset in the frame (pinhole model):

$$\theta_{target} = \theta_{gimbal} + \arctan\left(\frac{x - w/2}{w/2}\,\tan\frac{\text{FOV}_h}{2}\right)$$

Working in world angles means the camera's own rotation doesn't look like target motion. A constant-velocity **Kalman filter** tracks the state \\( [\theta_{pan}, \theta_{tilt}, \dot\theta_{pan}, \dot\theta_{tilt}] \\), and we aim at the predicted position \\( \theta + \dot\theta \cdot t_{lead} \\) to cancel out the processing latency.

**Motion control (Arduino Uno).** The Pi sends target positions over USB serial to an Arduino Uno. The Uno uses AccelStepper to drive two NEMA 17 steppers through TMC2209 drivers, with smooth acceleration ramps. A heartbeat watchdog stops the motors if the Pi goes silent.

**Streaming.** A Flask server on the Pi serves an MJPEG video stream and a JSON status API to a lightweight HTML/JS dashboard that any device on the network can open.

**Dashboard.** No build step: plain HTML, CSS and JS, with every color/radius/spacing value in one `tokens.css` file so the look stays consistent. Detection boxes are drawn client-side as an SVG overlay sized to the video's own coordinate space, so they line up with the stream and stay clickable. Since the vision and control-API work happened in parallel on separate machines, the dashboard ships with a client-side mock data source that mimics the real `/api/*` responses; it auto-detects a live backend and falls back to the mock seamlessly, so the UI was fully buildable and demoable before the endpoints existed.

**Dev without hardware.** With motors mocked, a virtual gimbal (`coop/sim.py`) crops a panning window out of the laptop webcam's frame, centered wherever the simulated pan/tilt currently points, so tracking is visibly following a person on a laptop with no motors or Pi camera attached.

**Control API.** A thread-safe `Control` object (`coop/control.py`) holds the operating mode (auto/manual/stop), an operator's target lock, the manual-aim setpoint, and a rolling event log, shared between the tracking loop and the Flask routes it drives (`/api/mode`, `/api/target`, `/api/aim`, `/api/nudge`, `/api/home`, `/api/events`). The Arduino serial link runs its own supervisor thread: if the connection drops it falls back to mock motion and keeps retrying in the background, logging `motor_connected`/`motor_disconnected` events, so a loose USB cable degrades the demo instead of crashing it.

**Settings without editing code.** Every tunable (motor direction, microstepping, gear ratio, limits, speed, prediction lead, confidence) can be overridden in a `coop.toml` file on the Pi, read with Python's built-in `tomllib`. Unknown keys and wrong types stop COOP at startup with the key named and a "did you mean" suggestion, because a silently ignored typo is how a motor ends up spinning the wrong way on demo day. The settings that need tuning with the hardware in front of you (prediction lead, deadband, confidence, motor speed and acceleration, direction) can also be changed live from the dashboard through `POST /api/settings`, applied on the next frame without a restart, and optionally written back to `coop.toml` with its comments preserved.

**Hardware.** One 12 V supply powers everything: the motors directly, and the Pi through a 5.1 V buck converter. The mount and enclosure were designed and built by our hardware lead.

**Deployment.** A systemd unit (`scripts/coop.service`, installed by `scripts/install_service.sh`) runs COOP on boot and restarts it automatically if it crashes. A second unit runs a **Cloudflare Tunnel**, which publishes the dashboard at an HTTPS subdomain through an outbound-only connection, so it works from venue Wi-Fi behind NAT with no port forwarding. **Cloudflare Access** sits in front: only approved email addresses (one-time PIN login) can see the camera or send it commands. The live MJPEG stream passes through the tunnel unbuffered.

**Testing.** A pytest suite covers the pixel-to-angle math, the Kalman predictor, target selection, the `Control` state machine, and the Flask API (via Flask's test client) — plus the Arduino serial protocol against a fake serial port that plays the Uno's side of the handshake, including simulated link drops. Because the hardware arrived last, we also wrote an **emulator of our own Arduino firmware** (`tools/fake_uno.py`): it parses commands with the sketch's exact rules, runs an AccelStepper-style acceleration ramp and the 2 s watchdog in real time, and tracks the step counter and the physical shaft separately, so a test can tell when the controller has lost count. pyserial opens it as `socket://localhost:5555`, so the real motor code can't tell the difference. On top of it, a rehearsal mode runs the entire app against a synthetic walker seen by a camera that turns with the emulated shaft: tracking, E-STOP, zeroing and USB unplug/replug were all exercised end to end before the first motor was wired. Bench tools for the day the hardware arrives jog the motor from the keyboard, check the camera, and benchmark YOLO in PyTorch vs NCNN at several input sizes. None of it needs a Pi, camera, or Arduino attached. GitHub Actions runs the suite on every push and pull request with only the lightweight dependencies installed. It skips the multi-GB PyTorch/Ultralytics install entirely, which also proves the tests never load the model or the Pi camera stack.

## Challenges we ran into
- **Running AI with no accelerator.** All inference runs on the Pi 5's CPU, so we used the smallest YOLO model at a reduced input size and kept the rest of the pipeline lightweight.
- **The camera moves itself.** When the camera turns, everything in the frame appears to move. Tracking in world angles instead of pixels fixed this.
- **Latency.** By the time a frame is processed and the motors move, the target has already moved on. The Kalman predictor aims ahead to compensate.
- **Tracker IDs break when the camera moves.** ByteTrack matches boxes between frames by pixel overlap, so when the gimbal slews onto a target the box jumps and the same person gets a new ID, silently dropping an operator's lock. When the tracked ID vanishes, COOP now re-identifies it as the detection closest to where the Kalman filter predicts the target in world angles, and carries the lock over. In testing, 11 of 12 lock switches held through the slew; before the fix, both attempts dropped within a second.
- **Real-time stepping.** Python on Linux can't produce reliably timed step pulses, so we moved step generation to an Arduino and kept the Pi focused on vision.
- **A flaky USB link shouldn't end the demo.** The Arduino connection can drop mid-run (a bumped cable, a brownout). We moved the serial link to its own supervisor thread that keeps retrying instead of taking down the whole process. The subtle part was reconnecting *safely*: opening the port resets the Uno, which zeroes its step counter wherever the camera stopped, so replaying the last target would have turned the camera past its cable limits. Now the Pi restores the Uno's counter to the last position it reported (a new `Z <pan> <tilt>` command) and freezes its own angle estimate during the outage instead of simulating motion that isn't happening.
- **An emergency stop that doesn't lose track of where the camera is.** The obvious e-stop, "stop, then cut motor power", is wrong for a stepper: the Arduino's AccelStepper keeps counting the steps of its braking ramp even with the drivers disabled, so at full speed the controller would believe the camera turned up to 75° further than it did. COOP brakes first and cuts power only once the reported position has been still for a quarter second (with a worst-case deadline), never sends a move while power is off, and re-disables the drivers after a USB reconnect because the Arduino boots with them on. A firmware emulator that tracks the step counter and the physical shaft separately proves the two stay equal.
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
- Alerts on top of the event log (e.g. a person detected in a zone after hours)
- Faster inference with an NCNN export or an AI accelerator HAT
````

---

## Built with
_(up to 25 tags, currently 25. Type each one into the tag box)_
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
computer-vision
html
css
javascript
systemd
cloudflare
pytest
```

---

## "Try it out" links
```
https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOP
```
✏️ Once `site/` is deployed (see `site/README.md`), add the showcase URL here too, e.g. `https://coop.<your-domain>`. Don't list the live dashboard: it's behind Cloudflare Access, so judges would hit a login wall.

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
