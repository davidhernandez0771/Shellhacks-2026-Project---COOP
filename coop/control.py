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
        with self._lock:
            self._set_mode_locked(mode)

    def set_target(self, track_id):
        if track_id is not None and not isinstance(track_id, int):
            raise ControlError("id must be an integer or null")
        with self._lock:
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
            self._manual_pan = 0.0
            self._set_mode_locked("manual")

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
