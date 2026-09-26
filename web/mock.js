// COOP mock data source: stands in for /api/* (docs/API.md) when no backend answers.
// Actors move in world angles and are projected through the simulated gimbal with the
// same pinhole model as coop/main.py, so auto mode really centers the target and the
// Kalman-style lead shows up exactly as it would on the rig. Pan-only, like the build.
//
// Demo the designed states without hardware: open the dashboard with ?demo=<state>
//   nocam        the camera never delivers a frame
//   reconnecting the Arduino is unplugged (serial "reconnecting")
//   expired      the Cloudflare Access session ran out
//   offline      the Pi stops answering after a few seconds
//   stale        the server answers but the vision loop froze
//   estop        starts with the e-stop engaged
//   notarget     nobody in view
//   hot          CPU at 82 °C and throttling
(function (global) {
  "use strict";

  const FRAME = { w: 640, h: 480, hfov_deg: 63.0, vfov_deg: 49.0 };
  const PAN_LIMITS = [-170, 170];
  const STEPS_PER_DEG = 4.444;
  const DEG = Math.PI / 180;
  const IDLE_DISABLE_S = 20;
  const ESTOP_ERROR = "e-stop engaged; POST /api/arm first";

  const RANGES = {
    lead_time_s: [0.0, 1.0],
    deadband_deg: [0.0, 10.0],
    conf: [0.05, 0.95],
    max_steps_per_sec: [50.0, 4000.0],
    accel_steps_per_sec2: [100.0, 50000.0],
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;
  const demo = (new URLSearchParams(global.location ? global.location.search : "").get("demo") || "").toLowerCase();

  function toPx(dPan, dTilt) {
    return {
      x: FRAME.w / 2 + (FRAME.w / 2) * Math.tan(dPan * DEG) / Math.tan((FRAME.hfov_deg / 2) * DEG),
      y: FRAME.h / 2 - (FRAME.h / 2) * Math.tan(dTilt * DEG) / Math.tan((FRAME.vfov_deg / 2) * DEG),
    };
  }

  // World-angle paths: pan swings wide so the camera has to turn to follow.
  const ACTORS = [
    { id: 1, label: "person", pan: (t) => 35 * Math.sin(t * 0.32), tilt: (t) => -4 + 2 * Math.sin(t * 0.9),
      conf: (t) => 0.82 + 0.12 * Math.sin(t * 0.6), wDeg: 10, hDeg: 22 },
    { id: 2, label: "car", pan: (t) => -40 + 70 * ((t * 0.05) % 1), tilt: () => -12,
      conf: (t) => 0.6 + 0.2 * Math.sin(t * 0.4 + 2), wDeg: 20, hDeg: 9 },
  ];

  class MockSource {
    constructor() {
      this.t0 = performance.now() / 1000;
      this.lastT = 0;
      this.mode = "auto";
      this.lockedId = null;
      this.pan = 0;
      this.aim = 0;
      this.zeroOffset = 0;            // world angle that the rig currently calls pan 0
      this.seq = 0;
      this.events = [];
      this.trackId = null;
      this.prevWorld = null;
      this.vel = [0, 0];
      this.estop = demo === "estop";
      this.driversEnabled = !this.estop;
      this.stopSince = null;
      this.settings = {
        lead_time_s: 0.15, deadband_deg: 1.0, conf: 0.4,
        max_steps_per_sec: 2000.0, accel_steps_per_sec2: 6000.0, pan_invert: false,
      };
      if (this.estop) this.mode = "stop";
      this._pushEvent("mode_changed", { mode: this.mode });
      if (this.estop) this._pushEvent("estop", {});
      if (demo === "reconnecting") this._pushEvent("motor_disconnected", {});
    }

    _pushEvent(type, extra) {
      this.seq += 1;
      this.events.push({ seq: this.seq, t: Date.now() / 1000, type, ...extra });
      if (this.events.length > 200) this.events.shift();
    }

    _detections(t) {
      if (demo === "notarget" || demo === "nocam") return [];
      const out = [];
      for (const a of ACTORS) {
        const p = a.pan(t) - this.zeroOffset, q = a.tilt(t);
        const tl = toPx(p - a.wDeg / 2 - this.pan, q + a.hDeg / 2);
        const br = toPx(p + a.wDeg / 2 - this.pan, q - a.hDeg / 2);
        if (Math.abs(p - this.pan) > 75 || br.x < 0 || tl.x > FRAME.w || br.y < 0 || tl.y > FRAME.h) continue;
        out.push({
          id: a.id, label: a.label, conf: Math.round(clamp(a.conf(t), 0.3, 0.98) * 100) / 100,
          box: [tl.x, tl.y, br.x, br.y].map((v, i) => Math.round(clamp(v, 0, i % 2 ? FRAME.h : FRAME.w))),
          _world: [p, q],
        });
      }
      return out;
    }

    _diag(t, fps) {
      const hot = demo === "hot";
      return {
        cpu_temp_c: hot ? round1(82 + Math.sin(t) * 0.6) : round1(58.5 + 2.5 * Math.sin(t * 0.05)),
        throttled: hot ? 0x50005 : 0,
        fps: demo === "nocam" ? null : fps,
        capture_fps: demo === "nocam" ? null : 30.0,
        infer_ms: demo === "nocam" ? null : round1(52 + 6 * Math.sin(t * 1.3)),
        latency_ms: demo === "nocam" ? null : round1(74 + 8 * Math.sin(t * 0.9)),
        serial: demo === "reconnecting" ? "reconnecting" : "mock",
        uptime_s: round1(3605 + t),
      };
    }

    async getStatus() {
      const t = performance.now() / 1000 - this.t0;
      if (demo === "expired") throw { kind: "expired" };
      if (demo === "offline" && t > 4) throw { kind: "offline" };
      const dt = Math.max(0.001, t - this.lastT);
      this.lastT = t;
      const fps = round1(13.5 + Math.sin(t * 3) * 0.8);
      const base = { server_time: Date.now() / 1000, mode: this.mode, estop: this.estop, diag: this._diag(t, fps) };
      if (demo === "nocam") return base;             // no frame published yet: just the basics

      const dets = this._detections(t);
      let target = null;
      if (this.mode !== "stop") {
        target = this.lockedId !== null
          ? dets.find((d) => d.id === this.lockedId) || null
          : dets.find((d) => d.id === this.trackId) || dets.slice().sort((a, b) => b.conf - a.conf)[0] || null;
      }

      if (target && target.id !== this.trackId) {
        this._pushEvent("target_acquired", { id: target.id, label: target.label });
        this.trackId = target.id;
        this.prevWorld = null;
        this.vel = [0, 0];
      } else if (!target && this.trackId !== null) {
        this._pushEvent("target_lost", { id: this.trackId });
        if (this.lockedId !== null) this.lockedId = null;
        this.trackId = null;
        this.prevWorld = null;
      }

      if (target) {
        // Finite-difference velocity with EMA smoothing, standing in for the Kalman filter.
        if (this.prevWorld) {
          for (let i = 0; i < 2; i++) {
            const raw = (target._world[i] - this.prevWorld[i]) / dt;
            this.vel[i] = 0.7 * this.vel[i] + 0.3 * raw;
          }
        }
        this.prevWorld = target._world.slice();
      }

      if (this.mode === "auto" && target) {
        this.aim = clamp(target._world[0] + this.vel[0] * this.settings.lead_time_s, ...PAN_LIMITS);
      } else if (this.mode === "stop") {
        this.aim = this.pan;
      }

      // Motors: frozen while the Arduino is away, the e-stop is on, or in stop mode.
      const canMove = this.mode !== "stop" && !this.estop && demo !== "reconnecting";
      if (canMove) {
        const maxSlew = this.settings.max_steps_per_sec / STEPS_PER_DEG;
        const step = maxSlew * dt;
        const err = this.aim - this.pan;
        if (Math.abs(err) >= this.settings.deadband_deg || this.mode === "manual") this.pan += clamp(err, -step, step);
      }

      // Idle power-down after a while in stop mode (the real rig does this so motors stay cool).
      if (this.mode === "stop" && !this.estop) {
        if (this.stopSince === null) this.stopSince = t;
        if (this.driversEnabled && t - this.stopSince > IDLE_DISABLE_S) {
          this.driversEnabled = false;
          this._pushEvent("motors_idle", { after_s: IDLE_DISABLE_S });
        }
      } else {
        this.stopSince = null;
        if (!this.estop) this.driversEnabled = true;
      }

      const frozen = demo === "stale" && t > 3;
      const strip = (d) => ({ id: d.id, label: d.label, conf: d.conf, box: d.box });
      return {
        ...base,
        frame_seq: frozen ? Math.floor(3 * 14) : Math.floor(t * 14),
        fps,
        frame: { ...FRAME },
        target: target ? { ...strip(target), locked: target.id === this.lockedId } : null,
        detections: dets.map(strip),
        gimbal: {
          pan: round1(this.pan), tilt: 0,
          target_pan: round1(this.aim), target_tilt: 0,
          pan_limits: PAN_LIMITS, tilt_limits: [0, 0],
          tilt_enabled: false,
          mock: demo !== "reconnecting",
          drivers_enabled: this.driversEnabled && demo !== "reconnecting",
        },
        velocity_deg_s: target ? this.vel.map(round1) : [0, 0],
      };
    }

    async getEvents(since) {
      return { events: this.events.filter((e) => e.seq > (since || 0)) };
    }

    _fail(error) { return { ok: false, error }; }

    async postMode(mode) {
      if (!["auto", "manual", "stop"].includes(mode)) return this._fail("bad mode");
      if (this.estop && mode !== "stop") return this._fail(ESTOP_ERROR);
      if (mode !== this.mode) {
        this.mode = mode;
        this._pushEvent("mode_changed", { mode });
      }
      if (mode === "manual") this.aim = this.pan;
      return { ok: true };
    }

    async postTarget(id) {
      if (this.estop && id !== null) return this._fail(ESTOP_ERROR);
      this.lockedId = id;
      if (id !== null && this.mode !== "auto") await this.postMode("auto");
      return { ok: true };
    }

    async postAim(pan) {
      if (this.mode !== "manual") return this._fail("aim only in manual");
      this.aim = clamp(pan, ...PAN_LIMITS);
      return { ok: true };
    }

    async postNudge(dpan) {
      if (this.mode !== "manual") return this._fail("nudge only in manual");
      return this.postAim(this.aim + dpan);
    }

    async postHome() {
      if (this.estop) return this._fail(ESTOP_ERROR);
      await this.postMode("manual");
      return this.postAim(0);
    }

    async postEstop() {
      if (!this.estop) {
        this.estop = true;
        this.driversEnabled = false;
        this.lockedId = null;
        if (this.mode !== "stop") { this.mode = "stop"; this._pushEvent("mode_changed", { mode: "stop" }); }
        this._pushEvent("estop", {});
      }
      this.aim = this.pan;
      return { ok: true };
    }

    async postArm() {
      if (this.estop) {
        this.estop = false;
        this.driversEnabled = true;
        this.stopSince = null;
        this._pushEvent("armed", {});
      }
      return { ok: true };
    }

    async postZero() {
      this.zeroOffset += this.pan;
      this.pan = 0;
      this.aim = 0;
      this.lockedId = null;
      this._pushEvent("zeroed", {});
      if (!this.estop && this.mode !== "manual") { this.mode = "manual"; this._pushEvent("mode_changed", { mode: "manual" }); }
      return { ok: true };
    }

    async getSettings() {
      return { settings: { ...this.settings }, ranges: RANGES, steps_per_deg: STEPS_PER_DEG, file: "coop.toml (mock)" };
    }

    async postSettings(body) {
      const next = { ...this.settings };
      const changed = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === "save") continue;
        if (!(k in this.settings)) return this._fail(`unknown setting: ${k}`);
        if (k === "pan_invert") {
          if (typeof v !== "boolean") return this._fail("pan_invert must be a boolean");
          if (v !== this.settings.pan_invert && this.mode !== "stop") return this._fail("pan_invert can only change in stop mode");
        } else {
          if (typeof v !== "number" || !isFinite(v)) return this._fail(`${k} must be a number`);
          const [lo, hi] = RANGES[k];
          if (v < lo || v > hi) return this._fail(`${k} must be between ${lo} and ${hi}`);
        }
        if (next[k] !== v) changed[k] = v;
        next[k] = v;
      }
      this.settings = next;
      const saved = !!body.save;
      if (Object.keys(changed).length || saved) this._pushEvent("settings_changed", { changed, saved });
      return { ok: true, settings: { ...this.settings }, saved };
    }
  }

  global.COOP_MOCK = MockSource;
  global.COOP_DEMO = demo;
})(window);
