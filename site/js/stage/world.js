// The street COOP watches, as data. Pure JS (no three.js), so the WebGL renderer, the 2D
// fallback and the overlay all agree on where everything is.
// Units are metres. +x is right, +y is up, -z is away from the viewer (toward the street).

export const RANGE_X = 17;          // objects wrap around at ±RANGE_X
export const EYE = [0, 1.55, 8.6];  // "COOP's eye" camera position for chapters 01-03
export const RIG = [-2.4, 0, 3.4];  // where the physical rig stands in chapter 04

// id = the tracker ID shown on labels; conf = base detection confidence (illustrative).
export const OBJECTS = [
  { id: 3, kind: "person", z: 0.6, speed: 1.15, dir: 1, x0: -3.2, conf: 0.87, focus: true },
  { id: 1, kind: "person", z: -1.9, speed: 0.95, dir: -1, x0: 3.8, conf: 0.74 },
  { id: 5, kind: "person", z: -2.6, speed: 1.05, dir: 1, x0: -8.5, conf: 0.69 },
  { id: 7, kind: "car", z: -4.9, speed: 5.2, dir: 1, x0: -12, conf: 0.91 },
  { id: 9, kind: "car", z: -7.3, speed: 3.8, dir: -1, x0: 4.5, conf: 0.66 },
];
export const FOCUS_INDEX = OBJECTS.findIndex((o) => o.focus);

// Local bounding boxes (object faces +x): [minX, minY, minZ, maxX, maxY, maxZ]
export const BOUNDS = {
  person: [-0.3, 0, -0.26, 0.3, 1.8, 0.26],
  car: [-2.15, 0, -0.95, 2.15, 1.52, 0.95],
};

const STRIDE = 1.35;                 // metres per full walk cycle

const wrap = (x) => {
  const span = RANGE_X * 2;
  return ((((x + RANGE_X) % span) + span) % span) - RANGE_X;
};

/** Position/heading/walk phase of object i at time t (seconds). */
export function objectState(i, t) {
  const o = OBJECTS[i];
  const dist = o.speed * t;
  return {
    x: wrap(o.x0 + o.dir * dist),
    z: o.z,
    heading: o.dir > 0 ? 0 : Math.PI,
    phase: (dist / STRIDE) * Math.PI * 2 + i * 1.3,
    vx: o.dir * o.speed,
  };
}

/** Alpha for objects near the wrap edge, so the wrap is never visible. */
export function edgeFade(x) {
  const a = Math.abs(x);
  return a < RANGE_X - 3 ? 1 : Math.max(0, (RANGE_X - a) / 3);
}

// ───────────────────────── seeded random ─────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Part codes: how the shader animates a point.
export const PART = { BODY: 0, LEG_L: 1, LEG_R: 2, ARM_L: 3, ARM_R: 4, STATIC: 9 };

// ───────────────────────── shape samplers ─────────────────────────
function sampleEllipsoid(out, r, n, cx, cy, cz, rx, ry, rz, part, bright) {
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    out.push([cx + rx * s * Math.cos(th), cy + ry * u, cz + rz * s * Math.sin(th), part, bright]);
  }
}
function sampleCylinderY(out, r, n, cx, cz, y0, y1, rx, rz, part, bright) {
  for (let i = 0; i < n; i++) {
    const th = r() * Math.PI * 2, y = y0 + (y1 - y0) * r();
    out.push([cx + rx * Math.cos(th), y, cz + rz * Math.sin(th), part, bright]);
  }
}
function sampleBoxSurface(out, r, n, x0, y0, z0, x1, y1, z1, part, bright, skipBottom) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const faces = [
    [dy * dz, 0], [dy * dz, 1], [dx * dz, 2], [skipBottom ? 0 : dx * dz, 3], [dx * dy, 4], [dx * dy, 5],
  ];
  const total = faces.reduce((a, f) => a + f[0], 0);
  for (let i = 0; i < n; i++) {
    let pick = r() * total, f = 0;
    while (f < 5 && pick > faces[f][0]) { pick -= faces[f][0]; f++; }
    const a = r(), b = r();
    let p;
    switch (f) {
      case 0: p = [x0, y0 + a * dy, z0 + b * dz]; break;
      case 1: p = [x1, y0 + a * dy, z0 + b * dz]; break;
      case 2: p = [x0 + a * dx, y1, z0 + b * dz]; break;
      case 3: p = [x0 + a * dx, y0, z0 + b * dz]; break;
      case 4: p = [x0 + a * dx, y0 + b * dy, z0]; break;
      default: p = [x0 + a * dx, y0 + b * dy, z1];
    }
    out.push([p[0], p[1], p[2], part, bright]);
  }
}
function sampleDiscZ(out, r, n, cx, cy, cz, rad, part, bright) {
  for (let i = 0; i < n; i++) {
    const th = r() * Math.PI * 2, rr = rad * Math.sqrt(0.55 + 0.45 * r());
    out.push([cx + rr * Math.cos(th), cy + rr * Math.sin(th), cz, part, bright]);
  }
}

function samplePerson(r) {
  const out = [];
  sampleEllipsoid(out, r, 150, 0, 1.64, 0, 0.1, 0.12, 0.1, PART.BODY, 1.25);          // head
  sampleEllipsoid(out, r, 60, 0, 1.49, 0, 0.05, 0.05, 0.05, PART.BODY, 1.0);          // neck
  sampleEllipsoid(out, r, 420, 0, 1.18, 0, 0.13, 0.28, 0.2, PART.BODY, 1.0);          // torso
  sampleEllipsoid(out, r, 110, 0, 0.94, 0, 0.12, 0.08, 0.17, PART.BODY, 0.95);        // hips
  sampleCylinderY(out, r, 150, 0, 0.1, 0.02, 0.92, 0.06, 0.065, PART.LEG_L, 0.95);    // legs
  sampleCylinderY(out, r, 150, 0, -0.1, 0.02, 0.92, 0.06, 0.065, PART.LEG_R, 0.95);
  sampleCylinderY(out, r, 95, 0, 0.26, 0.86, 1.4, 0.04, 0.04, PART.ARM_L, 0.9);        // arms
  sampleCylinderY(out, r, 95, 0, -0.26, 0.86, 1.4, 0.04, 0.04, PART.ARM_R, 0.9);
  return out;
}

function sampleCar(r) {
  const out = [];
  sampleBoxSurface(out, r, 1250, -2.1, 0.32, -0.9, 2.1, 0.95, 0.9, PART.BODY, 0.9, true);  // body
  // cabin: a box with a narrower roof, sampled as two boxes for a sloped read
  sampleBoxSurface(out, r, 520, -1.0, 0.95, -0.8, 0.9, 1.22, 0.8, PART.BODY, 0.85, true);
  sampleBoxSurface(out, r, 380, -0.75, 1.22, -0.76, 0.55, 1.46, 0.76, PART.BODY, 0.85, true);
  for (const wx of [-1.35, 1.35]) {
    for (const wz of [-0.92, 0.92]) sampleDiscZ(out, r, 90, wx, 0.33, wz, 0.33, PART.BODY, 0.9);
  }
  // headlights and tail lights: small bright clusters
  for (const lz of [-0.62, 0.62]) {
    sampleEllipsoid(out, r, 40, 2.12, 0.72, lz, 0.03, 0.06, 0.12, PART.BODY, 2.6);
    sampleEllipsoid(out, r, 26, -2.12, 0.75, lz, 0.03, 0.05, 0.1, PART.BODY, 1.6);
  }
  return out;
}

function sampleStreet(r) {
  const out = [];
  const S = PART.STATIC;
  // ground dot matrix, sparser with distance
  for (let z = 6; z > -16; z -= 0.42) {
    const step = z > -4 ? 0.42 : z > -9 ? 0.55 : 0.75;
    for (let x = -24; x < 24; x += step) {
      out.push([x + (r() - 0.5) * 0.12, 0, z + (r() - 0.5) * 0.12, S, 0.22 + r() * 0.1]);
    }
  }
  // curbs
  for (const cz of [-3.7, -8.5]) for (let x = -24; x < 24; x += 0.07) out.push([x, 0.02 + (r() * 0.02), cz, S, 0.8]);
  // lane dashes
  for (let x = -24; x < 24; x += 2.4) for (let d = 0; d < 1.3; d += 0.06) out.push([x + d, 0.01, -6.1 + (r() - 0.5) * 0.05, S, 0.75]);
  // lamp posts along the near curb
  for (const lx of [-10, -2.5, 5, 12.5]) {
    for (let y = 0; y < 4.2; y += 0.03) out.push([lx + (r() - 0.5) * 0.03, y, -3.45, S, 0.55]);
    for (let d = 0; d < 0.8; d += 0.03) out.push([lx + d * 0.2, 4.2 + d * 0.1, -3.45 - d, S, 0.55]);
    sampleEllipsoid(out, r, 60, lx + 0.16, 4.25, -4.25, 0.1, 0.05, 0.1, S, 2.4);
  }
  // building facades beyond the far curb: dotted outlines + windows
  let x = -26;
  while (x < 26) {
    const w = 3 + r() * 5, h = 3.5 + r() * 8, z = -11 - r() * 2.5;
    for (let y = 0; y < h; y += 0.1) { out.push([x, y, z, S, 0.4]); out.push([x + w, y, z, S, 0.4]); }
    for (let xx = x; xx < x + w; xx += 0.1) out.push([xx, h, z, S, 0.4]);
    for (let wy = 1.2; wy < h - 0.8; wy += 1.3) {
      for (let wx = x + 0.6; wx < x + w - 0.8; wx += 1.1) {
        const lit = r() < 0.18;
        const n = lit ? 22 : 7;
        for (let k = 0; k < n; k++) out.push([wx + r() * 0.55, wy + r() * 0.7, z + 0.01, S, lit ? 0.9 : 0.35]);
      }
    }
    x += w + 0.3 + r() * 1.2;
  }
  return out;
}

function sampleDust(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([(r() - 0.5) * 34, r() * 9, 4 - r() * 20, PART.STATIC, 0.25 + r() * 0.35]);
  }
  return out;
}

/**
 * Builds every point of the scene. Returns typed arrays ready for a BufferGeometry:
 *   position (home, local to the object for moving points), noise (scattered intro
 *   position), info (objIndex or -1, part, seed, brightness).
 * Also returns per-object ranges so the ghost copies can reuse the focus person's points.
 */
export function buildPoints() {
  const r = rng(20260926);
  const chunks = [];
  const ranges = [];
  let count = 0;
  OBJECTS.forEach((o, i) => {
    const pts = o.kind === "person" ? samplePerson(r) : sampleCar(r);
    ranges.push([count, pts.length]);
    chunks.push({ pts, obj: i });
    count += pts.length;
  });
  const street = sampleStreet(r);
  chunks.push({ pts: street, obj: -1 });
  count += street.length;
  const dust = sampleDust(r, 1400);
  chunks.push({ pts: dust, obj: -2 });
  count += dust.length;

  const position = new Float32Array(count * 3);
  const noise = new Float32Array(count * 3);
  const info = new Float32Array(count * 4);
  let k = 0;
  for (const { pts, obj } of chunks) {
    for (const p of pts) {
      position[k * 3] = p[0];
      position[k * 3 + 1] = p[1];
      position[k * 3 + 2] = p[2];
      // intro noise: a loose, flattened cloud in front of the camera
      const th = r() * Math.PI * 2, rad = Math.pow(r(), 0.6) * 9;
      noise[k * 3] = Math.cos(th) * rad * 1.35;
      noise[k * 3 + 1] = 1.6 + (r() - 0.5) * 6 * (1 - rad / 12);
      noise[k * 3 + 2] = -1.5 + Math.sin(th) * rad * 0.7;
      info[k * 4] = obj;
      info[k * 4 + 1] = p[3];
      info[k * 4 + 2] = r();
      info[k * 4 + 3] = p[4];
      k++;
    }
  }
  return { position, noise, info, count, ranges };
}

// ───────────────────────── JS mirror of the vertex shader ─────────────────────────
// Used by the 2D fallback. Keep in sync with POINT_VERTEX in gl.js.
const LIMB = {
  [PART.LEG_L]: [0.92, 0.5], [PART.LEG_R]: [0.92, -0.5],
  [PART.ARM_L]: [1.42, -0.4], [PART.ARM_R]: [1.42, 0.4],
};
export function pointWorld(px, py, pz, obj, part, seed, states, t, out) {
  let x = px, y = py, z = pz;
  if (obj >= 0) {
    const s = states[obj];
    const limb = LIMB[part];
    if (limb) {
      const a = Math.sin(s.phase) * limb[1];
      const c = Math.cos(a), sn = Math.sin(a);
      const dx = x, dy = y - limb[0];
      x = c * dx - sn * dy;
      y = limb[0] + sn * dx + c * dy;
    }
    if (OBJECTS[obj].kind === "person") y += Math.abs(Math.sin(s.phase)) * 0.03;
    const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
    const rx = ch * x - sh * z, rz = sh * x + ch * z;
    x = rx + s.x; z = rz + s.z;
  } else if (obj === -2) {
    x += Math.sin(t * 0.13 + seed * 40) * 0.4;
    y += Math.sin(t * 0.17 + seed * 23) * 0.25;
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
