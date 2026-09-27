/* Predictive Arc
 *
 * Full-bleed WebGL background: a field of dots whose brightness follows a
 * glowing arch/arc band running across the canvas, with a slow internal
 * wave shimmer and an optional pointer-reactive glow that bends the arc
 * toward the cursor. Meant to sit behind foreground copy (the prediction
 * chapter's text echoes the arc COOPER's tracking predicts).
 *
 * Settings for this instance (David's call):
 *   bg #060606, base #5A2410, accent #FF5A1F, highlight #FFB38F,
 *   density 70, dot size 120, speed 70,
 *   arch peak 100 / height 0 / thickness 206 / falloff 600,
 *   pointer radius 236 / strength 34 (enabled).
 *
 * Porting notes:
 *   - The source wrapper forced minWidth 1200 / minHeight 800, which breaks
 *     phones; dropped entirely here. The canvas just fills `host`'s box via
 *     ResizeObserver, with no forced minimum size.
 *   - The source's render loop runs requestAnimationFrame forever. Here the
 *     loop is paused via IntersectionObserver (host off-screen) and
 *     document.hidden, and skipped entirely (single static frame) when
 *     prefers-reduced-motion is on.
 *   - The canvas is pointer-events:none so it never blocks clicks/scroll on
 *     foreground content; pointer position for the glow is read from
 *     `pointermove` on the window instead of the canvas itself.
 */

const MAX_DPR = 2;

const VERT_SRC = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;
uniform float uTime, uDpr, uCell, uDot;
uniform float uPeak, uHeight, uThick, uFall;
uniform vec3  uBg, uBase, uAccent, uHigh;
uniform vec2  uMouse;
uniform float uMouseRadius, uMouseStrength;

void main(){
  float cs = max(uCell, 2.0);
  vec2 ci = floor(gl_FragCoord.xy / cs);
  vec2 cc = (ci + 0.5) * cs;

  float x = cc.x / uDpr;
  float y = (uRes.y - cc.y) / uDpr;
  float w = uRes.x / uDpr;
  float h = uRes.y / uDpr;

  float normX = (x - w * 0.5) / (w * 0.75);
  float curveY = h * uPeak + normX * normX * (h * uHeight);

  float mdx = x - uMouse.x;
  float influence = uMouseStrength * exp(-(mdx * mdx) / (2.0 * uMouseRadius * uMouseRadius + 1.0));
  curveY = mix(curveY, uMouse.y, influence);

  float dist = abs(y - curveY);
  float th = (140.0 + (1.0 - abs(normX)) * 80.0) * uThick;

  vec3 col = uBg;
  if (dist < th) {
    float i = 1.0 - dist / th;
    float waveX = sin(x * 0.015 + uTime);
    float waveY = cos(y * 0.02 + uTime);
    i = i * 0.7 + waveX * waveY * 0.3 * i;
    i *= max(0.0, 1.0 - pow(abs(normX), uFall));

    if (i > 0.02) {
      float side = uDot * i * uDpr;
      vec2 d = abs(gl_FragCoord.xy - cc);
      float cov = 1.0 - smoothstep(side * 0.5 - 1.0, side * 0.5 + 1.0, max(d.x, d.y));

      vec3 ink = mix(uBase, uAccent, clamp(pow(i, 1.1), 0.0, 1.0));
      ink = mix(ink, uHigh, smoothstep(0.72, 1.0, i));
      col = mix(uBg, ink, cov * clamp(i * 1.6, 0.0, 1.0));
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("predictive-arc shader:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function parseColor(input, fb) {
  if (!input) return fb;
  const str = String(input).trim();
  if (str.charAt(0) === "#") {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r / 255, g / 255, b / 255];
    }
    return fb;
  }
  const m = str.match(/[\d.]+/g);
  if (m && m.length >= 3) {
    return [
      Math.min(255, parseFloat(m[0])) / 255,
      Math.min(255, parseFloat(m[1])) / 255,
      Math.min(255, parseFloat(m[2])) / 255,
    ];
  }
  return fb;
}

function num(v, fb) {
  return typeof v === "number" && isFinite(v) ? v : fb;
}

function clampN(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

const ARCH_DEFAULTS = { peak: 100, archHeight: 0, thickness: 206, falloff: 600 };
const POINTER_DEFAULTS = { enabled: true, radius: 236, strength: 34 };

/**
 * Mount the predictive-arc WebGL background inside an existing container.
 *
 * `host` must already be positioned by the caller's stylesheet (e.g.
 * position: absolute; inset: 0 as a full-bleed background layer); this
 * module only inserts a <canvas> sized to fill it.
 *
 * @param {HTMLElement} host - existing container element already in the DOM.
 * @param {{
 *   reducedMotion?: boolean,
 *   background?: string,
 *   baseColor?: string,
 *   accentColor?: string,
 *   highlight?: string,
 *   density?: number,
 *   dotSize?: number,
 *   speed?: number,
 *   arch?: { peak?: number, archHeight?: number, thickness?: number, falloff?: number },
 *   pointer?: { enabled?: boolean, radius?: number, strength?: number },
 * }} [options]
 * @returns {{ destroy: () => void }}
 */
export function createPredictiveArc(host, options = {}) {
  if (!host || typeof host.appendChild !== "function") {
    throw new Error("createPredictiveArc: host must be an existing element");
  }

  const {
    background = "#060606",
    baseColor = "#5A2410",
    accentColor = "#FF5A1F",
    highlight = "#FFB38F",
    density = 70,
    dotSize = 120,
    speed = 70,
    arch,
    pointer,
  } = options;

  const arch_ = { ...ARCH_DEFAULTS, ...(arch || {}) };
  const pointer_ = { ...POINTER_DEFAULTS, ...(pointer || {}) };

  let prefersReduced = false;
  try {
    prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    prefersReduced = false;
  }
  const reduced = options.reducedMotion === true || prefersReduced;

  const settings = {
    bg: background,
    base: baseColor,
    accent: accentColor,
    high: highlight,
    density: Math.round(clampN(num(density, 160), 40, 320)),
    dotSize: clampN(num(dotSize, 100), 20, 400) / 100,
    speed: clampN(num(speed, 50), 0, 100) / 50,
    peak: clampN(num(arch_.peak, 35), 0, 100) / 100,
    archHeight: clampN(num(arch_.archHeight, 70), 0, 300) / 100,
    thickness: clampN(num(arch_.thickness, 100), 20, 400) / 100,
    falloff: clampN(num(arch_.falloff, 250), 50, 600) / 100,
    pointerEnabled: pointer_.enabled !== false,
    pointerRadius: clampN(num(pointer_.radius, 220), 40, 600),
    pointerStrength: clampN(num(pointer_.strength, 60), 0, 100) / 100,
  };

  host.classList.add("predictive-arc-host");

  const canvas = document.createElement("canvas");
  canvas.className = "predictive-arc-canvas";
  host.appendChild(canvas);

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false });
  if (!gl) {
    console.error("predictive-arc: WebGL unavailable");
    return {
      destroy() {
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  let prog = null;
  if (vs && fs) {
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("predictive-arc link:", gl.getProgramInfoLog(prog));
      prog = null;
    }
  }

  function releaseGL() {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    } catch (err) {
      /* noop */
    }
  }

  if (!prog) {
    return {
      destroy() {
        releaseGL();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const locs = {};
  const u = (name) => {
    if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
    return locs[name];
  };

  // pointer state, read from window pointermove so the canvas itself can
  // stay pointer-events:none and never block foreground content.
  const ps = { x: 0, y: 0, targetX: 0, targetY: 0, active: 0, targetActive: 0 };

  function onPointerMove(e) {
    if (!settings.pointerEnabled) return;
    const rect = canvas.getBoundingClientRect();
    ps.targetX = e.clientX - rect.left;
    ps.targetY = rect.height - (e.clientY - rect.top);
    ps.targetActive = 1;
  }
  function onPointerLeaveWindow() {
    ps.targetActive = 0;
  }

  if (settings.pointerEnabled) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerMove, { passive: true });
    window.addEventListener("pointercancel", onPointerLeaveWindow, { passive: true });
    document.addEventListener("mouseleave", onPointerLeaveWindow);
  }

  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let running = false;

  function resizeToHost() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = host.clientWidth || 1;
    const ch = host.clientHeight || 1;
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    return { bw, bh, dpr };
  }

  function drawFrame(dt) {
    clock = (clock + dt * 0.9 * settings.speed) % 6283;

    const { bw, bh, dpr } = resizeToHost();
    gl.viewport(0, 0, bw, bh);

    const pitchCss = Math.min(bw, bh) / dpr / settings.density;

    const posLerp = Math.min(1, dt * 12);
    const activeLerp = Math.min(1, dt * 6);
    ps.x += (ps.targetX - ps.x) * posLerp;
    ps.y += (ps.targetY - ps.y) * posLerp;
    ps.active += (ps.targetActive - ps.active) * activeLerp;

    gl.uniform2f(u("uRes"), bw, bh);
    gl.uniform1f(u("uTime"), clock);
    gl.uniform1f(u("uDpr"), dpr);
    gl.uniform1f(u("uCell"), Math.max(2, pitchCss * dpr));
    gl.uniform1f(u("uDot"), pitchCss * 1.2 * settings.dotSize);
    gl.uniform1f(u("uPeak"), settings.peak);
    gl.uniform1f(u("uHeight"), settings.archHeight);
    gl.uniform1f(u("uThick"), settings.thickness);
    gl.uniform1f(u("uFall"), settings.falloff);
    gl.uniform2f(u("uMouse"), ps.x, ps.y);
    gl.uniform1f(u("uMouseRadius"), settings.pointerRadius);
    gl.uniform1f(
      u("uMouseStrength"),
      settings.pointerEnabled ? settings.pointerStrength * ps.active : 0
    );
    const cg = parseColor(settings.bg, [0.024, 0.024, 0.024]);
    const cb = parseColor(settings.base, [0.353, 0.141, 0.063]);
    const ca = parseColor(settings.accent, [1.0, 0.353, 0.122]);
    const chh = parseColor(settings.high, [1.0, 0.702, 0.561]);
    gl.uniform3f(u("uBg"), cg[0], cg[1], cg[2]);
    gl.uniform3f(u("uBase"), cb[0], cb[1], cb[2]);
    gl.uniform3f(u("uAccent"), ca[0], ca[1], ca[2]);
    gl.uniform3f(u("uHigh"), chh[0], chh[1], chh[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function render(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    drawFrame(dt);
    raf = requestAnimationFrame(render);
  }

  function start() {
    if (running || reduced) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(render);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Pause the loop when the host scrolls off screen, per the porting note
  // (the original ran requestAnimationFrame forever).
  let io = null;
  let visible = true;
  try {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
        }
        if (visible && !document.hidden) start();
        else stop();
      },
      { threshold: 0 }
    );
    io.observe(host);
  } catch (err) {
    io = null;
  }

  function onVisibilityChange() {
    if (document.hidden) stop();
    else if (visible) start();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Keep the canvas backing store in step with host resizes even while
  // paused (so the next frame, or the static reduced-motion frame, is
  // correctly sized).
  let ro = null;
  try {
    ro = new ResizeObserver(() => {
      resizeToHost();
      if (reduced) drawFrame(0);
    });
    ro.observe(host);
  } catch (err) {
    ro = null;
  }

  if (reduced) {
    resizeToHost();
    drawFrame(0);
  } else if (!io) {
    // No IntersectionObserver support: fall back to always running while
    // the tab is visible.
    start();
  }

  function destroy() {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (io) {
      io.disconnect();
      io = null;
    }
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (settings.pointerEnabled) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      window.removeEventListener("pointercancel", onPointerLeaveWindow);
      document.removeEventListener("mouseleave", onPointerLeaveWindow);
    }
    releaseGL();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    host.classList.remove("predictive-arc-host");
  }

  return { destroy };
}
