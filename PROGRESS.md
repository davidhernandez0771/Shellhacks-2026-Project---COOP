# feat/website-originkit progress

Branch: `feat/website-originkit` (based on `dev`). PR target: `dev` (never `main`).

## Done
1. **Team section**: real icon-button UI for LinkedIn + Discord (David Hernandez, Diego Avila,
   Diego Tabares — exact roles/links from the task), `rel="noopener"`, accessible labels,
   click-to-copy for Discord handles (no public Discord profile URL exists).
2. **Name-story placeholder removed**: `site/index.html` (the line above the title, the HTML
   comment), `site/js/intro.js` (`NAME`/`NAME_HTML` gone, `TAGLINE` kept), `site/README.md`'s
   placeholder table, and `docs/DEVPOST.md`'s project-name placeholder (kept the still-needed
   tagline placeholder, removed only the name-story part). `README.md`'s own name-story line
   and "# COOP" title fixed to "# COOPER" too (same placeholder, "anywhere else it appears").
3. **Vector Wordmark** is now the hero "COOPER" title (`site/js/fx/vector-wordmark.js`),
   overlaying the plain-text fallback (kept for no-JS/no-WebGL).
4. **Intro replaced**: `site/js/gate.js` + `#gate` now run a Morphing Glyph Cloud
   (`site/js/fx/morphing-glyph-cloud.js`) forming "COOPER" out of a scattered shape, then
   hand off to the hero. No Enter button; skippable by click/key; once per
   `sessionStorage`; skipped entirely under reduced motion or on a repeat visit.
5. **All 10 OriginKit components ported** to `site/js/fx/*.js` + matching `.css` (vanilla,
   no React, no build step) and placed: Particle Gimbal (hero orb), Dither Reveal (new
   pipeline diagram in Build, `site/media/pipeline.svg`), Mask Text Reveal (every
   `.ch-title`), Tactile Button ("SEE HOW IT WORKS" → `#see`), Scan Grid Button ("VIEW ON
   GITHUB" → repo, new tab), Neon Border (frames the Warn chapter's live LED readout),
   Predictive Arc (Predict chapter background), Morphing Glyph Cloud (intro), Interactive
   Grid (new "Built with" section, `site/media/logos/*.svg` — 18 hand-drawn original marks,
   not hotlinked brand images).
6. **Particle quality** (`site/js/stage/points.js`): soft-core sprites (brighter centre, not
   just one falloff curve), depth-based colour/brightness variation (atmospheric fog tint +
   per-point jitter from the existing seed). Cheap (one extra varying, a few ALU ops/pixel).
7. **README.md** and **site/README.md** updated: team roles/links, SSH + systemd for the Pi,
   the dashboard's beep, the live site URL, the new intro/hero and `js/fx/*` architecture in
   "How it's put together". `docs/DEVPOST.md` synced (showcase-site paragraph, name
   placeholder, stale repo URL). `site/PERFORMANCE.md` has a new section on how the 10 new
   components are gated (lazy-mount, IntersectionObserver + `document.hidden`, DPR cap 2,
   skipped under `no-webgl`, static under reduced motion).
8. Fixed two real bugs found while testing: (a) the vector-wordmark's telemetry labels could
   sweep past the viewport edge and force horizontal scroll on desktop widths — clamped to
   real viewport pixels; (b) stale "...Project---COOP" (missing "ER") GitHub URLs in
   `site/index.html`, `README.md`, `docs/DEVPOST.md`, `docs/VENUE_SETUP.md`; (c) "Diego
   Taberas" → "Diego Tabares" everywhere.
9. Tested: `python -m http.server 8765 --directory site` + a headless Chromium
   (Playwright, pre-installed in this environment) pass at 1440px and 390px, `?still`
   (reduced motion) and `?nogl` (no-WebGL) paths — zero console errors, zero horizontal
   overflow, screenshots checked by eye at every chapter.
10. `python -m pytest -q` — 232 passed (untouched by this branch's changes; run per the
    task's own requirement before opening the PR).

## Known issue found during testing (not fixed — out of scope for this branch)
On a phone-width viewport, scrolling from Gallery into Team briefly shows a faint 3D
gallery-carousel card (the "PLACEHOLDER · photo 3:2" texture from `js/stage/carousel.js`)
behind the Team text. This is pre-existing (I didn't touch `carousel.js`/`director.js`),
and `styles.css` already has a comment acknowledging it ("the closing rig portrait would
sit behind the team text on a phone") with a partial mitigation (dims the whole stage to
30% opacity at chapter 7 on phones) — the dim doesn't fully hide it. **David should look
at this**; a real fix means changing how the carousel fades out at the Gallery→Team
boundary, which is `js/stage/carousel.js`/`director.js`, outside this branch's lane.

## Next (if resuming)
- Nothing required is left undone from the task list. Possible polish, at your discretion:
  - Gallery placeholders (`site/index.html`'s `#gallery-list`) are still `data-placeholder`
    stand-ins — real photos/video are explicitly the team's to add later (per
    `site/README.md`), not part of this task.
  - The pre-existing carousel/Team phone overlap noted above.
  - `docs/DEVPOST.md`'s image gallery / video-demo-link / inspiration / what-we-learned
    ✏️ sections are still open — explicitly the team's to write, not touched here.
- Open the PR: `feat/website-originkit` → `dev` (not `main`).

## Notes for whoever resumes
- OriginKit source: re-download with the command in the task; if `gist.githubusercontent.com`
  is blocked by the environment's network policy again, fetch
  `https://gist.github.com/<user>/<gist-id>` (the HTML page, not the raw CDN) and parse the
  10 files out of the `<td class="blob-code-inner js-file-line">` cells in line-number order
  (works, verified byte-for-byte against the JS block structure — see git history of this
  file for the exact parsing script if needed).
- Site conventions: vanilla ES modules, no build step; colors/timings only from
  `site/tokens.css`; each fx component is `site/js/fx/<name>.js` + a sibling `.css`; lazy-init
  near viewport via `main.js`'s `lazyMount()` helper; every rAF loop pauses via
  `IntersectionObserver` + `document.hidden`; DPR capped at 2; every component takes a
  `reducedMotion` option and renders a static frame instead of animating.
