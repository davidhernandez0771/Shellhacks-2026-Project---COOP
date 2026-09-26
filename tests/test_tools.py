"""Bench tools in tools/: jog, camera_check, bench_fps (the parts that don't need hardware)."""
import time

import numpy as np
import pytest

import cooper.motors as motors_mod
from tools import bench_fps, camera_check, jog
from tools.fake_uno import FakeUnoServer

STEPS_PER_DEG = 200 * 8 / 360.0


# ---- jog ----

class FakeGimbal:
    def __init__(self):
        self.pan = 0.0
        self.estopped = False
        self.drivers_enabled = True
        self.link_state = "connected"
        self.aims = []
        self.calls = []
        self.cfg = type("Cfg", (), {"pan_limits_deg": (-170.0, 170.0)})()

    def aim(self, pan, deadband_deg=0.0):
        self.aims.append(pan)

    def stop(self):
        self.calls.append("stop")

    def zero(self):
        self.calls.append("zero")
        self.pan = 0.0

    def estop(self):
        self.calls.append("estop")
        self.estopped = True

    def arm(self):
        self.calls.append("arm")
        self.estopped = False
        return True


def test_jog_arrows_move_by_the_step():
    g = FakeGimbal()
    j = jog.Jogger(g, step=5.0)
    j.handle("right")
    j.handle("right")
    j.handle("left")
    assert g.aims == [5.0, 10.0, 5.0]
    j.handle("d")
    j.handle("a")
    assert g.aims[-2:] == [10.0, 5.0]


def test_jog_step_size_cycles_and_stays_in_bounds():
    j = jog.Jogger(FakeGimbal(), step=5.0)
    j.handle("]")
    assert j.step == 10.0
    for _ in range(10):
        j.handle("]")
    assert j.step == jog.STEPS[-1]
    for _ in range(10):
        j.handle("[")
    assert j.step == jog.STEPS[0]


def test_jog_target_is_clamped_to_the_limits():
    g = FakeGimbal()
    g.cfg.pan_limits_deg = (-10.0, 10.0)
    j = jog.Jogger(g, step=45.0)
    j.handle("right")
    j.handle("right")
    assert j.target == 10.0
    assert g.aims[-1] == 10.0


def test_jog_home_zero_stop_estop_quit():
    g = FakeGimbal()
    j = jog.Jogger(g, step=5.0)
    j.handle("right")
    j.handle("0")
    assert g.aims[-1] == 0.0
    g.pan = 12.0
    j.handle("s")
    assert g.calls[-1] == "stop" and j.target == 12.0
    j.handle("z")
    assert g.calls[-1] == "zero" and j.target == 0.0
    j.handle("e")
    assert g.estopped
    j.handle("e")
    assert not g.estopped
    assert j.handle("q") == "quit"
    assert j.handle("x") is None  # unknown keys ignored


def test_jog_status_line_mentions_what_matters():
    g = FakeGimbal()
    g.pan = 12.345
    g.estopped = True
    line = jog.Jogger(g, step=5.0).status_line()
    assert "+12.35" in line and "E-STOP" in line and "connected" in line


@pytest.fixture
def uno(monkeypatch):
    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.05)
    server = FakeUnoServer(boot_delay_s=0.05).start()
    yield server
    server.close()


def test_jog_cli_goto_against_the_fake_uno(uno, capsys):
    assert jog.main(["--port", uno.url, "--goto", "45"]) == 0
    with uno.lock:
        assert uno.model.axes[0].rotor == 200
    assert "+45.00" in capsys.readouterr().out


def test_jog_cli_by_and_zero(uno):
    assert jog.main(["--port", uno.url, "--by", "-22.5"]) == 0
    with uno.lock:
        assert uno.model.axes[0].rotor == -100
    # A new jog run reconnects (resets the Uno), so its 0 is wherever the shaft is now.
    assert jog.main(["--port", uno.url, "--zero"]) == 0


def test_jog_cli_fails_cleanly_without_a_uno(monkeypatch, capsys):
    monkeypatch.setattr(jog, "CONNECT_TIMEOUT_S", 0.3)
    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.05)
    assert jog.main(["--port", "socket://127.0.0.1:9", "--goto", "10"]) == 1
    assert "no Uno" in capsys.readouterr().err


# ---- camera_check ----

class FakeCamera:
    def __init__(self, period=0.01, fail_every=0):
        self.period = period
        self.fail_every = fail_every
        self.n = 0

    def read(self):
        self.n += 1
        time.sleep(self.period)
        if self.fail_every and self.n % self.fail_every == 0:
            return None
        return np.full((480, 640, 3), self.n % 255, np.uint8)

    def close(self):
        pass


def test_camera_check_measures_resolution_and_fps():
    stats = camera_check.measure(FakeCamera(period=0.01), frames=20)
    assert stats["width"] == 640 and stats["height"] == 480
    assert 50 <= stats["fps"] <= 110
    assert stats["failed"] == 0
    assert stats["last_frame"].shape == (480, 640, 3)


def test_camera_check_counts_failed_grabs():
    stats = camera_check.measure(FakeCamera(period=0.0, fail_every=3), frames=9)
    assert stats["failed"] == 3


def test_camera_check_gives_up_on_a_dead_camera():
    stats = camera_check.measure(FakeCamera(period=0.0, fail_every=1), frames=5)
    assert stats["width"] is None and stats["failed"] == 5


def test_camera_check_main_saves_a_still(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(camera_check, "Camera", lambda cfg: FakeCamera(period=0.0))
    out = tmp_path / "still.jpg"
    assert camera_check.main(["--frames", "5", "--out", str(out)]) == 0
    assert out.stat().st_size > 0
    assert "640x480" in capsys.readouterr().out


# ---- bench_fps ----

def test_ncnn_model_path_is_per_size():
    assert bench_fps.ncnn_model_path("yolo11n.pt", 320) == "yolo11n_imgsz320_ncnn_model"
    assert bench_fps.ncnn_model_path("models/yolo11s.pt", 256).replace("\\", "/") == "models/yolo11s_imgsz256_ncnn_model"


def test_summarize_timings():
    s = bench_fps.summarize([0.1, 0.1, 0.1, 0.2])
    assert s["mean_ms"] == pytest.approx(125.0)
    assert s["p90_ms"] == pytest.approx(200.0)
    assert s["fps"] == pytest.approx(8.0)


def test_format_table_marks_the_fastest():
    rows = [("torch", 320, bench_fps.summarize([0.2])), ("ncnn", 320, bench_fps.summarize([0.1]))]
    table = bench_fps.format_table(rows)
    assert "| ncnn | 320 |" in table and "10.0" in table
    assert table.splitlines()[-1].startswith("Fastest: ncnn @ 320")


@pytest.fixture
def fake_ultralytics(monkeypatch):
    """A stand-in `ultralytics` package: CI never installs the real one (multi-GB)."""
    import sys
    import types
    from pathlib import Path

    loaded = []

    class YOLO:
        def __init__(self, path, task=None):
            self.path = path
            loaded.append(path)

        def export(self, format, imgsz):
            out = Path(self.path).with_name(Path(self.path).stem + "_ncnn_model")  # ultralytics' naming
            out.mkdir()
            return str(out)

        def track(self, frame, **kwargs):
            assert kwargs["persist"] and kwargs["tracker"] == "bytetrack.yaml"  # same call as COOPER
            return []

    module = types.ModuleType("ultralytics")
    module.YOLO = YOLO
    monkeypatch.setitem(sys.modules, "ultralytics", module)
    return loaded


def test_bench_fps_export_renames_per_size_and_skips_existing(fake_ultralytics, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert bench_fps.main(["--export", "--imgsz", "256", "320"]) == 0
    assert (tmp_path / "yolo11n_imgsz256_ncnn_model").is_dir()
    assert (tmp_path / "yolo11n_imgsz320_ncnn_model").is_dir()
    assert not (tmp_path / "yolo11n_ncnn_model").exists()
    assert bench_fps.main(["--export", "--imgsz", "320"]) == 0
    assert "exists, skipping" in capsys.readouterr().out


def test_bench_fps_runs_both_backends_and_skips_missing_ncnn(fake_ultralytics, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "yolo11n_imgsz320_ncnn_model").mkdir()
    assert bench_fps.main(["--imgsz", "256", "320", "--frames", "3", "--warmup", "1"]) == 0
    out = capsys.readouterr().out
    assert "skip ncnn @ 256" in out
    assert "| torch | 256 |" in out and "| torch | 320 |" in out and "| ncnn | 320 |" in out
    assert "yolo11n_imgsz320_ncnn_model" in fake_ultralytics


def test_camera_check_explains_a_camera_that_wont_open(monkeypatch, capsys):
    def no_camera(cfg):
        raise RuntimeError("Could not open webcam 0")

    monkeypatch.setattr(camera_check, "Camera", no_camera)
    assert camera_check.main(["--frames", "1"]) == 1
    err = capsys.readouterr().err
    assert "Could not open webcam 0" in err and "rpicam-hello" in err
