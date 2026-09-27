// Scroll: chapter progress (anime.js onScroll), word-by-word reveals, the nav, the chapter
// scrubber, the bearing tape and the chapter 04 (Warn) gauge: where an object is now and
// where its predicted path points, as a bearing from the fixed camera.

import { CHAPTERS } from "./stage/director.js";

const TAPE_PX_PER_DEG = 4;

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

function buildTape(strip) {
  for (let d = -180; d <= 180; d += 5) {
    const i = document.createElement("i");
    if (d % 15 === 0) i.className = "major";
    i.style.left = `${d * TAPE_PX_PER_DEG}px`;
    strip.appendChild(i);
    if (d % 30 === 0) {
      const b = document.createElement("b");
      b.textContent = d === 0 ? "0" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`;
      b.style.left = `${d * TAPE_PX_PER_DEG}px`;
      strip.appendChild(b);
    }
  }
}

// ── gauge (chapter 04, Warn): ±170° of bearing mapped onto a 240° arc ──
const G = { cx: 120, cy: 122, r: 96, span: 120, limit: 170 };
const toArc = (deg) => (Math.max(-G.limit, Math.min(G.limit, deg)) / G.limit) * G.span;
function polar(a, r = G.r) {
  const rad = (a * Math.PI) / 180;
  return [G.cx + r * Math.sin(rad), G.cy - r * Math.cos(rad)];
}
function arc(a0, a1, r = G.r) {
  const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${a1 >= a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function buildGauge() {
  document.getElementById("gauge-track").setAttribute("d", arc(-G.span, G.span));
  const ticks = document.getElementById("gauge-ticks");
  const NS = "http://www.w3.org/2000/svg";
  for (let d = -170; d <= 170; d += 10) {
    const major = d % 90 === 0 || Math.abs(d) === 170;
    const a = toArc(d);
    const [x0, y0] = polar(a, G.r + 4), [x1, y1] = polar(a, G.r + (major ? 12 : 8));
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", x0); l.setAttribute("y1", y0); l.setAttribute("x2", x1); l.setAttribute("y2", y1);
    if (major) l.setAttribute("class", "major");
    ticks.appendChild(l);
    if (major) {
      const [tx, ty] = polar(a, G.r + 22);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", tx.toFixed(1)); t.setAttribute("y", (ty + 3).toFixed(1));
      t.textContent = d === 0 ? "0" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`;
      ticks.appendChild(t);
    }
  }
}
const fmt = (v, pad = 5) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1).padStart(pad, "0")}°`;

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
  const strip = document.getElementById("tape-strip");
  const gaugePan = document.getElementById("gauge-pan");
  const gaugeAimV = document.getElementById("gauge-aim-v");
  const needle = document.getElementById("gauge-needle");
  const sweep = document.getElementById("gauge-sweep");
  const aimArc = document.getElementById("gauge-aim");
  const scrimEl = document.querySelector(".stage-scrim");
  buildTape(strip);
  buildGauge();

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

  // ── chrome: nav, scrubber, tape, gauge ──
  let lastIdx = -1, frameNo = 0, lastTapeX = null, lastGauge = "";
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
    const b = s.bearing ?? s.pan ?? 0;
    // A fixed dashcam has no bearing to show: the HUD counts frames, like the dashboard's frame_seq.
    frameNo = (frameNo + 1) % 1000000;
    hudPan.textContent = String(frameNo).padStart(6, "0");
    const x = -b * TAPE_PX_PER_DEG;
    if (lastTapeX === null || Math.abs(x - lastTapeX) > 0.2) {
      strip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      lastTapeX = x;
    }
    scrimEl.style.setProperty("--scrim-o", s.scrim.toFixed(3));
    if (s.rig > 0.05) {
      const key = `${s.pan.toFixed(1)}|${s.aim.toFixed(1)}`;
      if (key !== lastGauge) {
        lastGauge = key;
        const a = toArc(s.pan), aim = toArc(s.aim);
        const [nx, ny] = polar(a, G.r - 10);
        needle.setAttribute("x2", nx.toFixed(2)); needle.setAttribute("y2", ny.toFixed(2));
        sweep.setAttribute("d", Math.abs(a) < 0.05 ? "" : arc(Math.min(0, a), Math.max(0, a)));
        aimArc.setAttribute("d", arc(aim - 1.4, aim + 1.4, G.r));
        gaugePan.textContent = fmt(s.pan, 4);
        gaugeAimV.textContent = fmt(s.aim, 4);
      }
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
