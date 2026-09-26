# Morning report: `cloud/showcase` (Parts B and C)

Overnight cloud session, 2026-09-26. Branch **`cloud/showcase`** (from `dev`), pushed; nothing went to `dev` or `main`. Part A is on `cloud/hardware-ready` with its own report.

## TL;DR
- **Showcase (`site/`)**: rebuilt from scratch as a cinematic WebGL site: dotted-ring loader with an Enter `>>>` gate, the "COOP" scrambleText decode (→ full name → tagline), and seven scroll-driven chapters in one persistent three.js scene. Reduced-motion and no-WebGL versions, phones, docs. **Preview:** `https://cloud-showcase.coop-224.pages.dev` (Cloudflare Pages branch alias for `cloud/showcase`; see "Previewing").
- **Dashboard (`web/`)**: same black/white/orange identity; pan-only with the pan gauge as the hero instrument (click or drag it to aim), leader-line detection labels that decode in, E-stop / Arm / Zero, a diagnostics strip, live tuning, and a designed state for every failure. **Tested end to end against Part A's real backend** (`tools/rehearsal.py`: real loop + fake Uno + synthetic camera).
- Screenshots of everything: `docs/screenshots/` (39 JPEGs: site at 1440 and 390 px, reduced motion, no WebGL; dashboard live, manual and every state).

## What was done

### Part B: the showcase
| Chapter | What happens |
|---|---|
| Loader | 48-dot ring filled by real load progress (fonts → anime.js → three.js + scene → shaders compiled), reticle ticks, "Locked", then **Enter `>>>`** (click or Enter key). |
| Intro | Brackets close in like autofocus; **"COOP" decodes out of noise** letter by letter with anime.js `scrambleText` (cursor `░▒▓█`), brackets snap orange (lock), the line below decodes into "Computer-vision Object Observation & Prediction", then re-scrambles into "COOP keeps an eye on the coop." while the full name settles above the word. |
| 01 See | A street of ~20k points (people walking, cars, lamps, facades) forms out of the intro's noise. COOP's own 4:3 viewfinder with a live frame counter, and a band sweeping down the frame like the OV5647's rolling shutter. |
| 02 Detect | Corner brackets snap onto each figure in turn with leader lines and mono labels (`PERSON #3 · CONF 0.87`) that scramble in; the target locks (orange). |
| 03 Predict | The camera follows with lead; velocity arrow, orange ghost at *t*+1.6 s with a fading trail and aim reticle, angular rate label. Mid-chapter the copy hands over to the typeset equations (pixel→world angle and the lead aim), with annotated terms. |
| 04 Move | Third-person view: the rig turns to follow, its field-of-view frustum fades out from the lens, a dashed aim ray, and a ±170° arc gauge (pan, aim, limits). |
| 05 Build | Exploded, to-scale technical drawing: 12 V supply → buck, NEMA 17, TMC2209, Uno, Pi 5, OV5647, with aligned leader-line labels. |
| 06 Gallery | A 3D ring of 8 cards that turns card by card with scroll, plus drag with inertia. Placeholder cards until media is added. |
| 07 Team | David + teammate placeholder, GitHub and Devpost links, and a closing portrait of the rig slowly scanning. |

Also: a floating pill nav (collapses to "07 Menu" on phones), the chapter scrubber (`03 / 07`) and a **bearing tape** along the bottom that slides with the camera's pan angle (the design's signature: in COOP, scroll *is* panning), word-by-word reveals scrubbed by scroll, and a desktop cursor that turns into lock brackets over links and says "Drag" over the gallery.

**Quality bar, measured:**
- Console: 0 errors and 0 warnings across every run (1440, 390, reduced motion, no WebGL).
- No horizontal overflow at 1440 or 390.
- Load before the first interaction: about **1.16 MB raw / 450 KB gzipped** (three.js is 742 KB of that, behind the loader). Gallery media loads only near the gallery; GLTFLoader only if a model is set; the equation fonts are ~50 KB.
- 60 fps: **not verifiable here** (the container renders WebGL on the CPU through SwiftShader: 12–25 fps there). The scene is built for it: one draw call for all points with the animation in the vertex shader, capped point sizes, DPR capped at 1.75, and adaptive resolution that drops the pixel ratio if frames stay slow. Please check on a real laptop.
- Reduced motion: a still version with no gate; chapters cut between static compositions.
- No WebGL: the same scene is rendered as still frames on a 2D canvas; the gallery becomes a grid.

`site/README.md` explains editing copy, adding photos/videos (one `<li>` per item), swapping in the real camera `.glb` (one constant in `js/stage/solids.js`; tested with a generated test model), and deploying. `site/CREDITS.md` lists licenses.

### Part C: the dashboard
- **Identity:** `web/tokens.css` now matches the showcase; `docs/DESIGN_BRIEF.md` rewritten. No red or green: severity is orange plus shape (hazard stripes, fill vs. outline).
- **Pan-only:** the tilt D-pad is gone. The gauge shows pan (needle), aim (orange mark) and limits, with ◀ Home ▶ and click/drag-to-aim in Manual.
- **Detections:** corner brackets with leader-line mono labels that flip at the frame edge; a newly seen or newly acquired target's label decodes in.
- **Safety:** one-click **E-stop** (also key `X`, fires before anything re-renders), **Arm** from the banner, **Zero here** with a 3 s confirm click.
- **Diagnostics strip:** CPU °C, power/throttling (decoded bits in the tooltip), vision fps, camera fps, inference ms, latency ms, Arduino link, uptime. Missing values show "–".
- **Tuning panel** (collapsed): lead time, deadband, confidence, max speed and acceleration (shown in °/s), pan invert (only in Stop), Apply or Apply and save.
- **Designed states:** no camera, Arduino reconnecting, signed out (Access expired), offline, stale, e-stop, drivers powered down, no target (four variants). Preview any of them with mock data: `web/index.html?demo=nocam|reconnecting|expired|offline|stale|estop|notarget|hot`.
- **`web/mock.js`** implements the whole new contract (estop/arm/zero/settings, diag, drivers idle, events).

## Review passes (what each one caught)

### Showcase
1. **Correctness (first screenshots):** leader lines from the Build chapter stayed on screen through Gallery and Team. Diagnosed: `clearRect` on the overlay canvas did not clear it (reproduced with an explicit clear + readback; a bitmap reset did). The overlay now resets its bitmap per drawn frame and skips drawing when idle. Also: people walked behind the copy, labels ran off the right edge, the equations overlapped the target, the exploded view was too big and clipped, the gauge's labels collided, the carousel sat between cards, and the orange cursor was stuck at (0,0) after the gate.
2. **Retest:** fixed the above: an off-centre camera (subject right of the copy on desktop, above it on phones), a shader fade for anything passing behind the copy, labels that flip left at the edge, the copy→equations hand-off in 03, a smaller exploded view with aligned labels, a gauge moved out of the scene, and the carousel dwelling card by card. The target now paces back and forth instead of wrapping around, so every chapter reliably has it in frame and the prediction visibly flips when it turns. On phones: the wordmark clipped and the narrow aspect cropped the scene out entirely; fixed with a phone-sized wordmark and a minimum horizontal FOV.
3. **Art direction:** every chapter was the same template, and 01 See had no moment of its own, so See got the viewfinder, frame counter and rolling-shutter sweep. The ghost read as a smear (moved further ahead, trail made fainter). Labels re-scrambled on every number tick (now only when their subject changes).
4. **Final pass, weakest section:** 07 Team ended on a generic particle field. It now closes on a portrait of the rig scanning (dimmed on phones, where it would sit behind text).

### Dashboard
1. **Correctness:** with no gimbal data (no camera / signed out) the gauge was blank; the "Arduino reconnecting" chip was unreadable on hazard stripes; on phones the diagnostics came before the pan instrument (a CSS ordering bug); labels clipped at the right edge on phones.
2. **Retest against the real backend** (`tools/rehearsal.py` from `cloud/hardware-ready`, driven by Playwright): mode switches, nudge (+10°), dial click (→ −85° as expected), Home, E-stop (drivers off, banner), a mode change blocked with a clear message, Arm, two-step Zero, a settings change applied server-side, pan-invert locked outside Stop, and the event log showing every step. 0 console errors.
3. **Art direction:** a filled orange "Lock target" was the loudest thing on the page and competed with E-stop; it's now an orange outline, so E-stop is the only filled orange control. Removed a middle-dot hint row that wrapped badly.

## Decisions I made (please check)
1. **Design direction "Bearing"** out of three (`docs/DESIGN_DIRECTIONS.md`): Archivo at its widest for display, Martian Mono for telemetry, STIX Two for the equations only. Orange means lock.
2. **Libraries are vendored, not loaded from a CDN.** jsdelivr/esm.sh were blocked from the container, and self-hosting is faster and has no third-party dependency on demo day anyway. three.js was minified with esbuild once (documented in `site/README.md`); there's still no build step.
3. **The dashboard does not load anime.js**: the label scramble is ~30 lines in `app.js`, so the Pi serves no extra 118 KB.
4. **The dashboard now depends on Part A's API** (`estop`, `diag`, `/api/estop|arm|zero|settings`), with field names taken from `docs/API.md` on `cloud/hardware-ready` (it was already there). I did not edit `docs/API.md` on this branch, to avoid a conflict. **Merge `cloud/hardware-ready` first**, then this branch. Against an old backend it degrades: diagnostics show "–", and E-stop/Zero/Tuning report "This COOP build doesn't support that yet."
5. **Devpost "Built with"** was already at 25 tags; I swapped `libcamera` (covered by `picamera2`) and `computer-vision` (a topic, not a tool) for `three.js` and `anime.js`. Part A also edits `docs/DEVPOST.md`, so expect a small merge conflict there.
6. **Numbers on the showcase:** real where they describe COOP (FOV, frame size, 150 ms lead, ±170° limits, parts). The detection confidences, walking figures and frame counter are an illustration; `site/README.md` says so. The ghost is drawn 1.6 s ahead (labelled `AIM · t + 1.6 s`) because 150 ms would be invisible.
7. **E-stop keyboard shortcut is `X`** (not Space or Escape, which scroll or close things).

## What's not done / needs you
- ✏️ Placeholders: teammate name and line, the Devpost URL, gallery photos and videos, the real hostname in `<head>`, and a `.glb` of the camera if you want it (all listed in `site/README.md`).
- Real-GPU performance check (see above).
- Cloudflare Pages: if project `coop-224` isn't connected to the repo yet, connect it (framework None, no build command, output `site`), then the preview URL above works.
- `docs/API.md` on this branch is the old version until `cloud/hardware-ready` is merged.

## Previewing
- **Cloudflare Pages:** `https://cloud-showcase.coop-224.pages.dev` (branch alias = branch name lowercased, `/` → `-`).
- **Locally:** `python -m http.server 8765 --directory site`, then `/`, `/?still` (reduced motion), `/?nogl` (no WebGL), `/#build` (deep link).
- **Dashboard without hardware:** `python -m http.server 8767 --directory web` and open `/?demo=estop` (or any state above). With Part A merged: `python -m tools.rehearsal` and open http://localhost:8000.

## Tomorrow's hardware session (dashboard side)
Follow `docs/HARDWARE_TEST.md` on `cloud/hardware-ready` for the bench order (emulator → jog → camera check → FPS bench → full run). On the dashboard:
1. Open the dashboard; the header should say **Live · N fps** (no "mock") and the Pan chip **Motors live**. The diagnostics strip should show a real CPU temperature and **Arduino: connected**.
2. **Before anything moves, find E-stop** (top right, or `X`). Press it once: the banner says the drivers are off and the shaft should turn freely by hand. Press **Arm**.
3. Switch to **Manual** (`2`), press ▶ once. If the camera turns left, open **Tuning**, switch to **Stop**, tick **Invert pan**, **Apply and save**.
4. Point the camera straight ahead by hand (during E-stop if needed), then **Zero here** twice.
5. Click the dial at +30° and −30°: the camera should follow the needle. If it overshoots or crawls, adjust **Max speed** / **Acceleration** in Tuning.
6. **Auto** (`1`), walk across the room: the brackets should lock (orange when you click your box), and the orange aim mark should lead you. Tune **Lead time** so the aim sits just ahead, and **Deadband** if it jitters while you stand still.
7. Unplug the Uno's USB: the banner should say **Arduino reconnecting** and the camera should hold still; plug it back in and it resumes.
8. Watch **Power** and **CPU**: anything other than "OK", or ≥ 80 °C, turns orange. Hover for the decoded throttle bits (under-voltage usually means the buck is set too low or the cable is too thin).
