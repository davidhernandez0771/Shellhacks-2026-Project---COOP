// 06 Gallery: a ring of cards built from the <ul id="gallery-list"> items. Images and videos
// load lazily (only when the gallery is near); a video item without data-src gets a drawn
// placeholder. Each card's plane takes its image's aspect, so nothing is stretched or cropped.
// A tap/click on a card (or Enter) fires "cooper:gallery-open" with the card's list index;
// the viewer reads the <li> itself.

import * as THREE from "three";

const CARD_MAX_W = 1.75, CARD_MAX_H = 1.45; // the box every card fits inside (world units)
const CARD_GAP = 0.3;                        // between neighbouring cards' boxes
const FRONT_Z = 3.3;                         // where the front card sits, whatever the card count
const DEFAULT_ASPECT = 4 / 3;                // until the media's real size is known
const TAP_PX = 6, TAP_MS = 300;              // a press that moves less and ends sooner is a tap

function readItems() {
  return Array.from(document.querySelectorAll("#gallery-list > li")).map((li, i) => ({
    li,
    title: li.textContent.trim(),
    src: li.dataset.src || null,
    poster: li.dataset.poster || null,
    kind: li.dataset.kind || (li.dataset.src && /\.(mp4|webm|mov)$/i.test(li.dataset.src) ? "video" : "image"),
    alt: li.dataset.alt || li.textContent.trim(),
    index: i,
  }));
}

function placeholderTexture(item, total) {
  const c = document.createElement("canvas");
  c.width = 768; c.height = 576;               // 4:3, the default card
  const g = c.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  g.fillStyle = v("--ink-2");
  g.fillRect(0, 0, c.width, c.height);
  // dot grid
  g.fillStyle = "rgba(238,237,234,0.10)";
  for (let y = 24; y < c.height; y += 24) for (let x = 24; x < c.width; x += 24) g.fillRect(x, y, 1.5, 1.5);
  // corner brackets
  g.strokeStyle = v("--paper");
  g.lineWidth = 2;
  const m = 40, L = 34;
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [c.width - m, m, -1, 1], [m, c.height - m, 1, -1], [c.width - m, c.height - m, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + sy * L); g.lineTo(x, y); g.lineTo(x + sx * L, y); g.stroke();
  }
  // play glyph
  g.strokeStyle = v("--paper-2");
  g.beginPath(); g.moveTo(c.width / 2 - 18, c.height / 2 - 26); g.lineTo(c.width / 2 + 26, c.height / 2); g.lineTo(c.width / 2 - 18, c.height / 2 + 26); g.closePath(); g.stroke();
  const mono = `"Martian Mono", ui-monospace, monospace`;
  g.fillStyle = v("--paper-2");
  g.font = `400 20px ${mono}`;
  g.fillText(`${String(item.index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, m + 6, m + 58);
  g.fillStyle = v("--paper");
  g.font = `500 30px "Archivo", sans-serif`;
  g.fillText(item.title, m + 6, c.height - m - 44);
  g.fillStyle = v("--lock");
  g.font = `400 18px ${mono}`;
  g.fillText("VIDEO · COMING SOON", m + 6, c.height - m - 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function imageTexture(src, onReady) {
  new THREE.TextureLoader().load(src, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;                      // three clamps it to the GPU's max
    onReady(tex, null, tex.image.width, tex.image.height);
  });
}

function videoTexture(src, onReady) {
  const v = document.createElement("video");
  Object.assign(v, { src, muted: true, loop: true, playsInline: true, preload: "metadata", crossOrigin: "anonymous" });
  v.setAttribute("muted", "");
  v.addEventListener("loadeddata", () => {
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    onReady(tex, v, v.videoWidth, v.videoHeight);
  }, { once: true });
}

export function createCarousel(scene, pal, camera) {
  const items = readItems();
  const n = items.length;
  // radius from the card count, so neighbouring boxes never overlap; the ring is pushed back
  // so the front card stays where the camera frames it
  const radius = (CARD_MAX_W + CARD_GAP) / (2 * Math.sin(Math.PI / Math.max(3, n)));
  // fade toward the sides so the front card's neighbours keep the same brightness whatever
  // the spacing: cos(step)^facePow = cos(45°)^3, the 8-card ring's look (facePow = 3 at n = 8)
  const facePow = Math.log(Math.SQRT1_2 ** 3) / Math.log(Math.cos((Math.PI * 2) / Math.max(5, n)));
  const group = new THREE.Group();
  group.position.set(0, 1.45, FRONT_Z - radius);
  group.visible = false;
  scene.add(group);

  const cards = [];
  const plane = new THREE.PlaneGeometry(1, 1);    // scaled per card to its media's aspect
  const edgeGeo = new THREE.EdgesGeometry(plane);
  const blank = new THREE.Color(0x151514);         // a photo card before its texture arrives

  function fit(c, aspect) {
    let w = CARD_MAX_W, h = w / aspect;
    if (h > CARD_MAX_H) { h = CARD_MAX_H; w = h * aspect; }
    c.mesh.scale.set(w, h, 1);
    c.edge.scale.set(w, h, 1);
  }

  items.forEach((item, i) => {
    const a = (i / n) * Math.PI * 2;
    const holder = new THREE.Group();
    holder.position.set(Math.sin(a) * radius, 0, Math.cos(a) * radius);
    holder.rotation.y = a;
    const mat = new THREE.MeshBasicMaterial({ color: blank, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(plane, mat);
    mesh.userData.card = i;
    const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: pal.paper, transparent: true, opacity: 0 }));
    holder.add(mesh, edge);
    group.add(holder);
    const c = { item, holder, mesh, mat, edge, video: null };
    fit(c, DEFAULT_ASPECT);
    cards.push(c);
  });
  const meshes = cards.map((c) => c.mesh);

  function show(c, tex, w, h) {
    const old = c.mat.map;
    c.mat.map = tex;
    c.mat.color.set(0xffffff);
    c.mat.needsUpdate = true;
    if (w && h) fit(c, w / h);
    if (old && old !== tex) old.dispose();     // the placeholder or poster it replaces
    repaint = true;
  }

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    for (const c of cards) {
      const { item } = c;
      if (item.kind === "video") {
        if (item.poster) imageTexture(item.poster, (tex, _, w, h) => { if (!c.video) show(c, tex, w, h); else tex.dispose(); });
        else show(c, placeholderTexture(item, n), 4, 3);
        if (item.src) videoTexture(item.src, (tex, video, w, h) => { c.video = video; show(c, tex, w, h); });
      } else if (item.src) {
        imageTexture(item.src, (tex, _, w, h) => show(c, tex, w, h));
      }
    }
    // hover feedback only once the gallery is near (and after the custom cursor's own listener)
    window.addEventListener("pointermove", hover, { passive: true });
  }

  // ── picking ──────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  let vis = 0;
  function pick(x, y) {
    if (!camera || vis < 0.5) return -1;
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObjects(meshes, false)) {
      hit.object.parent.getWorldDirection(tmp);
      if (tmp.z > 0.3) return hit.object.userData.card;   // skip the faded cards at the back
    }
    return -1;
  }
  function open(index) {
    window.dispatchEvent(new CustomEvent("cooper:gallery-open", { detail: { index } }));
  }

  const root = document.documentElement;
  const pin = document.querySelector("#gallery .pin");
  const cursorEl = document.getElementById("cursor");
  const cursorLabel = document.getElementById("cursor-label");
  let hovered = -1;
  // only presses and hovers on the gallery itself (not the nav, a link, or the open viewer)
  const inGallery = (t) => root.classList.contains("gallery-active") && !!t.closest
    && !!t.closest("#gallery") && !t.closest("a, button, .nav, dialog, [role=dialog]");
  function hover(e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    const over = !dragging && inGallery(e.target) ? pick(e.clientX, e.clientY) : -1;
    if (over !== -1 && cursorEl && root.classList.contains("has-cursor")) {
      cursorEl.classList.add("is-lock");
      cursorEl.classList.remove("is-drag");
      if (cursorLabel) cursorLabel.textContent = "Open";
    }
    if ((over !== -1) === (hovered !== -1)) { hovered = over; return; }
    hovered = over;
    if (pin) pin.style.cursor = over !== -1 ? "pointer" : "";
  }

  // ── rotation: scroll sets a base angle, drag adds an offset with inertia ──
  let dragOffset = 0, vel = 0, dragging = false, lastX = 0, lastT = 0;
  let downX = 0, downY = 0, downT = 0, pressed = false;
  let focusCard = -1;                      // a keyboard-focused <li> turns the ring to its card
  function down(e) {
    if (!inGallery(e.target)) return;
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastT = performance.now(); vel = 0;
    pressed = true; downX = e.clientX; downY = e.clientY; downT = lastT;
    focusCard = -1;
    root.classList.add("is-dragging");
  }
  function move(e) {
    if (!dragging) return;
    const now = performance.now();
    const dx = e.clientX - lastX;
    const d = dx / Math.max(320, window.innerWidth) * Math.PI * 1.2;
    dragOffset -= d;
    vel = -d / Math.max(1, now - lastT) * 16;
    lastX = e.clientX; lastT = now;
  }
  function up(e) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    if (root.classList.contains("still")) vel = 0;
    if (pressed && e.type === "pointerup" && performance.now() - downT < TAP_MS
      && Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_PX) {
      const i = pick(e.clientX, e.clientY);
      if (i !== -1) { vel = 0; open(i); }
    }
    pressed = false;
  }
  window.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);

  // keyboard: the viewer makes the (visually hidden) list items focusable and opens one on
  // Enter/Space; focusing one here turns the ring to its card. Enter anywhere else in the
  // gallery opens the front card.
  for (const c of cards) {
    c.item.li.addEventListener("focus", () => setFocus(c.item.index));
    c.item.li.addEventListener("blur", () => setFocus(-1));
  }
  function setFocus(i) {
    if (focusCard !== -1) cards[focusCard].edge.material.color.copy(pal.paper);
    focusCard = i;
    if (i !== -1) cards[i].edge.material.color.copy(pal.lock);
    repaint = true;
  }
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.defaultPrevented || !root.classList.contains("gallery-active")) return;
    if (e.target.closest && e.target.closest("#gallery-list, a, button, input, textarea, select, [contenteditable], dialog, [role=dialog]")) return;
    open(frontIndex);
  });

  let frontIndex = 0, aiming = false;
  let repaint = false;                     // a change the stage must draw even when nothing moves

  return {
    group, cards, load,
    get front() { return frontIndex; },
    get moving() {
      const r = repaint; repaint = false;
      return r || dragging || aiming || Math.abs(vel) > 1e-4;
    },
    /** @returns {number} the ring angle in degrees */
    update(state, local, dt, still) {
      vis = state.carousel;
      group.visible = vis > 0.01;
      if (vis > 0.2) load();
      if (!dragging) { dragOffset += vel; vel *= Math.pow(0.9, Math.max(dt, 1 / 60) * 60); if (Math.abs(vel) < 1e-4) vel = 0; }
      // scroll turns the ring card by card: each card dwells at the front, then the ring
      // moves on to the next one (drag adds a free offset on top)
      const step = (Math.PI * 2) / n;
      const pos = Math.min(1, Math.max(0, local) / 0.6) * (n - 1);
      const k = Math.floor(pos), frac = pos - k;
      const e = frac < 0.4 ? 0 : frac > 0.8 ? 1 : ((x) => x * x * (3 - 2 * x))((frac - 0.4) / 0.4);
      aiming = false;
      if (focusCard !== -1 && !dragging) {
        // the offset that brings the focused card to the front, nearest to the current one
        let goal = (focusCard - (k + e)) * step;
        goal += Math.round((dragOffset - goal) / (Math.PI * 2)) * Math.PI * 2;
        vel = 0;
        dragOffset = still ? goal : goal + (dragOffset - goal) * Math.exp(-8 * dt);
        aiming = Math.abs(dragOffset - goal) > 1e-3;
      }
      const angle = -(k + e) * step - dragOffset;
      group.rotation.y = angle;
      group.scale.setScalar((0.85 + 0.15 * vis) * (window.innerWidth < 820 ? 1.3 : 1));
      let best = -Infinity;
      cards.forEach((c, i) => {
        c.holder.getWorldDirection(tmp);
        const facing = tmp.z;                     // 1 = facing the viewer
        if (facing > best) { best = facing; frontIndex = i; }
        const f = Math.max(0, facing);
        c.mat.opacity = vis * (0.12 + 0.88 * Math.pow(f, facePow));
        c.edge.material.opacity = vis * (0.18 + 0.6 * f * f);
        if (c.video) {
          if (vis > 0.5 && facing > 0.3) { if (c.video.paused) c.video.play().catch(() => {}); }
          else if (!c.video.paused) c.video.pause();
        }
      });
      return (-angle * 180 / Math.PI);
    },
  };
}
