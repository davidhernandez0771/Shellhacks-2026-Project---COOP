// A field of mono-space glyphs sampled from one shape's silhouette, each holding a matched
// point in a second shape; morphing between the two moves every glyph from its point in A to
// its point in B. Used by the intro (js/gate.js) to form the word "COOPER" out of a scattered
// burst shape. `createMorphingGlyphCloud(canvas, options)` draws into an existing canvas (the
// caller owns sizing/rAF) and returns { setMorph(target), progress, destroy() }.

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789<>/\\{}[]()=+-*#$%&@?!";
const FS = 0.018;
const MORPH_TAU = 0.46;
const MASK_SIZE = 320;

const SHAPES = {
  circle: "M12 1A11 11 0 1 1 11.99 1Z",
  burst: "M12 1L14.11 6.92L19.78 4.22L17.08 9.9L23 12L17.08 14.1L19.78 19.78L14.11 17.08L12 23L9.89 17.08L4.22 19.78L6.92 14.1L1 12L6.92 9.9L4.22 4.22L9.89 6.92Z",
  diamond: "M12 1L23 12L12 23L1 12Z",
};

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function parseRGB(input, fb) {
  if (!input) return fb;
  const str = String(input).trim();
  if (str.charAt(0) === "#") {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
    }
    return fb;
  }
  const m = str.match(/[\d.]+/g);
  if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
  return fb;
}

function maskCanvas(size) { const c = document.createElement("canvas"); c.width = size; c.height = size; return c; }

function maskFromPath(d, size) {
  if (typeof Path2D === "undefined") return null;
  const c = maskCanvas(size);
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) return null;
  x.setTransform(size / 24, 0, 0, size / 24, 0, 0);
  x.fillStyle = "#000";
  try { x.fill(new Path2D(d), "evenodd"); } catch { return null; }
  x.setTransform(1, 0, 0, 1, 0, 0);
  return { img: x.getImageData(0, 0, size, size), size };
}

function maskFromText(text, family, weight, size) {
  const c = maskCanvas(size);
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) return null;
  const box = size * 0.86;
  x.textAlign = "center"; x.textBaseline = "middle";
  const lines = String(text).split("\n");
  const probe = 100;
  x.font = weight + " " + probe + "px " + family;
  let widest = 1;
  for (const ln of lines) widest = Math.max(widest, x.measureText(ln).width);
  const fs = Math.max(4, Math.min((box / widest) * probe, (box / (lines.length * 1.12)) * probe));
  x.font = weight + " " + fs.toFixed(1) + "px " + family;
  x.fillStyle = "#000";
  const step = fs * 1.12;
  const y0 = size / 2 - ((lines.length - 1) * step) / 2;
  for (let i = 0; i < lines.length; i++) x.fillText(lines[i], size / 2, y0 + i * step);
  return { img: x.getImageData(0, 0, size, size), size };
}

function fitPoints(mask, spacing, rand) {
  const out = [];
  if (!mask) return out;
  const S = mask.size;
  const data = mask.img.data;
  const hit = new Uint8Array(S * S);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
  for (let i = 0; i < S * S; i++) {
    if (data[i * 4 + 3] <= 128) continue;
    any = true; hit[i] = 1;
    const gx = i % S, gy = (i / S) | 0;
    if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
    if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
  }
  if (!any) return out;
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const cell = Math.max(1.6, spacing * span);
  for (let gy2 = y0; gy2 < y1; gy2 += cell) {
    for (let gx2 = x0; gx2 < x1; gx2 += cell) {
      const jx = gx2 + rand() * cell, jy = gy2 + rand() * cell;
      const ix = jx | 0, iy = jy | 0;
      if (ix < 0 || ix >= S || iy < 0 || iy >= S || !hit[iy * S + ix]) continue;
      out.push({ x: (jx - mx) / span, y: (jy - my) / span });
    }
  }
  return out;
}

function byAngle(set) {
  return set.map((p, i) => ({ i, a: Math.atan2(p.y, p.x), r: Math.hypot(p.x, p.y) }))
    .sort((u, v) => u.a - v.a || u.r - v.r).map((o) => o.i);
}

function buildMask(side, fallback) {
  if (side.source === "shape") return maskFromPath(SHAPES[side.shape] || fallback, MASK_SIZE);
  const text = String(side.text || "").trim();
  if (!text) return maskFromPath(fallback, MASK_SIZE);
  return maskFromText(text, side.fontFamily || "Archivo, Arial, sans-serif", side.fontWeight || "700", MASK_SIZE) || maskFromPath(fallback, MASK_SIZE);
}

export function createMorphingGlyphCloud(canvas, options = {}) {
  const {
    baseColor = "#FF5A1F",
    sideA = { source: "shape", shape: "burst" },
    sideB = { source: "text", text: "COOPER", fontFamily: "Archivo, Arial, sans-serif", fontWeight: "700" },
    glyphSize = 60,
    speed = 50,
    cloud = { breath: 15, spacing: 106, markSize: 100 },
    reducedMotion = false,
  } = options;
  const cloud_ = { breath: 15, spacing: 106, markSize: 100, ...cloud };
  const v = {
    glyphSize: Math.max(0.2, glyphSize / 50),
    speed: Math.max(0, speed) / 50,
    markSize: Math.max(0.2, cloud_.markSize / 100),
    spacing: Math.max(0.4, cloud_.spacing / 100),
    breath: Math.max(0, cloud_.breath / 100),
  };

  const ctx = canvas.getContext("2d");
  let pair = [], glyphs = [];
  const rand0 = rng(9152026);
  const gap = (FS * 0.6 * 1.06 / Math.max(0.05, v.markSize)) * v.spacing;
  const A = fitPoints(buildMask(sideA, SHAPES.circle), gap, rand0);
  const B = fitPoints(buildMask(sideB, SHAPES.diamond), gap, rand0);
  if (A.length && B.length) {
    const oa = byAngle(A), ob = byAngle(B);
    const M = Math.min(A.length, B.length);
    const rand = rng(9152026);
    for (let j = 0; j < M; j++) pair.push([A[oa[(j * A.length / M) | 0]], B[ob[(j * B.length / M) | 0]]]);
    for (let i = 0; i < pair.length; i++) glyphs.push({ c: CHARS.charAt((rand() * CHARS.length) | 0), ph: rand() * Math.PI * 2, sp: 0.55 + rand() * 0.9, wob: 0.4 + rand() * 0.8 });
  }

  let clock = 0, m = 0, target = 0;
  const ink = parseRGB(baseColor, [255, 90, 31]);
  const rgb = ink[0] + "," + ink[1] + "," + ink[2];

  function render(dt) {
    const cw = canvas.clientWidth || canvas.width || 800;
    const ch = canvas.clientHeight || canvas.height || 500;
    ctx.clearRect(0, 0, cw, ch);
    if (!pair.length) return;
    clock += dt * v.speed;
    if (!reducedMotion) m += (target - m) * Math.min(1, (dt * v.speed) / MORPH_TAU);
    else m = target;
    const e = m < 0.5 ? 4 * m * m * m : 1 - Math.pow(-2 * m + 2, 3) / 2;
    const u = Math.min(cw, ch);
    const span = u * v.markSize;
    const cx = cw / 2, cy = ch / 2;
    const fs = u * FS * v.glyphSize;
    const breath = reducedMotion ? 0 : u * 0.0035 * v.breath;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold " + fs.toFixed(2) + "px Archivo, Arial, sans-serif";
    ctx.fillStyle = "rgba(" + rgb + ",0.9)";
    for (let i = 0; i < pair.length; i++) {
      const g = glyphs[i], p = pair[i];
      const ux = p[0].x + (p[1].x - p[0].x) * e;
      const uy = p[0].y + (p[1].y - p[0].y) * e;
      let pxx = cx + ux * span, pyy = cy + uy * span;
      if (!reducedMotion) {
        pxx += Math.sin(clock * g.sp + g.ph) * breath * g.wob;
        pyy += Math.cos(clock * g.sp * 0.9 + g.ph) * breath * g.wob;
      }
      ctx.fillText(g.c, pxx, pyy);
    }
  }

  if (reducedMotion) render(0);

  return {
    render,
    setMorph(t) { target = t; },
    get progress() { return m; },
    get settled() { return Math.abs(target - m) < 0.01; },
    destroy() {},
  };
}
