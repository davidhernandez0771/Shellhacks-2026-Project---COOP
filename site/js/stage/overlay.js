// The layer COOPER "understands" the scene with: detection brackets, leader-line labels, the
// velocity vector, the ghost's aim point and trail, "my lane" in the Warn chapter, and the
// leader lines of the exploded hardware. Lines go on a 2D canvas; labels are DOM nodes so
// they stay crisp and can scramble in with anime.js when a target is acquired.

import { OBJECTS, BOUNDS, FOCUS_INDEX, EYE, RIG, objectState, edgeFade } from "./world.js";
import { GHOST_S, LANE_HALF, LANE_LEN, bearing } from "./director.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const LOCK_AT = 0.3;           // chapter 02 progress at which the target locks
// Martian Mono at 10 px, 87.5% width: about 6.4 px per character (no layout reads per frame)
const labelWidth = (text) => text.length * 6.4 + 4;
const ease = (x) => { x = clamp01(x); return 1 - Math.pow(1 - x, 3); };

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    paper: v("--paper"), paper2: v("--paper-2"), paper3: v("--paper-3"), lock: v("--lock"), line: v("--line-strong"),
    yellow: v("--led-yellow"), red: v("--led-red"),
  };
}

export function createOverlay({ canvas, labelsEl, scramble, still }) {
  const ctx = canvas.getContext("2d");
  const col = tokens();
  let W = 0, H = 0, dpr = 1;

  function resize(w, h, ratio) {
    W = w; H = h; dpr = ratio;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }

  // ── DOM tags ───────────────────────────────────────────
  const tags = new Map();
  function tag(key, cls) {
    let t = tags.get(key);
    if (!t) {
      const el = document.createElement("div");
      el.className = `tag ${cls || ""}`;
      const line = document.createElement("span");
      el.appendChild(line);
      labelsEl.appendChild(el);
      t = { el, line, text: "", shown: false, sub: null };
      tags.set(key, t);
    }
    t.used = true;
    return t;
  }
  // `ident` names what the label is about; the label scrambles in when it first appears or
  // when its subject changes, and otherwise just updates its text (numbers ticking).
  function setTag(t, x, y, alpha, text, { lock = false, dim = false, sub = null, ident = text } = {}) {
    if (alpha <= 0.01) {
      if (t.shown) { t.el.style.opacity = "0"; t.shown = false; }
      return;
    }
    if (ident !== t.ident || !t.shown) {
      t.ident = ident;
      t.text = text;
      if (!still && scramble) scramble(t.line, text); else t.line.textContent = text;
    } else if (text !== t.text) {
      t.text = text;
      t.line.textContent = text;
    }
    if (sub !== t.sub) {
      t.sub = sub;
      let s = t.el.querySelector("small");
      if (sub) {
        if (!s) { s = document.createElement("small"); t.el.appendChild(s); }
        s.textContent = sub;
      } else if (s) s.remove();
    }
    t.shown = true;
    t.el.classList.toggle("is-lock", lock);
    t.el.classList.toggle("is-dim", dim);
    t.el.style.opacity = alpha.toFixed(3);
    t.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
  function sweepTags() {
    for (const [, t] of tags) {
      if (!t.used && t.shown) { t.el.style.opacity = "0"; t.shown = false; }
      t.used = false;
    }
  }

  // ── geometry helpers ───────────────────────────────────
  const corners = new Array(8).fill(0).map(() => [0, 0, 0]);
  function screenBox(i, s, project) {
    const b = BOUNDS[OBJECTS[i].kind];
    const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
    let k = 0;
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
      corners[k][0] = ch * x - sh * z + s.x;
      corners[k][1] = y;
      corners[k][2] = sh * x + ch * z + s.z;
      k++;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of corners) {
      const p = project(c);
      if (!p.front) return null;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) return null;
    return { x0, y0, x1, y1 };
  }

  function brackets(b, len, color, width, grow) {
    const g = grow || 0;
    const x0 = b.x0 - g, y0 = b.y0 - g, x1 = b.x1 + g, y1 = b.y1 + g;
    const L = Math.min(len, (x1 - x0) * 0.35, (y1 - y0) * 0.35);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
    ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
    ctx.moveTo(x0, y1 - L); ctx.lineTo(x0, y1); ctx.lineTo(x0 + L, y1);
    ctx.moveTo(x1 - L, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - L);
    ctx.stroke();
  }

  // past aim points in world space, re-projected every frame (like the dashboard)
  const trail = [];
  let lastTrailT = -1;

  /**
   * @param {object} s  director state
   * @param {object} ctxs  { t, local (per-chapter progress array), project, solids }
   */
  let drewLast = true;
  function draw(s, { t, local, project, partAnchors, level, scan, center }) {
    const needs = s.detect > 0.01 || s.predict > 0.01 || s.explode > 0.55 || s.eye > 0.01 || s.rig > 0.05;
    if (!needs && !drewLast) { sweepTags(); return; }
    drewLast = needs;
    // A full reset, not clearRect: in testing, clearRect sometimes left leader lines behind
    // on a GPU-backed canvas (headless Chromium / SwiftShader).
    if (ctx.reset) ctx.reset(); else canvas.width = canvas.width; // eslint-disable-line no-self-assign
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const small = W < 700;

    // viewfinder: COOP's own 4:3 frame (640 × 480), strongest in 01 --------------
    if (s.eye > 0.01) {
      const va = s.eye * (0.45 + 0.55 * s.scan);
      const fh = small ? Math.min(H * 0.22, (W - 48) * 0.75) : Math.min(H * 0.6, (W * 0.62) * 0.75);
      const fw = fh * 4 / 3;
      const x0 = center.x - fw / 2, y0 = center.y - fh / 2, x1 = x0 + fw, y1 = y0 + fh;
      ctx.globalAlpha = va * 0.9;
      brackets({ x0, y0, x1, y1 }, small ? 14 : 22, col.paper, 1);
      // optical axis
      ctx.globalAlpha = va * 0.5;
      ctx.strokeStyle = col.paper;
      ctx.beginPath();
      ctx.moveTo(center.x - 7, center.y); ctx.lineTo(center.x + 7, center.y);
      ctx.moveTo(center.x, center.y - 7); ctx.lineTo(center.x, center.y + 7);
      ctx.stroke();
      // the rolling-shutter line, clipped to the frame
      const sy = (1 - scan) * 0.5 * H;
      if (s.scan > 0.01 && sy > y0 && sy < y1) {
        ctx.globalAlpha = s.scan * s.eye * 0.35;
        ctx.beginPath(); ctx.moveTo(x0, sy); ctx.lineTo(x1, sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const frameNo = String(Math.floor(t * 14) % 1000000).padStart(6, "0");
      setTag(tag("vf-tl"), x0, y0 - 16, va * 0.9, "OV5647 · 640 × 480", { dim: true });
      setTag(tag("vf-tr"), x1 - labelWidth(`FRAME ${frameNo}`), y0 - 16, va * 0.9, `FRAME ${frameNo}`, { dim: true, ident: "frame" });
      if (!small) setTag(tag("vf-bl"), x0, y1 + 6, va * 0.9, "63.0° × 49.0°", { dim: true });
    }

    // my lane (chapter 04): the strip ahead of the unit, in the colour of the lit LED ------
    const laneA = s.rig * (1 - s.explode) * clamp01(s.street / 0.8);   // on the street only (not Build, Team)
    if (laneA > 0.02) {
      const c = level === 2 ? col.red : level === 1 ? col.yellow : col.paper3;
      ctx.strokeStyle = c;
      ctx.lineWidth = level ? 1.5 : 1;
      ctx.globalAlpha = laneA * (level ? 0.9 : 0.7);
      ctx.setLineDash([6, 6]);
      let far = null;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        let open = false;
        for (let z = RIG[2] - 0.3; z >= RIG[2] - LANE_LEN - 1e-6; z -= 0.4) {
          const q = project([RIG[0] + side * LANE_HALF, 0, z]);
          if (!q.front) { open = false; continue; }
          if (open) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); open = true; }
          if (side === 1) far = q;                       // the far corner carries the tag
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const name = ["CLEAR", "YELLOW · PATH ENTERS", "RED · IN MY LANE"][level];
      if (far) setTag(tag("lane"), far.x + 10, far.y - 8, laneA, `MY LANE · ${name}`, { dim: !level });
    }

    // detections ------------------------------------------------------------
    const pDetect = local[2];
    if (s.detect > 0.01) {
      OBJECTS.forEach((o, i) => {
        const st = objectState(i, t);
        const fade = edgeFade(st.x);
        const b = screenBox(i, st, project);
        const key = `det-${o.id}`;
        if (!b || fade <= 0.01) return;
        // stagger: each box snaps in at its own point of the chapter
        const order = [0.06, 0.1, 0.13, 0.16, 0.19][i] ?? 0.16;
        const appear = s.detect >= 0.99 ? ease((pDetect - order) / 0.08) : s.detect;
        const isFocus = i === FOCUS_INDEX;
        const lockAmt = isFocus ? clamp01((pDetect - LOCK_AT) / 0.04) * s.lock + (s.predict > 0 ? s.lock : 0) : 0;
        const locked = isFocus && Math.min(1, lockAmt) > 0.5;
        // keep the copy column clean: boxes that drift behind it on wide screens fade out
        const cx = (b.x0 + b.x1) / 2;
        const copyFade = small ? 1 : clamp01((cx - W * 0.36) / (W * 0.08));
        const a = appear * fade * copyFade * (isFocus ? 1 : Math.max(0.35, s.detect));
        if (a <= 0.01) return;
        const grow = (1 - appear) * 26;
        const color = locked ? col.lock : isFocus ? col.paper : col.paper2;
        ctx.globalAlpha = a;
        brackets(b, 14, color, locked ? 1.6 : 1, grow);
        if (locked) {
          ctx.globalAlpha = a * 0.35;
          ctx.strokeStyle = col.lock;
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        }
        // leader: from a top corner, up and out to the label; flips left near the right edge
        const conf = (o.conf + Math.sin(t * 1.7 + i * 2) * 0.015).toFixed(2);
        // phones: only the focus target gets the full label, the rest just their ID
        const label = small && !isFocus ? `#${o.id}` : `${o.kind.toUpperCase()} #${o.id} · CONF ${conf}`;
        const labelW = labelWidth(label);
        const run = small ? 14 : 26, rise = small ? 12 : 22, off = small ? 10 : 18;
        const flip = b.x1 + off + run + labelW + 8 > W - 12;
        const sx = flip ? b.x0 : b.x1;
        const lx = flip ? sx - off : sx + off, ly = b.y0 - rise;
        const ex = flip ? lx - run : lx + run;
        ctx.globalAlpha = a * 0.8;
        ctx.strokeStyle = locked ? col.lock : col.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, b.y0);
        ctx.lineTo(lx, ly);
        ctx.lineTo(ex, ly);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const tg = tag(key);
        setTag(tg, flip ? ex - 4 - labelW : ex + 4, ly - 7, a, label, { lock: locked, dim: !isFocus, sub: locked ? "TRACKED" : null, ident: `${o.id}${small && !isFocus ? "s" : ""}` });
      });
    }

    // prediction ------------------------------------------------------------
    if (s.predict > 0.01) {
      const st = objectState(FOCUS_INDEX, t);
      const fade = edgeFade(st.x);
      const pr = s.predict * fade;
      const c = project([st.x, 0.95, st.z]);
      const future = objectState(FOCUS_INDEX, t + GHOST_S);
      const g = project([future.x, 0.95, future.z]);
      const wrapped = Math.abs(future.x - st.x) > 5;
      if (c.front && g.front && !wrapped && pr > 0.01) {
        // velocity arrow
        const dx = g.x - c.x, dy = g.y - c.y;
        const len = Math.hypot(dx, dy);
        if (len > 12) {
          const ux = dx / len, uy = dy / len;
          ctx.globalAlpha = pr;
          ctx.strokeStyle = col.paper;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(g.x - ux * 14, g.y - uy * 14);
          ctx.stroke();
          ctx.fillStyle = col.paper;
          ctx.beginPath();
          const hx = g.x - ux * 12, hy = g.y - uy * 12;
          ctx.moveTo(hx + ux * 8, hy + uy * 8);
          ctx.lineTo(hx - uy * 4.5, hy + ux * 4.5);
          ctx.lineTo(hx + uy * 4.5, hy - ux * 4.5);
          ctx.closePath();
          ctx.fill();
        }
        // trail of past aim points (world positions, re-projected)
        if (!still && t - lastTrailT > 0.12) {
          trail.push([future.x, future.z]);
          if (trail.length > 14) trail.shift();
          lastTrailT = t;
        }
        trail.forEach((p, k) => {
          const q = project([p[0], 0.95, p[1]]);
          if (!q.front || Math.abs(p[0] - future.x) > 4) return;
          const age = (k + 1) / trail.length;
          ctx.globalAlpha = pr * age * 0.55;
          ctx.fillStyle = col.lock;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 1.2 + 1.8 * age, 0, Math.PI * 2);
          ctx.fill();
        });
        // aim ring on the ghost
        ctx.globalAlpha = pr;
        ctx.strokeStyle = col.lock;
        ctx.lineWidth = 1.5;
        const r = small ? 7 : 9;
        ctx.beginPath();
        ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        ctx.moveTo(g.x - r * 2, g.y); ctx.lineTo(g.x - r * 1.3, g.y);
        ctx.moveTo(g.x + r * 1.3, g.y); ctx.lineTo(g.x + r * 2, g.y);
        ctx.moveTo(g.x, g.y - r * 2); ctx.lineTo(g.x, g.y - r * 1.3);
        ctx.moveTo(g.x, g.y + r * 1.3); ctx.lineTo(g.x, g.y + r * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        setTag(tag("ghost"), g.x + r * 2 + 6, g.y + 6, pr, `PATH · t + ${GHOST_S.toFixed(1)} s`, { lock: true });
        // angular rate as COOP measures it: world-angle change seen from the camera
        const w = (bearing(EYE, objectState(FOCUS_INDEX, t + 0.1).x, st.z) - bearing(EYE, st.x, st.z)) / 0.1;
        setTag(tag("vel"), c.x - 8, c.y + (small ? 40 : 64), pr * 0.9, `ω ${w >= 0 ? "+" : "−"}${Math.abs(w).toFixed(1)}°/s`, { dim: true, ident: "vel" });
      } else if (wrapped) {
        trail.length = 0;
      }
    } else {
      trail.length = 0;
    }

    // exploded hardware leaders ------------------------------------------------
    const partA = clamp01((s.explode - 0.55) / 0.35);
    if (partA > 0.01 && partAnchors) {
      const a = partA;
      let maxX = 0;
      for (const p of partAnchors) if (p.screen.front) maxX = Math.max(maxX, p.screen.x);
      const colX = Math.min(maxX + (small ? 18 : 48), W - (small ? 120 : 230));
      // labels in a column, top to bottom in anchor order, pushed apart so none overlap;
      // a leader runs from each anchor, bends, and meets its label
      const gap = small ? 22 : 38;
      const rows = partAnchors.filter((p) => p.screen.front).sort((p, q) => p.screen.y - q.screen.y);
      let prev = -Infinity;
      for (const p of rows) { p.ly = Math.max(p.screen.y, prev + gap); prev = p.ly; }
      const over = prev - (H - (small ? 90 : 110));
      if (over > 0) for (const p of rows) p.ly -= over;          // keep the column on screen
      for (let i = rows.length - 2; i >= 0; i--) rows[i].ly = Math.min(rows[i].ly, rows[i + 1].ly - gap);
      for (const p of rows) {
        const q = p.screen;
        const endX = Math.max(q.x + 24, colX);
        const led = p.key === "yellow" ? col.yellow : p.key === "red" ? col.red : null;
        ctx.globalAlpha = a * 0.85;
        ctx.strokeStyle = p.key === "camera" ? col.lock : led || col.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2, 0, Math.PI * 2);
        ctx.moveTo(q.x + 2, q.y);
        ctx.lineTo(endX - 14, p.ly);
        ctx.lineTo(endX, p.ly);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const tg = tag(`part-${p.key}`, "part");
        setTag(tg, endX + 8, p.ly - 8, a, p.name, { sub: small ? null : p.spec, lock: p.key === "camera" });
      }
    }

    ctx.globalAlpha = 1;
    sweepTags();
  }

  return { resize, draw };
}
