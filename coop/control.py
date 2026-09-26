"""Shared control state for the tracking loop and the HTTP API.

Holds the operating mode, the operator's target lock, the manual pan setpoint, and the
event log described in docs/API.md. One Control instance is created in coop/main.py and
handed to both the tracking loop and coop.stream's Flask app, so it's the single
thread-safe hub between "what the operator asked for" and "what the camera is doing".

See the "Requests" section of docs/TERMINALS.md for how coop/main.py wires this in.
"""
from __future__ import annotations

import math
import threading
import time
from collections import deque

MODES = ("auto", "manual", "stop")
EVENT_LOG_SIZE = 200
ESTOP_ERROR = "e-stop engaged; POST /api/arm first"


class ControlError(ValueError):
    """A control request was invalid: bad mode, wrong type, or aim/nudge outside manual mode."""


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ControlError("angles must be finite numbers")
    return float(value)


def _clamp(value, limits):
    lo, hi = limits
    return min(max(value, lo), hi)


class Control:
    def __init__(self, motors_cfg):
        self._motors_cfg = motors_cfg
        self._lock = threading.Lock()
        self._mode = "auto"
        self._locked_id = None
        self._manual_pan = 0.0  # degrees, meaningful only in "manual" (the build is pan-only)
        self._events = deque(maxlen=EVENT_LOG_SIZE)
        self._next_seq = 1
        self._estopped = False
        self._gimbal = None
        # Serializes estop/arm/zero end to end (motor command + state), so an e-stop can't
        # land between an arm's check and its effect and be silently undone.
        self._safety_lock = threading.Lock()

    def bind_gimbal(self, gimbal):
        """Give Control the Gimbal so e-stop/arm/zero reach the motors immediately, without
        waiting for the vision loop's next frame (which may never come if the camera hung).
        Control only calls the gimbal outside its own lock."""
        self._gimbal = gimbal

    # ---- read (main.py's loop, and stream.py's /api/status and /api/events) ----

    @property
    def mode(self):
        with self._lock:
            return self._mode

    @property
    def locked_id(self):
        with self._lock:
            return self._locked_id

    @property
    def estopped(self):
        with self._lock:
            return self._estopped

    @property
    def manual_pan(self):
        with self._lock:
            return self._manual_pan

    def events_since(self, since):
        with self._lock:
            return [e for e in self._events if e["seq"] > since]

    # ---- mutators (stream.py's route handlers) ----

    def set_mode(self, mode):
        if mode not in MODES:
            raise ControlError(f"mode must be one of {MODES}")
        # Read outside our lock (Control never holds its lock while calling the gimbal).
        pan_now = self._gimbal.pan if self._gimbal is not None and mode == "manual" else None
        with self._lock:
            if mode != "stop":
                self._check_not_estopped_locked()
            if mode == "manual" and self._mode != "manual" and pan_now is not None:
                # Hold where the camera is, rather than jumping to an old manual setpoint.
                self._manual_pan = _clamp(pan_now, self._motors_cfg.pan_limits_deg)
            self._set_mode_locked(mode)

    def set_target(self, track_id):
        if track_id is not None and (not isinstance(track_id, int) or isinstance(track_id, bool)):
            raise ControlError("id must be an integer or null")
        with self._lock:
            if track_id is not None:
                self._check_not_estopped_locked()
            self._locked_id = track_id
            if track_id is not None:
                self._set_mode_locked("auto")

    def set_aim(self, pan):
        pan = _finite(pan)
        with self._lock:
            if self._mode != "manual":
                raise ControlError("aim requires manual mode")
            self._manual_pan = _clamp(pan, self._motors_cfg.pan_limits_deg)

    def nudge(self, dpan):
        dpan = _finite(dpan)
        with self._lock:
            if self._mode != "manual":
                raise ControlError("nudge requires manual mode")
            self._manual_pan = _clamp(self._manual_pan + dpan, self._motors_cfg.pan_limits_deg)

    def home(self):
        with self._lock:
            self._check_not_estopped_locked()
            self._manual_pan = 0.0
            self._set_mode_locked("manual")

    def estop(self):
        """Emergency stop: the motors first, then mode -> stop and the lock cleared.
        Stays engaged (moving requests fail) until arm()."""
        with self._safety_lock:
            if self._gimbal is not None:
                self._gimbal.estop()
            with self._lock:
                first = not self._estopped
                self._estopped = True
                self._locked_id = None
                self._set_mode_locked("stop")
                if first:
                    self._log_locked("estop")

    def arm(self):
        """Release the e-stop. The mode stays "stop"; the operator picks the next one."""
        with self._safety_lock:
            with self._lock:
                if not self._estopped:
                    return False
            if self._gimbal is not None:
                self._gimbal.arm()
            with self._lock:
                self._estopped = False
                self._log_locked("armed")
            return True

    def zero(self):
        """"Set zero here": the current position becomes pan 0. Outside an e-stop this also
        switches to manual aimed at 0, so nothing moves."""
        with self._safety_lock:
            if self._gimbal is not None:
                self._gimbal.zero()
            with self._lock:
                self._manual_pan = 0.0
                self._locked_id = None
                if not self._estopped:
                    self._set_mode_locked("manual")
                self._log_locked("zeroed")

    def _check_not_estopped_locked(self):
        if self._estopped:
            raise ControlError(ESTOP_ERROR)

    def _set_mode_locked(self, mode):
        if mode == self._mode:
            return
        self._mode = mode
        self._log_locked("mode_changed", mode=mode)

    # ---- event log (also called by coop/main.py and coop/motors.py) ----

    def log_event(self, event_type, **fields):
        with self._lock:
            self._log_locked(event_type, **fields)

    def _log_locked(self, event_type, **fields):
        event = {"seq": self._next_seq, "t": time.time(), "type": event_type, **fields}
        self._next_seq += 1
        self._events.append(event)
