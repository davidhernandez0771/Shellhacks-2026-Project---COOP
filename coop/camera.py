"""Frame capture: Pi camera via Picamera2, or a USB/laptop webcam for development."""
import logging

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
