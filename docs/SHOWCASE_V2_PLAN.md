# Showcase v2 plan (`site/`, branch `design/showcase-v2`)

The overnight showcase works, but its particle-cloud scenes read as AI-made (the same technique as David's previous project SANT). v2 makes it feel crafted by a studio. **Keep:** the black/white/orange identity, the scrambleText intro, the chapter structure, the reduced-motion and no-WebGL fallbacks, and **the round 3D carousel, which David loves. It's the quality bar for every new addition.**

David is present in VS Code for this work. **Show him each step in the browser and get his OK before moving on.** Use the `frontend-design` and `brainstorming` skills (`.claude/skills/`), interactively.

## Lanes (parallel terminals, each in its own folder and branch)
| Lane | Folder → branch | Steps | Owns (only edit these) | Preview |
|---|---|---|---|---|
| **A: Type & wordmark** (integration lane) | `C:\dev\COOP-site` → `design/showcase-v2` | 1, 2, 3, 7 | `index.html` copy/markup, `tokens.css`, `styles.css`, `fonts/`, new `js/wordmark.js`, `README.md`, `CREDITS.md`, `docs/DEVPOST.md` | `design-showcase-v2.coop-224.pages.dev` |
| **B: Cursor & extras** | `C:\dev\COOP-fx` → `design/fx` | 4, 6 | `js/cursor.js`, new `js/fx/*.js`, new `fx.css`, `vendor/` (new libs only) | `design-fx.coop-224.pages.dev` |
| **C: Simulations** | `C:\dev\COOP-sims` → `design/sims` | 5 | `js/stage/*` **except `carousel.js` (don't touch, David loves it)**, `js/chapters.js`, new `sims.css` | `design-sims.coop-224.pages.dev` |

- Lanes B and C put their styles in their own CSS file and only **add** `<link>`/`<script>` tags or small hooks to `index.html` (a `data-` attribute, a container element). Lane A owns the rest of the markup.
- Everything reads colors and fonts from `tokens.css` variables, so lane A's font change flows into B and C automatically. Never hard-code a font or color.
- Need something in another lane's files? Write it in a **Requests** section at the bottom of this plan instead of editing.
- Each lane commits only its own paths and pushes to its own branch. **Merging B and C into `design/showcase-v2` is done by the coordinator** (David's main Claude session) after David approves each lane's preview.

## OriginKit components (researched 2026-09-26)
OriginKit (originkit.dev) has 547 animated components. **David's free account can copy 10 a day**; Pro ($79/yr) unlocks the rest. The code is React/Framer, and our site has no build step, so the workflow is:
1. David opens the component, sets its colors to our tokens (`#060606` / off-white / orange), clicks **Get this Component** and saves the code to `site/_originkit/<name>.txt`. That folder is git-ignored reference material and is never published.
2. The lane ports it to vanilla JS/CSS in its own files, adapting it to COOP, and credits it in `site/CREDITS.md`.

Never scrape or copy components David hasn't copied through his own account.

| Component (all **free**) | Lane | Where it goes in COOP |
|---|---|---|
| **Vector Wordmark** | A | "COOP" hero, every chapter title, a giant footer wordmark (step 3) |
| **Mask Text Reveal** | A | Chapter subtitles and body copy revealing on scroll |
| **Outline Typeflow** | A | "COMPUTER-VISION OBJECT OBSERVATION & PREDICTION" running along the camera's traced outline in 05 BUILD |
| **Interactive Grid** | A | A "Built with" section: a hover grid of the stack (Pi 5, YOLO, OpenCV, three.js, anime.js, Arduino, Flask, Cloudflare) |
| **Particle Gimbal** | B | **The loader**: it's literally a gimbal. Replace the current dotted-ring loader. (Alternative: Gyro Loader.) |
| **Scan Grid Button** | B | Primary CTAs (a sci-fi HUD hover) |
| **Tactile Button** | B | Secondary buttons (the orange underside fits the palette) |
| **Neon Border / Glow Border** | B | Figure frames and cards: corner-bracket glow, recolored orange |
| **Pixel Trail** | B | A very subtle orange pixel trail behind the target cursor, like camera pixels |
| **Predictive Arc** | C | Background of 03 PREDICT (a WebGL dot arch; the name fits) |
| **ASCII Wave** | C | 01 SEE: the camera "pinging" the scene with ASCII rings, in orange |
| **Dither Globe** (reference only) | C | Proof that the 1-bit dither look is current. Build the dither shader for the scenes (step 5). |
| **Round Carousel** | — | Already in, and David loves it. Keep it. |

**Today's 10 free copies, in order:** Vector Wordmark, Particle Gimbal, Mask Text Reveal, Scan Grid Button, Tactile Button, Neon Border, Predictive Arc, ASCII Wave, Interactive Grid, Pixel Trail. Outline Typeflow and Glow Border are for tomorrow.

**Pro-only (need a paid plan; don't use unless David upgrades):** Axis Cursor (crosshair with an "Aim" label, perfect for COOP), Beam Sweep, Focus Reveal, Magnetic Hover Button, Pixel LED Display, Kinetic Grid, Encrypt Button, Spotlight Frames, Circular Gallery, Twin Galaxy Rings. The target cursor, magnetic buttons and the rest of step 6 stay our own implementations.

## Rules
- Work only in `site/` (plus `docs/DEVPOST.md` and `README.md` when relevant) on branch `design/showcase-v2`, in the folder `C:\dev\COOP-site`. Commit small and push often; each push gets a Cloudflare Pages preview at `https://design-showcase-v2.coop-224.pages.dev`. **Never push to `dev` or `main`.**
- No build step: native ES modules, vendored libraries in `site/vendor/`, self-hosted fonts in `site/fonts/`. Every library and font must allow commercial use and self-hosting. Record each one in `site/CREDITS.md` with its license file.
- Never copy another site's code or assets (OriginKit, Active Theory, CodePen demos): recreate effects yourself.
- Quality bar on every step: 60 fps on a mid laptop, no console errors, 1440 and 390 px widths, reduced motion, the no-WebGL fallback, touch devices.

## Steps, in order (David approves each one)
1. **Team fix, first and quick:** the teammate is **Diego Avila** (design and hardware). David Hernandez is software. Update the Team chapter, `README.md` and `docs/DEVPOST.md`. Leave a clearly marked spot for their links.
2. **Font:** build `site/specimen.html` showing 3 pairings on "COOP", the chapter titles, body text and telemetry labels. Let David pick one:
   - A. Clash Display + Satoshi + Departure Mono
   - B. Unbounded + Inter Tight + Departure Mono
   - C. Bricolage Grotesque + Geist + Geist Mono

   Confirm each license allows web embedding first (Fontshare's ITF Free Font License, OFL). Apply the chosen one site-wide, then remove the specimen page.
3. **Vector Wordmark on the big titles** (inspired by OriginKit's "Vector Wordmark"; build our own):
   - Use opentype.js (MIT) to load the chosen display font and get the real glyph outlines.
   - Render each title as SVG paths with a white→grey vertical shade.
   - Draw the anchor points and bezier handles with tiny mono coordinate labels (e.g. `10, 25`).
   - On scroll into view, the outline draws itself (stroke), the handles pop in, then it fills with the shade and the handles fade out.
   - On hover, the handles reappear and gently follow the pointer (reach, speed and damping as tunable constants).
   - Apply it to the "COOP" hero and every chapter title, and add a giant one in the footer.
   - Keep the real text in the DOM for accessibility and SEO; the SVG is aria-hidden.
4. **Target cursor** (desktop pointer devices only):
   - A small reticle dot follows the pointer with slight easing.
   - Over any interactive element, four **orange corner brackets snap to that element's exact bounding box**, like the nav's current active-item brackets, with a tiny mono label (the element's name).
   - It returns to the dot on leave. Hide the native cursor only where the custom one is active.
   - Reduced motion: no easing, no snap animation.
5. **New way to show the chapter simulations (replace the particle clouds):**
   - **1-bit dithered rendering:** render the scenes (people, cars, street, camera) as simple low-poly or silhouette 3D, through a post-processing Bayer/ordered-dither shader in black, white and orange only, so it looks like raw camera-sensor output.
   - **Aperture/iris reveal:** each chapter's simulation opens through animated camera shutter blades (SVG or shader) as it scrolls into view, and closes on the way out.
   - **Interactive PREDICT:** the visitor drags a person (or a car) across the street. The camera turns to follow, showing the velocity arrow and the predicted-aim ghost and trail, computed with the real math from `docs/DEVPOST.md` (constant-velocity Kalman, 150 ms lead). Use anime.js `createDraggable` or pointer events.
   - Keep one persistent scene if it helps performance; keep the fallbacks.
6. **Extras that make it feel crafted:**
   - a telemetry marquee band (live-looking FPS, pan angle, target ID)
   - magnetic buttons
   - nav links that scrambleText on hover
   - a subtle animated film-grain overlay
   - smooth scroll (Lenis, MIT)
   - a shutter transition between chapters
   - a real-progress preloader
   - Optional: a sound toggle, off by default. Ask David first.
7. **Final review:** do 3 passes (correctness, retest in the browser, art-director critique of anything that looks generic). Update `site/README.md`, `site/CREDITS.md` and `docs/DEVPOST.md`, then hand David the preview link. He decides when it merges to `dev`.
