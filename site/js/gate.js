// The intro: glyphs scattered across a burst shape travel into the word "COOPER"
// (js/fx/morphing-glyph-cloud.js), hold for a beat, then hand off to the Vector Wordmark hero
// title underneath. It plays once per browser session, waits for real asset loading, and is
// always skippable by a click or a key — there is no Enter button.
//
// Reduced motion and repeat visits never see this at all: main.js only gates on it when
// `gate.alreadySeen` is false and the visitor hasn't asked for reduced motion (see boot()).

import { createMorphingGlyphCloud } from "./fx/morphing-glyph-cloud.js";

const SEEN_KEY = "coopIntroSeen";
const HOLD_S = 0.5;   // how long "COOPER" holds, fully formed, before the gate can close

function sessionFlag() {
  try { return sessionStorage.getItem(SEEN_KEY) === "1"; } catch (e) { return false; }
}
function markSeen() {
  try { sessionStorage.setItem(SEEN_KEY, "1"); } catch (e) {}
}

export function createGate() {
  const root = document.documentElement;
  const gate = document.getElementById("gate");
  const statusEl = document.getElementById("gate-status");
  const canvas = document.getElementById("gate-canvas");
  const alreadySeen = sessionFlag();

  let target = 0, skipped = false, morphStarted = false, holding = false, holdT = 0;
  let cloud = null, raf = 0, last = 0;

  function resizeCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }

  if (!alreadySeen && canvas) {
    cloud = createMorphingGlyphCloud(canvas, { baseColor: "#FF5A1F" });
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    const tick = (now) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!morphStarted) { morphStarted = true; cloud.setMorph(1); }
      cloud.render(dt);
      if (!holding && cloud.settled) holding = true;
      if (holding) holdT += dt;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopAnim() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("resize", resizeCanvas);
  }

  return {
    alreadySeen,
    progress(p, label) {
      target = Math.max(target, Math.min(1, p));
      if (label && statusEl) statusEl.textContent = label;
    },
    /** Resolves once real loading is done AND (the visitor skipped, or the intro has played out). */
    ready() {
      markSeen();
      target = 1; // boot() only calls ready() once it considers the page functionally loaded
      return new Promise((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          window.removeEventListener("keydown", onKey);
          window.removeEventListener("pointerdown", onKey);
          stopAnim();
          resolve();
        };
        const onKey = () => { skipped = true; };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onKey);
        const check = () => {
          if (resolved) return;
          const animDone = skipped || (holding && holdT > HOLD_S);
          if (target >= 0.999 && animDone) finish();
          else requestAnimationFrame(check);
        };
        check();
      });
    },
    close() {
      root.classList.add("is-entered");
      root.classList.remove("is-gated");
      gate.setAttribute("aria-hidden", "true");
    },
    el: gate,
  };
}
