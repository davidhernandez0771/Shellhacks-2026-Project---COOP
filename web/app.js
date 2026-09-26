// COOP dashboard app. Talks to the real API (docs/API.md) and falls back to the
// client-side mock (mock.js) if the backend isn't there yet.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------- sources
  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  class RealSource {
    async getStatus() {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    }
    async getEvents(since) {
      const res = await fetch(`/api/events?since=${since || 0}`);
      if (!res.ok) throw new Error("events " + res.status);
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
  let lastEventSeq = 0;
  let lastStatus = null;

  async function chooseSource() {
    const real = new RealSource();
    try {
      await real.getStatus();
      source = real;
      usingMock = false;
    } catch (e) {
      source = new window.COOP_MOCK();
      usingMock = true;
    }
    $("#mock-badge").hidden = !usingMock;
  }

  // ---------------------------------------------------------------- state
  let currentMode = "auto";
  let optimisticMode = null; // set right after a click, cleared once status confirms it

  // ---------------------------------------------------------------- helpers
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function buildDotMeter(container, ratio, opts) {
    opts = opts || {};
    const total = opts.total || 8;
    const filled = Math.round(clamp(ratio, 0, 1) * total);
    container.innerHTML = "";
    container.classList.toggle("warm", !!opts.warm);
    for (let i = 0; i < total; i++) {
      const dot = document.createElement("span");
      if (i < filled) dot.classList.add("filled");
      container.appendChild(dot);
    }
  }

  function timeAgo(t) {
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 1) return "now";
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  // ---------------------------------------------------------------- topbar
  function renderTopbar(status, connState) {
    const pill = $("#live-pill");
    pill.classList.remove("state-live", "state-stale", "state-offline", "live-pulse");
    let label;
    if (connState === "offline") {
      pill.classList.add("state-offline");
      label = "OFFLINE";
    } else if (connState === "stale") {
      pill.classList.add("state-stale");
      label = "STALE";
    } else {
      pill.classList.add("state-live", "live-pulse");
      label = `LIVE · ${status.fps != null ? status.fps.toFixed(1) : "–"} fps`;
    }
    pill.querySelector(".label").textContent = label;

    if (status && status.mode && optimisticMode === status.mode) optimisticMode = null;
    const activeMode = optimisticMode || (status ? status.mode : currentMode);
    currentMode = activeMode;
    $$(".mode-switch button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === activeMode);
    });

    $("#dpad-wrap").hidden = activeMode !== "manual";
  }

  // ---------------------------------------------------------------- overlay
  const SVG_NS = "http://www.w3.org/2000/svg";

  function renderOverlay(status) {
    const svg = $("#overlay-svg");
    const frame = status.frame || { w: 640, h: 480 };
    svg.setAttribute("viewBox", `0 0 ${frame.w} ${frame.h}`);
    svg.innerHTML = "";

    const lockedId = status.target && status.target.locked ? status.target.id : null;
    const autoId = status.target ? status.target.id : null;

    (status.detections || []).forEach((d) => {
      const [x1, y1, x2, y2] = d.box;
      const isLocked = d.id === lockedId;
      const isAuto = !isLocked && d.id === autoId;

      if (isLocked) {
        const g = document.createElementNS(SVG_NS, "g");
        g.classList.add("locked");
        const len = Math.max(10, Math.min(x2 - x1, y2 - y1) * 0.22);
        const d0 = [
          `M ${x1} ${y1 + len} L ${x1} ${y1} L ${x1 + len} ${y1}`,
          `M ${x2 - len} ${y1} L ${x2} ${y1} L ${x2} ${y1 + len}`,
          `M ${x1} ${y2 - len} L ${x1} ${y2} L ${x1 + len} ${y2}`,
          `M ${x2 - len} ${y2} L ${x2} ${y2} L ${x2} ${y2 - len}`,
        ].join(" ");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d0);
        g.appendChild(path);

        const hit = document.createElementNS(SVG_NS, "rect");
        hit.setAttribute("x", x1); hit.setAttribute("y", y1);
        hit.setAttribute("width", x2 - x1); hit.setAttribute("height", y2 - y1);
        hit.setAttribute("class", "box");
        hit.style.cursor = "pointer";
        hit.addEventListener("click", () => lockTarget(d.id));
        g.appendChild(hit);
        svg.appendChild(g);
      } else {
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", x1); rect.setAttribute("y", y1);
        rect.setAttribute("width", x2 - x1); rect.setAttribute("height", y2 - y1);
        rect.setAttribute("rx", 6);
        rect.setAttribute("class", `box ${isAuto ? "auto" : "det"}`);
        rect.addEventListener("click", () => lockTarget(d.id));
        svg.appendChild(rect);
      }

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", x1);
      label.setAttribute("y", Math.max(12, y1 - 6));
      label.setAttribute("class", `box-label ${isLocked ? "locked" : ""}`);
      label.textContent = `${d.label} #${d.id}`;
      svg.appendChild(label);
    });
  }

  // ---------------------------------------------------------------- target card
  function renderTarget(status) {
    const t = status.target;
    const labelEl = $("#target-label");
    const emptyEl = $("#target-empty");
    const lockBtn = $("#lock-btn");

    const statusPill = $("#target-lock-pill");

    if (!t) {
      labelEl.hidden = true;
      emptyEl.hidden = false;
      statusPill.hidden = true;
      $("#target-stats").hidden = true;
      lockBtn.disabled = true;
      lockBtn.textContent = "No target";
      lockBtn.classList.remove("accent", "danger-outline");
      return;
    }

    labelEl.hidden = false;
    emptyEl.hidden = true;
    statusPill.hidden = false;
    $("#target-stats").hidden = false;
    labelEl.innerHTML = `${t.label}<span class="id">#${t.id}</span>`;

    buildDotMeter($("#conf-meter"), t.conf);
    $("#conf-num").textContent = `${Math.round(t.conf * 100)}%`;

    const [vp, vt] = status.velocity_deg_s || [0, 0];
    $("#vel-num").textContent = `${vp.toFixed(1)}°/s, ${vt.toFixed(1)}°/s`;

    statusPill.textContent = t.locked ? "LOCKED" : "AUTO";
    statusPill.classList.toggle("state-live", t.locked);
    statusPill.classList.toggle("state-stale", !t.locked);

    lockBtn.disabled = false;
    if (t.locked) {
      lockBtn.textContent = "Clear lock";
      lockBtn.classList.remove("accent");
      lockBtn.classList.add("danger-outline");
      lockBtn.onclick = () => lockTarget(null);
    } else {
      lockBtn.textContent = "Lock target";
      lockBtn.classList.add("accent");
      lockBtn.classList.remove("danger-outline");
      lockBtn.onclick = () => lockTarget(t.id);
    }
  }

  function lockTarget(id) {
    if (!source) return;
    source.postTarget(id).catch(() => {});
  }

  // ---------------------------------------------------------------- gimbal card
  function polar(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
  }
  function angleFor(v, lo, hi) {
    const t = clamp((v - lo) / (hi - lo), 0, 1);
    return -90 + t * 180;
  }
  function describeArc(cx, cy, r, a0, a1) {
    const p0 = polar(cx, cy, r, a0);
    const p1 = polar(cx, cy, r, a1);
    const largeArc = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const sweep = a1 >= a0 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${p1.x} ${p1.y}`;
  }

  function renderGimbal(status) {
    const g = status.gimbal || {};
    const [lo, hi] = g.pan_limits || [-170, 170];
    const cx = 100, cy = 110, r = 85;

    $("#dial-track").setAttribute("d", describeArc(cx, cy, r, -90, 90));
    $("#dial-min-label").textContent = `${lo}°`;
    $("#dial-max-label").textContent = `${hi}°`;

    const panAngle = angleFor(g.pan || 0, lo, hi);
    const targetAngle = angleFor(g.target_pan != null ? g.target_pan : g.pan || 0, lo, hi);

    const tip = polar(cx, cy, r - 10, panAngle);
    $("#dial-needle").setAttribute("x1", cx);
    $("#dial-needle").setAttribute("y1", cy);
    $("#dial-needle").setAttribute("x2", tip.x);
    $("#dial-needle").setAttribute("y2", tip.y);
    const dot = polar(cx, cy, r, panAngle);
    $("#dial-needle-dot").setAttribute("cx", dot.x);
    $("#dial-needle-dot").setAttribute("cy", dot.y);

    $("#dial-target-tick").setAttribute(
      "d",
      describeArc(cx, cy, r, targetAngle - 3, targetAngle + 3)
    );

    $("#pan-current-num").textContent = `${(g.pan || 0).toFixed(1)}°`;
    $("#pan-target-num").textContent = `${(g.target_pan != null ? g.target_pan : 0).toFixed(1)}°`;

    const tiltNote = $("#tilt-note");
    const tiltReadout = $("#tilt-readout");
    if (g.tilt_enabled) {
      tiltNote.hidden = true;
      tiltReadout.hidden = false;
      $("#tilt-num").textContent = `${(g.tilt || 0).toFixed(1)}°`;
    } else {
      tiltNote.hidden = false;
      tiltReadout.hidden = true;
    }

    const chip = $("#motors-chip");
    chip.classList.remove("state-live", "state-mock", "state-offline");
    if (g.mock) {
      chip.classList.add("state-mock");
      chip.querySelector(".label").textContent = "Motors · mock";
    } else if (motorsDisconnected) {
      chip.classList.add("state-offline");
      chip.querySelector(".label").textContent = "Motors · disconnected";
    } else {
      chip.classList.add("state-live");
      chip.querySelector(".label").textContent = "Motors · live";
    }
  }

  // ---------------------------------------------------------------- detections card
  function renderDetections(status) {
    const list = $("#det-list");
    const dets = status.detections || [];
    if (!dets.length) {
      list.innerHTML = '<div class="empty-note">Nothing in view</div>';
      return;
    }
    const lockedId = status.target && status.target.locked ? status.target.id : null;
    const autoId = status.target ? status.target.id : null;
    list.innerHTML = "";
    dets.forEach((d) => {
      const row = document.createElement("div");
      row.className = "det-row";
      if (d.id === lockedId) row.classList.add("is-locked");
      else if (d.id === autoId) row.classList.add("is-auto");
      row.innerHTML = `
        <span class="swatch"></span>
        <span class="name">${d.label} <span class="id">#${d.id}</span></span>
        <span class="conf tabular">${Math.round(d.conf * 100)}%</span>
      `;
      row.addEventListener("click", () => lockTarget(d.id));
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- events card
  let motorsDisconnected = false;

  const EVENT_LABELS = {
    target_acquired: (e) => `Acquired ${e.label || ""} #${e.id}`,
    target_lost: (e) => `Lost target #${e.id}`,
    mode_changed: (e) => `Mode → ${e.mode}`,
    motor_connected: () => "Motors connected",
    motor_disconnected: () => "Motors disconnected",
  };
  const EVENT_CLASS = {
    target_acquired: "acquired",
    target_lost: "lost",
    mode_changed: "mode",
    motor_connected: "motor-up",
    motor_disconnected: "motor-down",
  };

  function appendEvents(events) {
    if (!events.length) return;
    const list = $("#event-list");
    events.forEach((e) => {
      if (e.type === "motor_connected") motorsDisconnected = false;
      if (e.type === "motor_disconnected") motorsDisconnected = true;

      const row = document.createElement("div");
      row.className = `event-row ${EVENT_CLASS[e.type] || ""}`;
      const msg = (EVENT_LABELS[e.type] || (() => e.type))(e);
      row.innerHTML = `
        <span class="dot"></span>
        <span class="body"><span class="msg">${msg}</span><br><span class="t">${timeAgo(e.t)}</span></span>
      `;
      list.insertBefore(row, list.firstChild);
    });
    while (list.children.length > 50) list.removeChild(list.lastChild);
  }

  // ---------------------------------------------------------------- feed
  function renderFeed(status) {
    const feedImg = $("#feed-img");
    const feedCanvas = $("#feed-mock-canvas");
    if (usingMock) {
      feedImg.hidden = true;
      feedCanvas.hidden = false;
      $("#no-signal").hidden = true;
    } else {
      feedImg.hidden = false;
      feedCanvas.hidden = true;
    }
  }

  let mockCtxT = 0;
  function drawMockFeed() {
    const canvas = $("#feed-mock-canvas");
    if (canvas.hidden) return;
    const ctx = canvas.getContext("2d");
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    mockCtxT += 0.01;
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.4, 20, w * 0.5, h * 0.5, w * 0.75);
    grad.addColorStop(0, "#1a1512");
    grad.addColorStop(1, "#080605");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (h / 6) * i);
      ctx.lineTo(w, (h / 6) * i + Math.sin(mockCtxT + i) * 6);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- main loop
  function onStatus(status, connState) {
    lastStatus = status;
    renderTopbar(status, connState);
    renderFeed(status);
    renderOverlay(status);
    renderTarget(status);
    renderGimbal(status);
    renderDetections(status);
  }

  async function statusTick() {
    if (!source) return;
    try {
      const status = await source.getStatus();
      const age = Date.now() / 1000 - status.server_time;
      onStatus(status, age < 2 ? "live" : "stale");
    } catch (e) {
      if (lastStatus) onStatus(lastStatus, "offline");
    }
  }

  async function eventsTick() {
    if (!source) return;
    try {
      const { events } = await source.getEvents(lastEventSeq);
      if (events && events.length) {
        lastEventSeq = events[events.length - 1].seq;
        appendEvents(events);
      }
    } catch (e) { /* stay quiet, status pill already reflects connectivity */ }
  }

  function wireFeedFallback() {
    const feedImg = $("#feed-img");
    feedImg.addEventListener("error", () => { if (!usingMock) $("#no-signal").hidden = false; });
    feedImg.addEventListener("load", () => { $("#no-signal").hidden = true; });
  }

  function wireControls() {
    $$(".mode-switch button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode;
        optimisticMode = mode;
        $$(".mode-switch button").forEach((b) => b.classList.toggle("active", b === btn));
        $("#dpad-wrap").hidden = mode !== "manual";
        source.postMode(mode).catch(() => {});
      });
    });

    const STEP = 5;
    $("#dpad-up").addEventListener("click", () => source.postNudge(0, STEP).catch(() => {}));
    $("#dpad-down").addEventListener("click", () => source.postNudge(0, -STEP).catch(() => {}));
    $("#dpad-left").addEventListener("click", () => source.postNudge(-STEP, 0).catch(() => {}));
    $("#dpad-right").addEventListener("click", () => source.postNudge(STEP, 0).catch(() => {}));
    $("#dpad-home").addEventListener("click", () => source.postHome().catch(() => {}));
  }

  async function boot() {
    await chooseSource();
    wireControls();
    wireFeedFallback();
    statusTick();
    eventsTick();
    setInterval(statusTick, 300);
    setInterval(eventsTick, 1000);
    setInterval(drawMockFeed, 100);
  }

  boot();
})();
