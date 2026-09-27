/* Scan Grid Button
 *
 * Settings for this instance (David's call-to-action button):
 *   label "VIEW ON GITHUB", Martian Mono 500 16px, fill #060606, text #EEEDEA,
 *   hover fill #FF5A1F, hover text #060606, padding 16px 28px, radius 0,
 *   border 1px solid, glitch intensity 2, scan color #FF5A1F,
 *   transition ease-in-out 0.4s. Colors/timing live in scan-grid-button.css
 *   as custom properties on .scangrid-btn; this module only drives the two
 *   animated mechanics CSS transitions can't do alone:
 *
 *   1. A scanline band that sweeps top-to-bottom in a loop while hovered
 *      or focused (opacity fade-in, then an infinite linear translateY
 *      sweep).
 *   2. A brief "glitch" burst on the label: each character jitters
 *      sideways and RGB-splits (via a chained drop-shadow filter, standing
 *      in for the chromatic-aberration look) in a staggered cascade, then
 *      settles back to normal while the color swap continues underneath.
 *
 * Both use the Web Animations API and animate only transform/opacity/filter
 * (compositable, layout-safe properties). The flat color/border swap on
 * hover/focus is left to CSS transitions in scan-grid-button.css.
 */

const GLITCH_PX = 2; // David's "glitch 2" setting
const GLITCH_DURATION = 320; // ms, one burst
const GLITCH_STAGGER = 30; // ms between characters
const SCAN_BAND_PCT = 65; // matches --scangrid-scan-color band height in CSS
const SCAN_TRAVEL_PCT = (100 / SCAN_BAND_PCT) * 100; // travel so the band fully clears the button
const SCAN_LOOP_MS = 2000;
const SCAN_FADE_MS = 150;
const SCAN_FADE_OUT_MS = 200;

/**
 * Enhance an existing anchor/button element with the scan-grid hover
 * mechanic. Does not replace, clone or remove `el`; only wraps its text
 * content in inner layers and attaches listeners.
 *
 * @param {HTMLElement} el - existing <a> (or <button>) already in the DOM,
 *   already carrying its href/target/rel/text/base classes.
 * @param {{ reducedMotion?: boolean }} [options]
 * @returns {{ destroy: () => void }}
 */
export function createScanGridButton(el, options = {}) {
  if (!el || typeof el.appendChild !== "function") {
    throw new Error("createScanGridButton: el must be an existing element");
  }

  let prefersReduced = false;
  try {
    prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    prefersReduced = false;
  }
  const reduced = options.reducedMotion === true || prefersReduced;

  // --- build the internal structure, preserving the visible text as the
  // accessible name (aria-label), then splitting it into per-character
  // spans (aria-hidden) for the glitch effect.
  const label = (el.textContent || "").trim();
  if (!el.hasAttribute("aria-label") && label) {
    el.setAttribute("aria-label", label);
  }

  el.classList.add("scangrid-btn");
  if (reduced) el.classList.add("scangrid-btn--reduced");

  el.textContent = "";

  const scanEl = document.createElement("span");
  scanEl.className = "scangrid-btn-scan";
  scanEl.setAttribute("aria-hidden", "true");

  const labelEl = document.createElement("span");
  labelEl.className = "scangrid-btn-label";
  labelEl.setAttribute("aria-hidden", "true");

  const chars = Array.from(label).map((ch) => {
    const span = document.createElement("span");
    span.className = "scangrid-char";
    span.textContent = ch;
    labelEl.appendChild(span);
    return span;
  });

  el.appendChild(scanEl);
  el.appendChild(labelEl);

  // --- animation state
  const state = {
    hovering: false,
    focusing: false,
    scanLoop: null,
    scanFade: null,
    glitchAnims: [],
  };

  const isActive = () => state.hovering || state.focusing;

  function stopScanImmediately() {
    if (state.scanLoop) {
      try {
        state.scanLoop.cancel();
      } catch (err) {
        /* already finished/canceled */
      }
      state.scanLoop = null;
    }
    if (state.scanFade) {
      try {
        state.scanFade.cancel();
      } catch (err) {
        /* already finished/canceled */
      }
      state.scanFade = null;
    }
    scanEl.style.opacity = "0";
  }

  function startScan() {
    if (reduced || (typeof document !== "undefined" && document.hidden)) return;
    stopScanImmediately();
    scanEl.style.opacity = "1";
    state.scanFade = scanEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: SCAN_FADE_MS, easing: "ease-out", fill: "forwards" }
    );
    state.scanLoop = scanEl.animate(
      [
        { transform: "translateY(-100%)" },
        { transform: `translateY(${SCAN_TRAVEL_PCT}%)` },
      ],
      { duration: SCAN_LOOP_MS, easing: "linear", iterations: Infinity }
    );
  }

  function endScan() {
    if (!state.scanLoop && !state.scanFade) {
      scanEl.style.opacity = "0";
      return;
    }
    const fadeOut = scanEl.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: SCAN_FADE_OUT_MS, easing: "ease-in", fill: "forwards" }
    );
    fadeOut.onfinish = () => {
      stopScanImmediately();
    };
  }

  function runGlitch() {
    if (reduced) return;
    state.glitchAnims.forEach((a) => {
      try {
        a.cancel();
      } catch (err) {
        /* noop */
      }
    });
    state.glitchAnims = [];

    const g = GLITCH_PX;
    chars.forEach((charEl, i) => {
      const anim = charEl.animate(
        [
          { transform: "translateX(0px)", filter: "none", offset: 0 },
          {
            transform: `translateX(${-g}px)`,
            filter: `drop-shadow(${g}px 0 0 rgba(255,0,80,0.75)) drop-shadow(${-g}px 0 0 rgba(0,220,255,0.75))`,
            offset: 0.25,
          },
          {
            transform: `translateX(${g}px)`,
            filter: `drop-shadow(${-g}px 0 0 rgba(255,0,80,0.75)) drop-shadow(${g}px 0 0 rgba(0,220,255,0.75))`,
            offset: 0.5,
          },
          {
            transform: `translateX(${-g}px)`,
            filter: `drop-shadow(${g}px 0 0 rgba(255,0,80,0.75)) drop-shadow(${-g}px 0 0 rgba(0,220,255,0.75))`,
            offset: 0.75,
          },
          { transform: "translateX(0px)", filter: "none", offset: 1 },
        ],
        {
          duration: GLITCH_DURATION,
          delay: i * GLITCH_STAGGER,
          easing: "ease-out",
          fill: "none",
        }
      );
      state.glitchAnims.push(anim);
    });
  }

  function activate() {
    if (reduced) return;
    startScan();
    runGlitch();
  }

  function deactivate() {
    endScan();
    state.glitchAnims.forEach((a) => {
      try {
        a.cancel();
      } catch (err) {
        /* noop */
      }
    });
    state.glitchAnims = [];
  }

  function onPointerEnter() {
    if (state.hovering) return;
    state.hovering = true;
    activate();
  }
  function onPointerLeave() {
    state.hovering = false;
    if (!isActive()) deactivate();
  }
  function onFocus() {
    if (state.focusing) return;
    state.focusing = true;
    activate();
  }
  function onBlur() {
    state.focusing = false;
    if (!isActive()) deactivate();
  }
  function onVisibilityChange() {
    if (typeof document === "undefined") return;
    if (document.hidden) {
      stopScanImmediately();
    } else if (isActive() && !reduced) {
      startScan();
    }
  }

  el.addEventListener("mouseenter", onPointerEnter);
  el.addEventListener("mouseleave", onPointerLeave);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function destroy() {
    el.removeEventListener("mouseenter", onPointerEnter);
    el.removeEventListener("mouseleave", onPointerLeave);
    el.removeEventListener("focus", onFocus);
    el.removeEventListener("blur", onBlur);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    deactivate();
    stopScanImmediately();
  }

  return { destroy };
}
