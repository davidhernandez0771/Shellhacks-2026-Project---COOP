// COOPER mock data source: stands in for /api/* (docs/API.md) when no backend answers.
// It plays the same 20 s road as tools/rehearsal.py (a car in the next lane, a car cutting
// in, a pedestrian crossing, the lead car braking), projected with the same pinhole
// ground-plane model, and judges it with the same lane geometry. Paths come from the script
// itself (the mock knows the future), so they're exact rather than Kalman estimates.
//
// Demo the designed states without hardware: open the dashboard with ?demo=<state>
//   clear     frozen with nothing in or near the lane
//   warning   frozen as a car cuts in (yellow)
//   danger    frozen with the cut-in car in the lane (red)
//   nocam     the camera never delivers a frame
//   expired   the Cloudflare Access session ran out
//   offline   the Pi stops answering after a few seconds
//   stale     the server answers but the vision loop froze
//   hot       CPU at 82 °C and throttling
(function (global) {
  "use strict";

  const W = 640, H = 480;
  const F = (W / 2) / Math.tan((63.0 / 2) * Math.PI / 180);  // focal length, px
  const CAM_H = 1.3, LANE_M = 3.6, PERIOD = 20.0;
  const HORIZON = 1.5, STEP = 0.1, MIN_OVERLAP = 0.2, HOLD = 0.5;
  const LANE_DEFAULT = [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]];
  const RANGES = { conf: [0.05, 0.95], horizon_s: [0.1, 5.0], ttc_warn_s: [0.1, 10.0], ttc_clear_s: [0.1, 10.0], hold_s: [0.0, 5.0] };
  const FROZEN_AT = { clear: 1.0, warning: 5.2, danger: 6.5 };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;
  const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const demo = (new URLSearchParams(global.location ? global.location.search : "").get("demo") || "").toLowerCase();

  const ACTORS = {
    1: { label: "car", w: 1.8, h: 1.5 },     // lead car
    2: { label: "car", w: 1.8, h: 1.5 },     // cuts in
    3: { label: "person", w: 0.5, h: 1.7 },  // crosses
    4: { label: "car", w: 1.8, h: 1.5 },     // next lane, keeping pace
  };

  function positions(t) {
    t = ((t % PERIOD) + PERIOD) % PERIOD;
    const out = { 4: [-LANE_M, 9 + 2 * Math.sin(2 * Math.PI * t / 10)] };
    if (t < 15) out[1] = [0, 40];
    else if (t < 19.5) { const s = (t - 15) / 4.5; out[1] = [0, 40 - 33 * s * s]; }
    if (t >= 3 && t < 9) out[2] = [LANE_M * (1 - smooth(4, 7, t)), 10 + 15 * smooth(7.5, 9, t)];
    if (t >= 10 && t < 15) out[3] = [-7 + 14 * (t - 10) / 5, 11];
    return out;
  }
  function box(slot, x, z) {
    const a = ACTORS[slot], u = W / 2 + F * x / z, v = H / 2 + F * CAM_H / z;
    const hw = F * a.w / 2 / z, h = F * a.h / z;
    return [u - hw, v - h, u + hw, v];
  }

  // the lane geometry of cooper/risk.py
  function rowSpan(poly, y) {
    const xs = [];
    for (let i = 0; i < 4; i++) {
      const [xa, ya] = poly[i], [xb, yb] = poly[(i + 1) % 4];
      if (ya === yb) { if (y === ya) xs.push(xa, xb); }
      else if (y >= Math.min(ya, yb) && y <= Math.max(ya, yb)) xs.push(xa + (xb - xa) * (y - ya) / (yb - ya));
    }
    return xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
  }
  function edgeInLane(poly, x1, x2, y) {
    const span = rowSpan(poly, y);
    if (!span) return false;
    const overlap = Math.min(x2, span[1]) - Math.max(x1, span[0]);
    return overlap > 0 && overlap >= MIN_OVERLAP * Math.max(x2 - x1, 1e-6);
  }

  class MockSource {
    constructor() {
      this.t0 = performance.now() / 1000;
      this.seq = 0;
      this.events = [];
      this.lane = LANE_DEFAULT.map((c) => c.slice());
      this.settings = { conf: 0.4, horizon_s: HORIZON, ttc_warn_s: 2.0, ttc_clear_s: 2.5, hold_s: HOLD };
      this.level = "clear";
      this.lastSeen = { warning: -1e9, danger: -1e9 };
      this.reason = { warning: "", danger: "" };
      this.shown = "clear";
    }

    _pushEvent(type, extra) {
      this.seq += 1;
      this.events.push({ seq: this.seq, t: Date.now() / 1000, type, ...extra });
      if (this.events.length > 200) this.events.shift();
    }

    _sceneTime(t) { return demo in FROZEN_AT ? FROZEN_AT[demo] : t; }

    _objects(ts) {
      const poly = this.lane.map(([x, y]) => [x * W, y * H]);
      const now = positions(ts);
      const out = [];
      for (const slot of Object.keys(now)) {
        const [x, z] = now[slot];
        const b = box(slot, x, z);
        if (b[2] < 0 || b[0] > W || b[3] - b[1] < 3) continue;
        const cb = [clamp(b[0], 0, W - 1), clamp(b[1], 0, H - 1), clamp(b[2], 0, W - 1), clamp(b[3], 0, H - 1)].map(Math.round);
        const id = Number(slot) * 100 + 1;
        const name = `${ACTORS[slot].label} #${id}`;
        const path = [];
        let timeToLane = null;
        for (let k = 1; k <= Math.round(this.settings.horizon_s / STEP); k++) {
          const future = positions(ts + k * STEP)[slot];
          if (!future) break;
          const fb = box(slot, future[0], future[1]);
          path.push([round1((fb[0] + fb[2]) / 2), round1(fb[3])]);
          if (timeToLane === null && edgeInLane(poly, fb[0], fb[2], fb[3])) timeToLane = round1(k * STEP);
        }
        const o = { id, label: ACTORS[slot].label, conf: 0.9, box: cb, level: "clear", kind: null, reason: "",
                    path, velocity: [0, 0], ttc_s: null, time_to_lane_s: null };
        if (path.length) o.velocity = [round1((path[0][0] - (b[0] + b[2]) / 2) / STEP), round1((path[0][1] - b[3]) / STEP)];
        if (edgeInLane(poly, cb[0], cb[2], cb[3])) Object.assign(o, { level: "danger", kind: "in_lane", reason: `${name} in your lane` });
        else if (timeToLane !== null) Object.assign(o, { level: "warning", kind: "path", time_to_lane_s: timeToLane, reason: `${name} heading into your lane in ${timeToLane.toFixed(1)} s` });
        out.push(o);
      }
      return out;
    }

    _judge(objects, t) {
      const danger = objects.filter((o) => o.level === "danger").sort((a, b) => b.box[3] - a.box[3]);
      const warning = objects.filter((o) => o.level === "warning").sort((a, b) => a.time_to_lane_s - b.time_to_lane_s);
      if (danger.length) { this.lastSeen.danger = this.lastSeen.warning = t; this.reason.danger = danger[0].reason; }
      else if (warning.length) { this.lastSeen.warning = t; this.reason.warning = warning[0].reason; }
      const hold = this.settings.hold_s;
      const level = t - this.lastSeen.danger < hold ? "danger" : t - this.lastSeen.warning < hold ? "warning" : "clear";
      if (level !== this.shown) {
        this.shown = level;
        this._pushEvent("risk_changed", { level, reason: level === "clear" ? "" : this.reason[level] });
      }
      return { level, reason: level === "clear" ? "" : this.reason[level] };
    }

    _diag(t, fps) {
      const hot = demo === "hot", cam = demo !== "nocam";
      return {
        cpu_temp_c: hot ? round1(82 + Math.sin(t) * 0.6) : round1(58.5 + 2.5 * Math.sin(t * 0.05)),
        throttled: hot ? 0x50005 : 0,
        fps: cam ? fps : null,
        capture_fps: cam ? 30.0 : null,
        infer_ms: cam ? round1(52 + 6 * Math.sin(t * 1.3)) : null,
        latency_ms: cam ? round1(66 + 8 * Math.sin(t * 0.9)) : null,
        leds: "mock",
        uptime_s: round1(3605 + t),
      };
    }

    async getStatus() {
      const t = performance.now() / 1000 - this.t0;
      if (demo === "expired") throw { kind: "expired" };
      if (demo === "offline" && t > 4) throw { kind: "offline" };
      const fps = round1(14.5 + Math.sin(t * 3) * 0.8);
      const base = { server_time: Date.now() / 1000, diag: this._diag(t, fps) };
      if (demo === "nocam") return base;
      const objects = this._objects(this._sceneTime(t));
      const risk = this._judge(objects, t);
      const frozen = demo === "stale" && t > 3;
      return {
        ...base,
        frame_seq: frozen ? 42 : Math.floor(t * 14),
        fps,
        frame: { w: W, h: H },
        objects,
        risk,
        leds: { yellow: risk.level === "warning", red: risk.level === "danger", mode: "mock" },
        lane: this.lane.map((c) => c.slice()),
      };
    }

    async getEvents(since) {
      return { events: this.events.filter((e) => e.seq > (since || 0)) };
    }

    async getSettings() {
      return { settings: { ...this.settings }, ranges: RANGES, lane: this.lane, lane_default: LANE_DEFAULT, file: "cooper.toml (mock)" };
    }

    async postSettings(body) {
      const next = { ...this.settings };
      const changed = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === "save") continue;
        if (!(k in this.settings)) return { ok: false, error: `unknown setting '${k}'` };
        if (typeof v !== "number" || !isFinite(v)) return { ok: false, error: `${k} must be a number` };
        const [lo, hi] = RANGES[k];
        if (v < lo || v > hi) return { ok: false, error: `${k}: ${v} is outside ${lo}..${hi}` };
        if (next[k] !== v) changed[k] = v;
        next[k] = v;
      }
      if (next.ttc_warn_s >= next.ttc_clear_s) return { ok: false, error: "ttc_warn_s: must be below ttc_clear_s" };
      this.settings = next;
      const saved = !!body.save;
      if (Object.keys(changed).length || saved) this._pushEvent("settings_changed", { changed, saved });
      return { ok: true, settings: { ...this.settings }, saved };
    }

    async postLane(lane, save) {
      const flat = [].concat(...lane);
      if (lane.length !== 4 || flat.length !== 8 || flat.some((v) => typeof v !== "number" || v < 0 || v > 1)) {
        return { ok: false, error: "lane corners are fractions of the frame, 0..1" };
      }
      this.lane = lane.map((c) => c.slice());
      this._pushEvent("lane_changed", { lane: this.lane, saved: !!save });
      return { ok: true, lane: this.lane, saved: !!save };
    }
  }

  global.COOPER_MOCK = MockSource;
  global.COOPER_DEMO = demo;
})(window);
