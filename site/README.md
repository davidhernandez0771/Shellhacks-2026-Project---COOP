# COOP showcase site

A cinematic one-page site: a loader, the "COOP" decode intro, and seven chapters (See, Detect, Predict, Move, Build, Gallery, Team) played out in one persistent WebGL scene that scroll drives. Design rationale: `docs/DESIGN_DIRECTIONS.md`.

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
All text is in `index.html`, one `<section class="chapter">` per chapter. Paragraphs with `class="reveal-words"` get the word-by-word reveal automatically; keep them plain text (no links inside). The intro lines (full name, tagline) are in `js/intro.js` (`NAME`, `TAGLINE`).

## Fill the placeholders
Search for `✏️ PLACEHOLDER` (HTML comments) and `data-placeholder` (elements):

| Placeholder | Where | What to put |
|---|---|---|
| `teammate-name`, `teammate-what` | Team chapter | name and a one-line description |
| `devpost-url` | Team chapter | the Devpost project URL (until then `main.js` makes the link inert) |
| gallery `<li>` items | Gallery chapter | photos and videos, see below |

## Add photos and videos to the gallery
The 3D carousel is built from the list in `index.html` (`<ul id="gallery-list">`). Without WebGL the same list shows as a grid, so it's also the accessible version. Put files in `site/media/` and replace a placeholder `<li>`:

```html
<li data-src="media/build.jpg" data-alt="Inside COOP: Pi 5, Uno and TMC2209">Inside the build</li>
<li data-src="media/tracking.mp4" data-kind="video" data-alt="COOP following a person">Tracking a person</li>
```
- The text inside the `<li>` is the caption; `data-alt` is the description for screen readers.
- Any number of items works (the ring spaces them evenly). 6–10 looks best.
- Images: JPG/WebP, 3:2, about 1600×1067, under 400 KB each. They're cover-cropped to 3:2.
- Videos: MP4 (H.264), muted, 3:2 or 16:9, under 4 MB, a few seconds long. They loop silently and only play while facing the viewer.
- Media only downloads when the visitor scrolls near the gallery. The no-WebGL grid picks up the same `data-src` files automatically.

## Swap in the real camera model (.glb)
The Move and Build chapters use a procedural camera head. To use a model of the actual camera:
1. Export it as `.glb`: **facing −Z, +Y up, origin on the pan axis, in metres** (the procedural head is about 0.3 m wide). Keep it small (under ~1 MB; Draco compression is *not* enabled).
2. Put it at `site/models/coop-camera.glb`.
3. In `js/stage/solids.js`, set `export const CAMERA_MODEL_URL = "models/coop-camera.glb";` (and `CAMERA_MODEL_SCALE` if it needs scaling).

That's the only switch. The model is restyled to match the scene (ink fill, paper edges), because the scene has no lights; `vendor/GLTFLoader.js` is only downloaded when the constant is set.

## How it's put together
| File | Role |
|---|---|
| `main.js` | boot: loads fonts → anime.js → three.js + scene behind the gate, then the intro |
| `js/gate.js` | the dotted progress ring and the Enter prompt |
| `js/intro.js` | the scrambleText timeline (COOP → full name → tagline) |
| `js/chapters.js` | anime.js `onScroll` per chapter, word reveals, nav, chapter scrubber, bearing tape, gauge |
| `js/cursor.js` | the desktop cursor (ring → lock brackets on links, "Drag" in the gallery) |
| `js/stage/world.js` | the street as data: people, cars, sampled point clouds (no three.js) |
| `js/stage/director.js` | chapter keyframes: camera, what's visible, the pan angle |
| `js/stage/points.js` | the point cloud shader (one draw call; motion computed on the GPU) |
| `js/stage/overlay.js` | detection brackets, leader-line labels, velocity vector, aim point |
| `js/stage/solids.js` | the rig, the exploded hardware, and the `.glb` switch |
| `js/stage/carousel.js` | the gallery ring |
| `js/stage/fallback2d.js` | the no-WebGL renderer |
| `tokens.css` | every color, font and timing |

Numbers shown on the site are real where they describe COOP (FOV, frame size, lead time, limits). The detection confidences, walking figures and frame counter are an illustration, not live data.

**Updating the vendored libraries:** `vendor/three.module.min.js` is `three/build/three.module.js` bundled and minified with esbuild (`esbuild three.module.js --bundle --minify --format=esm`); `vendor/GLTFLoader.js` is `three/examples/jsm/loaders/GLTFLoader.js` bundled the same way with `--external:three`; `vendor/anime.esm.min.js` is copied from the `animejs` package's `dist/bundles/`.

## Deploy (Cloudflare Pages)
The Pages project is **`coop-224`**: framework **None**, build command **empty**, build output directory **`site`**. Every pushed branch gets a preview at `https://<branch-alias>.coop-224.pages.dev`, where the alias is the branch name lowercased with `/` turned into `-` (so `cloud/showcase` → `cloud-showcase.coop-224.pages.dev`). Pushes to `main` update production.

To connect it the first time: Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → this repo, with the settings above.

**Hostname:** the showcase is served at `coop.davidhernandez.work` (the public link for judges); the live dashboard is at `coop-live.davidhernandez.work` behind Cloudflare Access (see `scripts/setup_tunnel.md`). Don't put an Access policy on the showcase hostname.

### Alternative: GitHub Pages
GitHub Pages can only publish from the repo root or `/docs`, so deploy `site/` with an Actions workflow (`actions/upload-pages-artifact` with `path: site`, then `actions/deploy-pages`), and set **Settings → Pages → Source: GitHub Actions**.
