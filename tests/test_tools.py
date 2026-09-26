"""Bench tools in tools/: camera_check, bench_fps (the parts that don't need hardware)."""
import time

import numpy as np
import pytest

from tools import bench_fps, camera_check


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
