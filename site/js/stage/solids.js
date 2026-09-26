// The physical things: the COOP rig (camera on a pan base) and the exploded hardware stack.
// Drawn as "technical drawing" solids: an ink fill that hides what's behind it, and thin
// paper edges on top. Orange is reserved for the lens ring (the eye) and the aim ray.
//
// ── Swapping in the real camera model ─────────────────────────────────────────────
// Put a .glb of the actual camera in site/models/ and set CAMERA_MODEL_URL below, e.g.
//   export const CAMERA_MODEL_URL = "models/coop-camera.glb";
// The model replaces the procedural pan head. Model it facing -Z with +Y up, origin at the
// pan axis, in metres (the procedural head is ~0.3 m wide; scale with CAMERA_MODEL_SCALE).
// GLTFLoader is only downloaded when this is set.
export const CAMERA_MODEL_URL = null;
export const CAMERA_MODEL_SCALE = 1;

import * as THREE from "three";
import { RIG } from "./world.js";

const EDGE_ANGLE = 28;

function palette() {
  const css = getComputedStyle(document.documentElement);
  const rgb = (name) => css.getPropertyValue(name).trim().split(/\s+/).map(Number);
  return { paper: new THREE.Color(...rgb("--gl-paper")), lock: new THREE.Color(...rgb("--gl-lock")) };
}

/** An ink-filled solid with paper edges. Returns a Group; opacity is driven via setOpacity. */
function solid(geometry, mats, { edgeColor } = {}) {
  const g = new THREE.Group();
  const fill = new THREE.Mesh(geometry, mats.fill);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, EDGE_ANGLE), edgeColor ? mats.lockEdge : mats.edge);
  g.add(fill, edges);
  return g;
}

function makeMats(pal) {
  const fill = new THREE.MeshBasicMaterial({
    color: 0x0b0b0a, transparent: true, opacity: 1,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const edge = new THREE.LineBasicMaterial({ color: pal.paper, transparent: true, opacity: 0.85 });
  const lockEdge = new THREE.LineBasicMaterial({ color: pal.lock, transparent: true, opacity: 1 });
  return { fill, edge, lockEdge };
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, h, seg = 28) => new THREE.CylinderGeometry(r, r, h, seg);

function place(obj, x, y, z, rx = 0, ry = 0, rz = 0) {
  obj.position.set(x, y, z);
  obj.rotation.set(rx, ry, rz);
  return obj;
}

// ───────────────────────── rig ─────────────────────────
function buildHead(mats) {
  const head = new THREE.Group();
  head.add(place(solid(box(0.3, 0.2, 0.2), mats), 0, 0.14, 0));                       // camera body
  head.add(place(solid(cyl(0.075, 0.1), mats), 0, 0.14, -0.15, Math.PI / 2));        // lens barrel
  head.add(place(solid(new THREE.TorusGeometry(0.075, 0.006, 6, 40), mats, { edgeColor: true }), 0, 0.14, -0.2));
  head.add(place(solid(box(0.36, 0.035, 0.26), mats), 0, 0.02, 0));                  // bracket plate
  return head;
}

function buildRig(mats, pal) {
  const rig = new THREE.Group();
  rig.position.set(...RIG);
  const base = new THREE.Group();
  base.add(place(solid(cyl(0.34, 0.03, 36), mats), 0, 0.015, 0));     // foot
  base.add(place(solid(cyl(0.028, 0.84, 12), mats), 0, 0.45, 0));     // stand
  base.add(place(solid(box(0.5, 0.24, 0.5), mats), 0, 0.99, 0));      // housing (motor inside)
  base.add(place(solid(cyl(0.2, 0.035, 36), mats), 0, 1.13, 0));      // turntable
  rig.add(base);
  const pan = new THREE.Group();                                        // rotates about +Y
  pan.position.y = 1.15;
  let head = buildHead(mats);
  pan.add(head);
  rig.add(pan);

  // view frustum (63° × 49°) and the aim ray, in the pan group's space
  // per-vertex alpha: bright at the lens, fading to nothing at the far plane
  const frustumMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false });
  const L = 6.5, hx = Math.tan((63 / 2) * Math.PI / 180) * L, hy = Math.tan((49 / 2) * Math.PI / 180) * L;
  const o = [0, 0.14, -0.2];
  const c = [[-hx, hy], [hx, hy], [hx, -hy], [-hx, -hy]].map(([x, y]) => [x, 0.14 + y, -L]);
  const fr = [];
  for (const p of c) fr.push(...o, ...p);
  for (let i = 0; i < 4; i++) fr.push(...c[i], ...c[(i + 1) % 4]);
  const frGeo = new THREE.BufferGeometry();
  frGeo.setAttribute("position", new THREE.Float32BufferAttribute(fr, 3));
  const cols = [];
  for (let i = 0; i < fr.length / 3; i++) {
    const far = i >= 8 || i % 2 === 1;             // lens→corner lines: odd vertices are far
    cols.push(pal.paper.r, pal.paper.g, pal.paper.b, far ? 0.0 : 0.7);
  }
  frGeo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
  const frustum = new THREE.LineSegments(frGeo, frustumMat);
  pan.add(frustum);

  return { rig, base, pan, frustum, frustumMat, setHead(h) { pan.remove(head); head = h; pan.add(h); } };
}

// ───────────────────────── hardware parts (scale 0.02 m per mm, not to scale with the rig) ─────────────────────────
function buildParts(mats) {
  const parts = {};
  const S = 0.02;
  const mm = (v) => v * S;

  // OV5647 camera: board facing the viewer, lens toward +z
  const cam = new THREE.Group();
  cam.add(place(solid(box(mm(25), mm(24), mm(1.6)), mats), 0, 0, 0));
  cam.add(place(solid(box(mm(8.5), mm(8.5), mm(5)), mats), 0, mm(1.5), mm(3.3)));
  cam.add(place(solid(cyl(mm(7), mm(9), 32), mats), 0, mm(1.5), mm(10), Math.PI / 2));
  cam.add(place(solid(new THREE.TorusGeometry(mm(7), mm(0.35), 6, 40), mats, { edgeColor: true }), 0, mm(1.5), mm(14.6)));
  cam.add(place(solid(box(mm(16), mm(4), mm(3)), mats), 0, -mm(10), -mm(1.5)));
  parts.camera = { group: cam, anchor: [mm(13), mm(4), 0] };

  // Raspberry Pi 5: 85 × 56 board, ports along one edge, active cooler
  const pi = new THREE.Group();
  pi.add(place(solid(box(mm(85), mm(1.6), mm(56)), mats), 0, 0, 0));
  pi.add(place(solid(box(mm(17), mm(13.5), mm(21)), mats), mm(33), mm(7.5), mm(-15)));
  pi.add(place(solid(box(mm(17), mm(15.5), mm(13)), mats), mm(33), mm(8.5), mm(4)));
  pi.add(place(solid(box(mm(17), mm(15.5), mm(13)), mats), mm(33), mm(8.5), mm(20)));
  pi.add(place(solid(box(mm(40), mm(8), mm(40)), mats), mm(-12), mm(5), mm(2)));
  pi.add(place(solid(cyl(mm(14), mm(2), 32), mats), mm(-12), mm(10), mm(2)));
  pi.add(place(solid(box(mm(51), mm(8.5), mm(5)), mats), mm(-8), mm(5), mm(-25)));
  parts.pi = { group: pi, anchor: [mm(43), mm(6), 0] };

  // Arduino Uno: 69 × 53, USB-B and barrel jack
  const uno = new THREE.Group();
  uno.add(place(solid(box(mm(69), mm(1.6), mm(53)), mats), 0, 0, 0));
  uno.add(place(solid(box(mm(16), mm(11), mm(12)), mats), mm(-29), mm(6.3), mm(-12)));
  uno.add(place(solid(box(mm(14), mm(11), mm(9)), mats), mm(-30), mm(6.3), mm(18)));
  uno.add(place(solid(box(mm(35), mm(4), mm(9)), mats), mm(8), mm(3), mm(4)));
  uno.add(place(solid(box(mm(46), mm(8.5), mm(2.5)), mats), mm(6), mm(5), mm(-24.5)));
  uno.add(place(solid(box(mm(38), mm(8.5), mm(2.5)), mats), mm(10), mm(5), mm(24.5)));
  parts.uno = { group: uno, anchor: [mm(35), mm(4), 0] };

  // TMC2209 module with its heatsink
  const drv = new THREE.Group();
  drv.add(place(solid(box(mm(20), mm(1.6), mm(15)), mats), 0, 0, 0));
  drv.add(place(solid(box(mm(9), mm(2), mm(9)), mats), 0, mm(1.8), 0));
  for (let i = 0; i < 5; i++) drv.add(place(solid(box(mm(1), mm(7), mm(9)), mats), mm(-4 + i * 2), mm(6.3), 0));
  drv.add(place(solid(box(mm(20), mm(8.5), mm(2.5)), mats), 0, mm(-5), mm(-6.2)));
  drv.add(place(solid(box(mm(20), mm(8.5), mm(2.5)), mats), 0, mm(-5), mm(6.2)));
  parts.driver = { group: drv, anchor: [mm(10), mm(3), 0] };

  // NEMA 17: 42 × 42 × 40 with a shaft (the pan axis)
  const mot = new THREE.Group();
  mot.add(place(solid(box(mm(42), mm(34), mm(42)), mats), 0, 0, 0));
  mot.add(place(solid(box(mm(42), mm(3), mm(42)), mats), 0, mm(18.5), 0));
  mot.add(place(solid(cyl(mm(11), mm(2), 32), mats), 0, mm(21), 0));
  mot.add(place(solid(cyl(mm(2.5), mm(22), 16), mats, { edgeColor: true }), 0, mm(31), 0));
  parts.motor = { group: mot, anchor: [mm(21), mm(0), 0] };

  // 12 V supply → buck converter
  const pwr = new THREE.Group();
  pwr.add(place(solid(box(mm(62), mm(30), mm(44)), mats), mm(-16), 0, 0));
  pwr.add(place(solid(box(mm(43), mm(1.6), mm(21)), mats), mm(40), mm(-6), 0));
  pwr.add(place(solid(cyl(mm(6), mm(7), 20), mats), mm(44), mm(-1.5), 0));
  pwr.add(place(solid(box(mm(5), mm(8), mm(5)), mats), mm(30), mm(-1), mm(-5)));
  parts.power = { group: pwr, anchor: [mm(61), mm(-6), 0] };

  // exploded layout, bottom to top (y), in the stack group's space
  const order = [["power", 0.0], ["motor", 0.72], ["driver", 1.34], ["uno", 1.78], ["pi", 2.32], ["camera", 2.98]];
  const stack = new THREE.Group();
  stack.position.set(RIG[0], 0.25, RIG[2]);
  stack.rotation.y = -0.42;
  for (const [key, y] of order) {
    const p = parts[key];
    p.y = y;
    p.group.position.y = y;
    stack.add(p.group);
  }
  return { stack, parts, order };
}

export function createSolids(scene) {
  const pal = palette();
  const mats = makeMats(pal);
  const partMats = makeMats(pal);
  const rig = buildRig(mats, pal);
  const hw = buildParts(partMats);
  scene.add(rig.rig, hw.stack);

  if (CAMERA_MODEL_URL) {
    import("../../vendor/GLTFLoader.js").then(({ GLTFLoader }) => {
      new GLTFLoader().load(CAMERA_MODEL_URL, (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(CAMERA_MODEL_SCALE);
        // restyle to match the scene (it has no lights): ink fill + paper edges
        const meshes = [];
        model.traverse((o) => { if (o.isMesh) meshes.push(o); });
        for (const m of meshes) {
          m.material = mats.fill;
          m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, EDGE_ANGLE), mats.edge));
        }
        rig.setHead(model);
      });
    }).catch(() => { /* keep the procedural head */ });
  }

  const tmp = new THREE.Vector3();

  return {
    rig, hw, pal,
    /** Apply the director state. */
    update(state, t) {
      const rigVis = state.rig;
      rig.rig.visible = rigVis > 0.01;
      const housing = rigVis * state.housing;
      mats.fill.opacity = housing;
      mats.edge.opacity = 0.85 * housing;
      mats.lockEdge.opacity = housing;
      rig.frustumMat.opacity = 0.5 * rigVis * (1 - state.explode);
      rig.frustum.visible = rig.frustumMat.opacity > 0.01;
      rig.pan.rotation.y = -state.pan * Math.PI / 180;

      const ex = state.explode;
      hw.stack.visible = ex > 0.01;
      partMats.fill.opacity = Math.min(1, ex * 1.4);
      partMats.edge.opacity = 0.9 * Math.min(1, ex * 1.4);
      partMats.lockEdge.opacity = Math.min(1, ex * 1.4);
      const e = ex * ex * (3 - 2 * ex);
      for (const [key] of hw.order) {
        const p = hw.parts[key];
        // collapsed: everything sits inside the housing (y ≈ 0.75); exploded: its slot
        p.group.position.y = 0.75 + (p.y - 0.75) * e;
        p.group.rotation.y = (1 - e) * 0.6 + Math.sin(t * 0.25 + p.y) * 0.04 * e;
      }
      hw.stack.scale.setScalar(0.62 * (0.55 + 0.45 * e));
    },
    /** World position of a part's label anchor. */
    partAnchor(key, out = tmp) {
      const p = hw.parts[key];
      out.set(...p.anchor);
      return p.group.localToWorld(out);
    },
    /** World position of the lens (for the aim ray). */
    lensWorld(out = tmp) {
      out.set(0, 0.14, -0.2);
      return rig.pan.localToWorld(out);
    },
  };
}
