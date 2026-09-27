// Gallery viewer: a full-screen dialog for one gallery item, opened from the 3D carousel
// (window event "cooper:gallery-open", detail { index }) or from the <li>s of #gallery-list
// themselves (the no-WebGL grid and screen readers). Items are read from the list on every
// open, so it follows whatever the list holds: data-full (else data-src) is the file,
// data-kind="video" makes it a video, data-alt the description, the text the title; an item
// with no file is a placeholder ("Coming soon").
//
// Zoom is the point: pinch, double-tap/double-click or the wheel zoom about the pointer, and a
// drag pans once zoomed. Unzoomed, a horizontal swipe changes item and a swipe down closes.
// Only transform and opacity animate. The DOM is built on the first open; while closed nothing
// is listening except the open event and the list items.

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_PX = 60;       // horizontal travel that changes item
const CLOSE_PX = 90;       // downward travel that closes
const TAP_SLOP = 8;        // px a tap may drift and still be a tap
const DUR = 200;           // open/close/nav animation, ms
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";   // --ease-out

let still = false;
let el = null;             // refs to the built dialog, or null before the first open
let items = [];
let index = 0;
let isOpen = false;
let returnFocus = null;
let inerted = [];
let closing = null;        // finishes a close that is still animating

// zoom/pan state, applied to the image as translate(tx, ty) scale(s) about its centre
let s = 1, tx = 0, ty = 0;
const pointers = new Map();
let gesture = null;
let lastTap = { t: 0, x: 0, y: 0 };

export function initLightbox(opts = {}) {
  still = !!opts.still || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.addEventListener("cooper:gallery-open", (e) => {
    const i = Number(e.detail && e.detail.index);
    open(Number.isFinite(i) ? i : 0, document.activeElement);
  });
  const list = document.getElementById("gallery-list");
  if (!list) return;
  list.querySelectorAll(":scope > li").forEach((li, i) => {
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-haspopup", "dialog");
    li.classList.add("lb-trigger");
    li.addEventListener("click", () => open(i, li));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(i, li); }
    });
  });
}

function readItems() {
  const lis = document.querySelectorAll("#gallery-list > li");
  return Array.from(lis, (li) => {
    const src = li.dataset.full || li.dataset.src || "";
    const thumb = li.dataset.src || "";
    const title = li.textContent.trim();
    const video = li.dataset.kind === "video" || /\.(mp4|webm|mov)$/i.test(src);
    return { li, src, thumb, title, alt: li.dataset.alt || title, video };
  });
}

function build() {
  const root = document.createElement("div");
  root.className = "lb";
  root.hidden = true;
  root.tabIndex = -1;   // a click on the backdrop or the photo keeps focus inside
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Gallery viewer");
  root.innerHTML = `
    <div class="lb-backdrop"></div>
    <div class="lb-stage">
      <div class="lb-fig">
        <img class="lb-img" alt="" draggable="false" decoding="async">
        <video class="lb-video" controls muted playsinline loop preload="metadata"></video>
        <div class="lb-soon"><span class="lb-soon-title"></span><span class="lb-soon-k mono">Coming soon</span></div>
        <span class="lb-brackets" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      </div>
    </div>
    <div class="lb-bar mono">
      <span class="lb-count" aria-hidden="true"></span>
      <h2 class="lb-title"></h2>
      <span class="lb-zoom" aria-hidden="true"></span>
    </div>
    <button type="button" class="lb-btn lb-close" aria-label="Close viewer">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16"/></svg>
    </button>
    <button type="button" class="lb-btn lb-prev" aria-label="Previous item">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4l-6 6 6 6"/></svg>
    </button>
    <button type="button" class="lb-btn lb-next" aria-label="Next item">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4l6 6-6 6"/></svg>
    </button>
    <p class="sr-only lb-status" aria-live="polite"></p>`;
  document.body.appendChild(root);
  const q = (c) => root.querySelector(c);
  el = {
    root, backdrop: q(".lb-backdrop"), stage: q(".lb-stage"), fig: q(".lb-fig"),
    img: q(".lb-img"), video: q(".lb-video"), soon: q(".lb-soon"), soonTitle: q(".lb-soon-title"),
    count: q(".lb-count"), title: q(".lb-title"), zoom: q(".lb-zoom"), status: q(".lb-status"),
    close: q(".lb-close"), prev: q(".lb-prev"), next: q(".lb-next"),
  };
  el.close.addEventListener("click", close);
  el.prev.addEventListener("click", () => go(-1));
  el.next.addEventListener("click", () => go(1));
  el.stage.addEventListener("pointerdown", onDown);
  el.stage.addEventListener("pointermove", onMove);
  el.stage.addEventListener("pointerup", onUp);
  el.stage.addEventListener("pointercancel", onUp);
  el.stage.addEventListener("wheel", onWheel, { passive: false });
  el.stage.addEventListener("dblclick", (e) => {
    if (e.target === el.img) toggleZoom(e.clientX, e.clientY);
  });
  // size the media box from its aspect ratio (CSS fits it to the viewport, upscaling small
  // renders); a new layout size also means re-clamping any zoom
  el.img.addEventListener("load", () => { setAspect(el.img.naturalWidth, el.img.naturalHeight); clamp(); apply(); });
  el.video.addEventListener("loadedmetadata", () => setAspect(el.video.videoWidth, el.video.videoHeight));
}

// ───────────── open / close ─────────────

function open(i, from) {
  items = readItems();
  if (!items.length) return;
  if (!el) build();
  if (closing) closing();    // reopened mid-close: settle the old close first
  index = ((i % items.length) + items.length) % items.length;
  if (!isOpen) {
    isOpen = true;
    // back to whatever opened it; a pointer tap on the WebGL carousel leaves nothing focused, and
    // there the list items are visually hidden, so only the no-WebGL grid falls back to its item
    const grid = document.documentElement.classList.contains("no-webgl");
    returnFocus = from && from !== document.body ? from : grid ? items[index].li : null;
    lockPage(true);
    el.root.hidden = false;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    if (!still) {
      el.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR, easing: EASE });
      el.stage.animate([{ transform: "scale(0.96)" }, { transform: "none" }], { duration: DUR, easing: EASE });
    }
  }
  const multi = items.length > 1;
  el.prev.hidden = el.next.hidden = !multi;
  show(0);
  el.close.focus({ preventScroll: true });
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  el.video.pause();
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", onResize);
  pointers.clear();
  gesture = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    closing = null;
    el.root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    el.root.hidden = true;
    el.fig.style.transform = "";
    el.backdrop.style.opacity = "";
    el.video.removeAttribute("src");
    el.video.load();
    resetZoom();
    lockPage(false);
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    window.dispatchEvent(new CustomEvent("cooper:gallery-close", { detail: { index } }));
  };
  if (still) return finish();
  el.stage.animate([{ transform: "none" }, { transform: "scale(0.96)" }], { duration: DUR, easing: EASE, fill: "forwards" });
  el.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR, easing: EASE, fill: "forwards" }).onfinish = finish;
  closing = finish;
  // animations don't advance in a hidden tab: never leave the page locked behind a stalled one
  setTimeout(finish, DUR + 100);
}

// Scroll lock and modality: the page behind is inert (out of the tab order and the
// accessibility tree) and can't scroll; the scrollbar's width is padded so nothing shifts.
function lockPage(on) {
  const html = document.documentElement;
  if (on) {
    const bar = window.innerWidth - html.clientWidth;
    html.classList.add("lb-locked");
    if (bar > 0) html.style.paddingRight = `${bar}px`;
    inerted = Array.from(document.body.children).filter((n) => n !== el.root && !n.inert && n.tagName !== "SCRIPT");
    inerted.forEach((n) => { n.inert = true; });
  } else {
    html.classList.remove("lb-locked");
    html.style.paddingRight = "";
    inerted.forEach((n) => { n.inert = false; });
    inerted = [];
  }
}

// ───────────── items ─────────────

function go(dir) {
  if (items.length < 2) return;
  index = (index + dir + items.length) % items.length;
  show(dir);
}

function show(dir) {
  const it = items[index];
  const n = items.length;
  resetZoom();
  el.video.pause();
  el.count.textContent = `${pad(index + 1)} / ${pad(n)}`;
  el.title.textContent = it.title;
  el.status.textContent = `${it.title}, ${index + 1} of ${n}`;

  el.fig.dataset.kind = !it.src ? "soon" : it.video ? "video" : "image";
  if (!it.src) {
    el.img.removeAttribute("src");
    el.video.removeAttribute("src");
    el.soonTitle.textContent = it.title;
  } else if (it.video) {
    el.img.removeAttribute("src");
    el.video.setAttribute("aria-label", it.alt);
    if (el.video.getAttribute("src") !== it.src) el.video.src = it.src;
    el.video.muted = true;
    el.video.currentTime = 0;
    el.video.play().catch(() => {});
  } else {
    el.video.removeAttribute("src");
    el.img.alt = it.alt;
    showImage(it);
  }
  updateZoomUi();
  preload();

  if (dir && !still) {
    el.fig.animate(
      [{ opacity: 0, transform: `translateX(${dir * 40}px)` }, { opacity: 1, transform: "none" }],
      { duration: DUR, easing: EASE },
    );
  }
}

// The card image is already in the cache (the carousel or grid showed it) and has the same
// aspect ratio, so it stands in until the full-size file has downloaded and decoded.
function showImage(it) {
  const full = new Image();
  full.src = it.src;
  if (full.complete || !it.thumb || it.thumb === it.src) {
    setAspect(full.naturalWidth, full.naturalHeight);   // cached: size it before the first paint
    el.img.src = it.src;
    return;
  }
  const card = new Image();
  card.src = it.thumb;
  if (card.complete) setAspect(card.naturalWidth, card.naturalHeight);
  el.img.src = it.thumb;
  full.decode().catch(() => {}).then(() => {
    if (isOpen && items[index] === it) el.img.src = it.src;
  });
}

function setAspect(w, h) {
  if (w && h) el.fig.style.setProperty("--lb-ar", String(w / h));
}

// only the neighbouring full images, never videos
function preload() {
  if (items.length < 2) return;
  const seen = new Set();
  for (const d of [1, -1]) {
    const it = items[(index + d + items.length) % items.length];
    if (it.src && !it.video && !seen.has(it.src)) { seen.add(it.src); new Image().src = it.src; }
  }
}

const pad = (v) => String(v).padStart(2, "0");

// ───────────── keyboard ─────────────

function onKey(e) {
  let handled = true;
  switch (e.key) {
    case "Escape": close(); break;
    case "ArrowLeft": go(-1); break;
    case "ArrowRight": go(1); break;
    case "+": case "=": zoomCenter(s * 1.5); break;
    case "-": case "_": zoomCenter(s / 1.5); break;
    case "0": resetZoom(true); break;
    case "Tab": trapTab(e); break;
    default: handled = false;
  }
  // keep the page's own key handlers (chapter nav, carousel) out of it while open
  if (handled) { e.stopPropagation(); if (e.key !== "Tab") e.preventDefault(); }
}

function trapTab(e) {
  const f = Array.from(el.root.querySelectorAll("button, video[src]"))
    .filter((n) => !n.hidden && n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  const inside = el.root.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
}

// ───────────── zoom and pan ─────────────

function isImage() { return el.fig.dataset.kind === "image"; }

// layout box of the image (unaffected by its transform) and its untransformed centre
function box() {
  const r = el.img.getBoundingClientRect();
  return { cx: r.left + r.width / 2 - tx, cy: r.top + r.height / 2 - ty, w: el.img.offsetWidth, h: el.img.offsetHeight };
}

// scale to ns keeping the image point under (fx, fy) under it
function zoomAt(fx, fy, ns, b = box()) {
  ns = Math.min(MAX_SCALE, Math.max(1, ns));
  const lx = (fx - b.cx - tx) / s, ly = (fy - b.cy - ty) / s;
  tx = fx - b.cx - ns * lx;
  ty = fy - b.cy - ns * ly;
  s = ns;
  clamp(b);
}

// zoomed, the image edges may not come inside the viewport; unzoomed it sits at rest
function clamp(b = box()) {
  if (s <= 1.001) { s = 1; tx = 0; ty = 0; return; }
  const vw = window.innerWidth, vh = window.innerHeight;
  const axis = (t, c, size, view) => {
    const half = (size * s) / 2;
    if (half * 2 <= view) return view / 2 - c;       // smaller than the view: centre it
    return Math.min(half - c, Math.max(view - c - half, t));
  };
  tx = axis(tx, b.cx, b.w, vw);
  ty = axis(ty, b.cy, b.h, vh);
}

function apply(settle = false) {
  el.img.classList.toggle("is-settling", settle && !still);
  el.img.style.transform = s === 1 ? "" : `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
  updateZoomUi();
}

function updateZoomUi() {
  const zoomed = s > 1;
  el.root.classList.toggle("is-zoomed", zoomed);
  el.zoom.textContent = zoomed ? `×${s.toFixed(1)}` : isImage() ? zoomHint() : "";
}

const coarse = window.matchMedia("(pointer: coarse)");
const zoomHint = () => (coarse.matches ? "Pinch or double-tap to zoom" : "Scroll or double-click to zoom");

function resetZoom(animate = false) {
  s = 1; tx = 0; ty = 0;
  if (el) apply(animate);
}

function toggleZoom(x, y) {
  if (!isImage()) return;
  if (s > 1) resetZoom(true);
  else { zoomAt(x, y, DOUBLE_TAP_SCALE); apply(true); }
}

function zoomCenter(ns) {
  if (!isImage()) return;
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, ns);
  apply(true);
}

function onWheel(e) {
  e.preventDefault();
  if (!isImage()) return;
  // trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel as ~100px steps
  const k = e.ctrlKey ? 0.01 : 0.0025;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX, e.clientY, s * Math.exp(-dy * k));
  apply();
}

function onResize() { clamp(); apply(); }

// ───────────── pointer gestures ─────────────

function onDown(e) {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  // leave the video's own controls alone: mouse clicks on it, and touches on its control strip
  if (e.target === el.video) {
    if (e.pointerType === "mouse") return;
    const r = el.video.getBoundingClientRect();
    if (e.clientY > r.bottom - 56) return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { kind: "pending", x0: e.clientX, y0: e.clientY, t0: performance.now(), tx0: tx, ty0: ty, target: e.target };
  } else if (pointers.size === 2 && isImage()) {
    const [a, b] = pointers.values();
    const b0 = box();
    gesture = { kind: "pinch", d0: dist(a, b), s0: s, b: b0 };
    el.img.style.willChange = "transform";
  }
}

function onMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p || !gesture) return;
  p.x = e.clientX; p.y = e.clientY;

  if (gesture.kind === "pinch") {
    const [a, b] = pointers.values();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    zoomAt(mx, my, gesture.s0 * (dist(a, b) / gesture.d0), gesture.b);
    // follow the midpoint too, so two fingers can pan while they pinch
    if (gesture.mx !== undefined) { tx += mx - gesture.mx; ty += my - gesture.my; clamp(gesture.b); }
    gesture.mx = mx; gesture.my = my;
    apply();
    return;
  }

  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
  if (gesture.kind === "pending") {
    if (Math.hypot(dx, dy) < TAP_SLOP) return;
    gesture.kind = s > 1 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "swipe-x" : dy > 0 ? "swipe-down" : "none";
    el.stage.setPointerCapture(e.pointerId);
    if (gesture.kind === "pan") { gesture.b = box(); el.img.style.willChange = "transform"; }
  }
  if (gesture.kind === "pan") {
    tx = gesture.tx0 + dx; ty = gesture.ty0 + dy;
    clamp(gesture.b);
    apply();
  } else if (gesture.kind === "swipe-x") {
    el.fig.style.transform = `translate3d(${dx}px, 0, 0)`;
  } else if (gesture.kind === "swipe-down") {
    const k = Math.max(0, dy);
    el.fig.style.transform = `translate3d(0, ${k}px, 0) scale(${1 - Math.min(k / 1200, 0.15)})`;
    el.backdrop.style.opacity = String(1 - Math.min(k / 400, 0.6));
  }
}

function onUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;

  if (g.kind === "pinch") {
    // one finger lifted: the other carries on as a pan from here
    el.img.style.willChange = "";
    if (s < 1.05) resetZoom(true); else apply(true);
    const rest = pointers.values().next().value;
    gesture = rest ? { kind: s > 1 ? "pan" : "none", x0: rest.x, y0: rest.y, tx0: tx, ty0: ty, b: box() } : null;
    return;
  }
  if (pointers.size) return;
  gesture = null;

  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  const dt = performance.now() - g.t0;
  if (g.kind === "pan") {
    // drop the promoted layer so the zoomed image re-rasterizes sharp at its new scale
    el.img.style.willChange = "";
    apply();
  } else if (g.kind === "swipe-x" || g.kind === "swipe-down") {
    const fast = dt < 250;
    const cancel = e.type === "pointercancel";
    const nav = !cancel && g.kind === "swipe-x" && (Math.abs(dx) > SWIPE_PX || (fast && Math.abs(dx) > 25));
    const shut = !cancel && g.kind === "swipe-down" && (dy > CLOSE_PX || (fast && dy > 40));
    if (!shut) springBack(!nav);   // closing carries on from where the finger left it
    if (nav) go(dx < 0 ? 1 : -1);
    else if (shut) close();
  } else if (g.kind === "pending" && e.type !== "pointercancel") {
    onTap(e, g);
  }
}

function onTap(e, g) {
  const onMedia = g.target === el.img || g.target === el.video || el.soon.contains(g.target);
  if (e.pointerType !== "mouse" && g.target === el.img) {
    const now = performance.now();
    if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap.t = 0;
      toggleZoom(e.clientX, e.clientY);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  // a tap on the backdrop (not the media) closes, unless zoomed in
  if (!onMedia && s === 1) close();
}

function springBack(animate) {
  const from = el.fig.style.transform;
  el.fig.style.transform = "";
  el.backdrop.style.opacity = "";
  if (animate && from && !still) {
    el.fig.animate([{ transform: from }, { transform: "none" }], { duration: DUR, easing: EASE });
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
