// Chapter choreography: turns (scroll position, time) into the scene's target state.
// Each chapter is a keyframe function of time; scroll blends between neighbours.

import { EYE, RIG, OBJECTS, FOCUS_INDEX, objectState } from "./world.js";

export const CHAPTERS = ["Intro", "See", "Detect", "Predict", "Move", "Build", "Gallery", "Team"];
export const LEAD_S = 0.15;          // the real lead time (coop/config.py lead_time_s)
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

/** Where COOP aims: the focus target's position led by its velocity. */
export function aimPoint(t, lead = LEAD_S) {
  const s = objectState(FOCUS_INDEX, t);
  return { x: s.x + s.vx * lead, z: s.z };
}

function followYaw(t, gain = 1, limit = 38) {
  const a = aimPoint(t);
  const y = bearing(EYE, a.x, a.z) * gain;
  return Math.max(-limit, Math.min(limit, y));
}

export function rigPan(t) {
  const a = aimPoint(t);
  return Math.max(-170, Math.min(170, bearing(RIG, a.x, a.z)));
}

const BASE = {
  pos: [0, 1.6, 11], look: [0, 1.3, 0], fov: 42,
  form: 1, street: 1, detect: 0, lock: 0, predict: 0, rig: 0, housing: 1, explode: 0,
  carousel: 0, scrim: 1, pan: 0, eye: 0, scan: 0,
};

const KEYS = [
  // 0 intro: noise
  (t) => ({ form: 0, pos: [0, 1.7, 11.5], look: [0, 1.4, 0], pan: 0 }),
  // 1 see: COOP scans the street
  (t) => {
    const yaw = 13 * Math.sin(t * 0.16);
    return { eye: 1, pos: EYE.slice(), look: eyeLook(yaw), pan: yaw, scan: 1 };
  },
  // 2 detect: boxes, then a lock
  (t) => {
    const yaw = followYaw(t, 0.55);
    return { eye: 1, pos: EYE.slice(), look: eyeLook(yaw), pan: yaw, detect: 1, lock: 1 };
  },
  // 3 predict: follow with lead
  (t) => {
    const yaw = followYaw(t, 0.9);
    return { eye: 1, pos: EYE.slice(), look: eyeLook(yaw), pan: yaw, detect: 0.55, lock: 1, predict: 1 };
  },
  // 4 move: third person, the rig turns
  (t) => ({
    pos: [RIG[0] - 4.6, 2.9, RIG[2] + 6.0], look: [RIG[0] + 2.6, 1.0, RIG[2] - 2.2], fov: 40,
    rig: 1, street: 0.8, detect: 0.3, lock: 1, predict: 0.45, pan: rigPan(t), scrim: 0.9,
  }),
  // 5 build: exploded hardware
  (t) => ({
    pos: [RIG[0] + 2.2, 2.0, RIG[2] + 5.4], look: [RIG[0] + 0.55, 1.2, RIG[2]], fov: 36,
    rig: 1, housing: 0.1, explode: 1, street: 0.04, pan: 0, scrim: 0.85,
  }),
  // 6 gallery: carousel
  (t) => ({ pos: [0, 2.2, 9.4], look: [0, 1.3, 0], fov: 40, carousel: 1, street: 0, form: 0.85, scrim: 0.7 }),
  // 7 team: back to a quiet field
  (t) => ({ pos: [0, 1.7, 12], look: [0, 1.4, 0], form: 0.18, street: 0.7, pan: 0 }),
];

const NUM_KEYS = ["fov", "form", "street", "detect", "lock", "predict", "rig", "housing", "explode", "carousel", "scrim", "pan", "eye", "scan"];

function resolve(i, t) {
  return { ...BASE, ...KEYS[i](t) };
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
  const a = resolve(i, t);
  if (i >= n - 1) return a;
  const hold = holds[i] ?? 0.5;
  let w = smooth(hold, 1, frac);
  if (cut) w = frac > hold + (1 - hold) * 0.5 ? 1 : 0;
  if (w <= 0) return a;
  const b = resolve(i + 1, t);
  const out = {};
  for (const k of NUM_KEYS) out[k] = lerp(a[k], b[k], w);
  out.pos = a.pos.map((v, j) => lerp(v, b.pos[j], w));
  out.look = a.look.map((v, j) => lerp(v, b.look[j], w));
  return out;
}

export { OBJECTS, smooth, lerp };
