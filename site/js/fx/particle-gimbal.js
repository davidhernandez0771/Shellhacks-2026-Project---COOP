// A small draggable sphere of dots: three rings plus a Fibonacci-spiral core, all spinning
// together, that you can grab and throw with momentum. A decorative echo of "something that
// looks at the world and turns" near the hero title.
//
// createParticleGimbal(host, options) mounts a <canvas> filling `host` and returns { destroy() }.

const MAX_DPR = 2;
const TAU = Math.PI * 2;
const PERIOD = 6.2;
const BASE_SPREAD = 0.29;
const PERSPECTIVE = 3.5;
const MIN_RADIUS = 0.6;
const MAX_DOTS = 1024;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dotsN = (base, n) => Math.max(1, Math.round(base * n));

function fib(i, n) {
  const y = 1 - (i / Math.max(1, n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = 2.399963 * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
}

function spin(p, yaw, pitch) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const rx = p[0] * ca - p[2] * sa;
  let rz = p[0] * sa + p[2] * ca;
  const co = Math.cos(pitch), so = Math.sin(pitch);
  const ry = p[1] * co - rz * so;
  rz = p[1] * so + rz * co;
  return [rx, ry, rz, p[3], p[4], p[5]];
}

function frame(t, P, out) {
  const per = dotsN(40, P.n);
  for (let r = 0; r < 3; r++) {
    const rad = [1, 0.78, 0.56][r];
    for (let i = 0; i < per; i++) {
      const a = (i / per) * TAU;
      out.push(spin(spin([Math.cos(a) * rad, Math.sin(a) * rad, 0, 0.8, 0.9, r === 1 ? P.acc : P.dot], 0, (r + 1) * TAU * t), 1.05 * r, 0.3));
    }
  }
  const core = dotsN(38, P.n);
  for (let i = 0; i < core; i++) {
    const q = spin(fib(i, core), -2 * TAU * t, 0.4);
    out.push([q[0] * 0.3, q[1] * 0.3, q[2] * 0.3, 0.85, 0.9, P.dot]);
  }
}

function project(pts, size, P, emit) {
  const c = size / 2;
  const R = size * BASE_SPREAD * P.sp;
  const pv = PERSPECTIVE;
  const yaw = P.yw + TAU * P.sn * P.t;
  const list = [];
  for (const p of pts) {
    const q = spin(p, yaw, P.pc);
    const z = q[2];
    const s = pv / (pv - z);
    const f = clamp01((z + 1.1) / 2.2);
    list.push([c + q[0] * R * s, c + q[1] * R * s, P.ds * (0.4 + 1.6 * f) * s * (q[3] === undefined ? 1 : q[3]), (0.07 + 0.93 * Math.pow(f, 1.55)) * (q[4] === undefined ? 1 : q[4]), q[5] || P.dot, z]);
  }
  list.sort((a, b) => a[5] - b[5]);
  for (const d of list) emit(d[0], d[1], d[2], d[3], d[4]);
}

const fitCache = new Map();
function autoFit(size, P, restYaw, restPitch) {
  const key = size + "/" + P.n + "/" + P.sp + "/" + restYaw + "/" + restPitch + "/" + P.sn;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const half = size / 2;
  let ext = 0;
  const probe = { ...P, ds: 1, dot: "#fff", acc: "#fff", t: 0, yw: restYaw, pc: restPitch };
  const emit = (x, y, r, a) => {
    if (a <= 0.05 || r <= 0.15) return;
    ext = Math.max(ext, Math.abs(x - half) + 0.5 * r, Math.abs(y - half) + 0.5 * r);
  };
  for (let k = 0; k < 20; k++) {
    probe.t = k / 20;
    const out = [];
    frame(probe.t, probe, out);
    project(out, size, probe, emit);
  }
  const fit = ext > 1 ? Math.max(0.55, Math.min(1.7, (0.415 * size) / ext)) : 1;
  fitCache.set(key, fit);
  return fit;
}

function dotScaleFor(size) {
  if (size <= 46) return 0.4;
  if (size <= 190) return 0.4 + ((size - 46) / 144) * 0.6;
  if (size <= 340) return 1 + ((size - 190) / 150) * 0.55;
  return 1.55;
}

function parseColor(input, fb) {
  if (!input) return fb;
  const str = String(input).trim();
  if (str.charAt(0) === "#") {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + (hex.length === 4 ? hex[3] + hex[3] : "");
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b, a];
    }
    return fb;
  }
  const m = str.match(/[\d.]+/g);
  if (m && m.length >= 3) return [Math.min(255, parseFloat(m[0])), Math.min(255, parseFloat(m[1])), Math.min(255, parseFloat(m[2])), m.length >= 4 ? Math.min(1, parseFloat(m[3])) : 1];
  return fb;
}
const css = (c) => "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + c[3] + ")";

export function createParticleGimbal(host, options = {}) {
  const {
    dotColor = "#EEEDEA",
    accentColor = "#FF5A1F",
    density = 100,
    dotSize = 100,
    speed = 50,
    spinTurns = 1,
    ball = {},
    pointer = {},
    reducedMotion = false,
  } = options;
  const ball_ = { spread: 100, turn: 0, tilt: 0, ...ball };
  const pointer_ = { drag: 100, damping: 20, ...pointer };

  const v = {
    dot: dotColor, acc: accentColor,
    speed: clampN(speed, -100, 100) / 50,
    density: clampN(density, 20, 300) / 100,
    dotSize: clampN(dotSize, 20, 300) / 100,
    spinTurns: Math.round(clampN(spinTurns, -3, 3)),
    drag: reducedMotion ? 0 : clampN(pointer_.drag, 0, 300) / 100,
    damping: clampN(pointer_.damping, 1, 100),
    spread: clampN(ball_.spread, 40, 180) / 100,
    turn: (clampN(ball_.turn, -180, 180) * Math.PI) / 180,
    tilt: (clampN(ball_.tilt, -90, 90) * Math.PI) / 180,
  };

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() { canvas.remove(); } };

  const drag = { active: false, lx: 0, ly: 0, lt: 0, yaw: 0, pitch: 0, vx: 0, vy: 0 };
  let raf = 0, last = 0, phase = 0, onScreen = true, alive = true;

  function renderOnce(dt) {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = host.clientWidth || 120, ch = host.clientHeight || 120;
    const bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    phase = (phase + (dt * v.speed) / PERIOD) % 1;
    if (phase < 0) phase += 1;

    const size = Math.max(4, Math.min(cw, ch));
    const bx = (cw - size) / 2, by = (ch - size) / 2;
    const dotCol = css(parseColor(v.dot, [244, 241, 234, 1]));
    const accCol = css(parseColor(v.acc, [232, 133, 60, 1]));

    if (!drag.active) {
      const decay = Math.exp(-v.damping * 0.12 * dt);
      drag.yaw += drag.vx * dt;
      drag.pitch += drag.vy * dt;
      drag.vx *= decay; drag.vy *= decay;
    }
    const restPitch = v.tilt;
    drag.pitch = clampN(drag.pitch, -Math.PI / 2 - restPitch, Math.PI / 2 - restPitch);

    const P = { n: v.density, sp: v.spread, ds: dotScaleFor(size) * v.dotSize, yw: v.turn + drag.yaw, sn: v.spinTurns, pc: restPitch + drag.pitch, t: phase, dot: dotCol, acc: accCol };
    const fit = autoFit(size, P, v.turn, restPitch);
    const half = size / 2;
    const out = [];
    frame(phase, P, out);
    let drawn = 0;
    project(out, size, P, (x, y, r, a, col) => {
      if (drawn >= MAX_DOTS) return;
      const rr = r * (0.55 + 0.45 * fit);
      if (rr <= 0.05 || a <= 0.004) return;
      const cx = bx + half + (x - half) * fit, cy = by + half + (y - half) * fit;
      let dr = rr, da = Math.min(1, a);
      if (dr < MIN_RADIUS) { da *= (dr / MIN_RADIUS) * (dr / MIN_RADIUS); dr = MIN_RADIUS; }
      ctx.globalAlpha = da;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(cx, cy, dr, 0, TAU);
      ctx.fill();
      drawn++;
    });
    ctx.globalAlpha = 1;
  }

  const frameFn = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    renderOnce(dt);
    raf = requestAnimationFrame(frameFn);
  };

  function gate() {
    const shouldRun = alive && onScreen && !document.hidden;
    if (shouldRun && !raf) { last = performance.now(); raf = requestAnimationFrame(frameFn); }
    else if (!shouldRun && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    gate();
  }) : null;
  if (io) io.observe(host);
  document.addEventListener("visibilitychange", gate);

  const onDown = (e) => {
    if (v.drag <= 0) return;
    drag.active = true;
    drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = performance.now();
    drag.vx = 0; drag.vy = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  };
  const onMove = (e) => {
    if (!drag.active) return;
    const k = (v.drag * TAU) / Math.max(1, canvas.clientWidth || 120);
    const dx = (e.clientX - drag.lx) * k, dy = (e.clientY - drag.ly) * k;
    const now2 = performance.now();
    const span = Math.max(1, now2 - drag.lt);
    drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now2;
    drag.yaw -= dx; drag.pitch += dy;
    drag.vx = (-dx / span) * 1000; drag.vy = (dy / span) * 1000;
  };
  const onUp = () => { drag.active = false; };
  if (!reducedMotion) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  if (reducedMotion) renderOnce(0);
  else gate();

  return {
    destroy() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", gate);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      canvas.remove();
    },
  };
}
