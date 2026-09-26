"""Full-app rehearsal with no hardware at all: the real cooper.main loop watching a synthetic
road through a fixed dashcam.

    python -m tools.rehearsal            # then open http://localhost:8000

Everything after the camera is the real code: FrameGrabber, the loop, the API and the
dashboard. Only the pixels are synthetic, and the detector reads them back out of the
rendered frame (each actor is a flat colour), so what the app sees comes from the image.

The scene is a straight road seen from a camera 1.3 m up, looking level down the lane. Actors
live in road coordinates (X metres to the right, Z metres ahead) and are drawn with the
pinhole ground-plane model, so a box's height is proportional to 1/Z exactly as it would be
on the real camera. One 20 s loop:

     0-20 s  a car in the left lane, keeping pace (never in our path)
     0-15 s  a lead car far ahead in our lane (beyond the lane region)
     3-9  s  a car in the right lane cuts in front of us, then pulls away
    10-15 s  a pedestrian runs across the road
    15-19.5  the lead car brakes hard and we close on it

Options: --port (dashboard), --start-s (where in the loop to start), --speed (scene time per
real second), --timeline (no dashboard: run one loop offline and print every risk change).
"""
import argparse
import dataclasses
import math
import sys
import threading
import time
from pathlib import Path

if __package__ in (None, ""):  # allow `python tools/rehearsal.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from cooper.config import Config
from cooper.detector import Detection
from cooper.leds import Leds
from cooper.predictor import Tracks
from cooper.risk import RiskJudge

SKY, ROAD, MARKING = (40, 34, 30), (58, 58, 58), (190, 190, 190)


def _smoothstep(a, b, t):
    """0 before a, 1 after b, smooth in between."""
    x = min(max((t - a) / (b - a), 0.0), 1.0)
    return x * x * (3 - 2 * x)


class RoadScene:
    """The scripted road. `boxes(t)` is the ground truth, `render(t)` the camera frame."""

    LEAD, CUT_IN, PEDESTRIAN, NEIGHBOUR = 1, 2, 3, 4
    # slot: (label, width m, height m, BGR). Saturated colours the markings can't be mistaken for.
    ACTORS = {
        LEAD: ("car", 1.8, 1.5, (0, 110, 255)),
        CUT_IN: ("car", 1.8, 1.5, (255, 120, 0)),
        PEDESTRIAN: ("person", 0.5, 1.7, (60, 220, 60)),
        NEIGHBOUR: ("car", 1.8, 1.5, (200, 0, 200)),
    }
    LANE_WIDTH_M = 3.6

    def __init__(self, width=640, height=480, hfov_deg=63.0, cam_height_m=1.3, period_s=20.0):
        self.width, self.height = width, height
        self.cam_height_m = cam_height_m
        self.period_s = period_s
        self.f = (width / 2) / math.tan(math.radians(hfov_deg / 2))  # focal length in pixels

    # ---- geometry ----

    def project(self, x_m, z_m):
        """Pixel of the road point X metres right, Z metres ahead (horizon at mid-height)."""
        return self.width / 2 + self.f * x_m / z_m, self.height / 2 + self.f * self.cam_height_m / z_m

    def box(self, x_m, z_m, w_m, h_m):
        """Pixel box (x1, y1, x2, y2) of an upright w x h object standing on the road."""
        u, v = self.project(x_m, z_m)
        half_w, h = self.f * w_m / 2 / z_m, self.f * h_m / z_m
        return round(u - half_w), round(v - h), round(u + half_w), round(v)

    # ---- script ----

    def positions(self, t):
        """{slot: (X, Z)} for the actors on the road at scene time t (the loop repeats)."""
        t = t % self.period_s
        lane = self.LANE_WIDTH_M
        out = {self.NEIGHBOUR: (-lane, 9.0 + 2.0 * math.sin(2 * math.pi * t / 10.0))}
        if t < 15.0:
            out[self.LEAD] = (0.0, 40.0)
        elif t < 19.5:
            s = (t - 15.0) / 4.5
            out[self.LEAD] = (0.0, 40.0 - 33.0 * s * s)  # closing faster and faster: it's braking
        if 3.0 <= t < 9.0:
            x = lane * (1.0 - _smoothstep(4.0, 7.0, t))
            z = 10.0 + 15.0 * _smoothstep(7.5, 9.0, t)
            out[self.CUT_IN] = (x, z)
        if 10.0 <= t < 15.0:
            out[self.PEDESTRIAN] = (-7.0 + 14.0 * (t - 10.0) / 5.0, 11.0)
        return out

    def boxes(self, t):
        """{slot: (label, box)} of what's in frame, boxes clipped to it (x2, y2 inclusive)."""
        out = {}
        for slot, (x, z) in self.positions(t).items():
            label, w_m, h_m, _ = self.ACTORS[slot]
            x1, y1, x2, y2 = self.box(x, z, w_m, h_m)
            x1, y1 = max(x1, 0), max(y1, 0)
            x2, y2 = min(x2, self.width - 1), min(y2, self.height - 1)
            if x2 - x1 >= 3 and y2 - y1 >= 3:
                out[slot] = (label, (x1, y1, x2, y2))
        return out

    # ---- pixels ----

    def render(self, t):
        w, h = self.width, self.height
        frame = np.empty((h, w, 3), np.uint8)
        frame[: h // 2] = SKY
        frame[h // 2:] = ROAD
        # Lane markings between the lanes, dashes flowing towards us (we drive at ~15 m/s).
        for x in (-1.5 * self.LANE_WIDTH_M, -0.5 * self.LANE_WIDTH_M,
                  0.5 * self.LANE_WIDTH_M, 1.5 * self.LANE_WIDTH_M):
            phase = (t * 15.0) % 6.0
            for k in range(12):
                z_near = 3.0 + k * 6.0 - phase
                if z_near < 2.9:
                    continue
                a = tuple(round(c) for c in self.project(x, z_near))
                b = tuple(round(c) for c in self.project(x, z_near + 3.0))
                cv2.line(frame, a, b, MARKING, 2)
        positions = self.positions(t)
        visible = self.boxes(t)
        for slot in sorted(visible, key=lambda s: -positions[s][1]):  # far to near
            _, (x1, y1, x2, y2) = visible[slot]
            cv2.rectangle(frame, (x1, y1), (x2, y2), self.ACTORS[slot][3], -1)
        return frame


class SceneCamera:
    """Renders the scene in (scaled) real time. Same interface as cooper.camera.Camera.
    `stop` (a threading.Event) or `frames` reads end the run like Ctrl+C."""

    def __init__(self, scene, stop=None, fps=30.0, start_s=0.0, speed=1.0, frames=None):
        self.scene = scene
        self.stop = stop or threading.Event()
        self.period = 1.0 / fps
        self.start_s, self.speed, self.frames = start_s, speed, frames
        self.reads = 0
        self._t0 = self._next = time.monotonic()

    def read(self):
        self.reads += 1
        if self.stop.is_set() or (self.frames is not None and self.reads > self.frames):
            raise KeyboardInterrupt
        delay = self._next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self._next = max(self._next + self.period, time.monotonic())
        return self.scene.render(self.start_s + (time.monotonic() - self._t0) * self.speed)

    def close(self):
        pass


class SceneDetector:
    """Finds each actor by its colour. Same interface as cooper.detector.Detector.

    Track IDs behave like ByteTrack's: stable while an actor stays visible, new when it
    reappears. ID = slot * 100 + appearance count.
    """

    TOLERANCE = 25
    MIN_PIXELS = 30

    def __init__(self, cfg=None):
        self.cfg = cfg
        self._seen = set()
        self._appearances = {}

    def detect(self, frame):
        found = []
        for slot, (label, _, _, bgr) in RoadScene.ACTORS.items():
            lo = np.array([max(c - self.TOLERANCE, 0) for c in bgr], np.uint8)
            hi = np.array([min(c + self.TOLERANCE, 255) for c in bgr], np.uint8)
            points = cv2.findNonZero(cv2.inRange(frame, lo, hi))
            if points is None or len(points) < self.MIN_PIXELS:
                continue
            if slot not in self._seen:
                self._appearances[slot] = self._appearances.get(slot, 0) + 1
            x, y, bw, bh = cv2.boundingRect(points)
            track_id = slot * 100 + self._appearances[slot] % 100
            found.append(Detection(track_id, label, 0.9, (x, y, x + bw - 1, y + bh - 1)))
        self._seen = {d.track_id // 100 for d in found}
        return found


class SimFrame:
    """One simulated frame: its time, the risk output, every object's risk, the LEDs."""

    __slots__ = ("t", "level", "reason", "raw_level", "objects", "leds")

    def __init__(self, t, assessment, leds):
        self.t, self.level, self.reason = t, assessment.level, assessment.reason
        self.raw_level, self.objects, self.leds = assessment.raw_level, assessment.objects, leds


def simulate(duration_s=20.0, fps=30.0, start_s=0.0, cfg=None):
    """Run the scene through the detector, Tracks, RiskJudge and (mock) Leds in simulated
    time, frame by frame, exactly as cooper.main chains them. Returns [SimFrame]."""
    cfg = cfg or Config()
    cam = cfg.camera
    scene = RoadScene(cam.width, cam.height, cam.hfov_deg)
    detector, tracks, judge = SceneDetector(), Tracks(cfg.prediction), RiskJudge(cfg.risk)
    leds = Leds(dataclasses.replace(cfg.leds, enabled=False))
    frames = []
    for i in range(int(round(duration_s * fps))):
        t = start_s + i / fps
        assessment = judge.update(tracks.update(detector.detect(scene.render(t)), t), cam.width, cam.height, t)
        leds.set(assessment.level)
        frames.append(SimFrame(t, assessment, dict(leds.state)))
    return frames


def print_timeline(frames):
    """Every change of the output level and of each LED, with the reason."""
    prev = None
    for f in frames:
        if prev is None or f.level != prev.level or f.leds != prev.leds:
            lit = [name for name, on in f.leds.items() if on] or ["-"]
            print(f"{f.t:6.2f} s  {f.level:8} LED {'+'.join(lit):7} {f.reason}")
        prev = f


def patch_main(main_module, stop=None, start_s=0.0, speed=1.0, frames=None):
    """Swap cooper.main's Camera and Detector for the synthetic ones."""
    def camera(cfg):
        scene = RoadScene(cfg.width, cfg.height, cfg.hfov_deg)
        return SceneCamera(scene, stop, fps=cfg.fps, start_s=start_s, speed=speed, frames=frames)

    main_module.Camera = camera
    main_module.Detector = SceneDetector


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run COOPER on a synthetic road, no hardware needed.")
    parser.add_argument("--port", type=int, default=8000, help="dashboard port")
    parser.add_argument("--start-s", type=float, default=0.0, help="where in the 20 s loop to start")
    parser.add_argument("--speed", type=float, default=1.0, help="scene seconds per real second")
    parser.add_argument("--frames", type=int, default=None, help=argparse.SUPPRESS)  # tests: stop after N
    parser.add_argument("--timeline", action="store_true",
                        help="print one loop's risk and LED changes (simulated time) and exit")
    args = parser.parse_args(argv)

    if args.timeline:
        print_timeline(simulate(start_s=args.start_s))
        return

    import cooper.main

    patch_main(cooper.main, start_s=args.start_s, speed=args.speed, frames=args.frames)
    print(f"Synthetic road. Dashboard: http://localhost:{args.port}  (Ctrl+C to quit)")
    sys.argv = ["cooper.main", "--port", str(args.port)]
    cooper.main.main()


if __name__ == "__main__":
    main()
