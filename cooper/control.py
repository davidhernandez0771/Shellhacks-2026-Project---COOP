"""Shared state for the vision loop and the HTTP API: the event log described in docs/API.md.

One Control instance is created in cooper/main.py and handed to both the vision loop and
cooper.stream's Flask app, so it's the single thread-safe hub between them.
"""
from __future__ import annotations

import threading
import time
from collections import deque

EVENT_LOG_SIZE = 200


class Control:
    def __init__(self):
        self._lock = threading.Lock()
        self._events = deque(maxlen=EVENT_LOG_SIZE)
        self._next_seq = 1

    def events_since(self, since):
        with self._lock:
            return [e for e in self._events if e["seq"] > since]

    def log_event(self, event_type, **fields):
        with self._lock:
            event = {"seq": self._next_seq, "t": time.time(), "type": event_type, **fields}
            self._next_seq += 1
            self._events.append(event)
