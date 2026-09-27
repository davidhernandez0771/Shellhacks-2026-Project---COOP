/* Dither Reveal
 *
 * Full-bleed WebGL image treatment: the source photo is drawn through a
 * real ordered (Bayer 8x8) dither pass over its luminance, so most of the
 * frame reads as a coarse black/white/half-tone dot pattern. A soft-edged
 * circular "hole" in that pattern shows the real photo underneath at full
 * color. The hole drifts on its own (a slow orbiting/breathing motion driven
 * by the wave settings) so the effect reads on a static hero image with no
 * hover required, and it eases toward the pointer while the visitor is
 * hovering the element, then eases back to its own path on pointer-leave.
 *
 * Settings for this instance (David's call):
 *   fit cover, focus Y 50, dot size 4, reveal radius 120, softness 60,
 *   wave on, speed 60, density 20 (all baked into the defaults below).
 *
 * Porting notes:
 *   - The dithering itself (Bayer2/Bayer4/Bayer8 ordered dither over
 *     gl_FragCoord, tone quantized to 0 / 0.5 / 1) and the cover/contain
 *     "fit" math run in the fragment shader exactly as in the source this
 *     was ported from, which used WebGL rather than a 2D canvas filter.
 *   - The source only revealed the photo while the pointer was over the
 *     element (no reveal at all at rest). That does not suit a passive
 *     marketing image, so here the reveal circle is always visible and its
 *     center is driven by an autonomous wave orbit at rest, blending to the
 *     pointer position on hover. This is the one behavioral change from a
 *     straight port; everything else (dither math, wave-warp of the
 *     sampled UVs, fit/focus handling) is faithful.
 *   - No forced min-width/min-height: the canvas just fills `host`'s box
 *     via ResizeObserver.
 *   - The render loop is paused via IntersectionObserver (host off-screen)
 *     and document.hidden, and skipped entirely (single static frame, hole
 *     fixed at the resting center) when prefers-reduced-motion is on.
 */

const MAX_DPR = 2;

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;

uniform sampler2D uTexture;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseActive;
uniform float uRevealRadius;
uniform float uRevealSoftness;
uniform float uPixelSize;
uniform float uDitherStyle;

uniform float uWaveSpeed;
uniform float uWaveFrequency;
uniform float uWaveAmplitude;
uniform float uWaveMargin;

uniform float uCanvasAspect;
uniform float uImageAspect;
uniform vec2 uResolution;
uniform float uFit;
uniform float uFocusY;

varying vec2 vUv;

float Bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float Bayer4(vec2 a) { return Bayer2(a * 0.5) * 0.25 + Bayer2(a); }
float Bayer8(vec2 a) { return Bayer4(a * 0.5) * 0.25 + Bayer2(a); }

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

float ordered3(float gray, float thr) {
  float adj = gray + (thr - 0.5) * 0.5;
  return adj < 0.33 ? 0.0 : (adj < 0.66 ? 0.5 : 1.0);
}

float ditherTone(float gray, float ps) {
  vec2 fc = gl_FragCoord.xy / ps;
  if (uDitherStyle < 0.5) {
    return ordered3(gray, Bayer8(fc));
  } else if (uDitherStyle < 1.5) {
    float period = ps * 4.0;
    float v = fract((gl_FragCoord.x + gl_FragCoord.y) / period);
    return 1.0 - step(v, 1.0 - gray);
  }
  return step(ign(fc), gray);
}

vec2 fitUv(vec2 uv) {
  vec2 cover = uCanvasAspect < uImageAspect
      ? vec2(uCanvasAspect / uImageAspect, 1.0)
      : vec2(1.0, uImageAspect / uCanvasAspect);
  vec2 s = uFit > 0.5 ? 1.0 / cover : cover / (1.0 + 2.0 * uWaveMargin);
  vec2 out_ = (uv - 0.5) * s + 0.5;
  out_.y += (1.0 - s.y) * (0.5 - uFocusY) * step(s.y, 1.0);
  return out_;
}

void main() {
  vec2 uv = vUv;
  float time = uTime;
  float waveStrength = uWaveAmplitude * 0.1;
  float revealNorm = uRevealRadius / max(min(uResolution.x, uResolution.y), 1.0);

  float wave1 = sin(uv.y * uWaveFrequency + time * uWaveSpeed) * waveStrength;
  float wave2 = sin(uv.x * uWaveFrequency * 0.7 + time * uWaveSpeed * 0.8) * waveStrength * 0.5;

  vec2 distortedUv = uv;
  distortedUv.x += wave1;
  distortedUv.y += wave2;

  if (uMouseActive > 0.01) {
    float dist = distance(uv, uMouse);
    float mouseInfluence = smoothstep(revealNorm, 0.0, dist);
    float ripple = sin(dist * uWaveFrequency * 5.0 - time * uWaveSpeed)
        * uWaveAmplitude * 0.05 * mouseInfluence * uMouseActive;
    distortedUv.x += ripple;
    distortedUv.y += ripple;
  }

  vec2 sampleUv = fitUv(distortedUv);
  vec4 color = texture2D(uTexture, sampleUv);
  vec2 inside = step(vec2(0.0), sampleUv) * step(sampleUv, vec2(1.0));
  color *= inside.x * inside.y;

  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float ps = max(uPixelSize, 0.25);
  float tone = ditherTone(gray, ps);
  vec3 ditherColor = vec3(tone);

  float revealDist = distance(uv * uResolution, uMouse * uResolution);
  float innerRadius = max(0.0, uRevealRadius * (1.0 - uRevealSoftness));
  float outerRadius = uRevealRadius * (1.0 + uRevealSoftness) + 0.001;
  float revealAmount = (1.0 - smoothstep(innerRadius, outerRadius, revealDist)) * uMouseActive;

  gl_FragColor = vec4(mix(ditherColor, color.rgb, revealAmount), color.a);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("dither-reveal shader:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function num(v, fb) {
  return typeof v === "number" && isFinite(v) ? v : fb;
}

function clampN(v, lo, hi, fb) {
  const n = num(v, fb);
  return n < lo ? lo : n > hi ? hi : n;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Mount the dither-reveal WebGL effect inside an existing container.
 *
 * `host` must already be sized/positioned by the caller's stylesheet; this
 * module only inserts a <canvas> sized to fill it via ResizeObserver.
 *
 * @param {HTMLElement} host - existing container element already in the DOM.
 * @param {{
 *   src: string,
 *   reducedMotion?: boolean,
 *   fit?: 'cover' | 'contain',
 *   dotSize?: number,
 *   radius?: number,
 *   softness?: number,
 *   wave?: boolean,
 *   speed?: number,
 *   density?: number,
 *   onError?: () => void,
 * }} [options]
 * @returns {{ destroy: () => void }}
 */
export function createDitherReveal(host, options = {}) {
  if (!host || typeof host.appendChild !== "function") {
    throw new Error("createDitherReveal: host must be an existing element");
  }

  const {
    src = "",
    fit = "cover",
    dotSize = 4,
    radius = 120,
    softness = 60,
    wave = true,
    speed = 60,
    density = 20,
    onError,
  } = options;

  const FOCUS_Y = 0.5; // "Y 50" resting position, not exposed as an option

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

  const waveOn = wave !== false;
  const speedNorm = waveOn ? clampN(speed, 1, 100, 60) / 100 : 0;
  const settings = {
    fit: fit === "contain" ? 1 : 0,
    focusY: FOCUS_Y,
    pixelSize: clampN(dotSize, 1, 20, 4) / 2,
    revealRadius: clampN(radius, 20, 600, 120),
    revealSoftness: clampN(softness, 0, 100, 60) / 100,
    waveSpeed: speedNorm,
    waveFrequency: clampN(density, 5, 100, 20) / 10,
    waveAmplitude: speedNorm * 0.4,
    waveMargin: speedNorm * 0.4 * 0.15,
  };

  const canvas = document.createElement("canvas");
  canvas.className = "dither-reveal-canvas";
  host.appendChild(canvas);

  // The canvas is absolutely positioned to fill `host`; give host a
  // positioning context if the caller's stylesheet did not already set one.
  try {
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
  } catch (err) {
    /* noop */
  }

  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl) {
    console.error("dither-reveal: WebGL unavailable");
    if (typeof onError === "function") onError();
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
      console.error("dither-reveal link:", gl.getProgramInfoLog(prog));
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
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const locs = {};
  const u = (name) => {
    if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
    return locs[name];
  };

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([6, 6, 6, 255])
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  let imgAspect = 1.5;
  let imageReady = false;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    if (img.naturalHeight > 0) imgAspect = img.naturalWidth / img.naturalHeight;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      imageReady = true;
      if (reduced) drawFrame(); // eslint-disable-line no-use-before-define
    } catch (err) {
      /* noop */
    }
  };
  img.onerror = () => {
    console.warn("dither-reveal: image failed to load:", src);
    if (typeof onError === "function") onError();
  };
  if (src) img.src = src;

  // Reveal-hole state: an autonomous wave orbit at rest, blended toward the
  // pointer while hovering.
  const pointer = { x: 0.5, y: FOCUS_Y, active: 0, target: 0 };

  function onPointerMove(e) {
    const r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    pointer.x = (e.clientX - r.left) / r.width;
    pointer.y = 1 - (e.clientY - r.top) / r.height;
    pointer.target = 1;
  }
  const onPointerEnter = () => (pointer.target = 1);
  const onPointerLeave = () => (pointer.target = 0);

  if (!reduced) {
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerenter", onPointerEnter);
    host.addEventListener("pointerleave", onPointerLeave);
  }

  function orbit(t) {
    const s = settings.waveSpeed;
    const f = settings.waveFrequency;
    const angle1 = t * s * (0.6 + f * 0.05);
    const angle2 = t * s * (0.4 + f * 0.035) + 1.7;
    return {
      x: 0.5 + Math.sin(angle1) * 0.3,
      y: settings.focusY + Math.sin(angle2) * 0.16,
    };
  }

  function resizeToHost() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = host.clientWidth || 1;
    const ch = host.clientHeight || 1;
    const bw = Math.max(1, Math.floor(cw * dpr));
    const bh = Math.max(1, Math.floor(ch * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    return { cw, ch };
  }

  const start = performance.now();

  function drawFrame() {
    const { cw, ch } = resizeToHost();
    const t = reduced ? 0 : (performance.now() - start) / 1000;

    let holeX = 0.5;
    let holeY = settings.focusY;
    const mouseActive = 1;

    if (reduced) {
      holeX = 0.5;
      holeY = settings.focusY;
    } else {
      const o = orbit(t);
      pointer.active += (pointer.target - pointer.active) * 0.08;
      holeX = lerp(o.x, pointer.x, pointer.active);
      holeY = lerp(o.y, pointer.y, pointer.active);
    }

    gl.uniform1f(u("uTime"), t);
    gl.uniform2f(u("uMouse"), holeX, holeY);
    gl.uniform1f(u("uMouseActive"), mouseActive);
    gl.uniform1f(u("uRevealRadius"), settings.revealRadius);
    gl.uniform1f(u("uRevealSoftness"), settings.revealSoftness);
    gl.uniform1f(u("uPixelSize"), settings.pixelSize);
    gl.uniform1f(u("uDitherStyle"), 0); // bayer8 (mode: Default)
    gl.uniform1f(u("uWaveSpeed"), reduced ? 0 : settings.waveSpeed);
    gl.uniform1f(u("uWaveFrequency"), settings.waveFrequency);
    gl.uniform1f(u("uWaveAmplitude"), reduced ? 0 : settings.waveAmplitude);
    gl.uniform1f(u("uWaveMargin"), settings.waveMargin);
    gl.uniform1f(u("uCanvasAspect"), canvas.width / canvas.height);
    gl.uniform1f(u("uImageAspect"), imgAspect);
    gl.uniform2f(u("uResolution"), cw, ch);
    gl.uniform1f(u("uFit"), settings.fit);
    gl.uniform1f(u("uFocusY"), settings.focusY);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let raf = 0;
  let running = false;

  function render() {
    drawFrame();
    raf = requestAnimationFrame(render);
  }

  function startLoop() {
    if (running || reduced) return;
    running = true;
    raf = requestAnimationFrame(render);
  }

  function stopLoop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  let io = null;
  let visible = true;
  try {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting;
        if (visible && !document.hidden) startLoop();
        else stopLoop();
      },
      { threshold: 0.01 }
    );
    io.observe(host);
  } catch (err) {
    io = null;
  }

  function onVisibilityChange() {
    if (document.hidden) stopLoop();
    else if (visible) startLoop();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  let ro = null;
  try {
    ro = new ResizeObserver(() => {
      resizeToHost();
      if (reduced) drawFrame();
    });
    ro.observe(host);
  } catch (err) {
    ro = null;
  }

  if (reduced) {
    resizeToHost();
    drawFrame();
  } else if (!io) {
    startLoop();
  }

  function destroy() {
    stopLoop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (io) {
      io.disconnect();
      io = null;
    }
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (!reduced) {
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerenter", onPointerEnter);
      host.removeEventListener("pointerleave", onPointerLeave);
    }
    img.onload = null;
    img.onerror = null;
    releaseGL();
    gl.deleteProgram(prog);
    gl.deleteBuffer(buf);
    gl.deleteTexture(texture);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return { destroy };
}
