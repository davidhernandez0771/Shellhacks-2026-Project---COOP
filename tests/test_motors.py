"""The Pi <-> Arduino serial protocol (coop/motors.py), against a fake serial port.

Protocol reference: firmware/coop_motors/coop_motors.ino header. Connecting (and
reconnecting) happens on a background supervisor thread, so most assertions here poll
with wait_until instead of asserting immediately after a call.
"""
import time

import pytest

from coop.config import MotorConfig
from coop.motors import Gimbal, find_arduino_port
from tests.conftest import FakeSerial


def make_cfg(**overrides):
    cfg = MotorConfig()
    cfg.port = "FAKE0"  # bypasses find_arduino_port's USB scan
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


def wait_until(predicate, timeout=1.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class FakePort:
    def __init__(self, vid, device):
        self.vid = vid
        self.device = device


def test_find_arduino_port_matches_known_vid(monkeypatch):
    ports = [FakePort(0x1234, "/dev/ttyUSB0"), FakePort(0x2341, "/dev/ttyACM0")]
    monkeypatch.setattr("serial.tools.list_ports.comports", lambda: ports)
    assert find_arduino_port() == "/dev/ttyACM0"


def test_find_arduino_port_returns_none_when_nothing_matches(monkeypatch):
    monkeypatch.setattr("serial.tools.list_ports.comports", lambda: [FakePort(0x1234, "/dev/ttyUSB0")])
    assert find_arduino_port() is None


def test_connect_sends_motion_limits_then_resends_last_target(fake_serial_factory):
    cfg = make_cfg(max_steps_per_sec=2000.0, accel_steps_per_sec2=6000.0)
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        assert ser.sent[0] == "C 2000 6000\nZ\n"
        assert wait_until(lambda: ser.sent[1:2] == ["T 0 0\n"])
    finally:
        g.close()


def test_successful_connect_fires_motor_connected_event(fake_serial_factory):
    events = []
    cfg = make_cfg()
    g = Gimbal(cfg, on_event=lambda ev, **fields: events.append((ev, fields)))
    try:
        assert wait_until(lambda: events)
        ev, fields = events[0]
        assert ev == "motor_connected"
        assert "port" in fields
    finally:
        g.close()


def test_aim_sends_target_in_microsteps(fake_serial_factory):
    cfg = make_cfg(steps_per_rev=200, microsteps=8, pan_gear_ratio=1.0)
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g.aim(10.0, deadband_deg=0.0)
        steps_per_deg = cfg.steps_per_rev * cfg.microsteps / 360.0
        expected_pan = round(10.0 * steps_per_deg)
        assert ser.sent[-1] == f"T {expected_pan} 0\n"
    finally:
        g.close()


def test_aim_within_deadband_does_not_resend(fake_serial_factory):
    cfg = make_cfg()
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g.aim(10.0, deadband_deg=1.0)
        sent_count = len(ser.sent)

        g.aim(10.05, deadband_deg=1.0)  # well under 1 degree of change
        assert len(ser.sent) == sent_count
    finally:
        g.close()


def test_aim_clamps_to_pan_limits(fake_serial_factory):
    cfg = make_cfg(pan_limits_deg=(-30.0, 30.0))
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g.aim(999.0, deadband_deg=0.0)
        steps_per_deg = cfg.steps_per_rev * cfg.microsteps / 360.0
        expected_pan = round(30.0 * steps_per_deg)
        assert ser.sent[-1] == f"T {expected_pan} 0\n"
    finally:
        g.close()


def test_wire_tilt_is_always_zero(fake_serial_factory):
    """Pan-only build: the firmware protocol still carries a tilt field, always 0."""
    g = Gimbal(make_cfg())
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g.aim(15.0, deadband_deg=0.0)
        assert ser.sent[-1].startswith("T ")
        assert ser.sent[-1].endswith(" 0\n")
    finally:
        g.close()


def test_pan_invert_flips_the_wire_sign_and_the_reading(fake_serial_factory):
    cfg = make_cfg(pan_invert=True, steps_per_rev=200, microsteps=8)
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g.aim(10.0, deadband_deg=0.0)
        steps = round(10.0 * 200 * 8 / 360.0)
        assert ser.sent[-1] == f"T {-steps} 0\n"
        ser.push(f"P {-steps} 0\n".encode())
        assert wait_until(lambda: g.pan == pytest.approx(10.0, abs=0.2))
    finally:
        g.close()


def test_steps_per_deg_includes_microsteps_and_gear_ratio():
    g = Gimbal(make_cfg(enabled=False, steps_per_rev=200, microsteps=16, pan_gear_ratio=3.0))
    try:
        assert g.steps_per_deg == pytest.approx(200 * 16 * 3.0 / 360.0)
    finally:
        g.close()


def test_stop_sends_S_and_holds_current_position(fake_serial_factory):
    cfg = make_cfg()
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        g._pos = 123
        g.stop()
        assert g._target == 123
        assert wait_until(lambda: ser.sent and ser.sent[-1] == "S\n")
    finally:
        g.close()


def test_reader_thread_parses_position_reports(fake_serial_factory):
    cfg = make_cfg(steps_per_rev=200, microsteps=8)
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        ser.push(b"P 400 100\n")
        assert wait_until(lambda: g._pos == 400)  # the tilt field is ignored

        steps_per_deg = cfg.steps_per_rev * cfg.microsteps / 360.0
        assert g.pan == pytest.approx(400 / steps_per_deg)
    finally:
        g.close()


def test_reader_thread_ignores_garbled_lines(fake_serial_factory):
    cfg = make_cfg()
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        ser.push(b"garbage\n")
        ser.push(b"P not_a_number 5\n")
        ser.push(b"P 7 9\n")
        assert wait_until(lambda: g._pos == 7)
    finally:
        g.close()


def test_heartbeat_sent_when_idle(fake_serial_factory, monkeypatch):
    import coop.motors as motors_mod

    monkeypatch.setattr(motors_mod, "HEARTBEAT_S", 0.02)
    cfg = make_cfg()
    g = Gimbal(cfg)
    try:
        ser_ready = wait_until(lambda: fake_serial_factory)
        assert ser_ready
        ser = fake_serial_factory[0]
        assert wait_until(lambda: "H\n" in ser.sent)
    finally:
        g.close()


def test_falls_back_to_mock_when_handshake_never_gets_ready(monkeypatch):
    import coop.motors as motors_mod

    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.01)

    clock = {"t": 0.0}

    def fake_monotonic():
        clock["t"] += 1.0  # fast-forward past the 4s handshake deadline
        return clock["t"]

    monkeypatch.setattr(motors_mod.time, "monotonic", fake_monotonic)

    attempts = []

    class NoReadySerial(FakeSerial):
        def readline(self):
            return b""  # never answers READY

    def factory(port, baud, timeout=0.1):
        inst = NoReadySerial(port, baud, timeout)
        attempts.append(inst)
        return inst

    monkeypatch.setattr("serial.Serial", factory)

    cfg = make_cfg()
    g = Gimbal(cfg)
    try:
        assert wait_until(lambda: attempts)
        assert wait_until(lambda: g.mock)
    finally:
        g.close()


def test_supervisor_reconnects_after_link_drop_and_resends_target(monkeypatch):
    import coop.motors as motors_mod

    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.02)

    created = []

    class DropsAfterHandshake(FakeSerial):
        """Answers READY, then errors on the very next read (simulating a dropped cable)."""

        def readline(self):
            line = super().readline()
            if line == b"READY\n":
                return line
            raise OSError("link dropped")

    def factory(port, baud, timeout=0.1):
        inst = DropsAfterHandshake(port, baud, timeout) if not created else FakeSerial(port, baud, timeout)
        created.append(inst)
        return inst

    monkeypatch.setattr("serial.Serial", factory)

    events = []
    cfg = make_cfg()
    g = Gimbal(cfg, on_event=lambda ev, **fields: events.append(ev))
    try:
        assert wait_until(lambda: len(created) >= 2, timeout=2.0)
        assert wait_until(lambda: not g.mock, timeout=2.0)
        assert "motor_connected" in events
        assert "motor_disconnected" in events

        second = created[1]
        assert wait_until(lambda: second.sent[1:2] == ["T 0 0\n"])
    finally:
        g.close()


def test_mock_mode_never_opens_serial_and_simulates_motion(fake_serial_factory):
    cfg = make_cfg(enabled=False, max_steps_per_sec=2000.0)
    g = Gimbal(cfg)
    try:
        assert g.mock
        assert fake_serial_factory == []

        g.aim(10.0, deadband_deg=0.0)
        pan_before = g.pan
        time.sleep(0.05)
        pan_after = g.pan
        assert pan_after > pan_before
    finally:
        g.close()


def test_aim_ignores_non_finite_angles(fake_serial_factory):
    g = Gimbal(make_cfg())
    try:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[0]
        assert wait_until(lambda: len(ser.sent) >= 2)
        sent = len(ser.sent)
        g.aim(float("nan"))
        g.aim(float("inf"))
        assert len(ser.sent) == sent
        assert g._target == 0
    finally:
        g.close()
