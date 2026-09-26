"""Startup smoke tests: run the real coop.main.main() for one loop iteration.

Only the hardware/ML edges are faked (Camera, Detector) and Flask.run is a no-op, so the
real wiring runs: Config, Control, Gimbal (--no-motors), VirtualGimbal, KalmanPredictor,
SharedState, serve_in_background and create_app. This catches startup breakage the unit
tests can't, such as a call site that no longer matches a changed signature.
"""
import sys
import threading

import flask
import numpy as np
import pytest

import coop.main
import coop.stream
from coop.detector import Detection
from coop.stream import SharedState


class FakeCamera:
    """Returns one frame, then ends main()'s loop the way Ctrl+C would."""

    instances = []

    def __init__(self, cfg):
        self.reads = 0
        self.closed = False
        FakeCamera.instances.append(self)

    def read(self):
        self.reads += 1
        if self.reads > 1:
            raise KeyboardInterrupt
        return np.full((480, 640, 3), 90, dtype=np.uint8)

    def close(self):
        self.closed = True


class FakeDetector:
    def __init__(self, cfg):
        pass

    def detect(self, frame):
        return [Detection(3, "person", 0.87, (100, 60, 180, 260))]


@pytest.fixture
def run_main(monkeypatch):
    """Run main() once; return the Flask app it built, for querying afterwards."""
    FakeCamera.instances.clear()
    apps = []
    real_create_app = coop.stream.create_app

    def capture_create_app(*args, **kwargs):
        app = real_create_app(*args, **kwargs)
        apps.append(app)
        return app

    monkeypatch.setattr(coop.main, "Camera", FakeCamera)
    monkeypatch.setattr(coop.main, "Detector", FakeDetector)
    monkeypatch.setattr(coop.stream, "create_app", capture_create_app)
    monkeypatch.setattr(flask.Flask, "run", lambda self, *a, **k: None)
    monkeypatch.setattr(sys, "argv", ["coop.main", "--no-motors"])

    def run():
        coop.main.main()
        assert len(apps) == 1, "serve_in_background should build exactly one app"
        return apps[0]

    return run


def test_main_runs_one_iteration_and_publishes_status(run_main):
    client = run_main().test_client()

    status = client.get("/api/status").get_json()
    assert status["frame_seq"] == 1
    assert status["mode"] == "auto"
    assert status["target"]["id"] == 3
    assert status["target"]["locked"] is False
    assert [d["id"] for d in status["detections"]] == [3]
    assert status["gimbal"]["mock"] is True
    assert "server_time" in status

    events = client.get("/api/events").get_json()["events"]
    assert [e["type"] for e in events] == ["target_acquired"]


def test_main_shuts_down_cleanly(run_main):
    run_main()
    cam = FakeCamera.instances[-1]
    assert cam.reads == 2  # one frame, then the KeyboardInterrupt
    assert cam.closed


def test_video_stream_waits_for_the_first_frame():
    """/video opened before the first publish must block, not yield None (it used to 500)."""
    state = SharedState()
    frames = state.frames()
    got = []
    reader = threading.Thread(target=lambda: got.append(next(frames)), daemon=True)
    reader.start()

    reader.join(timeout=0.2)
    assert reader.is_alive(), "frames() yielded before anything was published"

    state.publish(b"JPEGDATA", {})
    reader.join(timeout=2.0)
    assert got and b"JPEGDATA" in got[0]
    assert state.status["frame_seq"] == 1
