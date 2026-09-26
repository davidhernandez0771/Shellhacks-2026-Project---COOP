"""The whole app, headless: the real cooper.main loop against tools/fake_uno.py, with the
synthetic camera/detector from tools/rehearsal.py (the camera turns with the emulated
shaft, so tracking is closed-loop). Drives it through the HTTP API like the dashboard.
"""
import sys
import threading
import time

import flask
import pytest

import cooper.main
import cooper.motors
import cooper.stream
from tools.fake_uno import FakeUnoServer
from tools.rehearsal import World, patch_main

STEPS_PER_DEG = 200 * 8 / 360.0


def wait_until(predicate, timeout=8.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    path = tmp_path / "cooper.toml"
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", path)
    return path


@pytest.fixture
def app(monkeypatch, settings_file):
    monkeypatch.setattr(cooper.motors, "RECONNECT_S", 0.05)
    uno = FakeUnoServer(boot_delay_s=0.05).start()
    world = World(uno, STEPS_PER_DEG, walk_deg=20.0, period_s=10.0)
    stop = threading.Event()
    monkeypatch.setattr(cooper.main, "Camera", None)  # patched below; restored by monkeypatch
    monkeypatch.setattr(cooper.main, "Detector", None)
    patch_main(cooper.main, world, stop)
    apps = []
    real_create_app = cooper.stream.create_app
    monkeypatch.setattr(cooper.stream, "create_app", lambda *a, **k: apps.append(real_create_app(*a, **k)) or apps[-1])
    monkeypatch.setattr(flask.Flask, "run", lambda self, *a, **k: None)
    monkeypatch.setattr(sys, "argv", ["cooper.main", "--motor-port", uno.url])

    errors = []

    def run():
        try:
            cooper.main.main()
        except BaseException as e:  # surfaced by the test
            errors.append(e)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert wait_until(lambda: apps)
    client = apps[0].test_client()
    assert wait_until(lambda: client.get("/api/status").get_json()["diag"]["serial"] == "connected")
    yield client, uno, world
    stop.set()
    thread.join(5)
    uno.close()
    assert not thread.is_alive(), "main() didn't shut down"
    assert not errors, errors


def status(client):
    return client.get("/api/status").get_json()


def axis(uno):
    with uno.lock:
        a = uno.model.axes[0]
        return a.counter, a.rotor, a.speed, uno.model.enabled


def test_the_whole_app_on_the_fake_uno(app):
    client, uno, world = app

    # --- auto: the camera follows the walker (closed loop through the emulated shaft) ---
    assert wait_until(lambda: (status(client).get("target") or {}).get("id") == 1)
    time.sleep(1.0)  # let the Kalman filter settle
    errors = []
    for _ in range(40):
        errors.append(abs(world.walker_pan() - world.camera_pan()))
        time.sleep(0.05)
    assert max(errors) < 6.0, f"tracking error up to {max(errors):.1f} deg"
    s = status(client)
    assert s["mode"] == "auto" and s["gimbal"]["mock"] is False
    assert s["diag"]["latency_ms"] > 0 and s["diag"]["fps"] > 5

    # --- manual: holds where it is, then nudges ---
    assert client.post("/api/mode", json={"mode": "manual"}).status_code == 200
    seq = status(client)["frame_seq"]
    assert wait_until(lambda: status(client)["frame_seq"] >= seq + 2)  # a frame from after the switch
    held = status(client)["gimbal"]["target_pan"]  # in manual this is the setpoint Control captured
    assert client.post("/api/nudge", json={"dpan": 10.0}).status_code == 200
    assert wait_until(lambda: abs(world.camera_pan() - (held + 10.0)) < 0.6)

    # --- e-stop: drivers off, no position lost, moving requests refused ---
    assert client.post("/api/estop").status_code == 200
    assert wait_until(lambda: axis(uno)[3] is False)
    counter, rotor, speed, _ = axis(uno)
    assert counter == rotor and speed == 0
    assert status(client)["estop"] is True and status(client)["mode"] == "stop"
    assert client.post("/api/mode", json={"mode": "auto"}).status_code == 400
    assert wait_until(lambda: status(client)["gimbal"]["drivers_enabled"] is False)

    # --- zero during e-stop, then arm ---
    assert client.post("/api/zero").status_code == 200
    assert wait_until(lambda: axis(uno)[0] == 0)
    assert axis(uno)[1] == rotor  # shaft untouched
    assert wait_until(lambda: abs(status(client)["gimbal"]["pan"]) < 0.1)
    assert client.post("/api/arm").status_code == 200
    assert wait_until(lambda: axis(uno)[3] is True)
    assert status(client)["mode"] == "stop"

    # --- live settings reach the Uno ---
    resp = client.post("/api/settings", json={"max_steps_per_sec": 1500})
    assert resp.status_code == 200
    assert wait_until(lambda: uno.model.max_speed == 1500.0)

    # --- manual move in the new frame: 10 deg from the new zero ---
    assert client.post("/api/mode", json={"mode": "manual"}).status_code == 200
    assert client.post("/api/aim", json={"pan": 10.0}).status_code == 200
    target_rotor = rotor + round(10 * STEPS_PER_DEG)
    assert wait_until(lambda: axis(uno)[1] == target_rotor)

    # --- unplug / replug: reconnects in the same frame of reference ---
    assert wait_until(lambda: status(client)["gimbal"]["pan"] == pytest.approx(10.0, abs=0.3))
    time.sleep(0.2)  # a report after settling
    uno.unplug()
    assert wait_until(lambda: status(client)["diag"]["serial"] == "reconnecting")
    uno.replug()
    assert wait_until(lambda: status(client)["diag"]["serial"] == "connected")
    time.sleep(0.3)
    counter, rotor_now, _, enabled = axis(uno)
    assert rotor_now == target_rotor  # nothing moved
    assert counter == round(10 * STEPS_PER_DEG)  # restored, in the zeroed frame
    assert enabled

    events = [e["type"] for e in client.get("/api/events").get_json()["events"]]
    for expected in ("motor_connected", "target_acquired", "estop", "zeroed", "armed",
                     "settings_changed", "motor_disconnected"):
        assert expected in events, expected


@pytest.fixture
def idle_after_1s(settings_file):
    settings_file.write_text("[motors]\nidle_disable_s = 1.0\n", encoding="utf-8")


def test_stop_mode_idles_the_drivers_and_manual_wakes_them(idle_after_1s, app):
    client, uno, _ = app
    assert client.post("/api/mode", json={"mode": "stop"}).status_code == 200
    time.sleep(0.5)
    assert axis(uno)[3] is True  # not yet
    assert wait_until(lambda: axis(uno)[3] is False, timeout=5)
    assert wait_until(lambda: status(client)["gimbal"]["drivers_enabled"] is False)
    assert "motors_idle" in [e["type"] for e in client.get("/api/events").get_json()["events"]]
    counter, rotor, _, _ = axis(uno)
    assert counter == rotor
    assert client.post("/api/mode", json={"mode": "manual"}).status_code == 200
    assert wait_until(lambda: axis(uno)[3] is True)
    assert status(client)["gimbal"]["drivers_enabled"] is True
