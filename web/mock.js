// COOP mock data source: stands in for /api/* (docs/API.md) when no backend answers.
// Actors move in world angles and are projected through the simulated gimbal with the
// same pinhole model as coop/main.py, so auto mode really centers the target and the
// Kalman-style lead shows up exactly as it would on the rig.
(function (global) {
  "use strict";

  const FRAME = { w: 640, h: 480, hfov_deg: 63.0, vfov_deg: 49.0 };
  const PAN_LIMITS = [-170, 170];
  const TILT_LIMITS = [-30, 45];
  const LEAD_S = 0.15;
  const MAX_SLEW_DEG_S = 90;
  const DEG = Math.PI / 180;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round1 = (v) => Math.round(v * 10) / 10;

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
      this.tilt = 0;
      this.aim = [0, 0];
      this.seq = 0;
      this.events = [];
      this.trackId = null;
      this.prevWorld = null;
      this.vel = [0, 0];
      this._pushEvent("mode_changed", { mode: this.mode });
    }

    _pushEvent(type, extra) {
      this.seq += 1;
      this.events.push({ seq: this.seq, t: Date.now() / 1000, type, ...extra });
      if (this.events.length > 200) this.events.shift();
    }

    _detections(t) {
      const out = [];
      for (const a of ACTORS) {
        const p = a.pan(t), q = a.tilt(t);
        const tl = toPx(p - a.wDeg / 2 - this.pan, q + a.hDeg / 2 - this.tilt);
        const br = toPx(p + a.wDeg / 2 - this.pan, q - a.hDeg / 2 - this.tilt);
        if (br.x < 0 || tl.x > FRAME.w || br.y < 0 || tl.y > FRAME.h) continue;
        out.push({
          id: a.id, label: a.label, conf: Math.round(clamp(a.conf(t), 0.3, 0.98) * 100) / 100,
          box: [tl.x, tl.y, br.x, br.y].map((v, i) => Math.round(clamp(v, 0, i % 2 ? FRAME.h : FRAME.w))),
          _world: [p, q],
        });
      }
      return out;
    }

    async getStatus() {
      const t = performance.now() / 1000 - this.t0;
      const dt = Math.max(0.001, t - this.lastT);
      this.lastT = t;
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
        this.aim = [
          clamp(target._world[0] + this.vel[0] * LEAD_S, ...PAN_LIMITS),
          0, // tilt disabled, matching the default rig
        ];
      } else if (this.mode === "stop") {
        this.aim = [this.pan, this.tilt];
      }

      if (this.mode !== "stop") {
        const step = MAX_SLEW_DEG_S * dt;
        this.pan += clamp(this.aim[0] - this.pan, -step, step);
        this.tilt += clamp(this.aim[1] - this.tilt, -step, step);
      }

      const strip = (d) => ({ id: d.id, label: d.label, conf: d.conf, box: d.box });
      return {
        server_time: Date.now() / 1000,
        frame_seq: Math.floor(t * 14),
        fps: round1(13.5 + Math.sin(t * 3) * 0.8),
        mode: this.mode,
        frame: { ...FRAME },
        target: target ? { ...strip(target), locked: target.id === this.lockedId } : null,
        detections: dets.map(strip),
        gimbal: {
          pan: round1(this.pan), tilt: round1(this.tilt),
          target_pan: round1(this.aim[0]), target_tilt: round1(this.aim[1]),
          pan_limits: PAN_LIMITS, tilt_limits: TILT_LIMITS,
          tilt_enabled: false,
          mock: true,
        },
        velocity_deg_s: target ? this.vel.map(round1) : [0, 0],
      };
    }

    async getEvents(since) {
      return { events: this.events.filter((e) => e.seq > (since || 0)) };
    }

    async postMode(mode) {
      if (mode !== this.mode) {
        this.mode = mode;
        this._pushEvent("mode_changed", { mode });
      }
      if (mode === "manual") this.aim = [this.pan, this.tilt];
      return { ok: true };
    }

    async postTarget(id) {
      this.lockedId = id;
      if (id !== null && this.mode !== "auto") await this.postMode("auto");
      return { ok: true };
    }

    async postAim(pan, tilt) {
      if (this.mode !== "manual") return { ok: false, error: "aim only in manual" };
      this.aim = [clamp(pan, ...PAN_LIMITS), clamp(tilt, ...TILT_LIMITS)];
      return { ok: true };
    }

    async postNudge(dpan, dtilt) {
      if (this.mode !== "manual") return { ok: false, error: "nudge only in manual" };
      return this.postAim(this.aim[0] + dpan, this.aim[1] + dtilt);
    }

    async postHome() {
      await this.postMode("manual");
      return this.postAim(0, 0);
    }
  }

  global.COOP_MOCK = MockSource;
})(window);
