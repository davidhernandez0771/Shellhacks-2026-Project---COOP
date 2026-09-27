// COOPER dashboard. Talks to the real API (docs/API.md) and falls back to the client-side
// mock (mock.js) when no backend answers at startup, or when ?demo=<state> is set.
//
// Everything drawn over the video (the lane, boxes, predicted paths) goes on one <canvas>,
// redrawn only when a new frame arrives, the feed is resized, a lane corner is dragged or
// a label is decoding. Layout is read only in the ResizeObserver, and the rail's DOM is
// rebuilt only when its content changes.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const POLL_MS = 300;
  const EVENTS_MS = 1000;
  const OFFLINE_AFTER_FAILS = 3;     // ~1 s of failed polls before we call it offline
  const STALE_AFTER_MS = 2000;       // frame_seq frozen this long = vision loop stalled
  const NO_CAMERA_AFTER_MS = 4000;   // connected, but no frame published for this long
  const HANDLE_HIT_PX = 18;          // lane corner grab radius, CSS px
  const SCRAMBLE_MS = 520;
  const SCRAMBLE_CHARS = "░▒▓█ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#";
  const LANE_FALLBACK = [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]];
  const LEVEL_WORD = { clear: "Clear", warning: "Warning", danger: "Danger" };

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
      return { ok: false, error: "Can't reach COOPER." };
    }
    if (res.type === "opaqueredirect") return { ok: false, error: "Signed out. Reload to sign in again." };
    if (res.status === 404) return { ok: false, error: "This COOPER build doesn't support that yet." };
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
    postSettings(body) { return postJSON("/api/settings", body); }
    postLane(lane, save) { return postJSON("/api/lane", { lane, save: !!save }); }
  }

  let source = null;
  let usingMock = false;

  async function chooseSource() {
    if (window.COOPER_DEMO) {
      source = new window.COOPER_MOCK();
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
        source = new window.COOPER_MOCK();
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
  let lastEventSeq = 0;
  let videoBroken = false;
  let laneDraft = null;             // [[x, y] * 4] normalized while editing, else null
  let dragCorner = -1;
  let laneDefault = null;

  const hasFrame = (s) => !!(s && s.frame);
  const isControllable = () => conn === "live" || conn === "stale" || conn === "connecting";
  const noCamera = () => conn !== "expired" && conn !== "offline" &&
    ((!usingMock && videoBroken) || (connectedAt && !hasFrame(lastStatus) && Date.now() - Math.max(connectedAt, lastFrameAt) > NO_CAMERA_AFTER_MS));
  const riskLevel = () => (lastStatus && lastStatus.risk && lastStatus.risk.level) || "clear";

  // ---------------------------------------------------------------- dom helpers
  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
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
  const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

  // ---------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  const friendly = (err) => (err ? capitalize(err) : "Something went wrong.");
  async function send(promise) {
    try {
      const r = await promise;
      if (r && r.ok === false) toast(friendly(r.error));
      return r;
    } catch (e) {
      toast("Can't reach COOPER.");
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------- label scramble
  // A newly seen object decodes its label, like the showcase.
  const scrambles = new Map();      // id -> t0
  let seenIds = new Set();
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
  function noteObjects(objects) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const now = new Set();
    for (const o of objects) {
      now.add(o.id);
      if (!seenIds.has(o.id) && !reduced) scrambles.set(o.id, performance.now());
    }
    seenIds = now;
  }

  // ---------------------------------------------------------------- canvas overlay
  const canvas = $("#overlay");
  const ctx = canvas.getContext("2d");
  let view = { cw: 0, ch: 0, dpr: 1 };  // CSS size of the canvas, set by the ResizeObserver
  let tok = null;                       // colors and fonts from tokens.css, read once
  let drawQueued = false;

  function tokens() {
    if (tok) return tok;
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    tok = {
      paper: v("--paper"), paper2: v("--paper-2"), paper3: v("--paper-3"), line: v("--line-strong"),
      box: v("--box-line"), halo: v("--halo"), lock: v("--lock"),
      yellow: v("--led-yellow"), yellowDim: v("--led-yellow-dim"), red: v("--led-red"), redDim: v("--led-red-dim"),
      grid: v("--feed-grid"), gridStrong: v("--feed-grid-strong"), ink2: v("--ink-2"),
      mono: v("--font-mono"),
    };
    return tok;
  }
  const levelColor = (level) => (level === "danger" ? tokens().red : level === "warning" ? tokens().yellow : tokens().box);

  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  // Frame pixels -> canvas CSS pixels, letterboxed like the <img> (object-fit: contain).
  function transform(frame) {
    const s = Math.min(view.cw / frame.w, view.ch / frame.h);
    return { s, ox: (view.cw - frame.w * s) / 2, oy: (view.ch - frame.h * s) / 2 };
  }

  function currentLane() {
    return laneDraft || (lastStatus && lastStatus.lane) || LANE_FALLBACK;
  }

  function draw() {
    const t = tokens();
    const { cw, ch, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const status = lastStatus;
    if (!status || !status.frame || noCamera() || !cw) return;
    const frame = status.frame;
    const { s, ox, oy } = transform(frame);
    const X = (x) => ox + x * s, Y = (y) => oy + y * s;
    if (usingMock) drawMockRoad(frame, X, Y, s, status.objects || []);

    // the lane, tinted by the current level
    const lane = currentLane().map(([x, y]) => [X(x * frame.w), Y(y * frame.h)]);
    const level = riskLevel();
    ctx.beginPath();
    lane.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = level === "danger" ? t.redDim : level === "warning" ? t.yellowDim : t.grid;
    ctx.fill();
    ctx.lineWidth = laneDraft ? 2 : 1.25;
    ctx.setLineDash(laneDraft ? [] : [6, 5]);
    ctx.strokeStyle = laneDraft ? t.lock : level === "danger" ? t.red : level === "warning" ? t.yellow : t.paper2;
    ctx.stroke();
    ctx.setLineDash([]);

    // objects, far to near so nearer boxes draw on top
    const objects = (status.objects || []).slice().sort((a, b) => a.box[3] - b.box[3]);
    const now = performance.now();
    let decoding = false;
    ctx.font = `10.5px ${t.mono}`;
    ctx.textBaseline = "middle";
    for (const o of objects) {
      const color = levelColor(o.level);
      const [x1, y1, x2, y2] = o.box.map((v, i) => (i % 2 ? Y(v) : X(v)));
      const hot = o.level !== "clear";

      // predicted path of the bottom-centre, from now out to the horizon
      if (o.path && o.path.length) {
        ctx.beginPath();
        ctx.moveTo((x1 + x2) / 2, y2);
        for (const [u, v] of o.path) ctx.lineTo(X(u), Y(v));
        ctx.strokeStyle = hot ? color : t.paper2;
        ctx.lineWidth = hot ? 2 : 1.25;
        ctx.stroke();
        ctx.fillStyle = hot ? color : t.paper2;
        for (let i = 4; i < o.path.length - 1; i += 5) {  // a tick every 0.5 s
          ctx.beginPath();
          ctx.arc(X(o.path[i][0]), Y(o.path[i][1]), 2, 0, Math.PI * 2);
          ctx.fill();
        }
        const [eu, ev] = o.path[o.path.length - 1];
        ctx.beginPath();
        ctx.arc(X(eu), Y(ev), 4, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // corner brackets, and the bottom edge the lane test uses
      const L = Math.max(7, Math.min(x2 - x1, y2 - y1) * 0.22);
      ctx.beginPath();
      ctx.moveTo(x1, y1 + L); ctx.lineTo(x1, y1); ctx.lineTo(x1 + L, y1);
      ctx.moveTo(x2 - L, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + L);
      ctx.moveTo(x1, y2 - L); ctx.lineTo(x1, y2); ctx.lineTo(x1 + L, y2);
      ctx.moveTo(x2 - L, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - L);
      ctx.strokeStyle = color;
      ctx.lineWidth = hot ? 2.25 : 1.25;
      ctx.stroke();
      if (hot) {
        ctx.beginPath();
        ctx.moveTo(x1, y2); ctx.lineTo(x2, y2);
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // label: "CAR #201 · 0.8 s", decoded in when the ID is new
      let text = `${o.label.toUpperCase()} #${o.id}${detailShort(o) ? ` · ${detailShort(o)}` : ""}`;
      const t0 = scrambles.get(o.id);
      if (t0 != null) {
        const p = (now - t0) / SCRAMBLE_MS;
        if (p >= 1.25) scrambles.delete(o.id);
        else { text = scrambleText(text, p); decoding = true; }
      }
      const tw = ctx.measureText(text).width;
      const flip = x1 + tw + 8 > cw;
      const tx = flip ? x2 - tw : x1;
      const ty = Math.max(y1 - 9, 8);
      ctx.lineWidth = 3;
      ctx.strokeStyle = t.halo;
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = hot ? color : t.paper;
      ctx.fillText(text, tx, ty);
    }

    // lane corner handles while editing
    if (laneDraft) {
      lane.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x, y, i === dragCorner ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = i === dragCorner ? t.lock : t.ink2;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = t.lock;
        ctx.stroke();
      });
    }
    if (decoding) queueDraw();
  }

  function detailShort(o) {
    if (o.kind === "in_lane") return "IN LANE";
    if (o.kind === "path" && num(o.time_to_lane_s)) return `${o.time_to_lane_s.toFixed(1)} s`;
    if (o.kind === "ttc" && num(o.ttc_s)) return `TTC ${o.ttc_s.toFixed(1)} s`;
    return "";
  }

  // The mock has no video: draw a plain road under the overlay (horizon at mid-height).
  function drawMockRoad(frame, X, Y, s, objects) {
    const t = tokens();
    ctx.strokeStyle = t.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(frame.h / 2)); ctx.lineTo(X(frame.w), Y(frame.h / 2));
    for (const k of [-1.5, -0.5, 0.5, 1.5]) {  // lane lines converge on the vanishing point
      ctx.moveTo(X(frame.w / 2), Y(frame.h / 2));
      ctx.lineTo(X(frame.w / 2 + k * frame.w * 0.9), Y(frame.h));
    }
    ctx.stroke();
    ctx.fillStyle = t.gridStrong;
    for (const o of objects) {
      const [x1, y1, x2, y2] = o.box;
      ctx.fillRect(X(x1), Y(y1), (x2 - x1) * s, (y2 - y1) * s);
    }
  }

  function wireCanvas() {
    const feed = $("#feed");
    new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const cw = feed.clientWidth, ch = feed.clientHeight;
      view = { cw, ch, dpr };
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      queueDraw();
    }).observe(feed);

    const toFrame = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (!laneDraft || !lastStatus || !lastStatus.frame) return;
      const f = lastStatus.frame, { s, ox, oy } = transform(f), p = toFrame(e);
      let best = -1, bestD = HANDLE_HIT_PX;
      laneDraft.forEach(([x, y], i) => {
        const d = Math.hypot(ox + x * f.w * s - p.x, oy + y * f.h * s - p.y);
        if (d < bestD) { best = i; bestD = d; }
      });
      if (best < 0) return;
      dragCorner = best;
      canvas.setPointerCapture(e.pointerId);
      feed.classList.add("is-dragging");
      queueDraw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (dragCorner < 0) return;
      const f = lastStatus.frame, { s, ox, oy } = transform(f), p = toFrame(e);
      laneDraft[dragCorner] = [
        Math.round(clamp((p.x - ox) / s / f.w, 0, 1) * 1000) / 1000,
        Math.round(clamp((p.y - oy) / s / f.h, 0, 1) * 1000) / 1000,
      ];
      queueDraw();
    });
    const end = () => { dragCorner = -1; feed.classList.remove("is-dragging"); queueDraw(); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------- lane editing
  function laneProblem(lane) {
    const [tl, tr, br, bl] = lane;
    if (Math.max(tl[1], tr[1]) >= Math.min(bl[1], br[1])) return "The top edge must be above the bottom edge.";
    if (tl[0] >= tr[0] || bl[0] >= br[0]) return "Left corners must be left of the right ones.";
    return null;
  }
  function startLaneEdit() {
    if (!lastStatus || !lastStatus.frame || laneDraft) return;
    laneDraft = currentLane().map((c) => c.slice());
    renderLanePanel();
    queueDraw();
  }
  function stopLaneEdit() {
    laneDraft = null;
    dragCorner = -1;
    renderLanePanel();
    queueDraw();
  }
  async function applyLane(save) {
    if (!laneDraft) return;
    const problem = laneProblem(laneDraft);
    if (problem) { toast(problem); return; }
    const r = await send(source.postLane(laneDraft, save));
    if (r && r.ok) {
      if (lastStatus) lastStatus.lane = r.lane;
      stopLaneEdit();
      toast(r.saved ? "Lane applied and saved to the settings file." : "Lane applied. Not saved: it resets when COOPER restarts.");
    }
  }
  async function resetLane() {
    if (!laneDraft) return;
    if (!laneDefault) {
      try { laneDefault = (await source.getSettings()).lane_default; } catch (e) { /* use the fallback */ }
    }
    laneDraft = (laneDefault || LANE_FALLBACK).map((c) => c.slice());
    queueDraw();
  }
  function renderLanePanel() {
    const editing = !!laneDraft;
    $("#lane-idle").hidden = editing;
    $("#lane-editing").hidden = !editing;
    $("#edit-tag").hidden = !editing;
    $("#feed").classList.toggle("is-editing", editing);
    const chip = $("#lane-chip");
    chip.className = editing ? "chip mono is-lock" : "chip mono";
    setText(chip, editing ? "Editing" : "Live");
    $("#lane-edit").disabled = !isControllable() || !hasFrame(lastStatus) || noCamera();
  }

  // ---------------------------------------------------------------- top bar, risk, banner
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
    setText(c.querySelector(".label"), usingMock ? `${label} · mock` : label);
  }

  function renderRisk(status) {
    const level = riskLevel();
    const reason = status && status.risk ? status.risk.reason : "";
    const leds = (status && status.leds) || { yellow: false, red: false, mode: null };
    const pill = $("#status-pill");
    if (pill.dataset.level !== level) pill.dataset.level = level;
    setText($("#status-word"), LEVEL_WORD[level]);
    const panel = $("#risk-panel");
    if (panel.dataset.level !== level) panel.dataset.level = level;
    setText($("#risk-word"), LEVEL_WORD[level]);
    setText($("#risk-reason"), reason ? capitalize(reason) + "." :
      noCamera() ? "No camera: nothing can be judged." : "Nothing in or heading into your lane.");
    $("#led-y").classList.toggle("is-on", !!leds.yellow);
    $("#led-r").classList.toggle("is-on", !!leds.red);
    const chip = $("#leds-chip");
    const mode = leds.mode || (status && status.diag && status.diag.leds);
    chip.className = `chip mono${mode === "mock" ? " is-mock" : mode === "gpio" ? " is-on" : ""}`;
    setText(chip, mode === "gpio" ? "LEDs · GPIO" : mode === "mock" ? "LEDs · mock" : "LEDs");
    chip.title = mode === "mock" ? "Not on a Pi (or --no-leds): the LEDs are simulated" : "";
  }

  function banner(kind, title, detail, action) {
    const b = $("#banner");
    b.hidden = false;
    b.className = `banner${kind === "alert" ? " is-alert" : ""}`;
    b.setAttribute("role", kind === "alert" ? "alert" : "status");
    setText($("#banner-title"), title);
    setText($("#banner-detail"), detail);
    const a = $("#banner-action");
    a.hidden = !action;
    if (action) { a.textContent = action.label; a.onclick = action.run; }
  }

  function renderBanner() {
    document.body.classList.toggle("is-down", conn === "offline" || conn === "expired");
    $("#feed").classList.toggle("is-stale", conn === "stale" || conn === "offline");
    const since = lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null;
    if (conn === "expired") {
      return banner("alert", "Signed out", "Your Cloudflare Access session ended, so COOPER can't be watched. Sign in again to continue.",
        { label: "Sign in again", run: () => location.reload() });
    }
    if (conn === "offline") {
      return banner("alert", "Connection lost", `Retrying every ${POLL_MS} ms${since != null ? `, last update ${since}s ago` : ""}. The LEDs keep working on the Pi without the dashboard.`);
    }
    if (conn === "stale") {
      const frozen = Math.round((Date.now() - lastFrameSeqChangeAt) / 1000);
      return banner("info", "Camera loop stalled", `The server answers, but no new frame for ${frozen}s. Risk and LEDs are frozen at their last state.`);
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
      title = "Can't reach COOPER";
      detail = "Check that the Pi is on and on the same network.";
    } else if (noCamera()) {
      title = "No camera";
      detail = "COOPER is running, but no frame has arrived from the camera. Check the 22-pin ribbon cable at both ends (contacts facing the right way), then restart COOPER.";
    }
    st.hidden = !title;
    if (title) { setText($("#feed-state-title"), title); setText($("#feed-state-detail"), detail); }
    $("#feed-tag").hidden = !usingMock || !!title;
    setText($("#feed-tag"), window.COOPER_DEMO ? `Demo · ${window.COOPER_DEMO}` : "Mock feed");
  }

  // ---------------------------------------------------------------- objects list
  function detailLong(o) {
    if (o.kind === "in_lane") return "in lane";
    if (o.kind === "path" && num(o.time_to_lane_s)) return `lane in ${o.time_to_lane_s.toFixed(1)} s`;
    if (o.kind === "ttc" && num(o.ttc_s)) return `TTC ${o.ttc_s.toFixed(1)} s`;
    return o.conf.toFixed(2);
  }
  let listKey = "";
  function renderObjects(status) {
    const objs = noCamera() ? [] : (status.objects || []);
    const rank = { danger: 0, warning: 1, clear: 2 };
    const ordered = objs.slice().sort((a, b) => rank[a.level] - rank[b.level] || b.box[3] - a.box[3]);
    const key = ordered.map((o) => `${o.id}:${o.level}:${detailLong(o)}`).join("|") + (noCamera() ? "!" : "");
    setText($("#det-count"), String(objs.length));
    if (key === listKey) return;  // unchanged: leave the DOM alone
    listKey = key;
    const list = $("#det-list");
    list.replaceChildren();
    if (!ordered.length) {
      list.appendChild(el("div", { class: "det-empty" }, noCamera() ? "No feed." : "Nothing in view."));
      return;
    }
    for (const o of ordered) {
      const row = el("div", { class: `det-row is-${o.level}`, title: o.reason || "" });
      const name = el("span", { class: "name" }, o.label);
      name.appendChild(el("span", { class: "id" }, `#${o.id}`));
      row.append(el("span", { class: "sw" }), name, el("span", { class: "conf" }, detailLong(o)));
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- event log
  const EVENT_TEXT = {
    risk_changed: (e) => (e.level === "clear" ? "Clear" : `${LEVEL_WORD[e.level] || e.level}: ${e.reason}`),
    lane_changed: (e) => (e.saved ? "Lane changed and saved" : "Lane changed"),
    settings_changed: (e) => {
      const keys = Object.keys(e.changed || {});
      return `Settings ${e.saved ? "saved" : "changed"}${keys.length ? `: ${keys.join(", ")}` : ""}`;
    },
  };
  function eventClass(e) {
    if (e.type === "risk_changed") return e.level === "danger" ? "is-danger" : e.level === "warning" ? "is-warning" : "is-quiet";
    return "is-quiet";
  }
  function appendEvents(events) {
    const list = $("#log");
    for (const e of events) {
      const li = el("li", { class: eventClass(e) });
      li.append(el("span", { class: "msg" }, (EVENT_TEXT[e.type] || (() => e.type))(e)), el("span", { class: "t", "data-t": e.t }, timeAgo(e.t)));
      list.insertBefore(li, list.firstChild);
    }
    while (list.children.length > 60) list.removeChild(list.lastChild);
  }
  function refreshEventTimes() {
    $$("#log .t").forEach((n) => setText(n, timeAgo(parseFloat(n.dataset.t))));
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
    if (box.title !== title) box.title = title;
    setText(box.querySelector("dd"), text);
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
    if (num(d.latency_ms)) setDiag("latency", `${Math.round(d.latency_ms)} ms`, { title: "Camera to LEDs" }); else na("latency");
    if (d.leds) setDiag("leds", d.leds === "gpio" ? "GPIO" : "mock", { title: d.leds === "mock" ? "Not on a Pi (or --no-leds): simulated" : "Driving the LEDs through gpiozero" });
    else na("leds");
    if (num(d.uptime_s)) setDiag("uptime", fmtUptime(d.uptime_s), { title: "Since COOPER started" }); else na("uptime");
  }

  // ---------------------------------------------------------------- tuning
  let settingsMeta = null;
  const secs = (v) => `${v.toFixed(v < 1 ? 2 : 1)} s`;
  const TUNE_FMT = { conf: (v) => v.toFixed(2), horizon_s: secs, ttc_warn_s: secs, ttc_clear_s: secs, hold_s: secs };
  function tuneMsg(text, error) {
    const m = $("#tuning-msg");
    m.textContent = text;
    m.classList.toggle("is-error", !!error);
  }
  function fillTuning(meta) {
    settingsMeta = meta;
    if (meta.lane_default) laneDefault = meta.lane_default;
    const form = $("#tuning-form");
    for (const [k, v] of Object.entries(meta.settings)) {
      const input = form.elements[k];
      if (!input) continue;
      const range = meta.ranges && meta.ranges[k];
      if (range) { input.min = range[0]; input.max = range[1]; }
      input.value = v;
      const out = input.parentElement.querySelector("output");
      if (out) out.textContent = TUNE_FMT[k] ? TUNE_FMT[k](Number(v)) : String(v);
    }
    $("#tuning-state").textContent = meta.file ? `File: ${meta.file.split(/[\\/]/).pop()}` : "Live settings";
  }
  async function loadTuning() {
    if (!source || !source.getSettings) return;
    try {
      fillTuning(await source.getSettings());
      tuneMsg("");
    } catch (e) {
      tuneMsg("This COOPER build has no live settings yet.", true);
    }
  }
  function changedSettings() {
    const form = $("#tuning-form");
    const out = {};
    if (!settingsMeta) return out;
    for (const [k, v] of Object.entries(settingsMeta.settings)) {
      const input = form.elements[k];
      if (!input) continue;
      const nv = Number(input.value);
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
      tuneMsg(r.saved ? "Applied and saved to the settings file." : "Applied. Not saved: it resets when COOPER restarts.");
    } else if (r) {
      tuneMsg(friendly(r.error), true);
    }
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
  }

  // ---------------------------------------------------------------- sound
  // Beeps in step with the LEDs, like a parking sensor: yellow = one short beep a second,
  // red = rapid high beeps for as long as it lasts. It follows risk.level (after the Pi's
  // hysteresis, exactly what the LEDs show) and stays silent when the feed is stale, offline
  // or signed out, so a frozen status can't keep beeping. Browsers block audio until the page
  // is clicked, so it's off until the viewer turns it on; the choice is remembered, and a
  // remembered "on" starts at the first click or key press.
  const SOUND_KEY = "cooper.sound";
  const BEEPS = {
    warning: { freq: 880, ms: 140, every: 1000 },
    danger: { freq: 1320, ms: 90, every: 240 },
  };
  let soundOn = false, audioCtx = null, lastBeepAt = 0, lastBeepLevel = "clear";

  function soundWanted() {
    try { return localStorage.getItem(SOUND_KEY) === "on"; } catch (e) { return false; }
  }
  function rememberSound(on) {
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (e) { /* private mode */ }
  }
  function ensureAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function beep(freq, ms) {
    const ctx = audioCtx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime, end = t + ms / 1000;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    // A 5 ms attack and release keep the beep from clicking.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
    gain.gain.setValueAtTime(0.12, end - 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(end + 0.01);
  }
  function setSound(on) {
    soundOn = on;
    rememberSound(on);
    if (on) ensureAudio();
    syncSoundButton();
  }
  function syncSoundButton() {
    const btn = $("#sound-btn");
    const blocked = soundOn && (!audioCtx || audioCtx.state !== "running");
    btn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    btn.classList.toggle("is-blocked", blocked);
    setText($("#sound-label"), !soundOn ? "Sound off" : blocked ? "Click to enable" : "Sound on");
  }
  function soundTick() {
    const level = conn === "live" ? riskLevel() : "clear";
    const pattern = soundOn && BEEPS[level];
    if (!pattern) { lastBeepLevel = "clear"; return; }
    const now = performance.now();
    // Beep at once when the level rises (clear → yellow, yellow → red), then on its rhythm.
    if (level !== lastBeepLevel || now - lastBeepAt >= pattern.every) {
      beep(pattern.freq, pattern.ms);
      lastBeepAt = now;
    }
    lastBeepLevel = level;
  }
  function wireSound() {
    $("#sound-btn").addEventListener("click", () => setSound(!soundOn));
    if (soundWanted()) {
      soundOn = true;
      // The remembered choice needs one user gesture before the browser lets audio play.
      const unlock = () => { ensureAudio(); syncSoundButton(); };
      document.addEventListener("pointerdown", unlock, { once: true });
      document.addEventListener("keydown", unlock, { once: true });
    }
    syncSoundButton();
    setInterval(soundTick, 60);
  }

  // ---------------------------------------------------------------- controls
  function wireControls() {
    wireSound();
    $("#fs-btn").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
    $("#lane-edit").addEventListener("click", startLaneEdit);
    $("#lane-apply").addEventListener("click", () => applyLane(false));
    $("#lane-save").addEventListener("click", () => applyLane(true));
    $("#lane-reset").addEventListener("click", resetLane);
    $("#lane-cancel").addEventListener("click", stopLaneEdit);
    wireCanvas();
    wireTuning();

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
      if ((e.key === "l" || e.key === "L") && !e.repeat) { if (laneDraft) stopLaneEdit(); else startLaneEdit(); }
      else if ((e.key === "f" || e.key === "F") && !e.repeat) toggleFullscreen();
      else if ((e.key === "s" || e.key === "S") && !e.repeat) setSound(!soundOn);
      else if (e.key === "Escape") {
        if (laneDraft) stopLaneEdit();
        else if ($("#feed").classList.contains("pseudo-fs")) setPseudoFullscreen(false);
      }
    });
  }

  // ---------------------------------------------------------------- main loop
  function render(newFrame) {
    renderBar(lastStatus);
    renderBanner();
    renderFeedState();
    renderDiag(lastStatus);
    renderRisk(lastStatus);
    renderLanePanel();
    if (lastStatus) renderObjects(lastStatus);
    if (newFrame) queueDraw();
  }

  let lastConn = null;
  async function statusTick() {
    if (!source) return;
    const wasDown = conn === "offline" || conn === "expired";
    let newFrame = false;
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
        newFrame = true;
      }
      const stale = status.frame_seq != null && now - lastFrameSeqChangeAt > STALE_AFTER_MS;
      conn = stale ? "stale" : "live";
      lastStatus = status;
      noteObjects(status.objects || []);
      if (wasDown) restartVideo();
    } catch (e) {
      failStreak += 1;
      if (e.kind === "expired") conn = "expired";
      else if (failStreak >= OFFLINE_AFTER_FAILS) conn = "offline";
    }
    render(newFrame || conn !== lastConn);
    lastConn = conn;
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
      ? (window.COOPER_DEMO ? `Demo state: ${window.COOPER_DEMO} (mock data)` : "No backend found: showing mock data")
      : "COOPER · Pi 5 dashcam";
    wireFeed();
    wireControls();
    syncFullscreenButton();
    statusTick();
    eventsTick();
    setInterval(statusTick, POLL_MS);
    setInterval(eventsTick, EVENTS_MS);
    // Background tabs throttle timers to ~1 Hz; refresh at once when the viewer comes back.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { statusTick(); eventsTick(); } });
  }

  boot();
})();
