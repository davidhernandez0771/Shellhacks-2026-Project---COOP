"""Frame capture: Pi camera via Picamera2, or a USB/laptop webcam for development.

FrameGrabber runs the capture on its own thread so the vision loop always gets the newest
frame: while YOLO works on one frame the camera keeps delivering, and the frames that
arrive in between are dropped instead of queueing up (a queue would add a frame of latency
per frame of backlog, and the tracker would aim at where the target used to be).
"""
import logging
import threading
import time
from collections import deque

import cv2

log = logging.getLogger(__name__)


class Camera:
    def __init__(self, cfg):
        self.cfg = cfg
        self._picam = None
        self._cap = None

        if cfg.source in ("auto", "picamera"):
            try:
                self._open_picamera()
            except Exception as e:  # ImportError off-Pi, RuntimeError if no camera attached
                if cfg.source == "picamera":
                    raise
                log.warning("Pi camera unavailable (%s); falling back to webcam", e)

        if self._picam is None:
            self._open_webcam()

    def _open_picamera(self):
        from picamera2 import Picamera2

        self._picam = Picamera2()
        video_cfg = self._picam.create_video_configuration(
            # "RGB888" in Picamera2 is BGR byte order, which is what OpenCV expects.
            main={"size": (self.cfg.width, self.cfg.height), "format": "RGB888"},
            controls={"FrameRate": self.cfg.fps},
        )
        self._picam.configure(video_cfg)
        self._picam.start()
        log.info("Using Pi camera at %dx%d", self.cfg.width, self.cfg.height)

    def _open_webcam(self):
        self._cap = cv2.VideoCapture(self.cfg.webcam_index)
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.cfg.width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.cfg.height)
        if not self._cap.isOpened():
            raise RuntimeError(f"Could not open webcam {self.cfg.webcam_index}")
        log.info("Using webcam %d", self.cfg.webcam_index)

    def read(self):
        """Return the next BGR frame, or None if capture failed."""
        if self._picam is not None:
            return self._picam.capture_array()
        ok, frame = self._cap.read()
        return frame if ok else None

    def close(self):
        if self._picam is not None:
            self._picam.stop()
        if self._cap is not None:
            self._cap.release()


class FrameGrabber:
    """Reads `camera` continuously on a background thread; read() returns the newest frame.

    If camera.read() raises, capture stops and the exception is re-raised by read() (after
    any frame already captured has been handed over), so a dead camera still ends the
    program as before; this includes a KeyboardInterrupt from a test double.
    """

    FPS_WINDOW = 30  # frames

    def __init__(self, camera):
        self._camera = camera
        self._cond = threading.Condition()
        self._frame = None
        self._t = None
        self._seq = 0
        self._taken = 0
        self._error = None
        self._stamps = deque(maxlen=self.FPS_WINDOW)
        self.dropped = 0  # frames captured but never processed
        self._running = True
        self._thread = threading.Thread(target=self._run, name="capture", daemon=True)
        self._thread.start()

    def _run(self):
        while self._running:
            try:
                frame = self._camera.read()
            except BaseException as e:  # noqa: B036 - handed to the consumer thread
                with self._cond:
                    self._error = e
                    self._cond.notify_all()
                return
            if frame is None:
                time.sleep(0.005)  # a failed grab; try again
                continue
            t = time.monotonic()
            with self._cond:
                if self._seq > self._taken:
                    self.dropped += 1
                self._frame, self._t = frame, t
                self._seq += 1
                self._stamps.append(t)
                self._cond.notify_all()

    def read(self, timeout=1.0):
        """(frame, capture time on time.monotonic()) newer than the last one returned, or
        (None, None) after `timeout` seconds without one."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._seq == self._taken and self._error is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, None
                self._cond.wait(min(remaining, 0.1))  # short waits keep Ctrl+C responsive
            if self._seq > self._taken:
                self._taken = self._seq
                return self._frame, self._t
            raise self._error

    @property
    def capture_fps(self):
        """Frames per second the camera is delivering (0 if it has stalled)."""
        with self._cond:
            stamps = list(self._stamps)
        if len(stamps) < 2 or time.monotonic() - stamps[-1] > 2.0:
            return 0.0
        return (len(stamps) - 1) / (stamps[-1] - stamps[0])

    def close(self):
        self._running = False
        self._thread.join(timeout=1.0)
