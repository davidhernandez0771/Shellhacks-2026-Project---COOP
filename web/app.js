// COOP dashboard. Talks to the real API (docs/API.md) and falls back to the client-side
// mock (mock.js) when no backend answers at startup.
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
  const DEFAULT_FOV = { h: 63.0, v: 49.0 };
  const TRAIL_LEN = 12;              // ~3.6 s of aim history at 300 ms polls
  const ARROW_HORIZON_S = 0.6;       // arrow = where the target will be this far ahead
  const NUDGE_DEG = 5;
  const NUDGE_FINE_DEG = 1;
  const NUDGE_MIN_INTERVAL_MS = 90;  // key auto-repeat must not flood the Pi

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------------------------------------------------------------- sources
  class SourceError extends Error {
    constructor(kind, msg) { super(msg || kind); this.kind = kind; }
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
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
    postMode(mode) { return postJSON("/api/mode", { mode }); }
    postTarget(id) { return postJSON("/api/target", { id }); }
    postAim(pan, tilt) { return postJSON("/api/aim", { pan, tilt }); }
    postNudge(dpan, dtilt) { return postJSON("/api/nudge", { dpan, dtilt }); }
    postHome() { return postJSON("/api/home", {}); }
  }

  let source = null;
  let usingMock = false;

  async function chooseSource() {
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
    $("#mock-badge").hidden = !usingMock;
  }

  // ---------------------------------------------------------------- state
  let lastStatus = null;
  let conn = "connecting";          // connecting | live | stale | offline | expired
  let failStreak = 0;
  let lastGoodAt = 0;               // client ms of last successful poll
  let lastFrameSeq = null;
  let lastFrameSeqChangeAt = 0;
  let clockSkew = 0;                // server_time - client time, seconds
  let optimisticMode = null;
  let lastEventSeq = 0;
  let motorsDisconnected = false;
  let trail = [];                   // [{pan, tilt}] predicted aim history, world angles
  let trailKey = null;              // target id + mode the trail belongs to

  const currentMode = () => optimisticMode || (lastStatus && lastStatus.mode) || "auto";
  const isControllable = () => conn === "live" || conn === "stale" || conn === "connecting";

  // ---------------------------------------------------------------- geometry
  function fovOf(frame) {
    return {
      h: (frame && frame.hfov_deg) || DEFAULT_FOV.h,
      v: (frame && frame.vfov_deg) || DEFAULT_FOV.v,
    };
  }

  // World angle -> frame pixel, same pinhole model as coop/main.py.
  function project(pan, tilt, gimbal, frame) {
    const fov = fovOf(frame);
    const dp = pan - (gimbal.pan || 0);
    const dt = tilt - (gimbal.tilt || 0);
    if (Math.abs(dp) > 80 || Math.abs(dt) > 80) return null;
    return {
      x: frame.w / 2 + (frame.w / 2) * Math.tan(dp * DEG) / Math.tan((fov.h / 2) * DEG),
      y: frame.h / 2 - (frame.h / 2) * Math.tan(dt * DEG) / Math.tan((fov.v / 2) * DEG),
    };
  }

  // Frame pixel -> angular offset from the optical axis (degrees).
  function pixelOffsetDeg(x, y, frame) {
    const fov = fovOf(frame);
    const nx = (x - frame.w / 2) / (frame.w / 2);
    const ny = (frame.h / 2 - y) / (frame.h / 2);
    return {
      pan: Math.atan(nx * Math.tan((fov.h / 2) * DEG)) / DEG,
      tilt: Math.atan(ny * Math.tan((fov.v / 2) * DEG)) / DEG,
    };
  }

  // Local pixels-per-degree at a given angular offset (d/dθ of the tan projection).
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

  function buildDotMeter(container, ratio, total) {
    total = total || 8;
    const filled = Math.round(clamp(ratio, 0, 1) * total);
    container.replaceChildren();
    for (let i = 0; i < total; i++) container.appendChild(el("span", i < filled ? { class: "filled" } : {}));
  }

  function timeAgo(serverT) {
    const s = Math.max(0, Date.now() / 1000 + clockSkew - serverT);
    if (s < 1) return "now";
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  const fmtSigned = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

  // ---------------------------------------------------------------- topbar + banner
  const PILL = {
    connecting: ["", "CONNECTING"],
    stale: ["state-stale", "STALE"],
    offline: ["state-offline", "OFFLINE"],
    expired: ["state-offline", "SIGNED OUT"],
  };

  function renderTopbar(status) {
    const pill = $("#live-pill");
    pill.classList.remove("state-live", "state-stale", "state-offline", "live-pulse");
    let label;
    if (conn === "live") {
      pill.classList.add("state-live", "live-pulse");
      label = `LIVE · ${status && status.fps != null ? status.fps.toFixed(1) : "–"} fps`;
    } else {
      const [cls, text] = PILL[conn];
      if (cls) pill.classList.add(cls);
      label = text;
    }
    pill.querySelector(".label").textContent = label;

    if (status && optimisticMode === status.mode) optimisticMode = null;
    const mode = currentMode();
    $$(".mode-switch button").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on);
    });
    $("#dpad-wrap").hidden = mode !== "manual";

    const tiltOn = !!(status && status.gimbal && status.gimbal.tilt_enabled);
    $("#dpad-up").disabled = !tiltOn;
    $("#dpad-down").disabled = !tiltOn;
  }

  function renderBanner() {
    const banner = $("#conn-banner");
    document.body.classList.toggle("is-disconnected", conn === "offline" || conn === "expired");
    $("#hero-frame").classList.toggle("is-stale", conn !== "live" && conn !== "connecting");

    if (conn === "live" || conn === "connecting") {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = `conn-banner ${conn === "stale" ? "warm" : "danger"}`;
    banner.setAttribute("role", conn === "expired" ? "alert" : "status");
    const since = lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null;
    const frozen = Math.round((Date.now() - lastFrameSeqChangeAt) / 1000);
    const copy = {
      offline: ["Connection lost", `Retrying every ${POLL_MS} ms${since != null ? ` · last update ${since}s ago` : ""}. Controls are paused.`],
      expired: ["Session expired", "Your Cloudflare Access sign-in ran out. Reload to sign in again."],
      stale: ["Camera loop stalled", `The server answers, but no new frame for ${frozen}s. Tracking is frozen.`],
    }[conn];
    $("#conn-title").textContent = copy[0];
    $("#conn-detail").textContent = copy[1];
    $("#conn-action").hidden = conn !== "expired";
  }

  // ---------------------------------------------------------------- overlay
  function renderOverlay(status) {
    const svg = $("#overlay-svg");
    const frame = status.frame;
    svg.replaceChildren();
    if (!frame) return;
    svg.setAttribute("viewBox", `0 0 ${frame.w} ${frame.h}`);

    // viewBox units per CSS pixel, so text and markers keep a constant on-screen size
    // from a phone to fullscreen (strokes use vector-effect instead).
    const k = Math.max(frame.w / (svg.clientWidth || frame.w), frame.h / (svg.clientHeight || frame.h));
    svg.style.setProperty("--k", k);

    const target = status.target;
    const lockedId = target && target.locked ? target.id : null;
    const autoId = target ? target.id : null;
    const interactive = isControllable();

    const boxes = svgEl("g", { class: "boxes" });
    // Largest first, so a smaller box inside an overlapping bigger one is on top and wins
    // the click (SVG hit-testing picks the topmost element).
    const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    const ordered = (status.detections || []).slice().sort((a, b) => area(b.box) - area(a.box));
    for (const d of ordered) {
      const [x1, y1, x2, y2] = d.box;
      const isLocked = d.id === lockedId;
      const isAuto = !isLocked && d.id === autoId;

      if (isLocked) {
        const len = Math.max(10 * k, Math.min(x2 - x1, y2 - y1) * 0.22);
        boxes.appendChild(svgEl("path", {
          class: "reticle",
          d: [
            `M ${x1} ${y1 + len} L ${x1} ${y1} L ${x1 + len} ${y1}`,
            `M ${x2 - len} ${y1} L ${x2} ${y1} L ${x2} ${y1 + len}`,
            `M ${x1} ${y2 - len} L ${x1} ${y2} L ${x1 + len} ${y2}`,
            `M ${x2 - len} ${y2} L ${x2} ${y2} L ${x2} ${y2 - len}`,
          ].join(" "),
        }));
      }
      const rect = svgEl("rect", {
        x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 6 * k,
        class: `box ${isLocked ? "hit" : isAuto ? "auto" : "det"}`,
      });
      if (interactive) rect.addEventListener("click", () => lockTarget(d.id));
      const title = svgEl("title");
      title.textContent = isLocked ? `${d.label} #${d.id} (locked)` : `Lock ${d.label} #${d.id}`;
      rect.appendChild(title);
      boxes.appendChild(rect);

      const label = svgEl("text", {
        x: x1, y: Math.max(14 * k, y1 - 6 * k),
        class: `box-label${isLocked ? " locked" : ""}`,
      });
      label.textContent = `${d.label} #${d.id}`;
      boxes.appendChild(label);
    }
    svg.appendChild(boxes);

    renderPrediction(svg, status, k);
  }

  function renderPrediction(svg, status, k) {
    const { target, gimbal, frame } = status;
    const mode = status.mode;
    const key = target && mode === "auto" ? `${target.id}` : null;
    if (key !== trailKey) { trail = []; trailKey = key; }
    $("#legend").hidden = !key;
    if (!key || !gimbal) return;

    const aimWorld = { pan: gimbal.target_pan, tilt: gimbal.tilt_enabled ? gimbal.target_tilt : gimbal.tilt };
    trail.push(aimWorld);
    if (trail.length > TRAIL_LEN) trail.shift();

    const g = svgEl("g", { class: "prediction" });
    const c = boxCenter(target.box);
    const fov = fovOf(frame);

    // Velocity arrow: world angular velocity converted with the local px-per-degree at the
    // target's position, so it shows where the target itself is heading.
    const [vp, vt] = status.velocity_deg_s || [0, 0];
    if (Math.hypot(vp, vt) >= 1) {
      const off = pixelOffsetDeg(c.x, c.y, frame);
      let dx = vp * pxPerDeg(off.pan, frame.w / 2, fov.h / 2) * ARROW_HORIZON_S;
      let dy = -vt * pxPerDeg(off.tilt, frame.h / 2, fov.v / 2) * ARROW_HORIZON_S;
      const maxLen = frame.w * 0.4;
      const len = Math.hypot(dx, dy);
      if (len > maxLen) { dx *= maxLen / len; dy *= maxLen / len; }
      if (len > 6 * k) {
        const defs = svgEl("defs");
        const marker = svgEl("marker", {
          id: "arrowhead", viewBox: "0 0 10 10", refX: 7, refY: 5,
          markerWidth: 11 * k, markerHeight: 11 * k, markerUnits: "userSpaceOnUse",
          orient: "auto-start-reverse",
        });
        marker.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "arrowhead" }));
        defs.appendChild(marker);
        g.appendChild(defs);
        g.appendChild(svgEl("line", {
          x1: c.x, y1: c.y, x2: c.x + dx, y2: c.y + dy,
          class: "velocity", "marker-end": "url(#arrowhead)",
        }));
      }
    }

    // Fading trail of past predicted aim points, re-projected against the current gimbal
    // angle so it stays put in the world while the camera turns.
    trail.forEach((p, i) => {
      if (i === trail.length - 1) return;
      const px = project(p.pan, p.tilt, gimbal, frame);
      if (!px || px.x < 0 || px.x > frame.w || px.y < 0 || px.y > frame.h) return;
      const age = (i + 1) / trail.length;
      g.appendChild(svgEl("circle", {
        cx: px.x, cy: px.y, r: (1.5 + 2 * age) * k,
        class: "trail", "fill-opacity": (0.1 + 0.6 * age).toFixed(2),
      }));
    });

    const aim = project(aimWorld.pan, aimWorld.tilt, gimbal, frame);
    if (aim) {
      g.appendChild(svgEl("line", { x1: c.x, y1: c.y, x2: aim.x, y2: aim.y, class: "lead-line" }));
      const r = 7 * k;
      g.appendChild(svgEl("circle", { cx: aim.x, cy: aim.y, r, class: "aim-ring" }));
      g.appendChild(svgEl("path", {
        class: "aim-ticks",
        d: `M ${aim.x - r * 1.8} ${aim.y} L ${aim.x - r * 1.1} ${aim.y} M ${aim.x + r * 1.1} ${aim.y} L ${aim.x + r * 1.8} ${aim.y}` +
           ` M ${aim.x} ${aim.y - r * 1.8} L ${aim.x} ${aim.y - r * 1.1} M ${aim.x} ${aim.y + r * 1.1} L ${aim.x} ${aim.y + r * 1.8}`,
      }));
    }
    svg.appendChild(g);
  }

  // ---------------------------------------------------------------- target card
  function renderTarget(status) {
    const t = status.target;
    const labelEl = $("#target-label");
    const lockBtn = $("#lock-btn");
    const pill = $("#target-lock-pill");
    const has = !!t;

    labelEl.hidden = !has;
    $("#target-empty").hidden = has;
    pill.hidden = !has;
    $("#target-stats").hidden = !has;
    lockBtn.classList.remove("accent", "danger-outline");

    if (!has) {
      lockBtn.disabled = true;
      lockBtn.textContent = "No target";
      lockBtn.onclick = null;
      return;
    }

    labelEl.replaceChildren(document.createTextNode(t.label), el("span", { class: "id" }, `#${t.id}`));
    buildDotMeter($("#conf-meter"), t.conf);
    $("#conf-num").textContent = `${Math.round(t.conf * 100)}%`;

    const [vp, vt] = status.velocity_deg_s || [0, 0];
    $("#vel-num").textContent = status.gimbal && status.gimbal.tilt_enabled
      ? `${fmtSigned(vp)}°/s, ${fmtSigned(vt)}°/s`
      : `${fmtSigned(vp)}°/s`;

    // Lead = how far the aim sits ahead of the target's current world angle.
    const g = status.gimbal;
    const leadRow = $("#lead-row");
    if (g && status.frame && status.mode === "auto") {
      const off = pixelOffsetDeg(boxCenter(t.box).x, boxCenter(t.box).y, status.frame);
      const lead = g.target_pan - (g.pan + off.pan);
      leadRow.hidden = false;
      $("#lead-num").textContent = `${fmtSigned(lead)}°`;
    } else {
      leadRow.hidden = true;
    }

    pill.textContent = t.locked ? "LOCKED" : "AUTO";
    pill.classList.toggle("state-live", t.locked);
    pill.classList.toggle("state-stale", !t.locked);

    lockBtn.disabled = !isControllable();
    if (t.locked) {
      lockBtn.textContent = "Clear lock";
      lockBtn.classList.add("danger-outline");
      lockBtn.onclick = () => lockTarget(null);
    } else {
      lockBtn.textContent = "Lock target";
      lockBtn.classList.add("accent");
      lockBtn.onclick = () => lockTarget(t.id);
    }
  }

  function lockTarget(id) {
    if (!source || !isControllable()) return;
    source.postTarget(id).catch(() => {});
  }

  // ---------------------------------------------------------------- gimbal card
  function polar(cx, cy, r, angleDeg) {
    return { x: cx + r * Math.sin(angleDeg * DEG), y: cy - r * Math.cos(angleDeg * DEG) };
  }
  function angleFor(v, lo, hi) {
    return -90 + clamp((v - lo) / (hi - lo), 0, 1) * 180;
  }
  function describeArc(cx, cy, r, a0, a1) {
    const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 >= a0 ? 1 : 0} ${p1.x} ${p1.y}`;
  }

  function renderGimbal(status) {
    const g = status.gimbal;
    if (!g) return;
    const [lo, hi] = g.pan_limits || [-170, 170];
    const cx = 100, cy = 110, r = 85;

    $("#dial-track").setAttribute("d", describeArc(cx, cy, r, -90, 90));
    $("#dial-min-label").textContent = `${lo}°`;
    $("#dial-max-label").textContent = `${hi}°`;

    const panAngle = angleFor(g.pan, lo, hi);
    const targetAngle = angleFor(g.target_pan != null ? g.target_pan : g.pan, lo, hi);
    const tip = polar(cx, cy, r - 10, panAngle);
    const needle = $("#dial-needle");
    needle.setAttribute("x1", cx); needle.setAttribute("y1", cy);
    needle.setAttribute("x2", tip.x); needle.setAttribute("y2", tip.y);
    const dot = polar(cx, cy, r, panAngle);
    $("#dial-needle-dot").setAttribute("cx", dot.x);
    $("#dial-needle-dot").setAttribute("cy", dot.y);
    $("#dial-target-tick").setAttribute("d", describeArc(cx, cy, r, targetAngle - 3, targetAngle + 3));

    $("#pan-current-num").textContent = `${g.pan.toFixed(1)}°`;
    $("#pan-target-num").textContent = `${(g.target_pan != null ? g.target_pan : g.pan).toFixed(1)}°`;

    $("#tilt-note").hidden = !!g.tilt_enabled;
    $("#tilt-readout").hidden = !g.tilt_enabled;
    if (g.tilt_enabled) $("#tilt-num").textContent = `${g.tilt.toFixed(1)}°`;

    const chip = $("#motors-chip");
    chip.classList.remove("state-live", "state-mock", "state-offline");
    let state, text;
    if (motorsDisconnected) [state, text] = ["state-offline", "Motors · disconnected"];
    else if (g.mock) [state, text] = ["state-mock", "Motors · mock"];
    else [state, text] = ["state-live", "Motors · live"];
    chip.classList.add(state);
    chip.querySelector(".label").textContent = text;
  }

  // ---------------------------------------------------------------- detections card
  function renderDetections(status) {
    const list = $("#det-list");
    const dets = status.detections || [];
    list.replaceChildren();
    if (!dets.length) {
      list.appendChild(el("div", { class: "empty-note" }, "Nothing in view"));
      return;
    }
    const lockedId = status.target && status.target.locked ? status.target.id : null;
    const autoId = status.target ? status.target.id : null;
    for (const d of dets) {
      const cls = d.id === lockedId ? " is-locked" : d.id === autoId ? " is-auto" : "";
      const row = el("button", { type: "button", class: `det-row${cls}`, "aria-label": `Lock ${d.label} #${d.id}` });
      const name = el("span", { class: "name" }, `${d.label} `);
      name.appendChild(el("span", { class: "id" }, `#${d.id}`));
      row.append(el("span", { class: "swatch" }), name, el("span", { class: "conf tabular" }, `${Math.round(d.conf * 100)}%`));
      row.disabled = !isControllable();
      row.addEventListener("click", () => lockTarget(d.id));
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- events card
  const EVENT_TEXT = {
    target_acquired: (e) => `Acquired ${e.label || ""} #${e.id}`,
    target_lost: (e) => `Lost target #${e.id}`,
    mode_changed: (e) => `Mode → ${e.mode}`,
    motor_connected: () => "Motors connected",
    motor_disconnected: () => "Motors disconnected",
  };
  const EVENT_CLASS = {
    target_acquired: "acquired", target_lost: "lost", mode_changed: "mode",
    motor_connected: "motor-up", motor_disconnected: "motor-down",
  };

  function appendEvents(events) {
    const list = $("#event-list");
    for (const e of events) {
      if (e.type === "motor_connected") motorsDisconnected = false;
      if (e.type === "motor_disconnected") motorsDisconnected = true;
      const row = el("div", { class: `event-row ${EVENT_CLASS[e.type] || ""}` });
      const body = el("span", { class: "body" });
      body.append(
        el("span", { class: "msg" }, (EVENT_TEXT[e.type] || (() => e.type))(e)),
        el("br"),
        el("span", { class: "t", "data-t": e.t }, timeAgo(e.t)),
      );
      row.append(el("span", { class: "dot" }), body);
      list.insertBefore(row, list.firstChild);
    }
    while (list.children.length > 50) list.removeChild(list.lastChild);
  }

  function refreshEventTimes() {
    $$("#event-list .t").forEach((n) => { n.textContent = timeAgo(parseFloat(n.dataset.t)); });
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
    $("#feed-mock-canvas").hidden = !usingMock;
    img.addEventListener("error", () => {
      if (usingMock) return;
      img.style.visibility = "hidden"; // no broken-image icon behind "No signal"
      $("#no-signal").hidden = false;
      // e.g. /video opened before the first frame, or the Pi restarting: keep retrying.
      clearTimeout(videoRetryTimer);
      videoRetryTimer = setTimeout(restartVideo, VIDEO_RETRY_MS);
    });
    img.addEventListener("load", () => {
      img.style.visibility = "";
      $("#no-signal").hidden = true;
    });
    if (!usingMock) restartVideo();
  }

  let _feedTokens = null;
  function feedTokens() {
    if (!_feedTokens) {
      const css = getComputedStyle(document.documentElement);
      const v = (name) => css.getPropertyValue(name).trim();
      _feedTokens = {
        glow: v("--feed-glow"), edge: v("--feed-edge"), grid: v("--feed-grid"),
        gridStrong: v("--feed-grid-strong"), label: v("--feed-grid-label"),
      };
    }
    return _feedTokens;
  }

  // Mock "video": a world-fixed grid that slides as the simulated gimbal pans, so you can
  // see the camera turn. Letterboxed exactly like the <img> (object-fit: contain).
  function drawMockFeed() {
    const canvas = $("#feed-mock-canvas");
    if (canvas.hidden || !lastStatus || !lastStatus.frame) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const { frame, gimbal } = lastStatus;
    const s = Math.min(cw / frame.w, ch / frame.h);
    const ox = (cw - frame.w * s) / 2, oy = (ch - frame.h * s) / 2;

    const tok = feedTokens();
    const grad = ctx.createRadialGradient(cw / 2, ch * 0.4, 10, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
    grad.addColorStop(0, tok.glow);
    grad.addColorStop(1, tok.edge);
    ctx.fillStyle = grad;
    ctx.fillRect(ox, oy, frame.w * s, frame.h * s);

    ctx.lineWidth = 1;
    const g = gimbal || { pan: 0, tilt: 0 };
    const first = Math.ceil((g.pan - 60) / 10) * 10;
    for (let a = first; a <= g.pan + 60; a += 10) {
      const p = project(a, 0, g, frame);
      if (!p || p.x < 0 || p.x > frame.w) continue;
      ctx.strokeStyle = a === 0 ? tok.gridStrong : tok.grid;
      ctx.beginPath();
      ctx.moveTo(ox + p.x * s, oy);
      ctx.lineTo(ox + p.x * s, oy + frame.h * s);
      ctx.stroke();
      ctx.fillStyle = tok.label;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`${a}°`, ox + p.x * s + 3, oy + frame.h * s - 6);
    }
    const horizon = project(g.pan, 0, g, frame);
    if (horizon) {
      ctx.strokeStyle = tok.grid;
      ctx.beginPath();
      ctx.moveTo(ox, oy + horizon.y * s);
      ctx.lineTo(ox + frame.w * s, oy + horizon.y * s);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- fullscreen
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  function toggleFullscreen() {
    const frame = $("#hero-frame");
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (frame.classList.contains("pseudo-fs")) {
      setPseudoFullscreen(false);
      return;
    }
    const req = frame.requestFullscreen || frame.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(frame)).then(syncFullscreenButton, () => setPseudoFullscreen(true));
    } else {
      // iPhone Safari has no element fullscreen; fill the viewport instead.
      setPseudoFullscreen(true);
    }
  }

  function setPseudoFullscreen(on) {
    $("#hero-frame").classList.toggle("pseudo-fs", on);
    document.body.classList.toggle("no-scroll", on);
    syncFullscreenButton();
  }

  function syncFullscreenButton() {
    const on = !!fsElement() || $("#hero-frame").classList.contains("pseudo-fs");
    const btn = $("#fs-btn");
    btn.setAttribute("aria-label", on ? "Exit fullscreen (F)" : "Fullscreen (F)");
    btn.title = btn.getAttribute("aria-label");
    $("#fs-icon-enter").style.display = on ? "none" : "";
    $("#fs-icon-exit").style.display = on ? "" : "none";
    if (lastStatus) renderOverlay(lastStatus);
  }

  // ---------------------------------------------------------------- controls
  function setMode(mode) {
    if (!source || !isControllable() || mode === currentMode()) return;
    optimisticMode = mode;
    renderTopbar(lastStatus);
    source.postMode(mode).catch(() => { optimisticMode = null; });
  }

  let lastNudgeAt = 0;
  function nudge(dpan, dtilt, btn) {
    if (!source || !isControllable() || currentMode() !== "manual") return;
    if (btn) {
      if (btn.disabled) return;
      btn.classList.add("pressed");
      setTimeout(() => btn.classList.remove("pressed"), 120);
    }
    const now = performance.now();
    if (now - lastNudgeAt < NUDGE_MIN_INTERVAL_MS) return;
    lastNudgeAt = now;
    source.postNudge(dpan, dtilt).catch(() => {});
  }

  function home() {
    if (!source || !isControllable()) return;
    const btn = $("#dpad-home");
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
    optimisticMode = "manual";
    source.postHome().catch(() => { optimisticMode = null; });
  }

  function wireControls() {
    $$(".mode-switch button").forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

    $("#dpad-up").addEventListener("click", (e) => nudge(0, NUDGE_DEG, e.currentTarget));
    $("#dpad-down").addEventListener("click", (e) => nudge(0, -NUDGE_DEG, e.currentTarget));
    $("#dpad-left").addEventListener("click", (e) => nudge(-NUDGE_DEG, 0, e.currentTarget));
    $("#dpad-right").addEventListener("click", (e) => nudge(NUDGE_DEG, 0, e.currentTarget));
    $("#dpad-home").addEventListener("click", home);

    $("#fs-btn").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
    $("#conn-action").addEventListener("click", () => location.reload());

    const KEY_MODES = { "1": "auto", "2": "manual", "3": "stop" };
    const KEY_NUDGE = {
      ArrowUp: [0, 1, "#dpad-up"], ArrowDown: [0, -1, "#dpad-down"],
      ArrowLeft: [-1, 0, "#dpad-left"], ArrowRight: [1, 0, "#dpad-right"],
    };
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;

      if (KEY_MODES[e.key] && !e.repeat) {
        setMode(KEY_MODES[e.key]);
      } else if (KEY_NUDGE[e.key] && currentMode() === "manual") {
        e.preventDefault(); // don't scroll the page while driving
        const [sp, st, sel] = KEY_NUDGE[e.key];
        const step = e.shiftKey ? NUDGE_FINE_DEG : NUDGE_DEG;
        nudge(sp * step, st * step, $(sel));
      } else if ((e.key === "h" || e.key === "H" || e.key === "Home") && !e.repeat) {
        home();
      } else if ((e.key === "f" || e.key === "F") && !e.repeat) {
        toggleFullscreen();
      } else if (e.key === "Escape" && $("#hero-frame").classList.contains("pseudo-fs")) {
        setPseudoFullscreen(false);
      }
    });
  }

  // ---------------------------------------------------------------- main loop
  function render() {
    renderTopbar(lastStatus);
    renderBanner();
    if (!lastStatus) return;
    renderOverlay(lastStatus);
    renderTarget(lastStatus);
    renderGimbal(lastStatus);
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
      if (status.server_time) clockSkew = 0.8 * clockSkew + 0.2 * (status.server_time - now / 1000);
      if (conn === "connecting") clockSkew = status.server_time ? status.server_time - now / 1000 : 0;

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
    wireFeed();
    wireControls();
    syncFullscreenButton();
    statusTick();
    eventsTick();
    setInterval(statusTick, POLL_MS);
    setInterval(eventsTick, EVENTS_MS);
    // Background tabs throttle timers to ~1 Hz; refresh at once when the viewer comes back.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { statusTick(); eventsTick(); }
    });
    if (usingMock) setInterval(drawMockFeed, 50);
  }

  boot();
})();
