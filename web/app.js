// COOP dashboard. Talks to the real API (docs/API.md) and falls back to the client-side
// mock (mock.js) when no backend answers at startup, or when ?demo=<state> is set.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEG = Math.PI / 180;

  const POLL_MS = 300;
  const EVENTS_MS = 1000;
  const OFFLINE_AFTER_FAILS = 3;     // ~1 s of failed polls before we call it offline
  const STALE_AFTER_MS = 2000;       // frame_seq frozen this long = vision loop stalled
  const NO_CAMERA_AFTER_MS = 4000;   // connected, but no frame published for this long
  const DEFAULT_FOV = { h: 63.0, v: 49.0 };
  const TRAIL_LEN = 12;              // ~3.6 s of aim history at 300 ms polls
  const ARROW_HORIZON_S = 0.6;       // arrow = where the target will be this far ahead
  const NUDGE_DEG = 5;
  const NUDGE_FINE_DEG = 1;
  const NUDGE_MIN_INTERVAL_MS = 90;  // key auto-repeat must not flood the Pi
  const ZERO_CONFIRM_MS = 3000;
  const SCRAMBLE_MS = 520;
  const SCRAMBLE_CHARS = "░▒▓█ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v) => typeof v === "number" && isFinite(v);

  // ---------------------------------------------------------------- sources
  class SourceError extends Error {
    constructor(kind, msg) { super(msg || kind); this.kind = kind; }
  }

  async function postJSON(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        redirect: "manual",
      });
    } catch (e) {
      return { ok: false, error: "Can't reach COOP." };
    }
    if (res.type === "opaqueredirect") return { ok: false, error: "Signed out. Reload to sign in again." };
    if (res.status === 404) return { ok: false, error: "This COOP build doesn't support that yet." };
    try { return await res.json(); } catch (e) { return { ok: false, error: `HTTP ${res.status}` }; }
  }

  class RealSource {
    async getStatus() {
      let res;
      try {
        // redirect:"manual" turns a Cloudflare Access login redirect into an inspectable
        // opaqueredirect instead of an indistinguishable CORS TypeError.
        res = await fetch("/api/status", { redirect: "manual", cache: "no-store" });
      } catch (e) {
        throw new SourceError("offline", e.message);
      }
      if (res.type === "opaqueredirect") throw new SourceError("expired");
      if (!res.ok) throw new SourceError("offline", `status ${res.status}`);
      return res.json();
    }
    async getEvents(since) {
      const res = await fetch(`/api/events?since=${since || 0}`, { redirect: "manual", cache: "no-store" });
      if (!res.ok) throw new SourceError("offline");
      return res.json();
    }
    async getSettings() {
      const res = await fetch("/api/settings", { redirect: "manual", cache: "no-store" });
      if (!res.ok) throw new SourceError("offline", `status ${res.status}`);
      return res.json();
    }
    postMode(mode) { return postJSON("/api/mode", { mode }); }
    postTarget(id) { return postJSON("/api/target", { id }); }
    postAim(pan) { return postJSON("/api/aim", { pan }); }
    postNudge(dpan) { return postJSON("/api/nudge", { dpan }); }
    postHome() { return postJSON("/api/home", {}); }
    postEstop() { return postJSON("/api/estop", {}); }
    postArm() { return postJSON("/api/arm", {}); }
    postZero() { return postJSON("/api/zero", {}); }
    postSettings(body) { return postJSON("/api/settings", body); }
  }

  let source = null;
  let usingMock = false;

  async function chooseSource() {
    if (window.COOP_DEMO) {
      source = new window.COOP_MOCK();
      usingMock = true;
      return;
    }
    const real = new RealSource();
    try {
      await real.getStatus();
      source = real;
    } catch (e) {
      // Only a backend that is absent at startup means "no backend yet". An Access redirect
      // means the backend exists and we should say so, not pretend with mock data.
      if (e.kind === "expired") {
        source = real;
      } else {
        source = new window.COOP_MOCK();
        usingMock = true;
      }
    }
  }

  // ---------------------------------------------------------------- state
  let lastStatus = null;
  let conn = "connecting";          // connecting | live | stale | offline | expired
  let failStreak = 0;
  let lastGoodAt = 0;               // client ms of last successful poll
  let connectedAt = 0;              // client ms of the first successful poll
  let lastFrameAt = 0;              // client ms of the last status that had a frame
  let lastFrameSeq = null;
  let lastFrameSeqChangeAt = 0;
  let clockSkew = 0;                // server_time - client time, seconds
  let optimisticMode = null;
  let lastEventSeq = 0;
  let motorsDisconnected = false;
  let videoBroken = false;
  let trail = [];                   // [{pan}] predicted aim history, world angles
  let trailKey = null;              // target id the trail belongs to

  const currentMode = () => optimisticMode || (lastStatus && lastStatus.mode) || "auto";
  const estopOn = () => !!(lastStatus && lastStatus.estop);
  const isControllable = () => conn === "live" || conn === "stale" || conn === "connecting";
  const serialState = () => (lastStatus && lastStatus.diag && lastStatus.diag.serial) || null;
  const hasFrame = (s) => !!(s && s.frame);
  const noCamera = () => conn !== "expired" && conn !== "offline" &&
    ((!usingMock && videoBroken) || (connectedAt && !hasFrame(lastStatus) && Date.now() - Math.max(connectedAt, lastFrameAt) > NO_CAMERA_AFTER_MS));

  // ---------------------------------------------------------------- geometry
  function fovOf(frame) {
    return { h: (frame && frame.hfov_deg) || DEFAULT_FOV.h, v: (frame && frame.vfov_deg) || DEFAULT_FOV.v };
  }
  // World pan angle -> frame x, same pinhole model as coop/main.py (pan-only build).
  function projectX(pan, gimbal, frame) {
    const fov = fovOf(frame);
    const dp = pan - (gimbal.pan || 0);
    if (Math.abs(dp) > 80) return null;
    return frame.w / 2 + (frame.w / 2) * Math.tan(dp * DEG) / Math.tan((fov.h / 2) * DEG);
  }
  function pixelOffsetDeg(x, y, frame) {
    const fov = fovOf(frame);
    const nx = (x - frame.w / 2) / (frame.w / 2);
    const ny = (frame.h / 2 - y) / (frame.h / 2);
    return {
      pan: Math.atan(nx * Math.tan((fov.h / 2) * DEG)) / DEG,
      tilt: Math.atan(ny * Math.tan((fov.v / 2) * DEG)) / DEG,
    };
  }
  function pxPerDeg(offDeg, halfSpanPx, halfFovDeg) {
    const c = Math.cos(offDeg * DEG);
    return (halfSpanPx / Math.tan(halfFovDeg * DEG)) * DEG / (c * c);
  }
  const boxCenter = (b) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });

  // ---------------------------------------------------------------- dom helpers
  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
    return node;
  }
  const fmtSigned = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  function timeAgo(serverT) {
    const s = Math.max(0, Date.now() / 1000 + clockSkew - serverT);
    if (s < 1) return "now";
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  function fmtUptime(s) {
    s = Math.floor(s);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
  }

  // ---------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  function friendly(err) {
    if (!err) return "Something went wrong.";
    if (/e-stop engaged/i.test(err)) return "The e-stop is on. Arm first.";
    if (/only in manual/i.test(err)) return "Switch to Manual to aim by hand.";
    return err.charAt(0).toUpperCase() + err.slice(1);
  }
  async function send(promise) {
    try {
      const r = await promise;
      if (r && r.ok === false) toast(friendly(r.error));
      return r;
    } catch (e) {
      toast("Can't reach COOP.");
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------- label scramble
  // A newly seen detection (and a newly acquired target) decodes its label, like the showcase.
  const scrambles = new Map();      // id -> { t0, text, node }
  let scrambleRaf = 0;
  function startScramble(id, text) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    scrambles.set(id, { t0: performance.now(), text, node: null });
    if (!scrambleRaf) scrambleRaf = requestAnimationFrame(tickScramble);
  }
  function scrambleText(text, p) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const reveal = i / text.length;
      if (text[i] === " ") out += " ";
      else if (p >= reveal + 0.25) out += text[i];
      else if (p >= reveal) out += "░▒▓█"[Math.min(3, Math.floor(((p - reveal) / 0.25) * 4))];
      else out += SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
    }
    return out;
  }
  function tickScramble(now) {
    scrambleRaf = 0;
    for (const [id, s] of scrambles) {
      const p = (now - s.t0) / SCRAMBLE_MS;
      if (s.node) s.node.textContent = p >= 1.25 ? s.text : scrambleText(s.text, p);
      if (p >= 1.25) scrambles.delete(id);
    }
    if (scrambles.size) scrambleRaf = requestAnimationFrame(tickScramble);
  }
  let seenIds = new Set();
  let lastTargetId = null;

  // ---------------------------------------------------------------- top bar + banner
  function renderBar(status) {
    const c = $("#conn");
    c.className = "conn";
    let label;
    if (conn === "live") {
      c.classList.add("is-live");
      label = `Live · ${status && num(status.fps) ? status.fps.toFixed(1) : "–"} fps`;
    } else if (conn === "stale") {
      c.classList.add("is-stale");
      label = "Stale";
    } else if (conn === "offline" || conn === "expired") {
      c.classList.add("is-down");
      label = conn === "offline" ? "Offline" : "Signed out";
    } else {
      label = "Connecting";
    }
    c.querySelector(".label").textContent = usingMock ? `${label} · mock` : label;

    if (status && optimisticMode === status.mode) optimisticMode = null;
    const mode = currentMode();
    const estop = estopOn();
    $$(".modes button").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-pressed", String(on));
      b.disabled = estop && b.dataset.mode !== "stop";
    });
    const eb = $("#estop-btn");
    eb.classList.toggle("is-engaged", estop);
    eb.querySelector("span").textContent = estop ? "E-stop on" : "E-stop";
    $("#manual").hidden = mode !== "manual";
    $("#gauge").classList.toggle("is-manual", mode === "manual" && !estop);
  }

  function banner(kind, title, detail, action) {
    const b = $("#banner");
    b.hidden = false;
    b.className = `banner${kind === "alert" ? " is-alert" : ""}`;
    b.setAttribute("role", kind === "alert" ? "alert" : "status");
    $("#banner-title").textContent = title;
    $("#banner-detail").textContent = detail;
    const a = $("#banner-action");
    a.hidden = !action;
    if (action) { a.textContent = action.label; a.onclick = action.run; }
  }

  function renderBanner() {
    document.body.classList.toggle("is-down", conn === "offline" || conn === "expired");
    $("#feed").classList.toggle("is-stale", conn === "stale" || conn === "offline");
    const since = lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null;
    const g = lastStatus && lastStatus.gimbal;
    if (conn === "expired") {
      return banner("alert", "Signed out", "Your Cloudflare Access session ended, so COOP can't be watched or controlled. Sign in again to continue.",
        { label: "Sign in again", run: () => location.reload() });
    }
    if (conn === "offline") {
      return banner("alert", "Connection lost", `Retrying every ${POLL_MS} ms${since != null ? `, last update ${since}s ago` : ""}. Controls are paused until COOP answers.`);
    }
    if (estopOn()) {
      return banner("alert", "E-stop engaged", "The drivers are off and the motor turns freely by hand. Arm to power them back on; COOP stays in Stop until you pick a mode.",
        { label: "Arm", run: () => send(source.postArm()) });
    }
    if (serialState() === "reconnecting") {
      return banner("alert", "Arduino reconnecting", "The camera holds still until the Uno is back. Check the USB cable between the Pi and the Uno; COOP keeps retrying on its own.");
    }
    if (conn === "stale") {
      const frozen = Math.round((Date.now() - lastFrameSeqChangeAt) / 1000);
      return banner("info", "Camera loop stalled", `The server answers, but no new frame for ${frozen}s. Tracking is frozen.`);
    }
    if (g && g.drivers_enabled === false) {
      return banner("info", "Drivers powered down", "COOP turned the motor off after a while in Stop, so it stays cool. Pick Auto or Manual to power it back on.");
    }
    $("#banner").hidden = true;
  }

  // ---------------------------------------------------------------- feed state
  function renderFeedState() {
    const st = $("#feed-state");
    let title = null, detail = null;
    if (conn === "expired") {
      title = "Signed out";
      detail = "The feed stops when the Cloudflare Access session ends.";
    } else if (conn === "offline" && !lastStatus) {
      title = "Can't reach COOP";
      detail = "Check that the Pi is on and on the same network.";
    } else if (noCamera()) {
      title = "No camera";
      detail = "COOP is running, but no frame has arrived from the camera. Check the 22-pin ribbon cable at both ends (contacts facing the right way), then restart COOP.";
    }
    st.hidden = !title;
    if (title) { $("#feed-state-title").textContent = title; $("#feed-state-detail").textContent = detail; }
    $("#feed-tag").hidden = !usingMock || !!title;
    $("#feed-tag").textContent = window.COOP_DEMO ? `Demo · ${window.COOP_DEMO}` : "Mock feed";
  }

  // ---------------------------------------------------------------- overlay
  function labelFor(d) { return `${d.label.toUpperCase()} #${d.id} · ${d.conf.toFixed(2)}`; }

  function renderOverlay(status) {
    const svg = $("#overlay");
    const frame = status.frame;
    svg.replaceChildren();
    if (!frame || noCamera()) return;
    svg.setAttribute("viewBox", `0 0 ${frame.w} ${frame.h}`);
    // viewBox units per CSS pixel, so text and markers keep a constant on-screen size.
    const k = Math.max(frame.w / (svg.clientWidth || frame.w), frame.h / (svg.clientHeight || frame.h));
    svg.style.setProperty("--k", k);

    const target = status.target;
    const lockedId = target && target.locked ? target.id : null;
    const autoId = target ? target.id : null;
    const interactive = isControllable() && !estopOn();
    const dets = status.detections || [];

    // scramble labels for IDs we haven't seen, and for a newly acquired target
    const nowIds = new Set(dets.map((d) => d.id));
    for (const d of dets) if (!seenIds.has(d.id)) startScramble(d.id, labelFor(d));
    if (autoId !== null && autoId !== lastTargetId) {
      const d = dets.find((x) => x.id === autoId);
      if (d) startScramble(d.id, labelFor(d));
    }
    seenIds = nowIds;
    lastTargetId = autoId;

    const layer = svgEl("g", { class: "boxes" });
    // Largest first, so a smaller box inside a bigger one is on top and wins the click.
    const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    const ordered = dets.slice().sort((a, b) => area(b.box) - area(a.box));
    for (const d of ordered) {
      const [x1, y1, x2, y2] = d.box;
      const cls = d.id === lockedId ? "locked" : d.id === autoId ? "auto" : "det";
      const g = svgEl("g", { class: `det-g ${cls}` });
      if (cls === "det") g.classList.add("det");

      const hit = svgEl("rect", { class: "hit", x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      const title = svgEl("title");
      title.textContent = cls === "locked" ? `${d.label} #${d.id} (locked)` : `Lock ${d.label} #${d.id}`;
      hit.appendChild(title);
      if (interactive) hit.addEventListener("click", () => lockTarget(d.id));
      g.appendChild(hit);

      if (cls === "locked") g.appendChild(svgEl("rect", { class: "frame-rect", x: x1, y: y1, width: x2 - x1, height: y2 - y1 }));
      const L = Math.max(8 * k, Math.min(x2 - x1, y2 - y1) * (cls === "det" ? 0.18 : 0.24));
      g.appendChild(svgEl("path", {
        class: "brk",
        d: `M ${x1} ${y1 + L} V ${y1} H ${x1 + L} M ${x2 - L} ${y1} H ${x2} V ${y1 + L} ` +
           `M ${x1} ${y2 - L} V ${y2} H ${x1 + L} M ${x2 - L} ${y2} H ${x2} V ${y2 - L}`,
      }));

      // leader line out of the top corner to a mono label; flips left at the frame's edge
      const text = labelFor(d);
      const textW = text.length * 7.2 * k;  // Martian Mono at 10.5 px, 87.5% width
      const rise = 12 * k, run = 16 * k;
      const flip = x2 + rise + run + textW + 6 * k > frame.w;
      const sx = flip ? x1 : x2;
      const top = Math.max(y1 - rise, 16 * k);
      const ex = flip ? sx - rise - run : sx + rise + run;
      g.appendChild(svgEl("path", { class: "leader", d: `M ${sx} ${y1} L ${flip ? sx - rise : sx + rise} ${top} H ${ex}` }));
      const t = svgEl("text", { class: "tag", x: flip ? ex - 4 * k : ex + 4 * k, y: top + 3.5 * k, "text-anchor": flip ? "end" : "start" });
      const sc = scrambles.get(d.id);
      t.textContent = sc ? scrambleText(text, (performance.now() - sc.t0) / SCRAMBLE_MS) : text;
      if (sc) { sc.node = t; sc.text = text; }
      g.appendChild(t);
      layer.appendChild(g);
    }
    svg.appendChild(layer);
    renderPrediction(svg, status, k);
  }

  function renderPrediction(svg, status, k) {
    const { target, gimbal, frame } = status;
    const key = target && status.mode === "auto" ? `${target.id}` : null;
    if (key !== trailKey) { trail = []; trailKey = key; }
    $("#legend").hidden = !key;
    if (!key || !gimbal) return;

    trail.push(gimbal.target_pan);
    if (trail.length > TRAIL_LEN) trail.shift();

    const g = svgEl("g", { class: "prediction" });
    const c = boxCenter(target.box);
    const fov = fovOf(frame);
    // Pan-only: the aim point sits at the target's height; only its x moves with the lead.
    const aimY = c.y;

    const [vp, vt] = status.velocity_deg_s || [0, 0];
    if (Math.hypot(vp, vt) >= 1) {
      const off = pixelOffsetDeg(c.x, c.y, frame);
      let dx = vp * pxPerDeg(off.pan, frame.w / 2, fov.h / 2) * ARROW_HORIZON_S;
      let dy = -vt * pxPerDeg(off.tilt, frame.h / 2, fov.v / 2) * ARROW_HORIZON_S;
      const maxLen = frame.w * 0.4;
      const len = Math.hypot(dx, dy);
      if (len > maxLen) { dx *= maxLen / len; dy *= maxLen / len; }
      if (len > 6 * k) {
        const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
        const hx = c.x + dx, hy = c.y + dy;
        g.appendChild(svgEl("line", { class: "vel", x1: c.x, y1: c.y, x2: hx - ux * 7 * k, y2: hy - uy * 7 * k }));
        g.appendChild(svgEl("path", {
          class: "vel-head",
          d: `M ${hx} ${hy} L ${hx - ux * 9 * k - uy * 4.5 * k} ${hy - uy * 9 * k + ux * 4.5 * k} L ${hx - ux * 9 * k + uy * 4.5 * k} ${hy - uy * 9 * k - ux * 4.5 * k} Z`,
        }));
      }
    }

    // fading trail of past aim points, re-projected against the current gimbal angle
    trail.forEach((p, i) => {
      if (i === trail.length - 1) return;
      const x = projectX(p, gimbal, frame);
      if (x == null || x < 0 || x > frame.w) return;
      const age = (i + 1) / trail.length;
      g.appendChild(svgEl("circle", { class: "trail", cx: x, cy: aimY, r: (1.5 + 2 * age) * k, "fill-opacity": (0.1 + 0.6 * age).toFixed(2) }));
    });

    const ax = projectX(gimbal.target_pan, gimbal, frame);
    if (ax != null) {
      g.appendChild(svgEl("line", { class: "lead-line", x1: c.x, y1: c.y, x2: ax, y2: aimY }));
      const r = 7 * k;
      g.appendChild(svgEl("circle", { class: "aim-ring", cx: ax, cy: aimY, r }));
      g.appendChild(svgEl("path", {
        class: "aim-ticks",
        d: `M ${ax - r * 1.9} ${aimY} H ${ax - r * 1.25} M ${ax + r * 1.25} ${aimY} H ${ax + r * 1.9} M ${ax} ${aimY - r * 1.9} V ${aimY - r * 1.25} M ${ax} ${aimY + r * 1.25} V ${aimY + r * 1.9}`,
      }));
    }
    svg.appendChild(g);
  }

  function lockTarget(id) {
    if (!source || !isControllable()) return;
    send(source.postTarget(id));
  }

  // ---------------------------------------------------------------- target panel
  function renderTarget(status) {
    const t = status.target;
    const has = !!t;
    const mode = status.mode;
    $("#target-name").hidden = !has;
    $("#target-empty").hidden = has;
    $("#target-stats").hidden = !has;
    $("#target-chip").hidden = !has;
    const btn = $("#lock-btn");
    btn.classList.remove("is-primary");

    if (!has) {
      const [title, detail] = estopOn()
        ? ["Not tracking", "The e-stop is on."]
        : mode === "stop"
          ? ["Not tracking", "COOP is in Stop. Pick Auto to track, or Manual to aim by hand."]
          : noCamera()
            ? ["No target", "Nothing to track without a camera feed."]
            : (status.detections || []).length
              ? ["No target", "Click a box in the feed to lock onto it."]
              : ["No target", "Nobody in view. COOP picks up the next person or car that walks in."];
      $("#target-empty-title").textContent = title;
      $("#target-empty-detail").textContent = detail;
      btn.disabled = true;
      btn.textContent = "Lock target";
      btn.onclick = null;
      return;
    }

    $("#target-name").replaceChildren(document.createTextNode(t.label), el("span", { class: "id" }, `#${t.id}`));
    const meter = $("#conf-meter");
    meter.replaceChildren();
    const on = Math.round(clamp(t.conf, 0, 1) * 8);
    for (let i = 0; i < 8; i++) meter.appendChild(el("i", i < on ? { class: "on" } : {}));
    $("#conf-num").textContent = t.conf.toFixed(2);
    const [vp] = status.velocity_deg_s || [0, 0];
    $("#vel-num").textContent = `${fmtSigned(vp)}°/s`;

    // Lead = how far the aim sits ahead of the target's current world angle.
    const g = status.gimbal;
    const leadRow = $("#lead-row");
    if (g && status.frame && mode === "auto") {
      const off = pixelOffsetDeg(boxCenter(t.box).x, boxCenter(t.box).y, status.frame);
      leadRow.hidden = false;
      $("#lead-num").textContent = `${fmtSigned(g.target_pan - (g.pan + off.pan))}°`;
    } else {
      leadRow.hidden = true;
    }

    const chip = $("#target-chip");
    chip.textContent = t.locked ? "Locked" : mode === "auto" ? "Auto" : "In view";
    chip.className = `chip mono ${t.locked ? "is-lock" : "is-on"}`;
    btn.disabled = !isControllable() || estopOn();
    if (t.locked) {
      btn.textContent = "Clear lock";
      btn.onclick = () => lockTarget(null);
    } else {
      btn.textContent = "Lock target";
      btn.classList.add("is-primary");
      btn.onclick = () => lockTarget(t.id);
    }
  }

  // ---------------------------------------------------------------- pan gauge
  const G = { cx: 150, cy: 132, r: 104, span: 120 };
  let panLimits = [-170, 170];
  const toArc = (deg) => {
    const [lo, hi] = panLimits;
    const lim = Math.max(Math.abs(lo), Math.abs(hi)) || 170;
    return (clamp(deg, lo, hi) / lim) * G.span;
  };
  const fromArc = (a) => {
    const [lo, hi] = panLimits;
    const lim = Math.max(Math.abs(lo), Math.abs(hi)) || 170;
    return clamp((a / G.span) * lim, lo, hi);
  };
  function polar(a, r) {
    return [G.cx + r * Math.sin(a * DEG), G.cy - r * Math.cos(a * DEG)];
  }
  function arcPath(a0, a1, r) {
    const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 >= a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  let gaugeBuiltFor = "";
  function buildGauge() {
    const key = panLimits.join(",");
    if (key === gaugeBuiltFor) return;
    gaugeBuiltFor = key;
    $("#g-track").setAttribute("d", arcPath(-G.span, G.span, G.r));
    $("#g-hit").setAttribute("d", arcPath(-G.span, G.span, G.r));
    const ticks = $("#g-ticks");
    ticks.replaceChildren();
    const [lo, hi] = panLimits;
    const first = Math.ceil(lo / 10) * 10;
    for (let d = first; d <= hi; d += 10) {
      const major = d % 90 === 0;
      const a = toArc(d);
      const [x0, y0] = polar(a, G.r + 5), [x1, y1] = polar(a, G.r + (major ? 14 : 9));
      ticks.appendChild(svgEl("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? "major" : "" }));
      if (major) {
        const [tx, ty] = polar(a, G.r + 25);
        const t = svgEl("text", { x: tx.toFixed(1), y: (ty + 3).toFixed(1) });
        t.textContent = d === 0 ? "0" : `${fmtSigned(d, 0)}`;
        ticks.appendChild(t);
      }
    }
    for (const d of [lo, hi]) {
      const a = toArc(d);
      const [x0, y0] = polar(a, G.r - 6), [x1, y1] = polar(a, G.r + 16);
      ticks.appendChild(svgEl("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "limit" }));
      const [tx, ty] = polar(a, G.r + 28);
      const t = svgEl("text", { x: tx.toFixed(1), y: (ty + 3).toFixed(1) });
      t.textContent = fmtSigned(d, 0);
      ticks.appendChild(t);
    }
    $("#limits-num").textContent = lo === -hi ? `Limits ±${hi}°` : `Limits ${lo}° / ${fmtSigned(hi, 0)}°`;
  }

  function renderGauge(status) {
    const g = status.gimbal;
    buildGauge();
    if (!g) {
      $("#pan-num").textContent = "–";
      $("#aim-num").textContent = "–";
      $("#g-sweep").setAttribute("d", "");
      $("#g-aim").setAttribute("d", "");
      const chip = $("#motors-chip");
      chip.className = serialState() === "reconnecting" ? "chip mono is-alert" : "chip mono";
      chip.textContent = serialState() === "reconnecting" ? "Arduino reconnecting" : serialState() === "mock" ? "Motors · mock" : "Motors";
      return;
    }
    if (Array.isArray(g.pan_limits) && g.pan_limits.length === 2) panLimits = g.pan_limits;
    buildGauge();
    const a = toArc(g.pan);
    const aim = toArc(num(g.target_pan) ? g.target_pan : g.pan);
    const [nx0, ny0] = polar(a, G.r - 40), [nx1, ny1] = polar(a, G.r - 6);
    const n = $("#g-needle");
    n.setAttribute("x1", nx0.toFixed(2)); n.setAttribute("y1", ny0.toFixed(2));
    n.setAttribute("x2", nx1.toFixed(2)); n.setAttribute("y2", ny1.toFixed(2));
    $("#g-sweep").setAttribute("d", Math.abs(a) < 0.2 ? "" : arcPath(Math.min(0, a), Math.max(0, a), G.r));
    $("#g-aim").setAttribute("d", arcPath(aim - 1.6, aim + 1.6, G.r));
    $("#pan-num").textContent = `${fmtSigned(g.pan)}°`;
    $("#aim-num").textContent = `${fmtSigned(num(g.target_pan) ? g.target_pan : g.pan)}°`;

    const chip = $("#motors-chip");
    chip.className = "chip mono";
    let text;
    if (serialState() === "reconnecting" || motorsDisconnected) { chip.classList.add("is-alert"); text = "Arduino reconnecting"; }
    else if (g.drivers_enabled === false) { text = "Drivers off"; }
    else if (g.mock) { chip.classList.add("is-mock"); text = "Motors · mock"; }
    else { chip.classList.add("is-on"); text = "Motors live"; }
    chip.textContent = text;
  }

  // click or drag on the dial to aim (manual mode)
  let lastAimAt = 0, aiming = false;
  function aimFromPointer(e) {
    const svg = $("#gauge-svg");
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 300 - G.cx;
    const y = ((e.clientY - r.top) / r.height) * 200 - G.cy;
    const a = Math.atan2(x, -y) / DEG;
    if (Math.abs(a) > G.span + 8) return;
    const now = performance.now();
    if (now - lastAimAt < NUDGE_MIN_INTERVAL_MS) return;
    lastAimAt = now;
    send(source.postAim(Math.round(fromArc(clamp(a, -G.span, G.span)) * 10) / 10));
  }
  function wireGauge() {
    const hit = $("#g-hit");
    hit.addEventListener("pointerdown", (e) => {
      if (currentMode() !== "manual" || !isControllable() || estopOn()) return;
      aiming = true;
      hit.setPointerCapture(e.pointerId);
      lastAimAt = 0;
      aimFromPointer(e);
    });
    hit.addEventListener("pointermove", (e) => { if (aiming) aimFromPointer(e); });
    const end = () => { aiming = false; };
    hit.addEventListener("pointerup", end);
    hit.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------- detections list
  function renderDetections(status) {
    const list = $("#det-list");
    const dets = noCamera() ? [] : status.detections || [];
    $("#det-count").textContent = String(dets.length);
    list.replaceChildren();
    if (!dets.length) {
      list.appendChild(el("div", { class: "det-empty" }, noCamera() ? "No feed." : "Nothing in view."));
      return;
    }
    const lockedId = status.target && status.target.locked ? status.target.id : null;
    const autoId = status.target ? status.target.id : null;
    for (const d of dets) {
      const cls = d.id === lockedId ? " is-locked" : d.id === autoId ? " is-auto" : "";
      const row = el("button", { type: "button", class: `det-row${cls}`, "aria-label": `Lock ${d.label} #${d.id}` });
      const name = el("span", { class: "name" }, d.label);
      name.appendChild(el("span", { class: "id" }, `#${d.id}`));
      row.append(el("span", { class: "sw" }), name, el("span", { class: "conf" }, d.conf.toFixed(2)));
      row.disabled = !isControllable() || estopOn();
      row.addEventListener("click", () => lockTarget(d.id));
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- event log
  const EVENT_TEXT = {
    target_acquired: (e) => `Acquired ${e.label || ""} #${e.id}`,
    target_lost: (e) => `Lost target #${e.id}`,
    mode_changed: (e) => `Mode: ${e.mode}`,
    motor_connected: () => "Arduino connected",
    motor_disconnected: () => "Arduino disconnected",
    estop: () => "E-stop engaged",
    armed: () => "Armed",
    zeroed: () => "Zero set here",
    motors_idle: (e) => `Drivers powered down${num(e.after_s) ? ` after ${Math.round(e.after_s)} s in Stop` : ""}`,
    settings_changed: (e) => {
      const keys = Object.keys(e.changed || {});
      return `Settings ${e.saved ? "saved" : "changed"}${keys.length ? `: ${keys.join(", ")}` : ""}`;
    },
  };
  const ALERT = new Set(["estop", "motor_disconnected", "target_lost"]);
  const QUIET = new Set(["mode_changed", "settings_changed", "motors_idle"]);

  function appendEvents(events) {
    const list = $("#log");
    for (const e of events) {
      if (e.type === "motor_connected") motorsDisconnected = false;
      if (e.type === "motor_disconnected") motorsDisconnected = true;
      const li = el("li", { class: ALERT.has(e.type) ? "is-alert" : QUIET.has(e.type) ? "is-quiet" : "" });
      li.append(el("span", { class: "msg" }, (EVENT_TEXT[e.type] || (() => e.type))(e)), el("span", { class: "t", "data-t": e.t }, timeAgo(e.t)));
      list.insertBefore(li, list.firstChild);
    }
    while (list.children.length > 60) list.removeChild(list.lastChild);
  }
  function refreshEventTimes() {
    $$("#log .t").forEach((n) => { n.textContent = timeAgo(parseFloat(n.dataset.t)); });
  }

  // ---------------------------------------------------------------- diagnostics strip
  const THROTTLE_BITS = [
    [0x1, "under-voltage now"], [0x2, "frequency capped now"], [0x4, "throttled now"], [0x8, "soft temperature limit now"],
    [0x10000, "under-voltage since boot"], [0x20000, "frequency capped since boot"], [0x40000, "throttled since boot"], [0x80000, "soft temperature limit since boot"],
  ];
  function setDiag(k, text, { warn = false, na = false, title = "" } = {}) {
    const box = $(`#diag [data-k="${k}"]`);
    box.classList.toggle("is-warn", warn);
    box.classList.toggle("is-na", na);
    box.title = title;
    box.querySelector("dd").textContent = text;
  }
  function renderDiag(status) {
    const d = (status && status.diag) || {};
    const na = (k) => setDiag(k, "–", { na: true, title: "Not reported" });
    if (num(d.cpu_temp_c)) setDiag("cpu", `${d.cpu_temp_c.toFixed(1)} °C`, { warn: d.cpu_temp_c >= 80, title: d.cpu_temp_c >= 80 ? "Hot: the Pi 5 throttles at 80–85 °C" : "" });
    else na("cpu");
    if (num(d.throttled)) {
      const flags = THROTTLE_BITS.filter(([b]) => d.throttled & b).map(([, t]) => t);
      setDiag("throttled", d.throttled === 0 ? "OK" : `0x${d.throttled.toString(16)}`, { warn: d.throttled !== 0, title: flags.length ? flags.join(", ") : "No throttling or under-voltage" });
    } else na("throttled");
    if (num(d.fps)) setDiag("fps", `${d.fps.toFixed(1)} fps`); else na("fps");
    if (num(d.capture_fps)) setDiag("capture", `${d.capture_fps.toFixed(1)} fps`, { title: num(d.fps) && d.capture_fps > d.fps * 1.5 ? "Inference is the bottleneck; stale frames are dropped" : "" });
    else na("capture");
    if (num(d.infer_ms)) setDiag("infer", `${Math.round(d.infer_ms)} ms`); else na("infer");
    if (num(d.latency_ms)) setDiag("latency", `${Math.round(d.latency_ms)} ms`, { title: "Camera to motor command" }); else na("latency");
    if (d.serial) setDiag("serial", d.serial, { warn: d.serial === "reconnecting", title: d.serial === "mock" ? "Motors disabled (--no-motors): simulated" : "" });
    else na("serial");
    if (num(d.uptime_s)) setDiag("uptime", fmtUptime(d.uptime_s), { title: "Since COOP started" }); else na("uptime");
  }

  // ---------------------------------------------------------------- tuning
  let settingsMeta = null;
  const TUNE_FMT = {
    lead_time_s: (v) => `${Math.round(v * 1000)} ms`,
    deadband_deg: (v) => `${v.toFixed(1)}°`,
    conf: (v) => v.toFixed(2),
    max_steps_per_sec: (v) => `${Math.round(v / (settingsMeta ? settingsMeta.steps_per_deg : 1))}°/s`,
    accel_steps_per_sec2: (v) => `${Math.round(v / (settingsMeta ? settingsMeta.steps_per_deg : 1))}°/s²`,
  };
  function tuneMsg(text, error) {
    const m = $("#tuning-msg");
    m.textContent = text;
    m.classList.toggle("is-error", !!error);
  }
  function fillTuning(meta) {
    settingsMeta = meta;
    const form = $("#tuning-form");
    for (const [k, v] of Object.entries(meta.settings)) {
      const input = form.elements[k];
      if (!input) continue;
      if (input.type === "checkbox") { input.checked = !!v; continue; }
      const range = meta.ranges && meta.ranges[k];
      if (range) { input.min = range[0]; input.max = range[1]; }
      input.value = v;
      const out = input.parentElement.querySelector("output");
      if (out) out.textContent = TUNE_FMT[k] ? TUNE_FMT[k](Number(v)) : String(v);
    }
    $("#tuning-state").textContent = meta.file ? `File: ${meta.file.split("/").pop()}` : "Live settings";
  }
  async function loadTuning() {
    if (!source || !source.getSettings) return;
    try {
      fillTuning(await source.getSettings());
      tuneMsg("");
    } catch (e) {
      tuneMsg("This COOP build has no live settings yet.", true);
    }
  }
  function changedSettings() {
    const form = $("#tuning-form");
    const out = {};
    if (!settingsMeta) return out;
    for (const [k, v] of Object.entries(settingsMeta.settings)) {
      const input = form.elements[k];
      if (!input) continue;
      const nv = input.type === "checkbox" ? input.checked : Number(input.value);
      if (nv !== v) out[k] = nv;
    }
    return out;
  }
  async function applyTuning(save) {
    const body = changedSettings();
    if (!Object.keys(body).length && !save) { tuneMsg("Nothing changed."); return; }
    if (save) body.save = true;
    const r = await send(source.postSettings(body));
    if (r && r.ok) {
      settingsMeta.settings = r.settings;
      fillTuning(settingsMeta);
      tuneMsg(r.saved ? "Applied and saved to the settings file." : "Applied. Not saved: it resets when COOP restarts.");
    } else if (r) {
      tuneMsg(friendly(r.error), true);
    }
  }
  function renderTuningLock() {
    const inv = $("#tuning-form").elements.pan_invert;
    if (inv) inv.disabled = currentMode() !== "stop";
  }
  function wireTuning() {
    const details = $("#tuning");
    details.addEventListener("toggle", () => { if (details.open) loadTuning(); });
    $("#tuning-form").addEventListener("input", (e) => {
      const input = e.target;
      const out = input.parentElement && input.parentElement.querySelector("output");
      if (out && TUNE_FMT[input.name]) out.textContent = TUNE_FMT[input.name](Number(input.value));
    });
    $("#tuning-apply").addEventListener("click", () => applyTuning(false));
    $("#tuning-save").addEventListener("click", () => applyTuning(true));
  }

  // ---------------------------------------------------------------- feed
  const VIDEO_RETRY_MS = 2000;
  let videoRetryTimer = null;
  function restartVideo() {
    // Browsers don't reconnect a dropped MJPEG stream on their own.
    if (!usingMock) $("#feed-img").src = `/video?t=${Date.now()}`;
  }
  function wireFeed() {
    const img = $("#feed-img");
    img.hidden = usingMock;
    $("#feed-mock").hidden = !usingMock;
    img.addEventListener("error", () => {
      if (usingMock) return;
      img.style.visibility = "hidden"; // no broken-image icon behind the state panel
      videoBroken = true;
      clearTimeout(videoRetryTimer);
      videoRetryTimer = setTimeout(restartVideo, VIDEO_RETRY_MS);
    });
    img.addEventListener("load", () => {
      img.style.visibility = "";
      videoBroken = false;
    });
    if (!usingMock) restartVideo();
  }

  let feedTok = null;
  function drawMockFeed() {
    const canvas = $("#feed-mock");
    if (canvas.hidden || !lastStatus || !lastStatus.frame || noCamera()) {
      if (!canvas.hidden) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (!feedTok) {
      const css = getComputedStyle(document.documentElement);
      const v = (n) => css.getPropertyValue(n).trim();
      feedTok = { grid: v("--feed-grid"), strong: v("--feed-grid-strong"), label: v("--feed-grid-label"), mono: v("--font-mono") };
    }
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // A world-fixed bearing grid that slides as the simulated gimbal pans. Letterboxed
    // exactly like the <img> (object-fit: contain).
    const { frame, gimbal } = lastStatus;
    const s = Math.min(cw / frame.w, ch / frame.h);
    const ox = (cw - frame.w * s) / 2, oy = (ch - frame.h * s) / 2;
    const g = gimbal || { pan: 0 };
    ctx.lineWidth = 1;
    ctx.font = `10px ${feedTok.mono}`;
    const first = Math.ceil((g.pan - 60) / 10) * 10;
    for (let a = first; a <= g.pan + 60; a += 10) {
      const x = projectX(a, g, frame);
      if (x == null || x < 0 || x > frame.w) continue;
      ctx.strokeStyle = a === 0 ? feedTok.strong : feedTok.grid;
      ctx.beginPath();
      ctx.moveTo(ox + x * s, oy);
      ctx.lineTo(ox + x * s, oy + frame.h * s);
      ctx.stroke();
      ctx.fillStyle = feedTok.label;
      ctx.fillText(`${a}°`, ox + x * s + 3, oy + frame.h * s - 8);
    }
    ctx.strokeStyle = feedTok.grid;
    ctx.beginPath();
    ctx.moveTo(ox, oy + frame.h * s * 0.5);
    ctx.lineTo(ox + frame.w * s, oy + frame.h * s * 0.5);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- fullscreen
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function toggleFullscreen() {
    const feed = $("#feed");
    if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (feed.classList.contains("pseudo-fs")) { setPseudoFullscreen(false); return; }
    const req = feed.requestFullscreen || feed.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(feed)).then(syncFullscreenButton, () => setPseudoFullscreen(true));
    else setPseudoFullscreen(true); // iPhone Safari has no element fullscreen; fill the viewport instead
  }
  function setPseudoFullscreen(on) {
    $("#feed").classList.toggle("pseudo-fs", on);
    document.body.classList.toggle("no-scroll", on);
    syncFullscreenButton();
  }
  function syncFullscreenButton() {
    const on = !!fsElement() || $("#feed").classList.contains("pseudo-fs");
    const btn = $("#fs-btn");
    btn.setAttribute("aria-label", on ? "Exit fullscreen (F)" : "Fullscreen (F)");
    btn.title = btn.getAttribute("aria-label");
    $("#fs-enter").hidden = on;
    $("#fs-exit").hidden = !on;
    if (lastStatus) renderOverlay(lastStatus);
  }

  // ---------------------------------------------------------------- controls
  function setMode(mode) {
    if (!source || !isControllable() || mode === currentMode()) return;
    if (estopOn() && mode !== "stop") { toast("The e-stop is on. Arm first."); return; }
    optimisticMode = mode;
    renderBar(lastStatus);
    send(source.postMode(mode)).then((r) => { if (!r || r.ok === false) optimisticMode = null; });
  }
  let lastNudgeAt = 0;
  function nudge(dpan, btn) {
    if (!source || !isControllable() || currentMode() !== "manual" || estopOn()) return;
    if (btn) { btn.classList.add("pressed"); setTimeout(() => btn.classList.remove("pressed"), 120); }
    const now = performance.now();
    if (now - lastNudgeAt < NUDGE_MIN_INTERVAL_MS) return;
    lastNudgeAt = now;
    send(source.postNudge(dpan));
  }
  function home() {
    if (!source || !isControllable()) return;
    if (estopOn()) { toast("The e-stop is on. Arm first."); return; }
    const btn = $("#home-btn");
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
    optimisticMode = "manual";
    send(source.postHome()).then((r) => { if (!r || r.ok === false) optimisticMode = null; });
  }
  function estop() {
    if (!source) return;
    // Fire first, render after: nothing may delay this request.
    const p = send(source.postEstop());
    optimisticMode = "stop";
    renderBar(lastStatus);
    p.then(() => statusTick());
  }
  let zeroArmedAt = 0;
  function zero() {
    if (!source || !isControllable()) return;
    const btn = $("#zero-btn");
    const now = Date.now();
    if (now - zeroArmedAt > ZERO_CONFIRM_MS) {
      // two-step: a stray click must not move the reference
      zeroArmedAt = now;
      btn.classList.add("is-confirm");
      btn.textContent = "Confirm zero";
      setTimeout(() => {
        if (Date.now() - zeroArmedAt >= ZERO_CONFIRM_MS) { btn.classList.remove("is-confirm"); btn.textContent = "Zero here"; }
      }, ZERO_CONFIRM_MS + 50);
      return;
    }
    zeroArmedAt = 0;
    btn.classList.remove("is-confirm");
    btn.textContent = "Zero here";
    send(source.postZero()).then((r) => { if (r && r.ok) toast("This position is now pan 0."); });
  }

  function wireControls() {
    $$(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("#nudge-left").addEventListener("click", (e) => nudge(-(e.shiftKey ? NUDGE_FINE_DEG : NUDGE_DEG), e.currentTarget));
    $("#nudge-right").addEventListener("click", (e) => nudge(e.shiftKey ? NUDGE_FINE_DEG : NUDGE_DEG, e.currentTarget));
    $("#home-btn").addEventListener("click", home);
    $("#estop-btn").addEventListener("click", estop);
    $("#zero-btn").addEventListener("click", zero);
    $("#fs-btn").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
    wireGauge();
    wireTuning();

    const KEY_MODES = { "1": "auto", "2": "manual", "3": "stop" };
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
      if ((e.key === "x" || e.key === "X") && !e.repeat) { estop(); return; }
      if (KEY_MODES[e.key] && !e.repeat) setMode(KEY_MODES[e.key]);
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && currentMode() === "manual") {
        e.preventDefault(); // don't scroll the page while driving
        const step = e.shiftKey ? NUDGE_FINE_DEG : NUDGE_DEG;
        nudge(e.key === "ArrowLeft" ? -step : step, $(e.key === "ArrowLeft" ? "#nudge-left" : "#nudge-right"));
      } else if ((e.key === "h" || e.key === "H" || e.key === "Home") && !e.repeat) home();
      else if ((e.key === "f" || e.key === "F") && !e.repeat) toggleFullscreen();
      else if (e.key === "Escape" && $("#feed").classList.contains("pseudo-fs")) setPseudoFullscreen(false);
    });
  }

  // ---------------------------------------------------------------- main loop
  function render() {
    renderBar(lastStatus);
    renderBanner();
    renderFeedState();
    renderDiag(lastStatus);
    renderTuningLock();
    if (!lastStatus) return;
    renderOverlay(lastStatus);
    renderTarget(lastStatus);
    renderGauge(lastStatus);
    renderDetections(lastStatus);
  }

  async function statusTick() {
    if (!source) return;
    const wasDown = conn === "offline" || conn === "expired";
    try {
      const status = await source.getStatus();
      const now = Date.now();
      failStreak = 0;
      lastGoodAt = now;
      if (!connectedAt) connectedAt = now;
      if (hasFrame(status)) lastFrameAt = now;
      if (num(status.server_time)) {
        const skew = status.server_time - now / 1000;
        clockSkew = conn === "connecting" ? skew : 0.8 * clockSkew + 0.2 * skew;
      }
      if (status.frame_seq !== lastFrameSeq) {
        lastFrameSeq = status.frame_seq;
        lastFrameSeqChangeAt = now;
      }
      const stale = status.frame_seq != null && now - lastFrameSeqChangeAt > STALE_AFTER_MS;
      conn = stale ? "stale" : "live";
      lastStatus = status;
      if (wasDown) restartVideo();
    } catch (e) {
      failStreak += 1;
      if (e.kind === "expired") conn = "expired";
      else if (failStreak >= OFFLINE_AFTER_FAILS) conn = "offline";
    }
    render();
  }

  async function eventsTick() {
    if (!source || conn === "offline" || conn === "expired") return;
    try {
      const { events } = await source.getEvents(lastEventSeq);
      if (events && events.length) {
        lastEventSeq = events[events.length - 1].seq;
        appendEvents(events);
      }
    } catch (e) { /* the status poll owns connection state */ }
    refreshEventTimes();
  }

  async function boot() {
    await chooseSource();
    $("#source-note").textContent = usingMock
      ? (window.COOP_DEMO ? `Demo state: ${window.COOP_DEMO} (mock data)` : "No backend found: showing mock data")
      : "COOP · Pi 5 tracking camera";
    wireFeed();
    wireControls();
    buildGauge();
    syncFullscreenButton();
    statusTick();
    eventsTick();
    setInterval(statusTick, POLL_MS);
    setInterval(eventsTick, EVENTS_MS);
    // Background tabs throttle timers to ~1 Hz; refresh at once when the viewer comes back.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { statusTick(); eventsTick(); } });
    if (usingMock) setInterval(drawMockFeed, 50);
  }

  boot();
})();
