"""The virtual-gimbal crop must follow the motors *config*, not Gimbal.mock.

With motors enabled, Gimbal.mock is also true before the Uno connects and during a USB
outage. Cropping the real camera frame then would feed detection the wrong geometry, so
main() must pass the frame through untouched. Runs the real main() for one frame with a
1280x720 camera: cropped output is the configured 640x480, uncropped stays 1280x720.
"""
import sys

import flask
import numpy as np
import pytest

import cooper.main
import cooper.motors
import cooper.stream


class WideCamera:
    def __init__(self, cfg):
        self.reads = 0

    def read(self):
        self.reads += 1
        if self.reads > 1:
            raise KeyboardInterrupt
        return np.full((720, 1280, 3), 90, dtype=np.uint8)

    def close(self):
        pass


class NoDetections:
    def __init__(self, cfg):
        pass

    def detect(self, frame):
        return []


@pytest.fixture
def published_status(monkeypatch):
    apps = []
    real_create_app = cooper.stream.create_app

    def capture_create_app(*args, **kwargs):
        apps.append(real_create_app(*args, **kwargs))
        return apps[-1]

    monkeypatch.setattr(cooper.main, "Camera", WideCamera)
    monkeypatch.setattr(cooper.main, "Detector", NoDetections)
    monkeypatch.setattr(cooper.stream, "create_app", capture_create_app)
    monkeypatch.setattr(flask.Flask, "run", lambda self, *a, **k: None)
    # Motors enabled but no Uno found: the gimbal stays in mock mode while it keeps retrying.
    monkeypatch.setattr(cooper.motors, "find_arduino_port", lambda: None)
    monkeypatch.setattr(cooper.motors, "RECONNECT_S", 0.01)

    def run(*cli_args):
        monkeypatch.setattr(sys, "argv", ["cooper.main", *cli_args])
        cooper.main.main()
        return apps[-1].test_client().get("/api/status").get_json()

    return run


def test_no_crop_while_enabled_motors_are_disconnected(published_status):
    status = published_status()
    assert status["gimbal"]["mock"] is True  # the Uno isn't connected...
    assert status["frame"]["w"] == 1280 and status["frame"]["h"] == 720  # ...but the frame is untouched


def test_crop_when_motors_disabled(published_status):
    status = published_status("--no-motors")
    assert status["frame"]["w"] == 640 and status["frame"]["h"] == 480
