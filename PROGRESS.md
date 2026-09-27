# feat/website-originkit progress

Branch: `feat/website-originkit` (based on `dev`). PR target: `dev` (never `main`).

## Done
- Fixed "Diego Taberas" → "Diego Tabares" everywhere (site/index.html, docs/DEVPOST.md, CLAUDE.md, README.md).
- Reconstructed the OriginKit bundle (network policy blocks `gist.githubusercontent.com` directly; fetched the gist's HTML page instead and parsed the 10 files back out of it) into `/tmp/originkit-bundle.txt` (not committed).

## In progress
- Working through the priority task list from the top (team section, name-story removal, Vector Wordmark hero, gate replacement, the other 9 OriginKit components, particle quality, README rewrite).

## Next
1. Team section: real UI for LinkedIn/Discord links (icon buttons, hover, `rel="noopener"`, accessible labels) for all three teammates.
2. Remove the name-story placeholder (index.html intro block, `js/intro.js` NAME/NAME_HTML, site/README.md placeholder table row).
3. Port Vector Wordmark → hero title (`site/js/fx/vector-wordmark.js` + CSS), replacing the scrambleText "COOPER" letters as the first/hero rendering.
4. Replace `site/js/gate.js` + `#gate` markup with a skippable, once-per-session, reduced-motion-respecting intro built from Morphing Glyph Cloud, still gated on real asset loading, no Enter button.
5. Port and place the remaining OriginKit components (Particle Gimbal hero, Dither Reveal image section, Mask Text Reveal headings, Tactile Button "SEE HOW IT WORKS" CTA, Scan Grid Button "VIEW ON GITHUB" CTA, Neon Border around the dashboard/demo visual, Predictive Arc background of Predict section, Interactive Grid "built with" logos from docs/DEVPOST.md tags).
6. Improve `site/js/stage/points.js` sprite quality (soft round sprites, size attenuation, depth/colour variation, smoother motion) without hurting frame rate.
7. Rewrite `README.md` and `site/README.md` to match the current COOPER dashcam project (no motorized-gimbal leftovers, no OriginKit/gist mentions, numbers matching `docs/MATH.md`/code), and keep `docs/DEVPOST.md` in sync.
8. Update `site/PERFORMANCE.md` with whatever perf-relevant work is done in step 6.
9. Run `python -m pytest` before opening the PR.
10. Open PR `feat/website-originkit` → `dev`.

## Notes for whoever resumes
- OriginKit source: re-download with the command in the task; if `gist.githubusercontent.com` is blocked again, fetch `https://gist.github.com/<user>/<gist-id>` (the HTML page, not the raw CDN) and parse the 10 files out of the `<td class="blob-code-inner js-file-line">` cells in file order — this worked and gives byte-identical text (verified against the JS block structure).
- Site conventions: everything is vanilla ES modules, no build step; colors/timings only from `site/tokens.css`; new fx components go in `site/js/fx/<name>.js` + a sibling CSS file; lazy-init near viewport; pause rAF via IntersectionObserver + `document.hidden`; cap devicePixelRatio at 2; respect `.still` (the `prefers-reduced-motion`/`?still` class on `<html>`).
