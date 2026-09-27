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

(filled in below as each is measured)

## Performance rules

(filled in at the end, once the fixes are locked in)
