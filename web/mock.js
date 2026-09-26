// COOP mock data source — stands in for the real /api/* endpoints (docs/API.md)
// until coop/stream.py + coop/control.py exist. Same shapes, generated client-side.
// Swap out: real backend just needs to answer the same JSON and this file stops mattering.
(function (global) {
  "use strict";

  const FRAME = { w: 640, h: 480 };
  const PAN_LIMITS = [-170, 170];
  const TILT_LIMITS = [-30, 45];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  class MockSource {
    constructor() {
      this.t0 = performance.now() / 1000;
      this.mode = "auto";
      this.lockedId = null;
      this.pan = 0;
      this.tilt = 0;
      this.seq = 0;
      this.events = [];
      this._pushEvent("mode_changed", { mode: this.mode });
      this._lastAcquired = null;
      this._fpsJitter = 0;
    }

    _now() { return Date.now() / 1000; }

    _pushEvent(type, extra) {
      this.seq += 1;
      this.events.push({ seq: this.seq, t: this._now(), type, ...extra });
      if (this.events.length > 200) this.events.shift();
    }

    _actors(tSec) {
      // two wandering "detections" inside the frame, deterministic but organic
      const person = {
        id: 1,
        label: "person",
        conf: 0.8 + 0.15 * Math.sin(tSec * 0.6),
        cx: FRAME.w * 0.5 + Math.sin(tSec * 0.35) * FRAME.w * 0.32,
        cy: FRAME.h * 0.55 + Math.sin(tSec * 0.2 + 1) * FRAME.h * 0.12,
        w: 110,
        h: 220,
      };
      const car = {
        id: 2,
        label: "car",
        conf: 0.55 + 0.2 * Math.sin(tSec * 0.4 + 2),
        cx: FRAME.w * 0.5 + Math.cos(tSec * 0.18) * FRAME.w * 0.4,
        cy: FRAME.h * 0.75 + Math.sin(tSec * 0.15) * FRAME.h * 0.06,
        w: 180,
        h: 100,
      };
      return [person, car].map((a) => ({
        id: a.id,
        label: a.label,
        conf: clamp(a.conf, 0.3, 0.98),
        box: [
          Math.round(clamp(a.cx - a.w / 2, 0, FRAME.w)),
          Math.round(clamp(a.cy - a.h / 2, 0, FRAME.h)),
          Math.round(clamp(a.cx + a.w / 2, 0, FRAME.w)),
          Math.round(clamp(a.cy + a.h / 2, 0, FRAME.h)),
        ],
      }));
    }

    async getStatus() {
      const tSec = performance.now() / 1000 - this.t0;
      const detections = this._actors(tSec);

      let target = null;
      if (this.mode !== "stop") {
        const chosen = this.lockedId
          ? detections.find((d) => d.id === this.lockedId)
          : detections.slice().sort((a, b) => b.conf - a.conf)[0];
        if (chosen) {
          target = { ...chosen, locked: chosen.id === this.lockedId };
          if (this._lastAcquired !== chosen.id) {
            this._pushEvent("target_acquired", { id: chosen.id, label: chosen.label });
            this._lastAcquired = chosen.id;
          }
        } else if (this._lastAcquired !== null) {
          this._pushEvent("target_lost", { id: this._lastAcquired });
          this._lastAcquired = null;
        }
      }

      let targetPan = this.pan;
      let targetTilt = this.tilt;
      if (this.mode === "auto" && target) {
        const cx = (target.box[0] + target.box[2]) / 2;
        const cy = (target.box[1] + target.box[3]) / 2;
        const offX = (cx - FRAME.w / 2) / (FRAME.w / 2); // -1..1
        const offY = (cy - FRAME.h / 2) / (FRAME.h / 2);
        targetPan = clamp(this.pan + offX * 20, ...PAN_LIMITS);
        targetTilt = clamp(this.tilt - offY * 10, ...TILT_LIMITS);
      }
      if (this.mode !== "stop") {
        this.pan += (targetPan - this.pan) * 0.08;
        this.tilt += (targetTilt - this.tilt) * 0.08;
      }

      const fps = 13.5 + Math.sin(tSec * 3) * 0.8;

      return {
        server_time: this._now(),
        fps: Math.round(fps * 10) / 10,
        mode: this.mode,
        frame: { w: FRAME.w, h: FRAME.h },
        target,
        detections,
        gimbal: {
          pan: Math.round(this.pan * 10) / 10,
          tilt: Math.round(this.tilt * 10) / 10,
          target_pan: Math.round(targetPan * 10) / 10,
          target_tilt: Math.round(targetTilt * 10) / 10,
          pan_limits: PAN_LIMITS,
          tilt_limits: TILT_LIMITS,
          tilt_enabled: false,
          mock: true,
        },
        velocity_deg_s: [
          Math.round((targetPan - this.pan) * 10) / 10,
          Math.round((targetTilt - this.tilt) * 10) / 10,
        ],
      };
    }

    async getEvents(since) {
      since = since || 0;
      return { events: this.events.filter((e) => e.seq > since) };
    }

    async postMode(mode) {
      this.mode = mode;
      this._pushEvent("mode_changed", { mode });
      return { ok: true };
    }

    async postTarget(id) {
      this.lockedId = id;
      if (id !== null) this.mode = "auto";
      return { ok: true };
    }

    async postAim(pan, tilt) {
      this.pan = clamp(pan, ...PAN_LIMITS);
      this.tilt = clamp(tilt, ...TILT_LIMITS);
      return { ok: true };
    }

    async postNudge(dpan, dtilt) {
      return this.postAim(this.pan + dpan, this.tilt + dtilt);
    }

    async postHome() {
      this.mode = "manual";
      this._pushEvent("mode_changed", { mode: this.mode });
      return this.postAim(0, 0);
    }
  }

  global.COOP_MOCK = MockSource;
})(window);
