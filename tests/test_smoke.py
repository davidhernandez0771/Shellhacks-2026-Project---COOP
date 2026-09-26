"""Startup smoke tests: run the real cooper.main.main() for one loop iteration.

Only the hardware/ML edges are faked (Camera, Detector) and Flask.run is a no-op, so the
real wiring runs: Config, Control, FrameGrabber, Tracks, RiskJudge, Leds (mock off a Pi),
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
    def run(argv=()):
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
    assert status["frame"]["w"] == 640 and status["frame"]["h"] == 480
    [obj] = status["objects"]
    assert (obj["id"], obj["label"], obj["conf"], obj["box"]) == (3, "person", 0.87, [100, 60, 180, 260])
    assert obj["level"] == "clear"               # its feet (y = 260) are beyond the lane's far end
    assert len(obj["path"]) == 15                # 1.5 s horizon in 0.1 s steps
    assert obj["path"][0] == [140.0, 260.0]      # first frame: no velocity yet, so it stays put
    assert status["risk"] == {"level": "clear", "reason": ""}
    assert status["leds"] == {"yellow": False, "red": False, "mode": "mock"}
    assert status["lane"] == [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]]
    assert "server_time" in status
    diag = status["diag"]
    assert diag["infer_ms"] >= 0 and diag["latency_ms"] >= diag["infer_ms"]
    assert "fps" in diag and "capture_fps" in diag
    assert diag["leds"] == "mock"
    assert diag["uptime_s"] >= 0


class FramesCamera(FakeCamera):
    """`frames` frames 50 ms apart (so FrameGrabber doesn't drop any), then Ctrl+C."""

    frames = 4

    def read(self):
        import time

        self.reads += 1
        if self.reads > self.frames:
            raise KeyboardInterrupt
        if self.reads > 1:
            time.sleep(0.05)
        return np.full((480, 640, 3), 90, dtype=np.uint8)


class InLaneDetector:
    def __init__(self, cfg):
        pass

    def detect(self, frame):
        return [Detection(7, "car", 0.9, (270, 300, 370, 400))]  # bottom edge 270..370 at y = 400


def test_an_object_in_the_lane_lights_the_red_led_and_logs_it(run_main, monkeypatch):
    lit = []
    real_leds = cooper.main.Leds

    def spy_leds(cfg, **kwargs):
        leds = real_leds(cfg, **kwargs)
        real_set = leds.set
        leds.set = lambda level: (real_set(level), lit.append(dict(leds.state)))[0]
        return leds

    monkeypatch.setattr(cooper.main, "Camera", FramesCamera)
    monkeypatch.setattr(cooper.main, "Detector", InLaneDetector)
    monkeypatch.setattr(cooper.main, "Leds", spy_leds)
    client = run_main().test_client()
    status = client.get("/api/status").get_json()
    assert status["risk"]["level"] == "danger" and "#7" in status["risk"]["reason"]
    assert status["leds"]["red"] is True and status["leds"]["yellow"] is False
    assert lit[0] == {"yellow": False, "red": False}   # enter_frames = 2: not on the first frame
    assert {"yellow": False, "red": True} in lit
    assert lit[-1] == {"yellow": False, "red": False}  # shutdown turns them off
    events = client.get("/api/events").get_json()["events"]
    assert [(e["type"], e["level"]) for e in events] == [("risk_changed", "danger")]


def test_no_leds_flag_disables_the_gpio(run_main, monkeypatch):
    seen = []
    real_leds = cooper.main.Leds
    monkeypatch.setattr(cooper.main, "Leds", lambda cfg, **k: seen.append(cfg.enabled) or real_leds(cfg, **k))
    run_main(argv=("--no-leds",))
    assert seen == [False]


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


def test_config_flag(run_main, tmp_path, monkeypatch):
    path = tmp_path / "bench.toml"
    path.write_text("[camera]\nhfov_deg = 55.0\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["cooper.main", "--config", str(path)])
    status = run_main(argv=None).test_client().get("/api/status").get_json()
    assert status["frame"]["hfov_deg"] == 55.0


def test_invalid_settings_file_exits_with_the_error(run_main, tmp_path, monkeypatch, capsys):
    path = tmp_path / "cooper.toml"
    path.write_text("[detector]\nconfidence = 0.5\n", encoding="utf-8")
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", path)
    with pytest.raises(SystemExit) as e:
        run_main()
    assert e.value.code == 2
    assert "confidence" in capsys.readouterr().err


def test_missing_explicit_config_exits(run_main, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["cooper.main", "--config", str(tmp_path / "nope.toml")])
    with pytest.raises(SystemExit):
        run_main(argv=None)


def test_main_serves_live_settings(run_main, tmp_path):
    client = run_main().test_client()
    body = client.get("/api/settings").get_json()
    assert body["settings"]["conf"] == 0.4
    assert body["file"].endswith("cooper.toml")
    resp = client.post("/api/settings", json={"conf": 0.3})
    assert resp.status_code == 200


def test_annotate_burns_the_boxes_into_the_frame(run_main, monkeypatch):
    drawn = []
    monkeypatch.setattr(cooper.main, "annotate", lambda frame, dets: drawn.append(dets) or frame)
    run_main(argv=("--annotate",))
    assert [d.track_id for d in drawn[0]] == [3]
