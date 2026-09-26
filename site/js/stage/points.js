// The point cloud: street, people, cars, dust, all in one draw call. Moving objects are
// animated in the vertex shader from a small uniform array, so the CPU never touches the
// 20k points per frame. pointWorld() in world.js mirrors this shader for the 2D fallback.

import * as THREE from "three";
import { OBJECTS, buildPoints, FOCUS_INDEX } from "./world.js";

const N_OBJ = OBJECTS.length;

const VERT = /* glsl */ `
  uniform vec4 uObj[${N_OBJ}];      // x, z, heading, walk phase
  uniform float uObjFade[${N_OBJ}];
  uniform float uForm;
  uniform float uTime;
  uniform float uStreet;
  uniform float uSize;
  uniform float uMaxSize;
  uniform float uLockObj;
  uniform float uLock;
  uniform vec3 uGhost;              // x offset, z offset, alpha (ghost copies only)
  uniform float uIsGhost;
  uniform vec4 uCopyZone;           // axis (0 = x, 1 = y), fade from, fade to (NDC), strength
  attribute vec3 aNoise;
  attribute vec4 aInfo;             // obj (-1 street, -2 dust), part, seed, brightness
  varying float vAlpha;
  varying float vLock;

  vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

  void main() {
    vec3 p = position;
    float obj = aInfo.x;
    float part = aInfo.y;
    float seed = aInfo.z;
    float alpha = aInfo.w;
    float isLock = 0.0;

    if (obj >= 0.0) {
      int oi = int(obj + 0.5);
      vec4 O = uObj[oi];
      float swing = 0.0, pivot = 0.0;
      if (part > 0.5 && part < 1.5) { pivot = 0.92; swing = 0.5; }
      else if (part > 1.5 && part < 2.5) { pivot = 0.92; swing = -0.5; }
      else if (part > 2.5 && part < 3.5) { pivot = 1.42; swing = -0.4; }
      else if (part > 3.5 && part < 4.5) { pivot = 1.42; swing = 0.4; }
      if (swing != 0.0) {
        vec2 q = rot(vec2(p.x, p.y - pivot), sin(O.w) * swing);
        p.x = q.x; p.y = q.y + pivot;
      }
      if (${OBJECTS.map((o, i) => (o.kind === "person" ? `oi == ${i}` : null)).filter(Boolean).join(" || ")}) p.y += abs(sin(O.w)) * 0.03;
      vec2 r = rot(vec2(p.x, p.z), O.z);
      p = vec3(r.x + O.x, p.y, r.y + O.y);
      alpha *= uObjFade[oi];
      isLock = step(abs(obj - uLockObj), 0.1) * uLock * 0.35;
    } else if (obj < -1.5) {
      p.x += sin(uTime * 0.13 + seed * 40.0) * 0.4;
      p.y += sin(uTime * 0.17 + seed * 23.0) * 0.25;
      alpha *= 0.6 + 0.4 * sin(uTime * 0.9 + seed * 60.0);
    } else {
      alpha *= uStreet;
    }
    if (obj >= 0.0) alpha *= 0.62 * smoothstep(0.0, 0.6, uStreet);

    // intro noise: each point drifts in its own orbit, then flies home staggered by seed
    vec3 n = aNoise + vec3(sin(uTime * 0.21 + seed * 31.0), cos(uTime * 0.17 + seed * 17.0) * 0.6, sin(uTime * 0.19 + seed * 11.0)) * 0.35;
    float f = clamp(uForm * 1.45 - seed * 0.45, 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    vec3 world = mix(n, p, f);
    if (obj < -1.5) world = p;
    alpha *= mix(0.55, 1.0, f);

    if (uIsGhost > 0.5) {
      world.x += uGhost.x;
      world.z += uGhost.y;
      alpha = aInfo.w * uGhost.z;
      isLock = 1.0;
    }

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    float depth = -mv.z;
    alpha *= smoothstep(34.0, 9.0, depth);
    gl_PointSize = min(uSize * (0.75 + 0.5 * aInfo.w) / max(depth, 0.5), uMaxSize);
    gl_Position = projectionMatrix * mv;
    // fade moving things as they pass behind the copy column, so text stays legible
    if (obj >= 0.0 || uIsGhost > 0.5) {
      vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.001);
      float c = uCopyZone.x < 0.5 ? ndc.x : ndc.y;
      alpha *= mix(1.0, smoothstep(uCopyZone.y, uCopyZone.z, c), uCopyZone.w);
    }
    vAlpha = alpha;
    vLock = isLock;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uLockColor;
  varying float vAlpha;
  varying float vLock;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    float a = smoothstep(0.5, 0.0, r);
    a = a * a;
    vec3 col = mix(uPaper, uLockColor, vLock);
    gl_FragColor = vec4(col * a * vAlpha, 1.0);
  }
`;

export function createPoints(scene, pal) {
  const data = buildPoints();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(data.position, 3));
  geo.setAttribute("aNoise", new THREE.BufferAttribute(data.noise, 3));
  geo.setAttribute("aInfo", new THREE.BufferAttribute(data.info, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, -4), 40);

  const uniforms = {
    uObj: { value: OBJECTS.map(() => new THREE.Vector4()) },
    uObjFade: { value: OBJECTS.map(() => 1) },
    uForm: { value: 0 },
    uTime: { value: 0 },
    uStreet: { value: 1 },
    uSize: { value: 60 },
    uMaxSize: { value: 8 },
    uCopyZone: { value: new THREE.Vector4(0, -0.55, -0.15, 1) },
    uLockObj: { value: FOCUS_INDEX },
    uLock: { value: 0 },
    uGhost: { value: new THREE.Vector3() },
    uIsGhost: { value: 0 },
    uPaper: { value: pal.paper },
    uLockColor: { value: pal.lock },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);

  // Ghost copies of the focus person: the predicted future position and its fading trail.
  const [start, count] = data.ranges[FOCUS_INDEX];
  const GHOSTS = 4;
  const ghosts = [];
  for (let g = 0; g < GHOSTS; g++) {
    const gGeo = new THREE.BufferGeometry();
    for (const name of ["position", "aNoise", "aInfo"]) gGeo.setAttribute(name, geo.getAttribute(name));
    gGeo.setDrawRange(start, count);
    gGeo.boundingSphere = geo.boundingSphere;
    const gUniforms = { ...uniforms, uIsGhost: { value: 1 }, uGhost: { value: new THREE.Vector3() } };
    const gMat = new THREE.ShaderMaterial({
      uniforms: gUniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const gp = new THREE.Points(gGeo, gMat);
    gp.frustumCulled = false;
    gp.renderOrder = 3;
    gp.visible = false;
    scene.add(gp);
    ghosts.push(gp);
  }

  return { points, uniforms, ghosts, data };
}
