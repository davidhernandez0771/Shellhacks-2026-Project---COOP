// The hero title: "COOPER" rendered as a single WebGL quad, its glyphs revealed through a
// soft-to-sharp mask that follows the pointer like a lens finding focus. With no pointer it
// auto-sweeps left to right.
//
// createVectorWordmark(host, options) mounts a <canvas> filling `host` and returns { destroy() }.

const MAX_DPR = 2;
const REF_WIDTH = 1200;
const MAX_TEX = 4096;

const SWEEP_RATE = 0.5;
const SWEEP_BAND = 0.28;
const DAMP_REF = 20;
const SPEED_REF = 50;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const fract = (x) => x - Math.floor(x);

function parseColor(input, fallback) {
  if (!input) return fallback;
  let s = String(input).trim();
  if (s[0] === "#") {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) { let x = ""; for (const c of h) x += c + c; h = x; }
    if (h.length === 6) h += "ff";
    if (h.length !== 8 || /[^0-9a-f]/i.test(h)) return fallback;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, parseInt(h.slice(6, 8), 16) / 255];
  }
  const m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/i);
  if (!m) return fallback;
  const parts = m[2].split(/[\s,/]+/).filter((p) => p.length > 0);
  if (parts.length < 3) return fallback;
  const num = (t, scale) => { const v = parseFloat(t); if (!Number.isFinite(v)) return 0; return t.indexOf("%") >= 0 ? (v / 100) * scale : v; };
  const alpha = parts.length > 3 ? clamp(num(parts[3], 1), 0, 1) : 1;
  if (m[1].toLowerCase().slice(0, 3) === "rgb") {
    return [clamp(num(parts[0], 255) / 255, 0, 1), clamp(num(parts[1], 255) / 255, 0, 1), clamp(num(parts[2], 255) / 255, 0, 1), alpha];
  }
  const hh = fract(parseFloat(parts[0]) / 360);
  const sat = clamp(num(parts[1], 1), 0, 1);
  const li = clamp(num(parts[2], 1), 0, 1);
  const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat;
  const p = 2 * li - q;
  const chan = (t) => { let u = fract(t); if (u < 1 / 6) return p + (q - p) * 6 * u; if (u < 1 / 2) return q; if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6; return p; };
  return [chan(hh + 1 / 3), chan(hh), chan(hh - 1 / 3), alpha];
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D uMap;
uniform vec2 uRes;
uniform vec2 uAtlas;
uniform vec2 uPtr;
uniform float uReach;
uniform vec3 uText;
uniform vec3 uShade;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec2 blurRG(vec2 uv, float e) {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float th = radians(fi / 6.0 * 360.0);
    vec2 dir = vec2(cos(th), sin(th));
    vec2 off = dir * (hash(vec2(fi, uv.x + uv.y)) + e);
    sum += texture2D(uMap, uv + off * e);
  }
  return (sum / 6.0).rg;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 E = (vUv * uRes - (uRes - uAtlas) * 0.5) / uAtlas;
  float inside = step(0.0, E.x) * step(E.x, 1.0) * step(0.0, E.y) * step(E.y, 1.0);
  vec2 safeUv = clamp(E, 0.0, 1.0);

  float b = clamp(1.0 - E.y * 3.5, 0.0, 1.0) * 0.008;
  vec2 soft = blurRG(safeUv, b);
  vec2 sharp = blurRG(safeUv, b * 0.1);

  float d = length((vUv - uPtr) / vec2(1.0, aspect));
  float k = 1.0 - pow(smoothstep(0.0, max(uReach, 1e-4), d), 3.0);

  float mask = mix(soft.r, sharp.g, k) * inside;
  vec3 fill = mix(uShade, uText, smoothstep(0.0, 1.0, E.y));

  gl_FragColor = vec4(fill * mask, mask) * pow(clamp(E.y, 0.0, 1.0), 0.7);
}`;

function compile(gl, vs, fs) {
  const make = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  return p;
}

function fontString(f, px) { return `${f.style} ${f.weight} ${px}px ${f.family}`; }

function buildAtlas(text, f, drawFontPx, dpr) {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  const setFont = (ctx, px) => {
    ctx.font = fontString(f, px);
    try { if ("letterSpacing" in ctx) ctx.letterSpacing = f.letterSpacing; } catch (e) {}
  };
  const measure = (px) => {
    setFont(probe, px);
    const m = probe.measureText(text);
    const asc = m.actualBoundingBoxAscent || px * 0.8;
    const desc = m.actualBoundingBoxDescent || px * 0.22;
    return { w: Math.max(1, m.width), asc, desc };
  };
  let fpx = Math.max(8, drawFontPx * dpr);
  let m = measure(fpx);
  let pad = fpx * 0.12;
  const over = Math.max((m.w + pad * 2) / MAX_TEX, (m.asc + m.desc + pad * 2) / MAX_TEX);
  if (over > 1) { fpx = Math.max(8, fpx / over); m = measure(fpx); pad = fpx * 0.12; }
  const w = Math.max(1, Math.ceil(m.w + pad * 2));
  const h = Math.max(1, Math.ceil(m.asc + m.desc + pad * 2));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, w, h);
  setFont(ctx, fpx);
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = "#ff0000";
  ctx.fillText(text, pad, pad + m.asc);
  const block = m.asc + m.desc;
  ctx.strokeStyle = "#00ff00"; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, block * (4 / 440));
  ctx.setLineDash([0, Math.max(2, block * (12 / 440))]);
  ctx.strokeText(text, pad, pad + m.asc);
  const cssPerPx = drawFontPx / fpx;
  return { canvas, cssW: w * cssPerPx, cssH: h * cssPerPx };
}

export function createVectorWordmark(host, options = {}) {
  const {
    text = "COOPER",
    fontFamily = "var(--font-display), Arial, sans-serif",
    fontWeight = 800,
    fontSize = 200,
    letterSpacing = "-0.04em",
    background = "transparent",
    textColor = "#EEEDEA",
    shade = "#9C9B98",
    reach = 290,
    speed = 50,
    damping = 60,
    reducedMotion = false,
  } = options;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  host.style.background = background === "transparent" ? "" : background;
  host.appendChild(canvas);

  const attrs = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "low-power" };
  const gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs);
  if (!gl) return { destroy() {} };

  const prog = compile(gl, VERT, FRAG);
  const U = {
    map: gl.getUniformLocation(prog, "uMap"), res: gl.getUniformLocation(prog, "uRes"),
    atlas: gl.getUniformLocation(prog, "uAtlas"), ptr: gl.getUniformLocation(prog, "uPtr"),
    reach: gl.getUniformLocation(prog, "uReach"), text: gl.getUniformLocation(prog, "uText"),
    shade: gl.getUniformLocation(prog, "uShade"),
  };
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let alive = true;
  let boxW = Math.max(1, host.offsetWidth), boxH = Math.max(1, host.offsetHeight);
  let dpr = 1, bufW = 0, bufH = 0;
  let atlasRatioW = 1, atlasRatioH = 1, atlasKey = "";
  const fontSpec = { family: fontFamily.replace(/^var\([^,]+,\s*/, "").replace(/\)$/, "") || "Arial, sans-serif", weight: String(fontWeight), style: "normal", size: fontSize, letterSpacing };
  // resolve the CSS custom property to a concrete family list for canvas text measuring
  try {
    const probeEl = document.createElement("span");
    probeEl.style.fontFamily = fontFamily;
    document.body.appendChild(probeEl);
    fontSpec.family = getComputedStyle(probeEl).fontFamily || fontSpec.family;
    probeEl.remove();
  } catch (e) {}

  function drawFontPx() { return fontSpec.size * (boxW / REF_WIDTH); }

  function resize() {
    boxW = Math.max(1, host.offsetWidth);
    boxH = Math.max(1, host.offsetHeight);
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(boxW * dpr));
    const h = Math.max(1, Math.round(boxH * dpr));
    if (w === bufW && h === bufH) return;
    bufW = w; bufH = h;
    canvas.width = w; canvas.height = h;
  }

  function rebuildAtlas() {
    const px = Math.max(8, drawFontPx());
    const atlas = buildAtlas(text || " ", fontSpec, px, dpr);
    if (!atlas) return;
    atlasRatioW = Math.max(1e-4, atlas.cssW / px);
    atlasRatioH = Math.max(1e-4, atlas.cssH / px);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const cw = atlas.canvas.width, ch = atlas.canvas.height;
    const isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const pot = (cw & (cw - 1)) === 0 && (ch & (ch - 1)) === 0;
    if (isGL2 || pot) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  const target = { x: -0.5, y: 0.5 }, eased = { x: -0.5, y: 0.5 };
  let hasPointer = false;

  const onMove = (e) => {
    hasPointer = true;
    const r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    target.x = (e.clientX - r.left) / r.width;
    target.y = 1 - (e.clientY - r.top) / r.height;
  };
  if (!reducedMotion) window.addEventListener("pointermove", onMove, { passive: true });

  function sync() {
    resize();
    const key = [text, fontSpec.weight, dpr, Math.ceil(Math.max(8, drawFontPx()) / 64)].join("|");
    if (key !== atlasKey) { atlasKey = key; rebuildAtlas(); }
  }

  function step(dt) {
    const rate = speed / SPEED_REF;
    if (!hasPointer) {
      const band = (atlasRatioH * Math.max(8, drawFontPx())) / boxH;
      target.x += dt * SWEEP_RATE * rate;
      target.y = (1 - band) / 2 + SWEEP_BAND * band;
      if (target.x > 1.5) { target.x = -0.5; eased.x = -0.5; }
    }
    const damp = clamp((damping / 100) * DAMP_REF * dt, 0, 1);
    eased.x += (target.x - eased.x) * damp;
    eased.y += (target.y - eased.y) * damp;
  }

  function draw() {
    const tc = parseColor(textColor, [0.859, 0.918, 0.992, 1]);
    const sc = parseColor(shade, [0.035, 0.063, 0.102, 1]);
    gl.viewport(0, 0, bufW, bufH);
    gl.useProgram(prog);
    gl.uniform1i(U.map, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(U.res, boxW, boxH);
    const px = Math.max(8, drawFontPx());
    gl.uniform2f(U.atlas, atlasRatioW * px, atlasRatioH * px);
    gl.uniform2f(U.ptr, eased.x, eased.y);
    // reduced motion: no lens at all, so the whole word shows as the solid fill (under the lens
    // it turns into the thin dotted outline). Below the reference width the lens shrinks with
    // the word, or on a phone it covers the whole title and the fill never shows.
    const lens = Math.max(1, reach) * Math.min(1, boxW / REF_WIDTH);
    gl.uniform1f(U.reach, reducedMotion ? 0 : lens / boxW);
    gl.uniform3f(U.text, tc[0], tc[1], tc[2]);
    gl.uniform3f(U.shade, sc[0], sc[1], sc[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  let raf = 0, last = 0, onScreen = true;
  const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    if (onScreen) gate();
  }) : null;
  if (io) io.observe(host);

  const frame = (now) => {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    sync();
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  };

  function gate() {
    const shouldRun = alive && onScreen && !document.hidden;
    if (shouldRun && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    else if (!shouldRun && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const ro = new ResizeObserver(() => { resize(); });
  ro.observe(host);
  document.addEventListener("visibilitychange", gate);

  if (document.fonts) document.fonts.ready.then(() => { if (alive) atlasKey = ""; }, () => {});

  if (reducedMotion) {
    // one static frame: fully revealed, handles at rest, no rAF loop
    sync();
    draw();
  } else {
    gate();
  }

  return {
    destroy() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", gate);
      canvas.remove();
    },
  };
}
