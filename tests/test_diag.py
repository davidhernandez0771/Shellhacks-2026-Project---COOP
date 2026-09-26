"""Health readouts for /api/status.diag (cooper/diag.py), with fake /sys files and vcgencmd."""
import subprocess
import time

from cooper.control import Control
from cooper.diag import DIAG_KEYS, SystemMonitor, read_cpu_temp_c, read_throttled
from cooper.stream import SharedState, create_app


def test_cpu_temp_from_sysfs_millidegrees(tmp_path):
    f = tmp_path / "temp"
    f.write_text("48312\n")
    assert read_cpu_temp_c(f) == 48.3


def test_cpu_temp_is_none_when_unavailable(tmp_path):
    assert read_cpu_temp_c(tmp_path / "missing") is None
    bad = tmp_path / "bad"
    bad.write_text("hot\n")
    assert read_cpu_temp_c(bad) is None


def fake_run(stdout, returncode=0):
    def run(cmd, **kwargs):
        assert cmd == ["vcgencmd", "get_throttled"]
        assert kwargs.get("timeout")  # never hang a status request on a stuck binary
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr="")
    return run


def test_throttled_from_vcgencmd(tmp_path):
    value = read_throttled(run=fake_run("throttled=0x50005\n"), which=lambda _: "/usr/bin/vcgencmd",
                           sysfs=tmp_path / "missing")
    assert value == 0x50005


def test_throttled_zero_means_healthy(tmp_path):
    assert read_throttled(run=fake_run("throttled=0x0\n"), which=lambda _: "/usr/bin/vcgencmd",
                          sysfs=tmp_path / "missing") == 0


def test_throttled_falls_back_to_sysfs(tmp_path):
    f = tmp_path / "get_throttled"
    f.write_text("50000\n")
    assert read_throttled(run=None, which=lambda _: None, sysfs=f) == 0x50000


def test_throttled_survives_a_broken_vcgencmd(tmp_path):
    def boom(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 1)

    assert read_throttled(run=boom, which=lambda _: "/usr/bin/vcgencmd", sysfs=tmp_path / "x") is None
    assert read_throttled(run=fake_run("error\n", 1), which=lambda _: "vcgencmd", sysfs=tmp_path / "x") is None
    assert read_throttled(run=fake_run("garbage\n"), which=lambda _: "vcgencmd", sysfs=tmp_path / "x") is None


def test_monitor_caches_the_slow_readings():
    calls = []
    mon = SystemMonitor(ttl_s=10,
                        temp_fn=lambda: calls.append("t") or 50.0, throttled_fn=lambda: calls.append("th") or 0)
    a = mon.snapshot()
    b = mon.snapshot()
    assert calls == ["t", "th"]
    assert a["cpu_temp_c"] == b["cpu_temp_c"] == 50.0
    assert a["throttled"] == 0


def test_monitor_refreshes_after_the_ttl():
    temps = iter([50.0, 51.0])
    mon = SystemMonitor(ttl_s=0.05, temp_fn=lambda: next(temps), throttled_fn=lambda: 0)
    assert mon.snapshot()["cpu_temp_c"] == 50.0
    time.sleep(0.08)
    assert mon.snapshot()["cpu_temp_c"] == 51.0


def test_monitor_reports_uptime_live():
    mon = SystemMonitor(temp_fn=lambda: None, throttled_fn=lambda: None)
    first = mon.snapshot()
    time.sleep(0.15)  # uptime is reported to 0.1 s
    second = mon.snapshot()
    assert second["uptime_s"] > first["uptime_s"] >= 0


def test_diag_has_no_serial_link():
    assert "serial" not in DIAG_KEYS
    assert "serial" not in SystemMonitor(temp_fn=lambda: None, throttled_fn=lambda: None).snapshot()


def test_status_diag_has_every_key_even_before_the_first_frame():
    mon = SystemMonitor(temp_fn=lambda: None, throttled_fn=lambda: None)
    client = create_app(SharedState(), Control(), diag=mon.snapshot).test_client()
    diag = client.get("/api/status").get_json()["diag"]
    assert set(diag) == set(DIAG_KEYS)
    assert diag["fps"] is None and diag["latency_ms"] is None
    assert diag["uptime_s"] >= 0


def test_status_diag_merges_loop_timings_with_live_readings():
    mon = SystemMonitor(temp_fn=lambda: 61.5, throttled_fn=lambda: 0x4)
    state = SharedState()
    state.publish(b"x", {"diag": {"fps": 12.0, "capture_fps": 30.0, "infer_ms": 55.0, "latency_ms": 80.0}})
    client = create_app(state, Control(), diag=mon.snapshot).test_client()
    diag = client.get("/api/status").get_json()["diag"]
    assert diag == {"cpu_temp_c": 61.5, "throttled": 4, "fps": 12.0, "capture_fps": 30.0,
                    "infer_ms": 55.0, "latency_ms": 80.0, "uptime_s": diag["uptime_s"]}


def test_status_diag_without_a_monitor_still_has_every_key():
    client = create_app(SharedState(), Control()).test_client()
    assert set(client.get("/api/status").get_json()["diag"]) == set(DIAG_KEYS)
