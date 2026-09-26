"""Startup smoke tests: run the real cooper.main.main() for one loop iteration.

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

import cooper.main
import cooper.stream
from cooper.detector import Detection
from cooper.stream import SharedState


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
    real_create_app = cooper.stream.create_app

    def capture_create_app(*args, **kwargs):
        app = real_create_app(*args, **kwargs)
        apps.append(app)
        return app

    monkeypatch.setattr(cooper.main, "Camera", FakeCamera)
    monkeypatch.setattr(cooper.main, "Detector", FakeDetector)
    monkeypatch.setattr(cooper.stream, "create_app", capture_create_app)
    monkeypatch.setattr(flask.Flask, "run", lambda self, *a, **k: None)
    def run(argv=("--no-motors",)):
        if argv is not None:
            monkeypatch.setattr(sys, "argv", ["cooper.main", *argv])
        cooper.main.main()
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
    assert diag["serial"] == "mock"  # --no-motors
    assert diag["uptime_s"] >= 0
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
    path = tmp_path / "cooper.toml"
    path.write_text("[camera]\nhfov_deg = 50.0\n", encoding="utf-8")
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", path)
    status = run_main().test_client().get("/api/status").get_json()
    assert status["frame"]["hfov_deg"] == 50.0


def test_config_flag_and_motor_port_flag(run_main, tmp_path, monkeypatch):
    path = tmp_path / "bench.toml"
    path.write_text("[camera]\nhfov_deg = 55.0\n", encoding="utf-8")
    seen = {}
    real_gimbal = cooper.main.Gimbal

    def spy_gimbal(cfg, **kwargs):
        seen["port"] = cfg.port
        return real_gimbal(cfg, **kwargs)

    monkeypatch.setattr(cooper.main, "Gimbal", spy_gimbal)
    monkeypatch.setattr(sys, "argv", ["cooper.main", "--no-motors", "--config", str(path),
                                      "--motor-port", "socket://localhost:5555"])
    status = run_main(argv=None).test_client().get("/api/status").get_json()
    assert status["frame"]["hfov_deg"] == 55.0
    assert seen["port"] == "socket://localhost:5555"


def test_invalid_settings_file_exits_with_the_error(run_main, tmp_path, monkeypatch, capsys):
    path = tmp_path / "cooper.toml"
    path.write_text("[motors]\npan_inverted = true\n", encoding="utf-8")
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", path)
    with pytest.raises(SystemExit) as e:
        run_main()
    assert e.value.code == 2
    assert "pan_inverted" in capsys.readouterr().err


def test_missing_explicit_config_exits(run_main, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["cooper.main", "--config", str(tmp_path / "nope.toml")])
    with pytest.raises(SystemExit):
        run_main(argv=None)


def test_main_serves_live_settings(run_main, tmp_path):
    client = run_main().test_client()
    body = client.get("/api/settings").get_json()
    assert body["settings"]["lead_time_s"] == 0.15
    assert body["file"].endswith("cooper.toml")
    resp = client.post("/api/settings", json={"lead_time_s": 0.3})
    assert resp.status_code == 200


def test_annotate_path_draws_the_lead_aim(run_main):
    """--annotate projects the predictor's aim point into the frame (auto mode, a target)."""
    client = run_main(argv=("--no-motors", "--annotate")).test_client()
    assert client.get("/api/status").get_json()["target"]["id"] == 3


class TimedCamera:
    """Frames `period_s` apart; ends the run after `frames` frames."""

    def __init__(self, frames, period_s):
        self.frames, self.period_s, self.reads = frames, period_s, 0

    def read(self):
        import time

        self.reads += 1
        if self.reads > self.frames:
            raise KeyboardInterrupt
        if self.reads > 1:
            time.sleep(self.period_s)
        return np.full((480, 640, 3), 90, dtype=np.uint8)

    def close(self):
        pass


def test_a_locked_target_that_disappears_is_lost_and_unlocked(run_main, monkeypatch):
    """Lock #3, then it vanishes: after lost_timeout_s (1 s) of capture time, target_lost
    fires and the lock clears. Exercises the loop's timing on FrameGrabber timestamps."""
    controls = []
    real_control = cooper.main.Control

    def capture_control(*a, **k):
        controls.append(real_control(*a, **k))
        return controls[-1]

    class LockThenVanish:
        def __init__(self, cfg):
            self.calls = 0

        def detect(self, frame):
            self.calls += 1
            if self.calls == 1:
                controls[0].set_target(3)
            return [Detection(3, "person", 0.9, (100, 60, 180, 260))] if self.calls <= 2 else []

    monkeypatch.setattr(cooper.main, "Control", capture_control)
    monkeypatch.setattr(cooper.main, "Camera", lambda cfg: TimedCamera(frames=8, period_s=0.25))
    monkeypatch.setattr(cooper.main, "Detector", LockThenVanish)
    client = run_main().test_client()
    types = [e["type"] for e in client.get("/api/events").get_json()["events"]]
    assert "target_acquired" in types and "target_lost" in types
    assert controls[0].locked_id is None
    assert client.get("/api/status").get_json()["target"] is None
