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
    def run(argv=("--no-motors",)):
        if argv is not None:
            monkeypatch.setattr(sys, "argv", ["coop.main", *argv])
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
    # Pan-only, but the dashboard still reads these.
    assert status["gimbal"]["tilt"] == 0
    assert status["gimbal"]["target_tilt"] == 0
    assert status["gimbal"]["tilt_enabled"] is False
    assert status["gimbal"]["tilt_limits"] == [0, 0]
    assert status["gimbal"]["drivers_enabled"] is True
    diag = status["diag"]
    assert diag["infer_ms"] >= 0 and diag["latency_ms"] >= diag["infer_ms"]
    assert "fps" in diag and "capture_fps" in diag
    assert status["estop"] is False

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


def test_settings_file_is_loaded(run_main, tmp_path, monkeypatch):
    path = tmp_path / "coop.toml"
    path.write_text("[camera]\nhfov_deg = 50.0\n", encoding="utf-8")
    monkeypatch.setattr("coop.settings.DEFAULT_PATH", path)
    status = run_main().test_client().get("/api/status").get_json()
    assert status["frame"]["hfov_deg"] == 50.0


def test_config_flag_and_motor_port_flag(run_main, tmp_path, monkeypatch):
    path = tmp_path / "bench.toml"
    path.write_text("[camera]\nhfov_deg = 55.0\n", encoding="utf-8")
    seen = {}
    real_gimbal = coop.main.Gimbal

    def spy_gimbal(cfg, **kwargs):
        seen["port"] = cfg.port
        return real_gimbal(cfg, **kwargs)

    monkeypatch.setattr(coop.main, "Gimbal", spy_gimbal)
    monkeypatch.setattr(sys, "argv", ["coop.main", "--no-motors", "--config", str(path),
                                      "--motor-port", "socket://localhost:5555"])
    status = run_main(argv=None).test_client().get("/api/status").get_json()
    assert status["frame"]["hfov_deg"] == 55.0
    assert seen["port"] == "socket://localhost:5555"


def test_invalid_settings_file_exits_with_the_error(run_main, tmp_path, monkeypatch, capsys):
    path = tmp_path / "coop.toml"
    path.write_text("[motors]\npan_inverted = true\n", encoding="utf-8")
    monkeypatch.setattr("coop.settings.DEFAULT_PATH", path)
    with pytest.raises(SystemExit) as e:
        run_main()
    assert e.value.code == 2
    assert "pan_inverted" in capsys.readouterr().err


def test_missing_explicit_config_exits(run_main, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["coop.main", "--config", str(tmp_path / "nope.toml")])
    with pytest.raises(SystemExit):
        run_main(argv=None)
