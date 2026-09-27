# Devpost submission: COOPER

Copy each section into the matching Devpost field. This file is kept up to date as the project changes; see "Keeping this current" at the bottom.

**Status legend:** ✏️ = needs your personal input before submitting.

---

## Project name
```
COOPER
```
✏️ _The story behind the name, and a tagline for the video and pitch, are yours to write._

## Elevator pitch
_(max 200 characters, currently 167)_
```
COOPER is a Raspberry Pi 5 dashcam that spots people and cars, predicts where each one is heading, and lights a yellow or red LED before something cuts into your lane.
```

---

## About the project
_(paste everything inside the box. Devpost supports Markdown and LaTeX)_

````markdown
## Inspiration
✏️ _What made you want to build this? A near miss, a car that cut in on you, a pedestrian stepping out from between parked cars, or just wanting to make hardware and AI work together. Write 2–4 sentences in your own words._

## What it does
COOPER is a car-mounted dashcam that warns you before something gets into your lane. A Raspberry Pi 5 with a camera sits behind the windshield, powered by the car. It never moves. It detects **people and vehicles** in real time, **predicts where every one of them is heading** over the next 1.5 seconds, and lights one of two LEDs:

- **Yellow: warning.** Something's predicted path enters your lane within 1.5 s (a car about to cut in, a pedestrian stepping off the curb), or it's closing on you fast.
- **Red: danger.** Something is in your lane right now.
- **Both off: clear.** Red overrides yellow, and the LEDs never flicker.

"Your lane" is a trapezoid of the road in front of the car, which you drag into place from the dashboard once the camera is mounted.

Everything streams live to a web dashboard: the video with every detected object, its predicted path drawn ahead of it, and the lane tinted yellow or red with the risk. A side panel says what COOPER is worried about and why ("car #201 heading into your lane in 0.8 s"), shows both LEDs, lists every object by risk, and logs every change. A diagnostics strip shows the Pi's temperature and throttling, the vision and camera frame rates, inference time and camera-to-LED latency; a tuning panel changes the prediction horizon and time-to-contact thresholds live. Every failure has its own designed state (no camera, connection lost, signed out), all in the same black-white-and-orange identity as the showcase site, down to phone width.

The dashboard is reachable from anywhere over HTTPS at the team's own subdomain, behind an email login.

## How we built it
**Vision (Raspberry Pi 5).** Frames come from a 5 MP OV5647 camera through Picamera2. A YOLO11n model (Ultralytics) detects people, cars, motorcycles, buses and trucks, and ByteTrack gives each object a persistent ID. Everything runs on the Pi 5's CPU. Capture runs on its own thread and the vision loop always takes the newest frame, dropping the ones that arrived during inference instead of queueing them, and each frame carries its capture timestamp so every filter is updated at the moment the photo was taken.

**Prediction in image space.** The camera rides with the car, so what matters for a collision is motion *relative to the camera*, which is exactly what the image shows. For each tracked object COOPER filters the bottom-centre of its box \\( (u, v) \\), where it touches the road, and the box height \\( h \\), which is proportional to 1/distance. A constant-velocity **Kalman filter** per object tracks \\( \mathbf{x} = [u, v, h, \dot u, \dot v, \dot h] \\) with

$$F = \begin{bmatrix} I & \Delta t\, I \\ 0 & I \end{bmatrix}, \quad H = \begin{bmatrix} I & 0 \end{bmatrix}, \quad Q_i = \sigma_i^2 \begin{bmatrix} \Delta t^4/4 & \Delta t^3/2 \\ \Delta t^3/2 & \Delta t^2 \end{bmatrix}, \quad R = 3^2 I$$

(\\( \sigma = 400 \\) px/s² for \\( u, v \\), 150 px/s² for \\( h \\)). Every matrix is block-diagonal per axis, so the six-state filter factors exactly into three two-state filters: a few dozen scalar operations per object per frame (a test checks it against the full 6×6 form).

**Risk.** Each object's path is sampled every 0.1 s out to 1.5 s. **Danger** when at least 20 % of its bottom edge is inside the lane now; **warning** when a predicted bottom edge enters the lane within the horizon, or when its **time to contact from scale growth**

$$\tau = \frac{h}{\dot h} = \frac{Z}{-\dot Z}$$

drops below 2.0 s while it's in the lane's corridor (released above 2.5 s). Hysteresis stops flicker: a level lights after 2 frames in a row and holds 0.5 s after its condition ends. The whole derivation is in `docs/MATH.md` in the repo.

**LEDs.** Two LEDs on the Pi's GPIO, driven with gpiozero, written only when they change. On any machine that isn't a Pi they're mocked automatically, so the whole app runs on a laptop.

**Streaming.** A Flask server on the Pi serves an MJPEG video stream and a JSON status API to a lightweight HTML/JS dashboard that any device on the network can open.

**Dashboard.** No build step: plain HTML, CSS and JS, with every color and spacing value in one `tokens.css` file. Everything drawn over the video (the lane, boxes and predicted paths) is on one `<canvas>` that redraws only when a new frame arrives, the feed is resized or a lane corner is dragged, so the dashboard stays light even on a phone. Dragging the lane's corners and pressing Apply updates the risk rules on the Pi on the very next frame; "Apply and save" writes it to the settings file. Without a backend it plays a mock of the same road with the same lane rules, so the UI is demoable anywhere.

**Dev without hardware.** `tools/rehearsal.py` runs the real app on a synthetic road seen through a fixed dashcam: a car in the next lane, a car cutting in, a pedestrian crossing and the lead car braking hard, drawn with the pinhole ground-plane model so box sizes scale exactly like on the real camera. Its detector reads the boxes back out of the rendered pixels, so everything from the capture thread to the dashboard is the real code. `--timeline` runs a loop offline and prints every risk and LED change.

**Settings without editing code.** Every tunable (camera, model, filter noise, lane, horizon, TTC thresholds, hysteresis, LED pins) can be overridden in a `cooper.toml` file, read with Python's built-in `tomllib`. Unknown keys and wrong types stop COOPER at startup with the key named and a "did you mean" suggestion. The lane and the risk thresholds can also be changed live from the dashboard, checked against the whole configuration (so the TTC warn threshold can't end up above its release threshold), and written back to `cooper.toml` with its comments preserved.

**Hardware.** A Raspberry Pi 5, the OV5647 camera and two LEDs with resistors, powered from the car through a USB-C PD charger. Diego Avila designed and built the mount and enclosure (Fusion 360) and wired all the hardware together.

**Deployment.** A systemd unit runs COOPER as soon as the car powers the Pi and restarts it if it crashes. A second unit runs a **Cloudflare Tunnel**, which publishes the dashboard at an HTTPS subdomain through an outbound-only connection, so it works behind any NAT (a phone hotspot included) with no port forwarding. **Cloudflare Access** sits in front: only approved email addresses (one-time PIN login) can see the camera.

**Showcase site.** The public page tells the story in scroll-driven chapters in one persistent three.js scene: a street of people and cars made of ~20,000 points. anime.js v4 drives the intro, the scroll timelines and the labels. It has no build step (native ES modules, vendored libraries, self-hosted fonts), a still version for reduced motion, and a 2D-canvas fallback for browsers without WebGL.

**Team.** David Hernandez Del Risco built the software: vision, tracking, prediction, risk, the site's first design, and the dashboard's backend. Diego Taberas shaped the pitch and the story of how COOPER came alive, and worked on part of the site's design. Diego Avila was the main designer and did the 3D CAD (Fusion 360), and wired all the hardware together.

**Testing.** A pytest suite covers the Kalman filter (against the full matrix form, the occlusion gate, time to contact), every risk rule and the hysteresis, the LEDs (gpio vs mock on a fake board, only writing on a change, releasing a half-claimed pin), the settings file, live settings and the lane API, the Flask API, diagnostics and the capture thread. It also runs the rehearsal's whole 20-second loop and checks that the cut-in, the pedestrian and the braking car each warn before they're danger, that the car in the next lane never lights an LED, and that no LED state lasts under a quarter second. GitHub Actions runs it on every push and pull request without installing PyTorch, Ultralytics or the Pi camera stack, which also proves the tests never load them.

## Challenges we ran into
- **Running AI with no accelerator.** All inference runs on the Pi 5's CPU, so we used the smallest YOLO model at a reduced input size and kept everything after it tiny: prediction and risk for ten objects take about a fifth of a millisecond on a laptop.
- **The camera moves with the car.** Instead of estimating our own motion, COOPER works on motion relative to the camera, in the image: an object's bottom edge says where it meets the road, and its box height says how close it is. That's exactly what decides a collision.
- **Jitter that looks like danger.** Time to contact from scale growth, \\( h / \dot h \\), is very sensitive: a car that isn't moving at all, with a few pixels of detector jitter, produced false "contact in under 2 s" readings in 20 of 50 simulated runs. COOPER now counts it only when the growth rate is more than two of its own standard deviations above zero (from the Kalman filter's covariance), which cut false alarms to almost none while a real approach still fires every time.
- **Occlusion put the ground under the wrong car.** A pedestrian walking behind a car in the next lane is seen only above that car's roof, so their box's bottom edge, which we treat as where they stand, jumped onto the roof and their predicted path swung out of the lane, making the warning drop out mid-crossing. The fix is Kalman innovation gating: measurements far outside the filter's prediction are rejected and it coasts. The subtle part: the gate widens while coasting, so on its own the ground point eventually accepted the bad value; gating it together with the box height (they come from the same edge) keeps it coasting until the person reappears.
- **A car far ahead is above the lane.** The lane only reaches about 14 m, so a braking car further out is outside it, and a time-to-contact rule limited to the lane would fire only once it was already there. The TTC corridor extends the lane's side edges towards the vanishing point.
- **A frame-rate readout that lied.** The dashboard showed 64 fps from a 31 fps camera: averaging \\( 1/\Delta t \\) overshoots whenever frames arrive unevenly. Inverting the average interval fixed it.
- **A dashboard that doesn't lie.** A request-time timestamp always looks fresh, and the Pi's and a phone's clocks disagree. Staleness is detected from a per-frame counter timed on the client's own clock, and an expired Cloudflare Access session is told apart from a dead network by reading the login redirect instead of the opaque CORS error.
- **A cinematic site that still runs on a judge's laptop.** The showcase animates ~20,000 points, so every person's walk cycle and every car's motion is computed in the vertex shader from a handful of uniforms: one draw call, and the CPU never touches the points.
- ✏️ _Add anything that actually went wrong during the hackathon (wiring, power in the car, mounting, calibration, time pressure). Judges like real stories._

## Accomplishments that we're proud of
- The full loop from camera to AI to prediction to a warning light, on a single Pi 5 with no accelerator
- Warnings that come *before* something is in your lane, not after
- The whole system runs on a laptop without any hardware (webcam or a synthetic road, mocked LEDs), which let software and hardware be built in parallel
- ✏️ _Add your own._

## What we learned
- ✏️ _In your own words: e.g. Kalman filters, time to contact, why the bottom edge of a box matters, real-time constraints on a small computer._

## What's next for COOPER
- Detect the actual lane lines, so "my lane" follows curves instead of being a fixed region
- A buzzer alongside the LEDs, and night vision with an IR camera module
- Read the car's speed over OBD-II to scale the horizon with speed
- A clean shutdown when the ignition turns off, to protect the SD card
- Faster inference with an AI accelerator HAT
````

---

## Built with
_(up to 25 tags, currently 22. Type each one into the tag box)_
```
python
raspberry-pi
yolo
ultralytics
pytorch
ncnn
bytetrack
opencv
numpy
kalman-filter
flask
picamera2
gpiozero
three.js
anime.js
html
css
javascript
systemd
cloudflare
pytest
github-actions
```

---

## "Try it out" links
```
https://coop.davidhernandez.work
https://github.com/davidhernandez0771/Shellhacks-2026-Project---COOP
```
Don't list the live dashboard: it's behind Cloudflare Access, so judges would hit a login wall.

---

## Image gallery
_(JPG/PNG/GIF, ≤5 MB each, 3:2 ratio works best, up to 15 images)_

Shot list:
- [ ] Hero photo of COOPER mounted behind the windshield (first image = thumbnail)
- [ ] Dashboard showing a yellow warning: a car's predicted path cutting into the lane
- [ ] Dashboard showing red: something in the lane
- [ ] The two LEDs lit, in the car
- [ ] Inside the build: Pi 5, camera, LEDs and wiring
- [ ] Wiring diagram (see `hardware/README.md`)
- [ ] The team working on it

The screenshots in `docs/screenshots/` show the old motorized-gimbal dashboard and will be replaced.

## Video demo link
_(YouTube / Vimeo / Facebook / Youku link; embedded at the top of the page)_

Suggested 1–2 minute outline:
1. **(0:00–0:10)** Hook: from the driver's seat, a car starts to drift into the lane and the yellow LED lights before it's there.
2. **(0:10–0:30)** What it is: the one-line pitch, over a shot of COOPER on the windshield.
3. **(0:30–1:10)** Live demo: the dashboard side by side with the road; the predicted paths, yellow for a cut-in, red once it's in the lane, and a car in the next lane that never lights anything.
4. **(1:10–1:40)** How it works: camera → YOLO → Kalman filter per object → lane risk → LEDs, with the time-to-contact idea.
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
