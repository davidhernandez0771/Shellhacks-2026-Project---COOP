// 06 Gallery: a ring of cards built from the <ul id="gallery-list"> items. Images and videos
// load lazily (only when the gallery is near); items without data-src get a drawn placeholder.

import * as THREE from "three";

const RADIUS = 3.5;
const CARD_W = 1.62, CARD_H = 1.08;     // 3:2

function readItems() {
  return Array.from(document.querySelectorAll("#gallery-list > li")).map((li, i) => ({
    title: li.textContent.trim(),
    src: li.dataset.src || null,
    kind: li.dataset.kind || (li.dataset.src && /\.(mp4|webm|mov)$/i.test(li.dataset.src) ? "video" : "image"),
    alt: li.dataset.alt || li.textContent.trim(),
    index: i,
  }));
}

function placeholderTexture(item, total) {
  const c = document.createElement("canvas");
  c.width = 768; c.height = 512;
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
  // play glyph for video slots
  if (item.kind === "video") {
    g.strokeStyle = v("--paper-2");
    g.beginPath(); g.moveTo(c.width / 2 - 18, c.height / 2 - 26); g.lineTo(c.width / 2 + 26, c.height / 2); g.lineTo(c.width / 2 - 18, c.height / 2 + 26); g.closePath(); g.stroke();
  } else {
    g.strokeStyle = v("--paper-3");
    g.beginPath(); g.moveTo(c.width / 2 - 30, c.height / 2); g.lineTo(c.width / 2 + 30, c.height / 2);
    g.moveTo(c.width / 2, c.height / 2 - 30); g.lineTo(c.width / 2, c.height / 2 + 30); g.stroke();
  }
  const mono = `"Martian Mono", ui-monospace, monospace`;
  g.fillStyle = v("--paper-2");
  g.font = `400 20px ${mono}`;
  g.fillText(`${String(item.index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, m + 6, m + 58);
  g.fillStyle = v("--paper");
  g.font = `500 30px "Archivo", sans-serif`;
  g.fillText(item.title, m + 6, c.height - m - 44);
  g.fillStyle = v("--lock");
  g.font = `400 18px ${mono}`;
  g.fillText(`PLACEHOLDER · ${item.kind === "video" ? "video" : "photo"} 3:2`, m + 6, c.height - m - 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function mediaTexture(item, onReady) {
  if (item.kind === "video") {
    const v = document.createElement("video");
    Object.assign(v, { src: item.src, muted: true, loop: true, playsInline: true, preload: "metadata", crossOrigin: "anonymous" });
    v.setAttribute("muted", "");
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    v.addEventListener("loadeddata", () => onReady(tex, v), { once: true });
    return;
  }
  new THREE.TextureLoader().load(item.src, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    onReady(tex, null);
  });
}

/** Cover-fit a texture into the 3:2 card. */
function cover(tex, w, h) {
  const aspect = w / h, card = CARD_W / CARD_H;
  tex.repeat.set(1, 1); tex.offset.set(0, 0);
  if (aspect > card) { tex.repeat.x = card / aspect; tex.offset.x = (1 - tex.repeat.x) / 2; }
  else { tex.repeat.y = aspect / card; tex.offset.y = (1 - tex.repeat.y) / 2; }
}

export function createCarousel(scene, pal) {
  const items = readItems();
  const group = new THREE.Group();
  group.position.set(0, 1.45, 0);
  group.visible = false;
  scene.add(group);

  const cards = [];
  const plane = new THREE.PlaneGeometry(CARD_W, CARD_H);
  const edgeGeo = new THREE.EdgesGeometry(plane);
  const n = items.length;
  items.forEach((item, i) => {
    const a = (i / n) * Math.PI * 2;
    const holder = new THREE.Group();
    holder.position.set(Math.sin(a) * RADIUS, 0, Math.cos(a) * RADIUS);
    holder.rotation.y = a;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(plane, mat);
    const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: pal.paper, transparent: true, opacity: 0 }));
    holder.add(mesh, edge);
    group.add(holder);
    cards.push({ item, holder, mesh, mat, edge, video: null, loaded: false });
  });

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    for (const c of cards) {
      c.mat.map = placeholderTexture(c.item, n);
      c.mat.needsUpdate = true;
      if (c.item.src) {
        mediaTexture(c.item, (tex, video) => {
          const w = video ? video.videoWidth : tex.image.width;
          const h = video ? video.videoHeight : tex.image.height;
          cover(tex, w, h);
          c.mat.map = tex;
          c.mat.needsUpdate = true;
          c.video = video;
        });
      }
    }
  }

  // rotation: scroll sets a base angle, drag adds an offset with inertia
  let dragOffset = 0, vel = 0, dragging = false, lastX = 0, lastT = 0;
  const root = document.documentElement;
  function down(e) {
    if (!root.classList.contains("gallery-active")) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest && e.target.closest("a, button, .nav")) return;
    dragging = true; lastX = e.clientX; lastT = performance.now(); vel = 0;
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
  function up() {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    if (root.classList.contains("still")) vel = 0;
  }
  window.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);

  const tmp = new THREE.Vector3();
  let frontIndex = 0;

  return {
    group, cards, load,
    get front() { return frontIndex; },
    get moving() { return dragging || Math.abs(vel) > 1e-4; },
    /** @returns {number} the ring angle in degrees (drives the bearing tape) */
    update(state, local, dt, still) {
      const vis = state.carousel;
      group.visible = vis > 0.01;
      if (vis > 0.2) load();
      if (!dragging) { dragOffset += vel; vel *= Math.pow(0.9, Math.max(dt, 1 / 60) * 60); if (Math.abs(vel) < 1e-4) vel = 0; }
      const angle = -local * Math.PI * 1.25 - dragOffset;
      group.rotation.y = angle;
      group.scale.setScalar(0.85 + 0.15 * vis);
      let best = -Infinity;
      cards.forEach((c, i) => {
        c.holder.getWorldDirection(tmp);
        const facing = tmp.z;                     // 1 = facing the viewer
        if (facing > best) { best = facing; frontIndex = i; }
        const f = Math.max(0, facing);
        c.mat.opacity = vis * (0.18 + 0.82 * f * f);
        c.edge.material.opacity = vis * (0.2 + 0.5 * f);
        if (c.video) {
          if (vis > 0.5 && facing > 0.3) { if (c.video.paused) c.video.play().catch(() => {}); }
          else if (!c.video.paused) c.video.pause();
        }
      });
      return (-angle * 180 / Math.PI);
    },
  };
}
