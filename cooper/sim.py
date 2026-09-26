"""Virtual gimbal for development without motor hardware.

On real hardware, the narrow-FOV camera physically rotates on the pan/tilt steppers, so
what the sensor sees changes as the gimbal moves. With motors mocked (see cooper/motors.py
Gimbal.mock) there's nothing to rotate, so we fake it: the webcam's wider FOV stands in
for the world the real camera could scan, and we cut out the view of a camera with the
configured FOV and resolution, pointed wherever the mock gimbal points. It hands detection
the same frame geometry the Pi camera would, so pixel_to_offset_deg's world-angle math
holds unchanged.

The window is never clamped to the webcam frame: past the edge of the "world" the view
fills with blank. Clamping would freeze the image while the pan angle kept moving, and
the tracker (world = pan + offset) would chase its target off to the pan limit.

Pinhole model throughout: image-plane distance scales with tan(angle). A pure crop ignores
the perspective change of a real rotation, which is fine within ~+-30 deg.
"""
import math

import cv2
import numpy as np

BLANK = 40  # grey level for the part of the view outside the webcam's world


class VirtualGimbal:
    def __init__(self, camera_cfg, sim_cfg):
        self.camera_cfg = camera_cfg
        self.sim_cfg = sim_cfg

    def crop(self, frame, pan_deg, tilt_deg):
        """Return the view of a camera pointed at (pan_deg, tilt_deg), at the configured size."""
        cam = self.camera_cfg
        out_w, out_h = cam.width, cam.height
        if abs(pan_deg) >= 89 or abs(tilt_deg) >= 89:  # facing away from the webcam's world
            return np.full((out_h, out_w, 3), BLANK, np.uint8)

        h, w = frame.shape[:2]
        # Focal length in webcam pixels; the world's vertical FOV follows from the aspect ratio.
        f = (w / 2) / math.tan(math.radians(self.sim_cfg.world_hfov_deg / 2))
        cw = 2 * f * math.tan(math.radians(cam.hfov_deg / 2))
        ch = 2 * f * math.tan(math.radians(cam.vfov_deg / 2))
        x0 = w / 2 + f * math.tan(math.radians(pan_deg)) - cw / 2
        y0 = h / 2 - f * math.tan(math.radians(tilt_deg)) - ch / 2

        sx, sy = out_w / cw, out_h / ch
        m = np.float32([[sx, 0, -x0 * sx], [0, sy, -y0 * sy]])
        return cv2.warpAffine(frame, m, (out_w, out_h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(BLANK, BLANK, BLANK))
