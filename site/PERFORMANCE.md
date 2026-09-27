# Site performance

Measured with `tools/site_perf/`: `serve.mjs` fronts `site/` the way Cloudflare Pages
does (brotli, `Cache-Control: no-cache`, ETags/304s), and `measure.mjs` drives headless
Chromium at 1440×900, 4× CPU throttle, DevTools "Fast 4G", cold cache, median of 3 runs.
Headless WebGL runs on SwiftShader (software), so **scroll FPS here is only meaningful
relative to itself** (before vs. after, DPR2 vs. DPR1, gl vs. `?nogl`) — not as an
absolute number a real GPU would hit.

Baseline was captured from `origin/dev`'s `site/` (before any fix in this doc), served
on its own port so later edits on this branch don't move the baseline.

## Baseline (origin/dev, before fixes)

| Config | Loader end | Transfer | Requests | Scroll FPS | Frame p50/p95 | Task ms/frame | Long tasks (load) |
|---|---|---|---|---|---|---|---|
| WebGL, DPR 2 | 2.8 s | 441 KB | 24 | 8.4 | 100 / 217 ms | 117 | 3 (673 ms) |
| WebGL, DPR 1 | 2.4 s | 441 KB | 24 | 14.2 | 67 / 133 ms | 71 | 3 (333 ms) |
| `?nogl`, DPR 2 | 2.3 s | 441 KB | 24 | 17.3 | 50 / 133 ms | 58 | 2 (194 ms) |
| `?nogl`, DPR 1 | 2.1 s | 441 KB | 24 | 32.8 | 33 / 50 ms | 28 | 2 (123 ms) |

Largest transferred files (unchanged across configs, same HTML/JS/fonts/vendor):

| File | Size |
|---|---|
| `vendor/three.module.min.js` | 172.1 KB |
| `fonts/archivo-var.woff2` | 88.2 KB |
| `vendor/anime.esm.min.js` | 38.9 KB |
| `fonts/martian-mono-var.woff2` | 37.8 KB |
| `fonts/stix-two-text-latin-400-italic.woff2` | 18.0 KB |
| `fonts/stix-two-text-latin-400-normal.woff2` | 16.6 KB |

### Reading the numbers

- **Loader end** (~2.1–2.8 s here) is dominated by network + module parse + shader warm-up
  under throttle, not by anything frame-rate dependent in this headless run. But
  `js/gate.js`'s ring converges a fixed *fraction per animation frame*
  (`shown += (target - shown) * 0.12`) instead of a fixed fraction per elapsed *time* — on
  a real machine where the main thread is busy (importing three.js, compiling shaders,
  laying out fonts) and `requestAnimationFrame` fires far less often than 60 Hz, the ring's
  wall-clock convergence time stretches by the same factor the frame rate drops by. That's
  the reported "~10 s loader" on MacBooks: not slower loading, a slower-appearing *ring*.
  Fixed below (time-based convergence, independent of frame rate).
- **WebGL DPR 2 → DPR 1** roughly halves task time per frame (117 ms → 71 ms): the
  full-screen WebGL draw (fragment shading, MSAA resolve) scales with pixel count, and DPR 2
  is 4× the pixels of DPR 1.
- **`?nogl` is still slow** (58 ms/frame at DPR 2, only 2× faster than WebGL, not 10×): the
  2D HUD overlay (`js/stage/overlay.js`) — every visible chapter does a full canvas reset
  and redraws all brackets/leader-lines/lane markings every animation frame at up to DPR 2 —
  and the no-WebGL scene fallback (`js/stage/fallback2d.js`, also DPR-capped at 2) are
  themselves expensive 2D-canvas fill-rate work, independent of WebGL. `?nogl` isolates this:
  it's roughly half the WebGL cost, not a rounding error.
- `js/stage/stage.js` already caps WebGL at `MAX_DPR = 1.5` and has an adaptive
  downgrade (drop the ratio cap after 90 sustained slow frames), but at the baseline's ~8
  fps that threshold takes **~11 seconds** to trip — long past the point a visitor has
  already judged the page as laggy.

## Fixes

### 1. Loader ring: converge per elapsed time, not per animation frame

`js/gate.js`'s ring advanced `shown += (target - shown) * 0.12` once per
`requestAnimationFrame` callback. That is a fixed fraction *per tick*, so its wall-clock
fill time is proportional to how often rAF actually fires — on a busy main thread (module
imports, shader compile under `stage.warm()`, font layout) a real machine can see rAF at a
fraction of 60 Hz, and the ring visibly crawls even after loading has actually finished.
Changed to a fixed fraction per elapsed *second* (`1 - exp(-14·dt)`, ~0.8 s to converge
regardless of frame rate).

| Config | Loader end before | Loader end after |
|---|---|---|
| WebGL, DPR 2 | 2.8 s | 2.0 s |

Scroll performance is unaffected (this only touches the pre-"Enter" gate), as expected.

### 2. Match the 2D HUD/fallback resolution to the WebGL ratio cap

`overlay.resize()` and `fallback.resize()` were called with a hardcoded DPR cap of 2,
independent of `MAX_DPR` (1.5) or its adaptive downgrade — so the full-canvas 2D redraw
(`js/stage/overlay.js`, every frame it has anything to show) and the no-WebGL fallback
render were consistently sharper, and more expensive per pixel, than the WebGL draw they
sit on top of or replace. Pass the same `ratio` computed for WebGL instead.

| Config | Scroll FPS before | Scroll FPS after | Task ms/frame before | after |
|---|---|---|---|---|
| WebGL, DPR 2 | 8.4 | 10.7 | 117 | 94 |
| `?nogl`, DPR 2 | 17.3 | 22.1 | 58 | 43 |

### 3. React to sustained slow frames in ~1s, not ~11s

The existing adaptive-resolution step (drop the WebGL ratio cap after sustained slow
frames) required 90 consecutive slow frames before acting. At the baseline's ~8 fps that's
**~11 seconds** of visible lag before the page corrects itself — long past the point a
visitor has judged it as laggy. Lowered the threshold to 24 frames (~1s at a healthy frame
rate, ~3s even at the baseline's fps), so the page recovers quickly instead of staying
pegged at the worst-case resolution for the whole first scroll.

| Config | Scroll FPS before (fix 2 only) | Scroll FPS after (+ fix 3) | Task ms/frame before | after |
|---|---|---|---|---|
| WebGL, DPR 2 | 10.7 | 16.2 | 94 | 62 |
| WebGL, DPR 1 | — | 16.1 | — | 63 |

(`?nogl` never had this problem: it doesn't run the WebGL adaptive-resolution branch, so
fix 3 doesn't apply there — its whole gain is fix 2.)

Combined, fixes 2+3 take WebGL/DPR2 scroll from **8.4 fps / 117 ms per frame** (baseline)
to **16.2 fps / 62 ms per frame** — essentially a 2× reduction in main-thread cost per
scroll frame, with no change to the steady-state resolution when the page isn't struggling.

### 4. Disable MSAA on the WebGL renderer

`WebGLRenderer` was created with `antialias: true`. Under SwiftShader (headless) this alone
was worth 16.2 → 25.4 fps; visually, checked with a same-DPR (1.5, the site's `MAX_DPR`)
screenshot comparison of the Warn chapter (the densest line/edge scene — the COOPER model's
paper edges, "my lane" dashes, detection brackets), the difference is not perceptible: the
DPR cap already supersamples above 1×, which covers most of what MSAA buys on this line-art
style at a fraction of the per-frame GPU cost. (MSAA cost on a real GPU is usually cheaper
than on SwiftShader's software rasterizer, but the resolve step is never free, and the scene
never needed it once DPR-supersampled.)

| Config | Scroll FPS before | Scroll FPS after | Task ms/frame before | after |
|---|---|---|---|---|
| WebGL, DPR 2 | 16.2 | 27.1 | 62 | 37 |

Fixes 1–4 combined take the reported problem's two symptoms from baseline to:

| Metric | Baseline | After fixes 1–4 |
|---|---|---|
| Loader end (WebGL, DPR 2) | 2.8 s | ~2.0 s |
| Scroll FPS (WebGL, DPR 2) | 8.4 | 27.1 |
| Task ms/frame (WebGL, DPR 2) | 117 | 37 |

### 5. Give `?nogl` the same adaptive-resolution relief as WebGL

After fix 4, `?nogl` (47 ms/frame) was slower than WebGL (37 ms/frame): the fallback 2D
scene render (`fallback2d.js`) plus the HUD overlay is now the more expensive path, but the
adaptive-resolution step from fix 3 was gated on `animate` (`= !still && webgl`), which is
always `false` without WebGL — so a struggling `?nogl` visitor never got the ratio-cap
downgrade a struggling WebGL visitor does. Changed the gate to `!still`, since the
ratio/resize the step controls applies to the 2D canvases the same way it applies to the
WebGL one, regardless of which path is drawing.

| Config | Scroll FPS before | Scroll FPS after | Task ms/frame before | after |
|---|---|---|---|---|
| `?nogl`, DPR 2 | 20.4 | 32.3 | 47 | 28 |

(WebGL numbers are unchanged by this fix, confirmed by re-measuring: 28.1 fps / 36 ms per
frame, within run-to-run noise of fix 4's 27.1 fps / 37 ms.)

## Performance rules

(filled in at the end, once the fixes are locked in)
