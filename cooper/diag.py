"""Health readouts for /api/status.diag: SoC temperature, throttling, LED mode, uptime, fps.

Everything degrades to None off the Pi (a laptop has no vcgencmd; Windows has no /sys), so
the dashboard can show "n/a" instead of the backend failing.
"""
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

# Every key /api/status.diag always carries (docs/API.md). The vision loop publishes the
# pipeline timings; SystemMonitor.snapshot() supplies the rest at request time.
DIAG_KEYS = ("cpu_temp_c", "throttled", "fps", "capture_fps", "infer_ms", "latency_ms", "leds", "uptime_s")

TEMP_PATH = Path("/sys/class/thermal/thermal_zone0/temp")
# Exposed by the Raspberry Pi firmware driver on Pi OS kernels (hex, no 0x prefix).
THROTTLED_SYSFS = Path("/sys/devices/platform/soc/soc:firmware/get_throttled")


def read_cpu_temp_c(path=TEMP_PATH):
    """SoC temperature in degrees C, or None."""
    try:
        return round(int(Path(path).read_text().strip()) / 1000.0, 1)
    except (OSError, ValueError):
        return None


def read_throttled(run=subprocess.run, which=shutil.which, sysfs=THROTTLED_SYSFS):
    """The `vcgencmd get_throttled` bit field as an int (0 = healthy), or None."""
    if which("vcgencmd"):
        try:
            out = run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=1.0)
            m = re.search(r"throttled=(0x[0-9a-fA-F]+)", out.stdout or "")
            if out.returncode == 0 and m:
                return int(m.group(1), 16)
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        return int(Path(sysfs).read_text().strip(), 16)
    except (OSError, ValueError):
        return None


class SystemMonitor:
    """snapshot() -> {cpu_temp_c, throttled, leds, uptime_s}.

    Temperature and throttling are cached for `ttl_s` (vcgencmd is a subprocess; the
    dashboard polls every ~300 ms). The LED mode ("gpio" or "mock") and uptime are live.
    """

    def __init__(self, ttl_s=2.0, temp_fn=read_cpu_temp_c, throttled_fn=read_throttled, leds_mode=None):
        self._leds_mode = leds_mode or (lambda: None)
        self._ttl_s = ttl_s
        self._temp_fn = temp_fn
        self._throttled_fn = throttled_fn
        self._started = time.monotonic()
        self._lock = threading.Lock()
        self._cached = None
        self._cached_at = 0.0

    def snapshot(self):
        now = time.monotonic()
        with self._lock:
            if self._cached is None or now - self._cached_at >= self._ttl_s:
                self._cached = {"cpu_temp_c": self._temp_fn(), "throttled": self._throttled_fn()}
                self._cached_at = now
            slow = dict(self._cached)
        return {**slow, "leds": self._leds_mode(), "uptime_s": round(now - self._started, 1)}


class RateMeter:
    """Frames per second from frame timestamps: 1 / (moving average of the interval).

    Averaging the interval and then inverting is the right order. Averaging 1/dt instead
    overshoots whenever frames arrive unevenly (a webcam that delivers them in pairs reads
    as hundreds of fps), because the mean of 1/dt is at least 1 / (mean of dt)."""

    def __init__(self, alpha=0.1):
        self.alpha = alpha
        self._last = None
        self._dt = None

    def update(self, t):
        if self._last is not None and t > self._last:
            dt = t - self._last
            self._dt = dt if self._dt is None else (1 - self.alpha) * self._dt + self.alpha * dt
        if self._last is None or t > self._last:
            self._last = t
        return 1.0 / self._dt if self._dt else 0.0
