"""Full-app rehearsal with no hardware at all: the real coop.main loop, a synthetic scene
seen through a camera that turns with the fake Uno's shaft, and the fake Uno itself.

    python -m tools.rehearsal            # then open http://localhost:8000

Everything between the camera and the motors is the real code: FrameGrabber, the
tracker's world-angle maths, the Kalman lead, Control, the API, the Gimbal and its serial
protocol. Only the pixels are synthetic: a person (an orange block) walks back and forth
across +-25 degrees, and the "camera" renders it where it would appear given the physical
angle of the emulated shaft. So if tracking works here, it closes the loop: the dashboard
should show the camera following the walker, and E-STOP/ZERO/settings all act on the
emulated motor. Try `--invert` to see what a wrong motor direction looks like (it runs
away to a limit; press E-STOP).

Options: --port (dashboard), --uno-port (fake Uno TCP port, 0 = any), --walk-deg,
--period-s, --invert.
"""
import argparse
import math
import sys
import threading
import time
from pathlib import Path

if __package__ in (None, ""):  # allow `python tools/rehearsal.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from coop.detector import Detection
from tools.fake_uno import FakeUnoServer

WALKER_BGR = (0, 110, 255)  # orange, easy to threshold
BACKGROUND = 28


class World:
    """A person walking along pan(t) = walk_deg * sin(2 pi t / period_s), seen by a camera
    whose pan is the fake Uno's physical rotor angle."""

    def __init__(self, uno, steps_per_deg, walk_deg=25.0, period_s=12.0):
        self.uno = uno
        self.steps_per_deg = steps_per_deg
        self.walk_deg = walk_deg
        self.period_s = period_s
        self.t0 = time.monotonic()

    def walker_pan(self, t=None):
        t = time.monotonic() - self.t0 if t is None else t
        return self.walk_deg * math.sin(2 * math.pi * t / self.period_s)

    def camera_pan(self):
        with self.uno.lock:
            return self.uno.model.axes[0].rotor / self.steps_per_deg


class SyntheticCamera:
    """Renders what a camera pointing at World.camera_pan() sees. Same interface as
    coop.camera.Camera. `stop` (a threading.Event) ends the run like Ctrl+C."""

    def __init__(self, world, cfg, stop=None, fps=30.0):
        self.world, self.cfg = world, cfg
        self.stop = stop or threading.Event()
        self.period = 1.0 / fps
        self._next = time.monotonic()

    def read(self):
        if self.stop.is_set():
            raise KeyboardInterrupt
        delay = self._next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self._next = max(self._next + self.period, time.monotonic())
        w, h = self.cfg.width, self.cfg.height
        frame = np.full((h, w, 3), BACKGROUND, np.uint8)
        offset = self.world.walker_pan() - self.world.camera_pan()
        half = math.radians(self.cfg.hfov_deg / 2)
        if abs(offset) < 85:
            x = w / 2 + (w / 2) * math.tan(math.radians(offset)) / math.tan(half)
            bw, bh = w // 14, h // 3
            x1, y1 = int(x - bw / 2), int(h / 2 - bh / 2)
            cv2.rectangle(frame, (x1, y1), (x1 + bw, y1 + bh), WALKER_BGR, -1)
        return frame

    def close(self):
        pass


class SyntheticDetector:
    """Finds the orange walker by colour. Same interface as coop.detector.Detector."""

    def __init__(self, cfg=None):
        self.cfg = cfg

    def detect(self, frame):
        lo = np.array([max(c - 30, 0) for c in WALKER_BGR], np.uint8)
        hi = np.array([min(c + 30, 255) for c in WALKER_BGR], np.uint8)
        mask = cv2.inRange(frame, lo, hi)
        points = cv2.findNonZero(mask)
        if points is None or len(points) < 50:
            return []
        x, y, bw, bh = cv2.boundingRect(points)
        return [Detection(1, "person", 0.9, (x, y, x + bw, y + bh))]


def patch_main(main_module, world, stop):
    """Swap coop.main's Camera and Detector for the synthetic ones."""
    main_module.Camera = lambda cfg: SyntheticCamera(world, cfg, stop)
    main_module.Detector = SyntheticDetector


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run COOP against a synthetic scene and a fake Uno.")
    parser.add_argument("--port", type=int, default=8000, help="dashboard port")
    parser.add_argument("--uno-port", type=int, default=0, help="fake Uno TCP port (0 = any free one)")
    parser.add_argument("--walk-deg", type=float, default=25.0)
    parser.add_argument("--period-s", type=float, default=12.0)
    parser.add_argument("--invert", action="store_true",
                        help="configure pan_invert=true on a correctly wired motor (shows a runaway)")
    args = parser.parse_args(argv)

    import coop.main
    from coop.settings import load_config

    uno = FakeUnoServer(port=args.uno_port, boot_delay_s=0.3).start()
    m = load_config().motors  # same gearing as the app will use
    world = World(uno, m.steps_per_rev * m.microsteps / 360.0 * m.pan_gear_ratio, args.walk_deg, args.period_s)
    stop = threading.Event()
    patch_main(coop.main, world, stop)
    print(f"Fake Uno on {uno.url}. Dashboard: http://localhost:{args.port}  (Ctrl+C to quit)")
    sys.argv = ["coop.main", "--motor-port", uno.url, "--port", str(args.port)]
    if args.invert:
        # Applied after coop.toml is loaded: a live change, exactly as the dashboard would.
        print("pan_invert will be set to true once running (stop mode required).")
        threading.Thread(target=_invert_later, args=(args.port,), daemon=True).start()
    try:
        coop.main.main()
    finally:
        uno.close()


def _invert_later(port):
    import json
    import urllib.request

    def post(path, body):
        req = urllib.request.Request(f"http://localhost:{port}{path}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=2).read()

    for _ in range(50):
        try:
            post("/api/mode", {"mode": "stop"})
            post("/api/settings", {"pan_invert": True})
            post("/api/mode", {"mode": "auto"})
            return
        except OSError:
            time.sleep(0.2)


if __name__ == "__main__":
    main()
