// No-WebGL fallback: the same scene, projected on the CPU and drawn as dots and edges on a
// 2D canvas. It renders still frames only (on scroll between chapters and on resize), so it
// costs nothing while idle.

import * as THREE from "three";
import { pointWorld, OBJECTS, objectState, edgeFade } from "./world.js";

export function createFallback(canvas, data, pal) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  const v = new THREE.Vector3();
  const tmp = [0, 0, 0];
  const paper = `rgb(${[pal.paper.r, pal.paper.g, pal.paper.b].map((c) => Math.round(c * 255)).join(",")})`;
  const lock = `rgb(${[pal.lock.r, pal.lock.g, pal.lock.b].map((c) => Math.round(c * 255)).join(",")})`;

  function resize(w, h, ratio) {
    W = w; H = h; dpr = Math.min(ratio, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  function render(camera, scene, state, t, lockObj) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    camera.updateMatrixWorld();
    const states = OBJECTS.map((_, i) => objectState(i, t));
    const fades = states.map((s) => edgeFade(s.x));
    const { position: P, noise: N, info: I, count } = data;
    const camPos = camera.position;
    ctx.fillStyle = paper;
    for (let k = 0; k < count; k++) {
      const obj = I[k * 4], part = I[k * 4 + 1], seed = I[k * 4 + 2];
      let alpha = I[k * 4 + 3];
      pointWorld(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], obj, part, seed, states, t, tmp);
      let f = Math.min(1, Math.max(0, state.form * 1.45 - seed * 0.45));
      f = f * f * (3 - 2 * f);
      if (obj < -1.5) f = 1;
      const x = N[k * 3] + (tmp[0] - N[k * 3]) * f;
      const y = N[k * 3 + 1] + (tmp[1] - N[k * 3 + 1]) * f;
      const z = N[k * 3 + 2] + (tmp[2] - N[k * 3 + 2]) * f;
      if (obj >= 0) alpha *= fades[obj] * (1 - 0.85 * (1 - state.street));
      else if (obj > -1.5) alpha *= state.street;
      alpha *= 0.55 + 0.45 * f;
      if (alpha < 0.02) continue;
      v.set(x, y, z).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const depth = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
      alpha *= Math.min(1, Math.max(0, (34 - depth) / 25));
      if (alpha < 0.02) continue;
      const sx = (v.x + 1) * 0.5 * W, sy = (1 - v.y) * 0.5 * H;
      const size = Math.max(0.8, Math.min(3, 16 / depth));
      ctx.globalAlpha = Math.min(1, alpha * 0.9);
      ctx.fillStyle = obj === lockObj && state.lock > 0.5 ? lock : paper;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }

    // solids: project their edge lines
    ctx.lineWidth = 1;
    scene.updateMatrixWorld();
    scene.traverseVisible((o) => {
      if (!o.isLineSegments) return;
      const opacity = o.material.opacity;
      if (opacity < 0.02) return;
      const pos = o.geometry.getAttribute("position");
      const range = o.geometry.drawRange;
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = `#${o.material.color.getHexString()}`;
      ctx.beginPath();
      const end = Math.min(pos.count, range.start + range.count);
      for (let i = range.start; i + 1 < end; i += 2) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const ax = (v.x + 1) * 0.5 * W, ay = (1 - v.y) * 0.5 * H;
        v.fromBufferAttribute(pos, i + 1).applyMatrix4(o.matrixWorld).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo((v.x + 1) * 0.5 * W, (1 - v.y) * 0.5 * H);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  return { resize, render };
}
