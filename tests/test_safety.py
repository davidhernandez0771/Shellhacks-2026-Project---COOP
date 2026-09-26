"""Gimbal safety: e-stop, arm, zero, idle driver power-down and the frame-of-reference epoch.

Uses test_motors.py's FakeSerial to check what goes on the wire; tests/test_gimbal_e2e.py
checks the physical outcome against the firmware emulator.
"""
import time

import pytest

import cooper.motors as motors_mod
from cooper.config import MotorConfig
from cooper.motors import Gimbal

STEPS_PER_DEG = 200 * 8 / 360.0


def wait_until(predicate, timeout=2.0, interval=0.005):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def make(fake_serial_factory=None, events=None, **overrides):
    cfg = MotorConfig(port="FAKE0")
    for key, value in overrides.items():
        setattr(cfg, key, value)
    on_event = (lambda ev, **f: events.append((ev, f))) if events is not None else None
    g = Gimbal(cfg, on_event=on_event)
    if cfg.enabled:
        assert wait_until(lambda: not g.mock)
        ser = fake_serial_factory[-1]
        assert wait_until(lambda: len(ser.sent) >= 2)  # handshake + resumed target
        return g, ser
    return g, None


@pytest.fixture
def gimbals():
    made = []
    yield made
    for g in made:
        g.close()


# ---- e-stop ----

def test_estop_sends_S_at_once_and_E0_only_once_motion_has_stopped(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    g.aim(90.0)
    ser.push(b"P 100 0\n")
    assert wait_until(lambda: g._pos == 100)

    g.estop()
    assert ser.sent[-1] == "S\n"
    assert g.estopped
    # Still decelerating: the reported position keeps changing, so the drivers stay on.
    for pos in range(120, 240, 20):
        ser.push(f"P {pos} 0\n".encode())
        time.sleep(0.05)
        assert "E 0\n" not in ser.sent
        assert g.drivers_enabled
    # Position stops changing -> power down.
    for _ in range(8):
        ser.push(b"P 240 0\n")
    assert wait_until(lambda: "E 0\n" in ser.sent, timeout=1.0)
    assert not g.drivers_enabled


def test_estop_when_already_still_powers_down_quickly(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    time.sleep(0.3)  # no movement reported for a while
    t0 = time.monotonic()
    g.estop()
    assert wait_until(lambda: "E 0\n" in ser.sent, timeout=1.0)
    assert time.monotonic() - t0 < 0.6


def test_estop_powers_down_by_the_deadline_even_without_reports(fake_serial_factory, gimbals, monkeypatch):
    monkeypatch.setattr(motors_mod, "ESTOP_MARGIN_S", 0.05)
    g, ser = make(fake_serial_factory, max_steps_per_sec=1000.0, accel_steps_per_sec2=10000.0)
    gimbals.append(g)
    g.estop()
    # Keep "moving" forever; the deadline (1000/10000 + 0.05 s) must still cut power.
    stop_at = time.monotonic() + 0.6
    pos = 0
    while time.monotonic() < stop_at and "E 0\n" not in ser.sent:
        pos += 5
        ser.push(f"P {pos} 0\n".encode())
        time.sleep(0.02)
    assert "E 0\n" in ser.sent


def test_estop_blocks_aim_until_armed(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    g.estop()
    assert wait_until(lambda: "E 0\n" in ser.sent)
    sent = len(ser.sent)
    g.aim(30.0)
    assert len(ser.sent) == sent

    assert g.arm() is True
    assert ser.sent[-1] == "E 1\n"
    assert g.drivers_enabled and not g.estopped
    g.aim(30.0)
    assert ser.sent[-1] == f"T {round(30 * STEPS_PER_DEG)} 0\n"


def test_arm_before_power_down_cancels_it(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    ser.push(b"P 5 0\n")
    g.estop()
    for pos in (10, 20):  # still moving
        ser.push(f"P {pos} 0\n".encode())
    g.arm()
    time.sleep(0.6)
    assert "E 0\n" not in ser.sent
    assert g.drivers_enabled


def test_a_stale_power_down_from_an_earlier_estop_is_ignored(fake_serial_factory, gimbals, monkeypatch):
    """estop -> arm -> move -> estop: the first estop's timer must not cut power mid-ramp."""
    monkeypatch.setattr(motors_mod, "ESTOP_MARGIN_S", 0.2)
    g, ser = make(fake_serial_factory, max_steps_per_sec=1000.0, accel_steps_per_sec2=10000.0)
    gimbals.append(g)
    g.estop()
    pos = 0
    for _ in range(10):  # keep "moving" so the first estop can't finish by stillness
        pos += 5
        ser.push(f"P {pos} 0\n".encode())
        time.sleep(0.02)
    g.arm()
    g.estop()  # second estop; keep reporting motion so only a deadline could cut power
    t0 = time.monotonic()
    while "E 0\n" not in ser.sent and time.monotonic() - t0 < 1.0:
        pos += 5
        ser.push(f"P {pos} 0\n".encode())
        time.sleep(0.01)
    assert time.monotonic() - t0 >= 0.25  # the second estop's own deadline (0.1 + 0.2 s)


def test_arm_without_estop_is_a_no_op(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    sent = len(ser.sent)
    assert g.arm() is False
    assert len(ser.sent) == sent


def test_reconnect_while_estopped_keeps_the_drivers_off(monkeypatch, gimbals):
    """The Uno boots with its drivers enabled; the handshake must switch them off again."""
    from tests.conftest import FakeSerial

    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.01)
    created = []

    class Droppable(FakeSerial):
        dropped = False

        def readline(self):
            if self.dropped:
                raise OSError("unplugged")
            return super().readline()

    def factory(port, baud, timeout=0.1):
        created.append(Droppable(port, baud, timeout))
        return created[-1]

    monkeypatch.setattr("serial.Serial", factory)
    g = Gimbal(MotorConfig(port="FAKE0"))
    gimbals.append(g)
    assert wait_until(lambda: not g.mock)
    g.estop()
    created[0].dropped = True
    assert wait_until(lambda: len(created) == 2 and not g.mock)
    assert created[1].sent[0].endswith("Z 0 0\nE 0\n")
    assert g.estopped and not g.drivers_enabled


def test_estop_in_mock_mode_freezes_the_simulation(gimbals):
    g, _ = make(enabled=False)
    gimbals.append(g)
    g.aim(90.0)
    time.sleep(0.02)
    g.estop()
    frozen = g.pan
    time.sleep(0.05)
    assert g.pan == pytest.approx(frozen)
    assert wait_until(lambda: not g.drivers_enabled)
    g.aim(-90.0)
    time.sleep(0.05)
    assert g.pan == pytest.approx(frozen)


# ---- idle power-down in stop mode ----

def test_drivers_power_down_after_idle_timeout_in_stop(fake_serial_factory, gimbals):
    events = []
    g, ser = make(fake_serial_factory, events=events, idle_disable_s=0.2)
    gimbals.append(g)
    g.stop()
    time.sleep(0.1)
    g.stop()
    assert "E 0\n" not in ser.sent
    assert wait_until(lambda: "E 0\n" in ser.sent, timeout=1.5)  # the reader thread checks too
    assert not g.drivers_enabled and not g.estopped
    assert ("motors_idle", {"after_s": 0.2}) in events
    assert ser.sent.count("E 0\n") == 1


def test_leaving_stop_re_enables_before_moving(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory, idle_disable_s=0.1)
    gimbals.append(g)
    g.stop()
    assert wait_until(lambda: not g.drivers_enabled, timeout=1.5)
    g.aim(20.0)
    assert ser.sent[-2:] == ["E 1\n", f"T {round(20 * STEPS_PER_DEG)} 0\n"]
    assert g.drivers_enabled


def test_re_enable_happens_even_when_the_aim_is_inside_the_deadband(fake_serial_factory, gimbals):
    """Stop -> manual at the same angle: nothing to move, but the motor must hold again."""
    g, ser = make(fake_serial_factory, idle_disable_s=0.1)
    gimbals.append(g)
    g.stop()
    assert wait_until(lambda: not g.drivers_enabled, timeout=1.5)
    g.aim(0.0, deadband_deg=1.0)
    assert ser.sent[-1] == "E 1\n"
    assert g.drivers_enabled


def test_idle_power_down_can_be_turned_off(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory, idle_disable_s=0.0)
    gimbals.append(g)
    for _ in range(20):
        g.stop()
        time.sleep(0.02)
    assert "E 0\n" not in ser.sent
    assert g.drivers_enabled


def test_idle_power_down_waits_for_motion_to_end(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory, idle_disable_s=0.05)
    gimbals.append(g)
    g.stop()
    for pos in range(0, 400, 10):  # still coasting down
        ser.push(f"P {pos} 0\n".encode())
        g.stop()
        time.sleep(0.02)
        assert "E 0\n" not in ser.sent
    assert wait_until(lambda: "E 0\n" in ser.sent, timeout=1.5)


def test_aim_cancels_the_idle_timer(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory, idle_disable_s=0.2)
    gimbals.append(g)
    g.stop()
    time.sleep(0.1)
    g.aim(0.0, deadband_deg=1.0)  # back to manual/auto
    time.sleep(0.4)
    assert "E 0\n" not in ser.sent


# ---- zero and the frame epoch ----

def test_zero_makes_here_zero(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    ser.push(f"P {round(40 * STEPS_PER_DEG)} 0\n".encode())
    assert wait_until(lambda: g.pan == pytest.approx(40.0, abs=0.3))
    epoch = g.frame_epoch
    g.zero()
    assert ser.sent[-1] == "Z\n"
    assert g.pan == 0.0
    assert g.frame_epoch == epoch + 1
    assert g._target == 0


def test_aim_from_a_stale_epoch_is_dropped(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    epoch = g.frame_epoch
    g.zero()
    sent = len(ser.sent)
    g.aim(30.0, epoch=epoch)  # computed from angles in the old frame
    assert len(ser.sent) == sent
    g.aim(30.0, epoch=g.frame_epoch)
    assert ser.sent[-1].startswith("T ")


def test_zero_in_mock_mode(gimbals):
    g, _ = make(enabled=False, max_steps_per_sec=100000.0)
    gimbals.append(g)
    g.aim(45.0)  # exactly 200 microsteps
    assert wait_until(lambda: g.pan == pytest.approx(45.0, abs=0.01))
    g.zero()
    time.sleep(0.02)
    assert g.pan == 0.0


# ---- live changes ----

def test_set_motion_limits_updates_the_uno(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    g.set_motion_limits(1500.0, 5000.0)
    assert ser.sent[-1] == "C 1500 5000\n"
    assert (g.cfg.max_steps_per_sec, g.cfg.accel_steps_per_sec2) == (1500.0, 5000.0)


def test_set_pan_invert_flips_the_reading_and_bumps_the_epoch(fake_serial_factory, gimbals):
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    ser.push(f"P {round(30 * STEPS_PER_DEG)} 0\n".encode())
    assert wait_until(lambda: g.pan == pytest.approx(30.0, abs=0.3))
    epoch = g.frame_epoch
    g.set_pan_invert(True)
    assert g.pan == pytest.approx(-30.0, abs=0.3)
    assert g.frame_epoch == epoch + 1
    g.set_pan_invert(True)  # no change, no new epoch
    assert g.frame_epoch == epoch + 1


# ---- link state ----

def test_link_state(fake_serial_factory, gimbals, monkeypatch):
    g, _ = make(enabled=False)
    gimbals.append(g)
    assert g.link_state == "mock"

    g2, _ = make(fake_serial_factory)
    gimbals.append(g2)
    assert g2.link_state == "connected"

    monkeypatch.setattr(motors_mod, "find_arduino_port", lambda: None)
    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.01)
    g3 = Gimbal(MotorConfig(port="auto"))
    gimbals.append(g3)
    assert g3.link_state == "reconnecting"


def test_a_report_sent_before_the_Z_arrived_is_ignored(fake_serial_factory, gimbals):
    """The Uno may have a pre-zero "P 400 0" in flight; it must not undo the zero."""
    g, ser = make(fake_serial_factory)
    gimbals.append(g)
    ser.push(b"P 400 0\n")
    assert wait_until(lambda: g._pos == 400)
    g.zero()
    ser.push(b"P 400 0\n")  # stale: sent before the Uno processed Z
    time.sleep(0.05)
    assert g.pan == 0.0 and g._hw_pos == 0
    time.sleep(motors_mod.ZERO_SETTLE_S)
    ser.push(b"P 3 0\n")  # a genuine post-zero report
    assert wait_until(lambda: g._pos == 3)
