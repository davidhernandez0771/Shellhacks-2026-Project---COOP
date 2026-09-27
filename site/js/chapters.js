// Scroll: chapter progress (anime.js onScroll), word-by-word reveals, the nav, the chapter
// scrubber, the frame counter and the chapter 04 (Warn) LEDs: COOPER's two lights, lit by
// the scene's warning level.

import { CHAPTERS } from "./stage/director.js";

const LEVEL_NAMES = ["Clear", "Yellow", "Red"];

function splitWords(el) {
  const words = [];
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const parts = child.textContent.split(/( +)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^ +$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
          const span = document.createElement("span");
          span.className = "w";
          span.textContent = part;
          frag.appendChild(span);
          words.push(span);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(el);
  return words;
}

export function initChapters(anime, stage, { still }) {
  const { animate, onScroll, stagger } = anime;
  const root = document.documentElement;
  const sections = Array.from(document.querySelectorAll(".chapter"));
  const progress = new Array(sections.length).fill(0);
  const navLinks = Array.from(document.querySelectorAll("#nav-links a"));
  const hudCh = document.getElementById("hud-ch");
  const hudName = document.getElementById("hud-name");
  const hudPan = document.getElementById("hud-pan");
  const menuCh = document.getElementById("nav-menu-ch");
  const leds = document.getElementById("leds");
  const ledLevel = document.getElementById("led-level");
  const scrimEl = document.querySelector(".stage-scrim");

  // holds: how long each chapter keeps its scene before blending into the next
  let holds = [];
  function measure() {
    const vh = window.innerHeight;
    holds = sections.map((s) => Math.min(0.8, Math.max(0.2, 1 - (1.1 * vh) / s.offsetHeight)));
  }
  measure();
  window.addEventListener("resize", measure);

  let chapter = 0;
  function recompute() {
    let c = 0;
    for (let i = 0; i < sections.length; i++) {
      if (progress[i] > 0) c = i + Math.min(progress[i], 0.9999);
    }
    chapter = c;
    stage.setScroll(c, holds, progress);
    updateChrome();
  }

  sections.forEach((section, i) => {
    onScroll({
      target: section,
      enter: "top top",
      leave: "top bottom",
      onUpdate: (obs) => {
        progress[i] = obs.progress;
        section.style.setProperty("--p", obs.progress.toFixed(4));
        recompute();
      },
      onEnter: () => { progress[i] = Math.max(progress[i], 0.0001); recompute(); },
      onLeaveBackward: () => { progress[i] = 0; recompute(); },
    });
  });

  // An instant jump (a nav link, the logo, Home) can skip over sections without anime
  // updating them, leaving a stale progress behind (e.g. the hero showing chapter 05's
  // scene). Resync every section from its geometry: the same "top top" → "top bottom" range.
  function resync() {
    let changed = false;
    sections.forEach((section, i) => {
      const r = section.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, -r.top / r.height));
      if (Math.abs(p - progress[i]) > 0.001) {
        progress[i] = p;
        section.style.setProperty("--p", p.toFixed(4));
        changed = true;
      }
    });
    if (changed) recompute();
  }
  window.addEventListener("scroll", resync, { passive: true });

  // word-by-word reveal, scrubbed by scroll
  if (!still) {
    document.querySelectorAll(".reveal-words").forEach((p) => {
      const words = splitWords(p);
      const section = p.closest(".chapter");
      animate(words, {
        opacity: [0.14, 1],
        duration: 300,
        delay: stagger(26),
        ease: "linear",
        autoplay: onScroll({ target: section, enter: "bottom top", leave: "top 18%", sync: 0.35 }),
      });
    });
  }

  // ── chrome: nav, scrubber, frame counter, LEDs ──
  let lastIdx = -1, frameNo = 0, lastLevel = -1;
  function updateChrome() {
    // the next chapter "arrives" once its section fills most of the screen
    const k = Math.min(CHAPTERS.length - 1, Math.floor(chapter + (chapter % 1 > 0.85 ? 1 : 0)));
    if (k !== lastIdx) {
      lastIdx = k;
      const num = String(k).padStart(2, "0");
      hudCh.textContent = num;
      menuCh.textContent = num;
      hudName.textContent = CHAPTERS[k];
      navLinks.forEach((a) => a.setAttribute("aria-current", String(Number(a.dataset.ch) === k)));
      root.classList.toggle("gallery-active", k === 6 && !root.classList.contains("no-webgl"));
      root.dataset.chapter = String(k);
    }
  }

  stage.onFrame((s) => {
    // the HUD counts frames, like the dashboard's frame_seq
    frameNo = (frameNo + 1) % 1000000;
    hudPan.textContent = String(frameNo).padStart(6, "0");
    scrimEl.style.setProperty("--scrim-o", s.scrim.toFixed(3));
    // red overrides yellow: data-level lights at most one lamp (styles.css)
    const level = s.level ?? 0;
    if (s.rig > 0.05 && level !== lastLevel) {
      lastLevel = level;
      leds.dataset.level = String(level);
      ledLevel.textContent = LEVEL_NAMES[level];
    }
  });

  // mobile menu
  const nav = document.getElementById("nav");
  const menuBtn = document.getElementById("nav-menu");
  menuBtn.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  navLinks.forEach((a) => a.addEventListener("click", () => {
    nav.classList.remove("is-open");
    menuBtn.setAttribute("aria-expanded", "false");
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("is-open")) { nav.classList.remove("is-open"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.focus(); }
  });

  recompute();
}
