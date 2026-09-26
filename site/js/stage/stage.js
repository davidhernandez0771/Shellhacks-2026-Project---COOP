// The persistent stage behind the page: one scene, one camera, one loop. Scroll sets the
// chapter; the director turns it into a target state; the camera eases toward it.

import * as THREE from "three";
import { OBJECTS, FOCUS_INDEX, objectState, edgeFade } from "./world.js";
import { stateAt, GHOST_S, SCAN_PERIOD } from "./director.js";

// rolling-shutter band position in NDC (top to bottom, then a short pause off-screen)
const scanY = (t) => 1.15 - ((t % SCAN_PERIOD) / SCAN_PERIOD) * 2.9;
import { createPoints } from "./points.js";
import { createSolids } from "./solids.js";
import { createCarousel } from "./carousel.js";
import { createOverlay, LOCK_AT } from "./overlay.js";
import { createFallback } from "./fallback2d.js";

const STILL_T = 7.4;        // the frozen moment used for reduced motion and the fallback
const MAX_DPR = 1.75;

function damp(a, b, lambda, dt) { return b + (a - b) * Math.exp(-lambda * dt); }

export function createStage({ still, webgl, scramble }) {
  const glCanvas = document.getElementById("stage-gl");
  const hudCanvas = document.getElementById("stage-hud");
  const labelsEl = document.getElementById("stage-labels");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);

  let renderer = null;
  let fallback = null;
  let solids, points, carousel;

  if (webgl) {
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
  }
  solids = createSolids(scene);
  const pal = solids.pal;
  if (webgl) {
    points = createPoints(scene, pal);
    carousel = createCarousel(scene, pal);
  } else {
    // the fallback only needs the point data, not GPU objects
    points = { data: null };
  }

  const overlay = createOverlay({ canvas: hudCanvas, labelsEl, scramble, still: still || !webgl });

  let fbData = null;

  // ── sizing ───────────────────────────────────────────────
  let W = 0, H = 0, ratio = 1, ratioCap = MAX_DPR;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    ratio = Math.min(window.devicePixelRatio || 1, ratioCap);
    camera.aspect = W / H;
    // Frame the subject away from the copy: right of centre on wide screens (copy is on the
    // left), higher up on phones (copy sits at the bottom). The overlay projects through the
    // same camera, so it follows automatically.
    const wide = W > 820;
    if (wide) camera.setViewOffset(W, H, -0.17 * W, 0, W, H);
    else camera.setViewOffset(W, H, 0, 0.17 * H, W, H);
    if (points && points.uniforms) {
      // copy column: the left ~40% on wide screens, the bottom ~45% on phones (NDC)
      points.uniforms.uCopyZone.value.set(wide ? 0 : 1, wide ? -0.5 : -0.35, wide ? -0.12 : 0.05, 1);
    }
    camera.updateProjectionMatrix();
    if (renderer) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(W, H, false);
    }
    if (fallback) fallback.resize(W, H, window.devicePixelRatio || 1);
    overlay.resize(W, H, Math.min(window.devicePixelRatio || 1, 2));
    dirty = true;
  }

  // ── inputs ───────────────────────────────────────────────
  let chapter = 0, holds = [], local = new Array(8).fill(0);
  let pointer = { x: 0, y: 0 }, pointerS = { x: 0, y: 0 };
  let dirty = true;
  function setScroll(c, h, l) {
    chapter = c; holds = h; local = l;
    dirty = true;
  }
  function setPointer(x, y) { pointer.x = x; pointer.y = y; }

  // ── state ────────────────────────────────────────────────
  let t = still || !webgl ? STILL_T : 0;
  const cur = { pos: new THREE.Vector3(0, 1.7, 11.5), look: new THREE.Vector3(0, 1.4, 0), fov: 42, pan: 0 };
  let first = true;
  let last = performance.now();
  let lastState = null;
  const listeners = [];
  const v3 = new THREE.Vector3();

  // where the optical axis lands on screen (the view offset moves it off-centre)
  function opticalCenter() {
    return W > 820 ? { x: W * 0.67, y: H * 0.5 } : { x: W * 0.5, y: H * 0.33 };
  }

  function project(p) {
    v3.set(p[0], p[1], p[2]).project(camera);
    return { x: (v3.x + 1) * 0.5 * W, y: (1 - v3.y) * 0.5 * H, front: v3.z > -1 && v3.z < 1 };
  }

  const partKeys = Array.from(document.querySelectorAll("#parts li")).map((li) => ({
    key: li.dataset.part,
    name: li.children[0].textContent,
    spec: li.children[1].textContent,
  }));

  // adaptive resolution: if frames are slow for a while, drop the pixel ratio
  let slowFrames = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const animate = !still && webgl;
    if (animate) t += dt;

    const s = stateAt(chapter, holds, t, still);
    // pointer parallax (not in still mode)
    if (animate) {
      pointerS.x = damp(pointerS.x, pointer.x, 3, dt);
      pointerS.y = damp(pointerS.y, pointer.y, 3, dt);
    }
    const par = 1 - s.eye * 0.7;
    const tgtPos = v3.set(s.pos[0] + pointerS.x * 0.45 * par, s.pos[1] - pointerS.y * 0.22 * par, s.pos[2]);
    if (first || !animate) {
      cur.pos.copy(tgtPos);
      cur.look.set(...s.look);
      cur.fov = s.fov;
      cur.pan = s.pan;
      first = false;
    } else {
      const k = 2.6;
      cur.pos.set(damp(cur.pos.x, tgtPos.x, k, dt), damp(cur.pos.y, tgtPos.y, k, dt), damp(cur.pos.z, tgtPos.z, k, dt));
      cur.look.set(damp(cur.look.x, s.look[0], k, dt), damp(cur.look.y, s.look[1], k, dt), damp(cur.look.z, s.look[2], k, dt));
      cur.fov = damp(cur.fov, s.fov, k, dt);
      cur.pan = damp(cur.pan, s.pan, 3.2, dt);
    }
    camera.position.copy(cur.pos);
    camera.lookAt(cur.look);
    // portrait screens: widen the vertical FOV so at least ~46° stays visible horizontally
    const minFov = (2 * Math.atan(Math.tan((23 * Math.PI) / 180) / camera.aspect) * 180) / Math.PI;
    const fov = Math.max(cur.fov, Math.min(minFov, 88));
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

    const eased = { ...s, pan: cur.pan };
    solids.update(eased, t);

    let bearing = cur.pan;
    if (webgl) {
      const u = points.uniforms;
      u.uTime.value = t;
      u.uForm.value = s.form;
      u.uStreet.value = s.street;
      u.uLock.value = s.lock * Math.max(s.detect > 0.5 ? Math.min(1, Math.max(0, (local[2] - LOCK_AT) / 0.04)) : 0, s.predict);
      u.uSize.value = 58 * ratio * Math.min(1.25, H / 900 + 0.35) * (W > 820 ? 1 : 0.7);
      u.uMaxSize.value = 8 * ratio;
      u.uCopyZone.value.w = s.form * (1 - s.carousel);
      u.uScan.value.set(scanY(t), s.scan);
      OBJECTS.forEach((o, i) => {
        const st = objectState(i, t);
        u.uObj.value[i].set(st.x, st.z, st.heading, st.phase);
        u.uObjFade.value[i] = edgeFade(st.x);
      });
      // ghosts: the predicted position and a short trail toward it
      const now0 = objectState(FOCUS_INDEX, t);
      const fut = objectState(FOCUS_INDEX, t + GHOST_S);
      const wrapped = Math.abs(fut.x - now0.x) > 5;
      points.ghosts.forEach((g, i) => {
        const f = (i + 1) / points.ghosts.length;
        const a = s.predict * (wrapped ? 0 : 1) * edgeFade(now0.x) * (i === points.ghosts.length - 1 ? 0.5 : 0.07 * f);
        g.visible = a > 0.005;
        g.material.uniforms.uGhost.value.set((fut.x - now0.x) * f, 0, a);
      });
      if (carousel) {
        if (carousel.moving) dirty = true;
        const cb = carousel.update(s, local[6], dt, still);
        if (s.carousel > 0.5) bearing = cb;
      }
      if (animate || dirty) renderer.render(scene, camera);
    } else if (fallback && dirty) {
      fallback.render(camera, scene, s, t, FOCUS_INDEX);
    }

    if (dirty || animate) {
      const partAnchors = s.explode > 0.4 ? partKeys.map((p) => {
        const w = solids.partAnchor(p.key);
        return { ...p, screen: project([w.x, w.y, w.z]) };
      }) : null;
      let lensScreen = null;
      if (s.rig > 0.05) { const l = solids.lensWorld(); lensScreen = project([l.x, l.y, l.z]); }
      overlay.draw(s, { t, local, project, partAnchors, lensScreen, scan: scanY(t), center: opticalCenter() });
    }

    lastState = { ...s, pan: cur.pan, aim: s.pan, bearing, t };
    for (const fn of listeners) fn(lastState);
    dirty = false;

    // adaptive resolution
    if (animate && ratioCap > 1 && dt > 0.026) {
      if (++slowFrames > 90) { ratioCap = Math.max(1, ratio - 0.5); slowFrames = 0; resize(); }
    } else if (slowFrames > 0) slowFrames--;

    requestAnimationFrame(frame);
  }

  function start() {
    if (!webgl) {
      import("./world.js").then(({ buildPoints }) => {
        fbData = buildPoints();
        fallback = createFallback(glCanvas, fbData, pal);
        resize();
        requestAnimationFrame(frame);
      });
      return;
    }
    resize();
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  // Warm the GPU: compile shaders now, during the loader, not on the first scroll.
  function warm() {
    if (!renderer) return;
    resize();
    renderer.compile(scene, camera);
  }

  return {
    start, warm, setScroll, setPointer, resize,
    onFrame(fn) { listeners.push(fn); },
    get state() { return lastState; },
  };
}
