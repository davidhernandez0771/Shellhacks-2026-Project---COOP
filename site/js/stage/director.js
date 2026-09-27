// Chapter choreography: turns (scroll position, time) into the scene's target state.
// Each chapter is a keyframe function of time; scroll blends between neighbours.

import { EYE, RIG, OBJECTS, BOUNDS, objectState } from "./world.js";

export const CHAPTERS = ["Intro", "See", "Detect", "Predict", "Warn", "Build", "Gallery", "Team"];
export const SCAN_PERIOD = 2.4;      // seconds per rolling-shutter sweep in chapter 01
export const GHOST_S = 1.6;          // the ghost is drawn further ahead than t_lead so it's visible

const DEG = 180 / Math.PI;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Bearing in degrees from a point to a world position (0 = facing -z, + = right). */
export function bearing(from, x, z) {
  return Math.atan2(x - from[0], -(z - from[2])) * DEG;
}

function eyeLook(yawDeg, pitch = -0.085) {
  const a = yawDeg / DEG;
  return [EYE[0] + Math.sin(a) * 10, EYE[1] + pitch * 10, EYE[2] - Math.cos(a) * 10];
}

// ── COOPER's warning level in the scene (illustrative, but by the real rules) ──
// "My lane" is the strip of road just ahead of the unit. Red: an object's box overlaps it now.
// Yellow: its predicted path, sampled every 0.1 s out to the 1.5 s horizon, enters it.
// Red overrides yellow, and a level holds for 0.5 s (see docs/MATH.md).
export const LANE_HALF = 0.8;        // metres either side of the unit's axis
export const LANE_LEN = 5.5;         // metres ahead of the unit
export const HORIZON_S = 1.5, STEP_S = 0.1, HOLD_S = 0.5;

function inLane(i, x) {
  const half = BOUNDS[OBJECTS[i].kind][3];
  return Math.abs(x - RIG[0]) < LANE_HALF + half;
}

function rawLevel(t) {
  let level = 0;
  for (let i = 0; i < OBJECTS.length; i++) {
    const s = objectState(i, t);
    if (s.z > RIG[2] || s.z < RIG[2] - LANE_LEN) continue;   // behind it, or further than the lane
    if (inLane(i, s.x)) return 2;
    if (level) continue;
    for (let k = 1; k * STEP_S <= HORIZON_S + 1e-9; k++) {
      const f = objectState(i, t + k * STEP_S);
      if (Math.abs(f.x - s.x) > 5) break;            // wrapped around the street's edge
      if (inLane(i, f.x)) { level = 1; break; }
    }
  }
  return level;
}

/** 0 clear, 1 yellow (warning), 2 red (danger), with the 0.5 s hold. */
export function riskLevel(t) {
  let level = 0;
  for (let d = 0; d <= HOLD_S + 1e-9 && level < 2; d += STEP_S) level = Math.max(level, rawLevel(t - d));
  return level;
}

const BASE = {
  pos: [0, 1.6, 11], look: [0, 1.3, 0], fov: 42,
  form: 1, street: 1, detect: 0, lock: 0, predict: 0, rig: 0, zoom: 0, explode: 0,
  carousel: 0, scrim: 1, eye: 0, scan: 0,
};

// COOPER is fixed: in chapters 01-03 the view is its own, straight down the road.
const LOOK_AHEAD = eyeLook(0);

const KEYS = [
  // 0 intro: noise
  (t) => ({ form: 0, pos: [0, 1.7, 11.5], look: [0, 1.4, 0] }),
  // 1 see: the rolling-shutter scan
  (t) => ({ eye: 1, pos: EYE.slice(), look: LOOK_AHEAD, scan: 1 }),
  // 2 detect: boxes, then a lock
  (t) => ({ eye: 1, pos: EYE.slice(), look: LOOK_AHEAD, detect: 1, lock: 1 }),
  // 3 predict: the path ahead
  (t) => ({ eye: 1, pos: EYE.slice(), look: LOOK_AHEAD, detect: 0.55, lock: 1, predict: 1 }),
  // 4 warn: third person behind the unit, its lane and its two LEDs
  (t) => ({
    pos: [RIG[0] - 2.3, 1.95, RIG[2] + 3.1], look: [RIG[0] + 1.3, 0.75, RIG[2] - 3.4], fov: 40,
    rig: 1, street: 0.8, detect: 0.3, lock: 1, predict: 0.45, scrim: 0.9,
  }),
  // 5 build: seen from the front right; scrolling through the chapter pulls the parts apart
  (t, frac) => ({
    pos: [RIG[0] + 1.55, 1.5, RIG[2] - 2.3], look: [RIG[0] + 0.02, 1.02, RIG[2] - 0.2], fov: 34,
    rig: 1, zoom: 1, explode: smooth(0.04, 0.45, frac), street: 0.04, scrim: 0.85,
  }),
  // 6 gallery: carousel
  (t) => ({ pos: [0, 2.2, 9.4], look: [0, 1.3, 0], fov: 40, carousel: 1, street: 0, form: 0.85, scrim: 0.7 }),
  // 7 team: a closing portrait of the unit; the view drifts, the unit doesn't move
  (t) => {
    const a = 0.75 + Math.sin(t * 0.07) * 0.2;
    return {
      pos: [RIG[0] + Math.sin(a) * 2.2, 1.6, RIG[2] + Math.cos(a) * 2.2], look: [RIG[0] - 0.1, 1.0, RIG[2]], fov: 34,
      form: 0.12, street: 0, rig: 1, scrim: 1,
    };
  },
];

const NUM_KEYS = ["fov", "form", "street", "detect", "lock", "predict", "rig", "zoom", "explode", "carousel", "scrim", "eye", "scan"];

function resolve(i, t, frac = 0) {
  return { ...BASE, ...KEYS[i](t, frac) };
}

// No camera blend may pass through the unit: a blended position inside this sphere is
// pushed out to its surface.
const KEEP_OUT = { c: [RIG[0], 1.2, RIG[2]], r: 2.1 };
function keepOut(p) {
  const d = p.map((v, j) => v - KEEP_OUT.c[j]);
  const len = Math.hypot(...d);
  if (len >= KEEP_OUT.r || len < 1e-6) return p;
  return d.map((v, j) => KEEP_OUT.c[j] + (v / len) * KEEP_OUT.r);
}

/**
 * @param {number} c  chapter float: integer part = chapter, fraction = progress through it
 * @param {number[]} holds  per chapter, the fraction of its scroll during which it holds
 *                          before blending into the next
 * @param {number} t  seconds
 * @param {boolean} cut  reduced motion: hard cut instead of a blend
 */
export function stateAt(c, holds, t, cut = false) {
  const n = KEYS.length;
  const i = Math.max(0, Math.min(n - 1, Math.floor(c)));
  const frac = c - i;
  const a = resolve(i, t, frac);
  if (i >= n - 1) return a;
  const hold = holds[i] ?? 0.5;
  let w = smooth(hold, 1, frac);
  if (cut) w = frac > hold + (1 - hold) * 0.5 ? 1 : 0;
  if (w <= 0) return a;
  const b = resolve(i + 1, t);
  const out = {};
  for (const k of NUM_KEYS) out[k] = lerp(a[k], b[k], w);
  out.pos = a.pos.map((v, j) => lerp(v, b.pos[j], w));
  if (a.rig > 0 || b.rig > 0) out.pos = keepOut(out.pos);
  out.look = a.look.map((v, j) => lerp(v, b.look[j], w));
  return out;
}

export { OBJECTS, smooth, lerp };
