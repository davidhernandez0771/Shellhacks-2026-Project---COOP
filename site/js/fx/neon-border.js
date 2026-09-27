/* Neon Border
 *
 * A glowing frame that sweeps a bright "comet" segment continuously around
 * an element's perimeter: a conic-gradient rebuilt every frame, masked down
 * to a thin ring (padding-box minus content-box), plus a blurred halo
 * trailing behind it. Two copies run half a lap apart so there are always
 * two comets chasing each other around the box. Under a dim always-on ring
 * underneath, so the box reads as "framed" even between sweeps.
 *
 * Settings for this instance (David's call):
 *   color #FF5A1F, rounded 4 (of min(w,h)/2), thickness 2px,
 *   border length 35 (% of perimeter lit at once), glow 50, speed 8,
 *   movement: continuous.
 *
 * Porting notes:
 *   - No framer-motion in the source; it was already plain React + rAF, so
 *     this is a direct port of the math (perimeter parameterization, corner
 *     easing, conic-gradient stop building) into plain DOM/CSS.
 *   - Only "continuous" movement is ported (the "step" mode from the source
 *     is dropped) since that's the only mode this instance uses.
 *   - Perf: rebuilding a conic-gradient every frame is the expensive part,
 *     so the rAF loop is paused via IntersectionObserver (el off-screen),
 *     document.hidden, AND prefers-reduced-motion (both the caller's
 *     `reducedMotion` option and the live media query are honored — either
 *     one freezes it). Per frame, only the `--arc` custom property
 *     (background) is touched; every geometry value (inset/padding/
 *     border-radius) is only recomputed on resize, so the animation never
 *     triggers layout, only paint.
 *   - Mounts as an absolutely-positioned overlay appended as `el`'s last
 *     child (does not touch `el`'s existing children). If `el` computes to
 *     `position: static`, this sets it to `relative` so the overlay has a
 *     containing block; that's restored on destroy().
 */

// ---- perimeter / conic-gradient math (ported) -----------------------------

function withAlpha(input, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  if (typeof input !== 'string') return `rgba(0,0,0,${a})`;
  const s = input.trim();

  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map((c) => c + c).join('');
    }
    const n = parseInt(h.slice(0, 6), 16);
    if (!Number.isFinite(n)) return `rgba(0,0,0,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  const rgb = s.match(/^rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((v) => parseFloat(v));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
    }
  }
  return `rgba(0,0,0,${a})`;
}

// u in [0,1) -> a point walking clockwise from top-left around the w x h box.
function perimeterPoint(u, w, h) {
  const d = (((u % 1) + 1) % 1) * 2 * (w + h);
  if (d < w) return [d, 0];
  if (d < w + h) return [w, d - w];
  if (d < w * 2 + h) return [w - (d - w - h), h];
  return [0, h - (d - w * 2 - h)];
}

// Fractional-perimeter position of the k-th corner (accounts for aspect
// ratio: corners are not evenly spaced at 0/0.25/0.5/0.75 on a non-square box).
function cornerLap(k, w, h) {
  const p = 2 * (w + h);
  const at = [0, w / p, (w + h) / p, (w * 2 + h) / p];
  return Math.floor(k / 4) + at[((k % 4) + 4) % 4];
}

function perimeterAngle(u, w, h) {
  const [x, y] = perimeterPoint(u, w, h);
  return (Math.atan2(x - w / 2, h / 2 - y) * 180) / Math.PI;
}

const ARC_SAMPLES = 24;
const MIN_ARC = 0.015;

// Builds the conic-gradient for one comet: `lap` is its center position
// (0..1 around the perimeter), `lengthPct` how much of the perimeter it
// covers, smoothstep-faded in/out at both ends.
function buildArc(lap, lengthPct, w, h, color) {
  const fw = w > 0 ? w : 100;
  const fh = h > 0 ? h : 100;

  const len = Math.max(0, Math.min(100, lengthPct));
  const span = Math.max(MIN_ARC, (len / 100) * 0.5);
  const solidT = len / 100;

  const stops = [];
  let base = 0;
  let prev = 0;
  let acc = 0;

  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const f = i / ARC_SAMPLES;
    const angle = perimeterAngle(lap + (f - 0.5) * span, fw, fh);
    if (i === 0) {
      base = angle;
    } else {
      let d = angle - prev;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      acc += d;
    }
    prev = angle;

    const t = Math.abs(f - 0.5) * 2;
    const k = solidT >= 1 ? 1 : t <= solidT ? 1 : 1 - (t - solidT) / (1 - solidT);
    stops.push(`${withAlpha(color, k * k * (3 - 2 * k))} ${acc.toFixed(2)}deg`);
  }

  const end = acc.toFixed(2);
  stops.push(`${withAlpha(color, 0)} ${end}deg`);
  stops.push(`${withAlpha(color, 0)} 360deg`);

  return `conic-gradient(from ${base.toFixed(2)}deg at 50% 50%, ${stops.join(', ')})`;
}

// ---- easing (ported: continuous/"glide" mode only) -------------------------

const SLOWEST_CYCLE = 30;
const FASTEST_CYCLE = 4;
const GLIDE_EASE = [0.65, 0, 0.35, 1];

function makeEaseFn(pts) {
  const [x1, y1, x2, y2] = pts;
  const bez = (a, b, t) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (t) => {
    const x = Math.max(0, Math.min(1, t));
    let s = x;
    for (let i = 0; i < 8; i++) {
      const cx = bez(x1, x2, s) - x;
      const u = 1 - s;
      const dx = 3 * u * u * x1 + 6 * u * s * (x2 - x1) + 3 * s * s * (1 - x2);
      if (Math.abs(dx) < 1e-6) break;
      s -= cx / dx;
      s = Math.max(0, Math.min(1, s));
    }
    return bez(y1, y2, s);
  };
}

const glideEase = makeEaseFn(GLIDE_EASE);

// ---- fixed "look" constants (David's settings, not exposed as options) ----

const GLOW_LAYERS = [
  { blur: 8, opacity: 0.5, reach: 0.3 },
  { blur: 15, opacity: 0.3, reach: 0.6 },
  { blur: 57, opacity: 0.18, reach: 1 },
];
const MAX_GLOW_BLUR = Math.max(...GLOW_LAYERS.map((l) => l.blur));
const MAX_GLOW_REACH = 36;
const EDGE_COPIES = 2;
const BORDER_LENGTH = 35; // "border length 35": % of the perimeter lit at once
const GLOW_AMOUNT = 0.5; // "glow 50"
const BASE_RING_ALPHA = 0.16; // dim always-on ring under the sweeping comets

const NEON_DEFAULTS = {
  color: '#FF5A1F',
  radius: 4, // 0-100 scale: % of min(width,height)/2 (matches the source's `rounded`)
  thickness: 2, // px
  speed: 8, // 0-20 scale
};

/**
 * Mounts an animated neon sweep frame around `el` (appended as an overlay
 * child of `el`, not replacing or moving anything already inside it).
 *
 * @param {HTMLElement} el - existing element to frame.
 * @param {object} [options]
 * @param {boolean} [options.reducedMotion] - force the static (non-sweeping) look.
 * @param {string} [options.color] - CSS color, default '#FF5A1F'.
 * @param {number} [options.thickness] - ring thickness in px, default 2.
 * @param {number} [options.radius] - corner rounding, 0-100 (% of min(w,h)/2), default 4.
 * @param {number} [options.speed] - 0-20, default 8.
 * @returns {{ destroy(): void }}
 */
export function createNeonBorder(el, options = {}) {
  if (!el || typeof el.appendChild !== 'function') {
    throw new Error('createNeonBorder(el, options) requires an existing element');
  }

  const color = typeof options.color === 'string' ? options.color : NEON_DEFAULTS.color;
  const thickness = Math.max(1, Math.min(10, options.thickness ?? NEON_DEFAULTS.thickness));
  const roundedPct = Math.max(0, Math.min(100, options.radius ?? NEON_DEFAULTS.radius));
  const speed = Math.max(0, Math.min(20, options.speed ?? NEON_DEFAULTS.speed));
  const forceReducedMotion = options.reducedMotion === true;

  // The overlay is absolutely positioned, so `el` needs to be a positioning
  // context. Only touch it if it isn't one already.
  const computedPosition = getComputedStyle(el).position;
  const restorePosition = computedPosition === 'static';
  if (restorePosition) el.style.position = 'relative';

  const root = document.createElement('div');
  root.className = 'neon-border';
  root.setAttribute('aria-hidden', 'true');
  root.style.setProperty('--neon-color', color);
  root.style.setProperty('--neon-thickness', `${thickness}px`);
  root.style.setProperty('--neon-base-color', withAlpha(color, BASE_RING_ALPHA));

  const base = document.createElement('div');
  base.className = 'neon-border-base';
  root.appendChild(base);

  function buildGroup() {
    const group = document.createElement('div');
    group.className = 'neon-border-group';

    const glowBands = GLOW_LAYERS.map((layer) => {
      const wrap = document.createElement('div');
      wrap.className = 'neon-border-glow';
      wrap.style.setProperty('--neon-blur', `${layer.blur}px`);
      wrap.style.setProperty('--neon-opacity', String(layer.opacity));
      const band = document.createElement('div');
      band.className = 'neon-border-band';
      wrap.appendChild(band);
      group.appendChild(wrap);
      return { layer, wrap, band };
    });

    const edgeBands = [];
    for (let i = 0; i < EDGE_COPIES; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'neon-border-edge';
      const band = document.createElement('div');
      band.className = 'neon-border-band';
      wrap.appendChild(band);
      edgeBands.push(band);
      group.appendChild(wrap);
    }

    return { group, glowBands, edgeBands };
  }

  const groupA = buildGroup();
  const groupB = buildGroup();
  root.appendChild(groupA.group);
  root.appendChild(groupB.group);
  el.appendChild(root);

  let size = { w: el.clientWidth, h: el.clientHeight };
  let radiusPx = 0;

  function setBand(band, r, offset) {
    band.style.inset = `${offset - r}px`;
    band.style.padding = `${r}px`;
    band.style.borderRadius = radiusPx > 0 ? `${radiusPx + r}px` : '0';
  }

  function layout() {
    const w = size.w;
    const h = size.h;
    radiusPx = (roundedPct / 100) * (Math.min(w, h) / 2);
    root.style.borderRadius = radiusPx > 0 ? `${radiusPx}px` : '0';

    const glowOuter = 10 + MAX_GLOW_REACH + MAX_GLOW_BLUR * 2;

    [...groupA.edgeBands, ...groupB.edgeBands].forEach((band) => setBand(band, thickness, 0));

    [...groupA.glowBands, ...groupB.glowBands].forEach(({ layer, wrap, band }) => {
      wrap.style.inset = `${-glowOuter}px`;
      wrap.style.padding = `${glowOuter}px`;
      wrap.style.borderRadius = radiusPx > 0 ? `${radiusPx + glowOuter}px` : '0';
      const r = thickness + GLOW_AMOUNT * MAX_GLOW_REACH * layer.reach;
      setBand(band, r, glowOuter);
    });
  }

  let lastLapA = 0;
  let lastLapB = 0.5;

  function paint(lapA, lapB) {
    lastLapA = lapA;
    lastLapB = lapB;
    groupA.group.style.setProperty('--arc', buildArc(lapA, BORDER_LENGTH, size.w, size.h, color));
    groupB.group.style.setProperty('--arc', buildArc(lapB, BORDER_LENGTH, size.w, size.h, color));
  }

  function paintStatic() {
    // No travelling sweep: light the full ring evenly (still glowing, just frozen).
    const arc = buildArc(0, 100, size.w, size.h, color);
    groupA.group.style.setProperty('--arc', arc);
    groupB.group.style.setProperty('--arc', arc);
  }

  const reduceMotionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function isStatic() {
    return forceReducedMotion || speed <= 0 || !!(reduceMotionQuery && reduceMotionQuery.matches);
  }

  layout();
  if (isStatic()) paintStatic();
  else paint(0, 0.5);

  // Let the initial inline styles land, then fade the frame in (opacity
  // only, cheap) instead of popping in fully built.
  requestAnimationFrame(() => root.classList.add('is-ready'));

  // ---- animation loop -------------------------------------------------

  let raf = 0;
  let running = false;
  let last = 0;
  let corner = 0;
  let stepT = 0;

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    const cycle = (SLOWEST_CYCLE + ((FASTEST_CYCLE - SLOWEST_CYCLE) * (speed - 1)) / 19) / 4;
    stepT += dt / cycle;
    while (stepT >= 1) {
      stepT -= 1;
      corner += 1;
    }
    const eased = glideEase(stepT);

    const fw = size.w > 0 ? size.w : 100;
    const fh = size.h > 0 ? size.h : 100;
    const from = cornerLap(corner, fw, fh);
    const to = cornerLap(corner + 1, fw, fh);
    const lap = from + (to - from) * eased;

    paint(lap, lap + 0.5);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || isStatic()) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }

  // ---- visibility gating (off-screen / hidden tab / reduced motion) ---

  let intersecting = true;

  function updateRunState() {
    if (isStatic()) {
      stop();
      paintStatic();
    } else if (intersecting && !document.hidden) {
      start();
    } else {
      stop();
    }
  }

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        intersecting = entries[entries.length - 1].isIntersecting;
        updateRunState();
      }, { threshold: 0 })
    : null;
  if (io) io.observe(el);

  function onVisibilityChange() {
    updateRunState();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function onReducedMotionChange() {
    updateRunState();
  }
  if (reduceMotionQuery) {
    if (reduceMotionQuery.addEventListener) {
      reduceMotionQuery.addEventListener('change', onReducedMotionChange);
    } else if (reduceMotionQuery.addListener) {
      // Safari < 14
      reduceMotionQuery.addListener(onReducedMotionChange);
    }
  }

  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === size.w && h === size.h) return;
        size = { w, h };
        layout();
        if (isStatic()) paintStatic();
        else paint(lastLapA, lastLapB);
      })
    : null;
  if (ro) ro.observe(el);

  updateRunState();

  return {
    destroy() {
      stop();
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reduceMotionQuery) {
        if (reduceMotionQuery.removeEventListener) {
          reduceMotionQuery.removeEventListener('change', onReducedMotionChange);
        } else if (reduceMotionQuery.removeListener) {
          reduceMotionQuery.removeListener(onReducedMotionChange);
        }
      }
      root.remove();
      if (restorePosition) el.style.position = '';
    },
  };
}
