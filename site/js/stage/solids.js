// The physical thing: COOPER itself, a fixed dashcam (Pi 5 in its case, the camera on a post,
// two LEDs in the lid). Drawn as "technical drawing" solids: an ink fill that hides what's
// behind it, and thin paper edges on top. Nothing on it moves in use; in the Build chapter
// the parts pull apart into an exploded view.
//
// ── The model ─────────────────────────────────────────────────────────────────────
// models/cooper-camera.glb is made from the team's CAD by tools/cad_to_glb.py: metres,
// lens facing -Z, +Y up, origin at the centre of the case's bottom face, one node per
// part (PART_NODES). It's loaded lazily, when the scroll nears the Warn chapter (loadModel);
// until then, or if it fails, a stand-in made of boxes with the same parts is shown.
// Set CAMERA_MODEL_URL to null to always use the stand-in.
export const CAMERA_MODEL_URL = "models/cooper-camera.glb";
export const CAMERA_MODEL_SCALE = 1;

import * as THREE from "three";
import { RIG } from "./world.js";

const EDGE_ANGLE = 28;

// label key (#parts li[data-part]) → node name in the .glb
export const PART_NODES = {
  camera: "Camera_Module",
  mount: "Camera_Mount",
  lid: "Pi_Case_Lid",
  yellow: "LED5mm_Yellow",
  red: "LED5mm_Red",
  pi: "RASPBERRY_PI_5_1",
  case: "Pi_Case",
};

// The exploded view, in model metres: where each part ends up, and the slice of the
// explode progress (0..1) in which it travels. The lid lifts off first, taking the LEDs
// with it and then letting them rise further; the Pi rises out of the tray; the camera
// mount and then the camera module slide forward, toward the road. The tray stays.
const EXPLODE = {
  lid:    { to: [0, 0.062, 0],       at: [0.00, 0.40] },
  yellow: { to: [0, 0.108, 0],       at: [0.05, 0.55] },
  red:    { to: [0, 0.108, 0],       at: [0.05, 0.55] },
  pi:     { to: [0, 0.030, 0],       at: [0.30, 0.75] },
  mount:  { to: [0, 0.020, -0.032],  at: [0.40, 0.85] },
  camera: { to: [0, 0.020, -0.082],  at: [0.50, 1.00] },
  case:   { to: [0, 0, 0],           at: [0.00, 1.00] },
};

// the unit in the scene: small and at dash height in Warn/Team, large for the Build chapter
const UNIT = {
  scale: 4.2, y: 1.05,               // ~0.26 m wide × 0.39 m long: reads at street scale
  buildScale: 5.2, buildY: 0.72,
};

function palette() {
  const css = getComputedStyle(document.documentElement);
  const rgb = (name) => css.getPropertyValue(name).trim().split(/\s+/).map(Number);
  return {
    paper: new THREE.Color(...rgb("--gl-paper")),
    lock: new THREE.Color(...rgb("--gl-lock")),
    yellow: new THREE.Color(...rgb("--gl-led-yellow")),
    red: new THREE.Color(...rgb("--gl-led-red")),
  };
}

function makeMats(pal) {
  const fill = () => new THREE.MeshBasicMaterial({
    color: 0x0b0b0a, transparent: true, opacity: 1,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const edge = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return {
    fill: fill(),
    edge: edge(pal.paper, 0.85),
    lockEdge: edge(pal.lock, 1),
    // the LEDs get their own materials so they can light up
    yellow: { fill: fill(), edge: edge(pal.paper, 0.85) },
    red: { fill: fill(), edge: edge(pal.paper, 0.85) },
  };
}

// one EdgesGeometry per geometry, even when a mesh is instanced (the two LEDs share one)
const edgeCache = new WeakMap();
function edgesOf(geometry) {
  if (!edgeCache.has(geometry)) edgeCache.set(geometry, new THREE.EdgesGeometry(geometry, EDGE_ANGLE));
  return edgeCache.get(geometry);
}

function restyle(mesh, fill, edge) {
  mesh.material = fill;
  mesh.add(new THREE.LineSegments(edgesOf(mesh.geometry), edge));
}

function matsFor(key, mats) {
  if (key === "yellow" || key === "red") return mats[key];
  return { fill: mats.fill, edge: key === "camera" ? mats.lockEdge : mats.edge };
}

// ───────────────────────── stand-in (until the .glb arrives) ─────────────────────────
// Same parts, same places (the node centres of the .glb), as simple solids.
function standIn() {
  const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const cyl = (r, h, x = 0, y = 0, z = 0, alongZ = false) => {
    const g = new THREE.CylinderGeometry(r, r, h, 20);
    if (alongZ) g.rotateX(Math.PI / 2);
    return g.translate(x, y, z);
  };
  const merge = (geos) => {
    // tiny merge: the stand-in only needs positions
    const pos = [];
    for (const g of geos) {
      const n = g.index ? g.toNonIndexed() : g;
      pos.push(...n.getAttribute("position").array);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return out;
  };
  const part = (name, geo, x, y, z) => {
    const m = new THREE.Mesh(geo);
    m.name = name;
    m.position.set(x, y, z);
    return m;
  };
  const led = merge([cyl(0.0025, 0.009, 0, 0.012, 0), cyl(0.0003, 0.028, -0.001, -0.006, 0), cyl(0.0003, 0.028, 0.001, -0.006, 0)]);
  const root = new THREE.Group();
  root.add(
    part("Pi_Case", box(0.062, 0.027, 0.092), 0, 0.0135, 0),
    part("Pi_Case_Lid", box(0.062, 0.012, 0.092), 0, 0.031, 0),
    part("RASPBERRY_PI_5_1", merge([box(0.056, 0.0016, 0.085), box(0.02, 0.016, 0.017, 0.012, 0.008, 0.034), box(0.015, 0.014, 0.017, -0.01, 0.007, 0.034)]), 0.0006, 0.0126, -0.0018),
    part("Camera_Mount", merge([box(0.036, 0.036, 0.008, 0, 0.012, 0), box(0.012, 0.03, 0.012, 0, -0.015, 0.004)]), 0.0003, 0.0551, -0.0428),
    part("Camera_Module", merge([box(0.025, 0.024, 0.002, 0, 0, 0.011), box(0.0085, 0.0085, 0.006, 0, 0, 0.006), cyl(0.0045, 0.011, 0, 0, -0.0045, true)]), 0.0002, 0.061, -0.0562),
    part("LED5mm_Yellow", led, -0.0157, 0.0173, 0.0395),
    part("LED5mm_Red", led, 0.0157, 0.0173, 0.0395),
  );
  return root;
}

// ───────────────────────── the unit ─────────────────────────
/** Wrap a model's part nodes in pivots we can move, restyle them, and measure them. */
function adopt(model, mats) {
  const parts = {};
  for (const [key, name] of Object.entries(PART_NODES)) {
    const node = model.getObjectByName(name);
    if (!node) throw new Error(`model has no node ${name}`);
    const m = matsFor(key, mats);
    node.traverse((o) => { if (o.isMesh) restyle(o, m.fill, m.edge); });
    node.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(node, true);
    // label anchor: the middle of the part's right-hand face, in model space
    parts[key] = {
      node,
      base: node.position.clone(),
      anchor: new THREE.Vector3(box.max.x, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2),
      box,
    };
  }
  const cam = parts.camera.box;
  const lens = new THREE.Vector3((cam.min.x + cam.max.x) / 2, (cam.min.y + cam.max.y) / 2, cam.min.z);
  return { model, parts, lens };
}

function buildFrustum(pal) {
  // the view volume (63° × 49°), fixed: per-vertex alpha, bright at the lens, gone at the far plane
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false });
  const L = 6.5, hx = Math.tan((63 / 2) * Math.PI / 180) * L, hy = Math.tan((49 / 2) * Math.PI / 180) * L;
  const c = [[-hx, hy], [hx, hy], [hx, -hy], [-hx, -hy]].map(([x, y]) => [x, y, -L]);
  const fr = [];
  for (const p of c) fr.push(0, 0, 0, ...p);
  for (let i = 0; i < 4; i++) fr.push(...c[i], ...c[(i + 1) % 4]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(fr, 3));
  const cols = [];
  for (let i = 0; i < fr.length / 3; i++) {
    const far = i >= 8 || i % 2 === 1;             // lens→corner lines: odd vertices are far
    cols.push(pal.paper.r, pal.paper.g, pal.paper.b, far ? 0.0 : 0.7);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
  return { lines: new THREE.LineSegments(geo, mat), mat };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => x * x * (3 - 2 * x);

export function createSolids(scene) {
  const pal = palette();
  const mats = makeMats(pal);
  const unit = new THREE.Group();
  unit.position.set(RIG[0], UNIT.y, RIG[2]);
  const frustum = buildFrustum(pal);
  scene.add(unit, frustum.lines);

  let current = adopt(standIn(), mats);
  unit.add(current.model);

  let loading = false;
  /** Fetch the real model (once). Called when the scroll nears the Warn chapter. */
  function loadModel() {
    if (loading || !CAMERA_MODEL_URL) return;
    loading = true;
    import("../../vendor/GLTFLoader.js").then(({ GLTFLoader }) => {
      new GLTFLoader().load(CAMERA_MODEL_URL, (gltf) => {
        const model = gltf.scene;
        try {
          const next = adopt(model, mats);         // measured at scale 1, in model space
          model.scale.setScalar(CAMERA_MODEL_SCALE);
          unit.remove(current.model);
          current = next;
          unit.add(model);
        } catch (e) { console.warn("COOPER model:", e.message); }
      }, undefined, () => { /* keep the stand-in */ });
    }).catch(() => { /* keep the stand-in */ });
  }

  const tmp = new THREE.Vector3();
  const lensW = new THREE.Vector3();

  return {
    pal, loadModel,
    /** Apply the director state. `led` is 0 clear, 1 yellow, 2 red (red overrides yellow). */
    update(state, t, led = 0) {
      const vis = state.rig;
      unit.visible = vis > 0.01;
      const ex = state.explode;
      const z = ease(state.zoom);                  // 0 on the street, 1 in the Build chapter
      unit.scale.setScalar(UNIT.scale + (UNIT.buildScale - UNIT.scale) * z);
      unit.position.y = UNIT.y + (UNIT.buildY - UNIT.y) * z;

      mats.fill.opacity = vis;
      mats.edge.opacity = 0.85 * vis;
      mats.lockEdge.opacity = vis;
      // LEDs: lit by the risk level; in the Build chapter both glow so you can tell them apart
      for (const [key, on] of [["yellow", led === 1], ["red", led === 2]]) {
        const m = mats[key];
        const glow = Math.max(on ? 1 : 0, 0.55 * ex);
        m.fill.color.setRGB(0.043, 0.043, 0.039).lerp(pal[key], glow);
        m.fill.opacity = vis;
        m.edge.color.copy(pal.paper).lerp(pal[key], glow);
        m.edge.opacity = 0.85 * vis;
      }

      for (const [key, p] of Object.entries(current.parts)) {
        const x = EXPLODE[key];
        const k = ease(clamp01((ex - x.at[0]) / (x.at[1] - x.at[0])));
        p.node.position.set(p.base.x + x.to[0] * k, p.base.y + x.to[1] * k, p.base.z + x.to[2] * k);
      }

      // the fixed view volume, from the lens, straight down the road
      unit.updateMatrixWorld();
      lensW.copy(current.lens);
      current.parts.camera.node.parent.localToWorld(lensW.add(current.parts.camera.node.position).sub(current.parts.camera.base));
      frustum.lines.position.copy(lensW);
      frustum.mat.opacity = 0.5 * vis * (1 - state.zoom);
      frustum.lines.visible = frustum.mat.opacity > 0.01;
    },
    /** World position of a part's label anchor. */
    partAnchor(key, out = tmp) {
      const p = current.parts[key];
      out.copy(p.anchor).sub(p.base).add(p.node.position);
      return p.node.parent.localToWorld(out);
    },
  };
}
