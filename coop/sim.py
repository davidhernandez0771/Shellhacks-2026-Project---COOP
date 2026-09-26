"""Virtual gimbal for development without motor hardware.

On real hardware, the narrow-FOV camera physically rotates on the pan/tilt steppers, so
what the sensor sees changes as the gimbal moves. With motors mocked (see coop/motors.py
Gimbal.mock) there's nothing to rotate, so we fake it: the webcam's wider FOV stands in
for the world the real camera would be able to scan, and we crop a sub-window sized to
the configured camera FOV, centered wherever the mock gimbal currently thinks it's
pointed. Panning that crop is a visible stand-in for physically panning the camera, and
it feeds detection a frame consistent with CameraConfig.hfov_deg/vfov_deg, matching the
pinhole convention pixel_to_offset_deg uses in the world-angle math.
"""
import cv2
import numpy as np


class VirtualGimbal:
    def __init__(self, camera_cfg, sim_cfg):
        self.camera_cfg = camera_cfg
        self.sim_cfg = sim_cfg

    def crop(self, frame, pan_deg, tilt_deg):
        """Return a window of `frame` as seen by a camera pointed at (pan_deg, tilt_deg)."""
        h, w = frame.shape[:2]
        frac_x = min(self.camera_cfg.hfov_deg / self.sim_cfg.world_hfov_deg, 1.0)
        frac_y = min(self.camera_cfg.vfov_deg / self.sim_cfg.world_vfov_deg, 1.0)
        cw, ch = frac_x * w, frac_y * h

        cx = w / 2 + pan_deg / (self.sim_cfg.world_hfov_deg / 2) * (w / 2)
        cy = h / 2 - tilt_deg / (self.sim_cfg.world_vfov_deg / 2) * (h / 2)
        x1 = int(np.clip(cx - cw / 2, 0, w - cw))
        y1 = int(np.clip(cy - ch / 2, 0, h - ch))

        window = frame[y1:y1 + int(ch), x1:x1 + int(cw)]
        return window if window.shape[:2] == (h, w) else cv2.resize(window, (w, h))
