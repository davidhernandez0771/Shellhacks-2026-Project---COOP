# COOPER showcase site

A cinematic one-page site for COOPER, a fixed, car-mounted Raspberry Pi 5 dashcam that predicts every road user's path and lights a yellow or red LED before something enters your lane. A loader, the "COOPER" decode intro, and seven chapters (See, Detect, Predict, Warn, Build, Gallery, Team) played out in one persistent WebGL scene that scroll drives. Design rationale: `docs/DESIGN_DIRECTIONS.md`.

**No build step.** Plain HTML, CSS and native ES modules. three.js and anime.js are vendored in `vendor/` and mapped with an import map in `index.html`, and the fonts are self-hosted in `fonts/`, so the page makes no third-party requests and deploys as-is.

## Preview locally
```bash
python -m http.server 8765 --directory site
```
Open http://localhost:8765. Useful switches:

| URL | What you get |
|---|---|
| `/?still` | the reduced-motion version (same as the OS "reduce motion" setting) |
| `/?nogl` | the no-WebGL fallback (a 2D-canvas render of the same scene) |
| `/?debug` | exposes `window.__coop` (the stage and anime.js) in the console |
| `/#build` | deep link to a chapter (skips the intro animation) |

## Edit the copy
All text is in `index.html`, one `<section class="chapter">` per chapter. Paragraphs with `class="reveal-words"` get the word-by-word reveal automatically; keep them plain text (no links inside). The intro tagline under the wordmark is `TAGLINE` in `js/intro.js`. The chapter names in the bottom HUD come from `CHAPTERS` in `js/stage/director.js`, and the on-canvas tags (`TRACKED`, `PATH · t + …`) from `js/stage/overlay.js`.

The Warn chapter keeps the section id `move` (the nav, the scroll code and the scene key off chapter numbers and ids), so don't rename the id.

## Fill the placeholders
Search for `✏️ PLACEHOLDER` (HTML comments) and `data-placeholder` (elements):

| Placeholder | Where | What to put |
|---|---|---|
| `cost-comparison` | Problem block | COOPER's total parts cost vs. a newer car vs. an aftermarket system |
| `devpost-url` | Team chapter | the Devpost project URL (until then `main.js` makes the link inert) |
| gallery `<li>` items | Gallery chapter | photos and videos, see below |

## Add photos and videos to the gallery
The 3D carousel is built from the list in `index.html` (`<ul id="gallery-list">`). Without WebGL the same list shows as a grid, so it's also the accessible version. Put files in `site/media/` and replace a placeholder `<li>`:

```html
<li data-src="media/build.jpg" data-alt="Inside COOPER: the Pi 5, camera and LEDs">Inside the build</li>
<li data-src="media/cut-in.mp4" data-kind="video" data-alt="COOPER lighting yellow as a car cuts in">A cut-in, caught early</li>
```
- The text inside the `<li>` is the caption; `data-alt` is the description for screen readers.
- Any number of items works (the ring spaces them evenly). 6–10 looks best.
- Images: JPG/WebP, 3:2, about 1600×1067, under 400 KB each. They're cover-cropped to 3:2.
- Videos: MP4 (H.264), muted, 3:2 or 16:9, under 4 MB, a few seconds long. They loop silently and only play while facing the viewer.
- Media only downloads when the visitor scrolls near the gallery. The no-WebGL grid picks up the same `data-src` files automatically.

## The 3D model (.glb)
The Warn, Build and Team chapters show COOPER itself: `models/cooper-camera.glb`, made from the team's Fusion 360 assembly by `tools/cad_to_glb.py` (Blender, headless). It has one node per part: `Pi_Case`, `Pi_Case_Lid`, `RASPBERRY_PI_5_1`, `Camera_Mount`, `Camera_Module`, `LED5mm_Yellow` and `LED5mm_Red` (an instance of the yellow one's mesh). It's in metres, with the lens facing −Z, +Y up and the origin at the centre of the case's bottom face. It has about 24k triangles and weighs 281 KB, with positions only (no normals, textures or Draco).

To rebuild it after a CAD change, export the assembly from Fusion as **FBX** (it keeps the component names; the OBJ export loses them) and run from the repo root:

```
blender -b -P tools/cad_to_glb.py -- --src "path/to/Assembled Pi Case.fbx"
blender -b -P tools/cad_to_glb.py -- --src "…fbx" --preview preview.png   # check the part grouping first
```

The CAD files stay out of the repo. The script prints each part's triangle count; the budgets are at the top of it. On the site:
- `js/stage/solids.js` loads the model lazily, once the scroll nears the Warn chapter. Until then, or if it fails, a stand-in built from boxes (same parts, same places) is shown. `CAMERA_MODEL_URL = null` forces the stand-in.
- The model is restyled to match the scene (ink fill, paper edges; the scene has no lights). The exploded view is the `EXPLODE` table there: the lid lifts off first and takes the LEDs with it, the Pi rises out of the tray, then the mount and the camera module slide forward.
- The Build labels (`#parts` in `index.html`) hang on the parts through `data-part` → `PART_NODES`.
- Nothing on COOPER moves in use: no turning base, no bearing readout. The Warn chapter shows its two LEDs, lit by the scene's warning level (`riskLevel` in `js/stage/director.js`, by the real rules: red when something is in "my lane" now, yellow when a predicted path enters it within 1.5 s, red overrides yellow, and a level holds 0.5 s). The same level tints the lane in the scene and lights the model's LEDs.

## How it's put together
| File | Role |
|---|---|
| `main.js` | boot: loads fonts → anime.js → three.js + scene behind the gate, then the intro |
| `js/gate.js` | the dotted progress ring and the Enter prompt |
| `js/intro.js` | the scrambleText timeline (COOPER → name line → tagline) |
| `js/chapters.js` | anime.js `onScroll` per chapter, word reveals, nav, chapter scrubber, frame counter, the Warn LEDs |
| `js/cursor.js` | the desktop cursor (ring → lock brackets on links, "Drag" in the gallery) |
| `js/stage/world.js` | the street as data: people, cars, sampled point clouds (no three.js) |
| `js/stage/director.js` | chapter keyframes: camera and what's visible; the scene's warning level; the HUD chapter names |
| `js/stage/points.js` | the point cloud shader (one draw call; motion computed on the GPU) |
| `js/stage/overlay.js` | detection brackets, leader-line labels, velocity vector, predicted path point, "my lane", the Build labels |
| `js/stage/solids.js` | COOPER's 3D model (lazy .glb, box stand-in), its exploded view and lit LEDs, the view frustum |
| `js/stage/carousel.js` | the gallery ring |
| `js/stage/fallback2d.js` | the no-WebGL renderer |
| `tokens.css` | every color, font and timing |

Numbers in the copy are real where they describe COOPER (FOV, frame size, the 1.5 s horizon and 0.1 s path steps, the 2 s time-to-contact warning, two frames to light and 0.5 s hold; see `cooper/config.py` on the dashcam branch). The scene is an illustration, not live data: the detection confidences, figures, frame counter, "my lane" (a 1.6 m × 5.5 m strip ahead of the unit) and the `PATH · t + 1.6 s` tag (drawn further ahead than the real horizon so it's visible) are all made up.

**Updating the vendored libraries:** `vendor/three.module.min.js` is `three/build/three.module.js` bundled and minified with esbuild (`esbuild three.module.js --bundle --minify --format=esm`); `vendor/GLTFLoader.js` is `three/examples/jsm/loaders/GLTFLoader.js` bundled the same way with `--external:three`; `vendor/anime.esm.min.js` is copied from the `animejs` package's `dist/bundles/`.

## Deploy (Cloudflare Pages)
The Pages project is **`coop-224`**: framework **None**, build command **empty**, build output directory **`site`**. Every pushed branch gets a preview at `https://<branch-alias>.coop-224.pages.dev`, where the alias is the branch name lowercased with `/` turned into `-` (so `cloud/showcase` → `cloud-showcase.coop-224.pages.dev`). Pushes to `main` update production.

To connect it the first time: Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → this repo, with the settings above.

**Hostname:** the showcase is served at `coop.davidhernandez.work` (the public link for judges); the live dashboard is at `coop-live.davidhernandez.work` behind Cloudflare Access (see `scripts/setup_tunnel.md`). Don't put an Access policy on the showcase hostname.

### Alternative: GitHub Pages
GitHub Pages can only publish from the repo root or `/docs`, so deploy `site/` with an Actions workflow (`actions/upload-pages-artifact` with `path: site`, then `actions/deploy-pages`), and set **Settings → Pages → Source: GitHub Actions**.
