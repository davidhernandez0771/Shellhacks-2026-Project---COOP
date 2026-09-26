"""The real cooper.motors.Gimbal against tools/fake_uno.py over a local TCP socket.

Unlike test_motors.py's FakeSerial (which records lines), the emulator runs the firmware's
logic in real time, so these check outcomes: the shaft (`rotor`) ends up where the Pi
thinks it is, across moves, reconnects and driver power-downs.
"""
import time

import pytest

import cooper.motors as motors_mod
from cooper.config import MotorConfig
from cooper.motors import Gimbal
from tools.fake_uno import FakeUnoServer

STEPS_PER_DEG = 200 * 8 / 360.0


def wait_until(predicate, timeout=5.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


@pytest.fixture
def uno(monkeypatch):
    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.05)
    server = FakeUnoServer(boot_delay_s=0.05).start()
    yield server
    server.close()


@pytest.fixture
def make_gimbal(uno):
    made = []

    def make(**overrides):
        cfg = MotorConfig(port=uno.url, max_steps_per_sec=4000.0, accel_steps_per_sec2=20000.0)
        for key, value in overrides.items():
            setattr(cfg, key, value)
        events = []
        g = Gimbal(cfg, on_event=lambda ev, **f: events.append(ev))
        g.events = events
        made.append(g)
        assert wait_until(lambda: not g.mock), "never connected to the fake Uno"
        return g

    yield make
    for g in made:
        g.close()


def pan_axis(uno):
    with uno.lock:
        a = uno.model.axes[0]
        return a.counter, a.rotor, a.speed


def settled_at(uno, steps):
    counter, rotor, speed = pan_axis(uno)
    return counter == steps and rotor == steps and speed == 0


def test_handshake_sends_limits_and_zero(uno, make_gimbal):
    make_gimbal()
    assert wait_until(lambda: uno.model.commands[:2] == ["C 4000 20000", "Z"])
    assert (uno.model.max_speed, uno.model.accel) == (4000.0, 20000.0)


def test_aim_moves_the_shaft_and_the_reading_follows(uno, make_gimbal):
    g = make_gimbal()
    g.aim(45.0)
    assert wait_until(lambda: settled_at(uno, round(45 * STEPS_PER_DEG)))
    assert wait_until(lambda: g.pan == pytest.approx(45.0, abs=0.3))


def test_heartbeats_keep_a_long_move_going(uno, make_gimbal):
    g = make_gimbal(max_steps_per_sec=300.0)
    g.aim(170.0)  # 756 steps at 300 steps/s: longer than the 2 s watchdog
    assert wait_until(lambda: settled_at(uno, round(170 * STEPS_PER_DEG)), timeout=6)
    assert not uno.model.watchdog_tripped


def test_pan_invert_turns_the_shaft_the_other_way(uno, make_gimbal):
    g = make_gimbal(pan_invert=True)
    g.aim(30.0)
    assert wait_until(lambda: settled_at(uno, -round(30 * STEPS_PER_DEG)))
    assert wait_until(lambda: g.pan == pytest.approx(30.0, abs=0.3))


def test_unplug_and_replug_keeps_the_frame_of_reference(uno, make_gimbal):
    g = make_gimbal()
    g.aim(90.0)
    target = round(90 * STEPS_PER_DEG)
    assert wait_until(lambda: settled_at(uno, target))
    # Wait for a report taken after settling: the Pi can only restore what it was told.
    assert wait_until(lambda: g.pan == pytest.approx(target / STEPS_PER_DEG, abs=1e-9))

    uno.unplug()
    assert wait_until(lambda: g.mock)
    assert wait_until(lambda: "motor_disconnected" in g.events)
    time.sleep(0.2)
    assert g.pan == pytest.approx(90.0, abs=0.3)  # frozen, not simulated

    uno.replug()
    assert wait_until(lambda: uno.connections == 2 and not g.mock)
    # The Uno rebooted with its counter at 0; the Pi restored it to where the shaft is.
    assert wait_until(lambda: settled_at(uno, target))
    assert g.pan == pytest.approx(90.0, abs=0.3)

    g.aim(0.0)
    assert wait_until(lambda: settled_at(uno, 0))


def test_unplug_mid_move_error_is_bounded_by_one_report_period(uno, make_gimbal):
    """Known limit: the Pi only knows the last 50 ms report, so a mid-move unplug can leave
    the restored counter behind the shaft by up to max_speed * 50 ms."""
    g = make_gimbal(max_steps_per_sec=1000.0, accel_steps_per_sec2=20000.0)
    g.aim(170.0)
    assert wait_until(lambda: pan_axis(uno)[0] > 200)
    uno.unplug()
    assert wait_until(lambda: g.mock)
    uno.replug()
    assert wait_until(lambda: uno.connections == 2 and not g.mock)
    time.sleep(0.2)
    counter, rotor, _ = pan_axis(uno)
    # Bound: one report period at full speed, plus the reader's own latency.
    assert abs(counter - rotor) <= 1000 * 0.05 + 30


# ---- safety, checked against the shaft ----

def test_estop_mid_move_does_not_lose_position(uno, make_gimbal):
    """S then E 0 straight away would let the Uno count ~400 braking steps with no torque."""
    g = make_gimbal()
    g.aim(170.0)
    assert wait_until(lambda: abs(pan_axis(uno)[2]) >= 3000)  # near full speed
    g.estop()
    assert wait_until(lambda: not g.drivers_enabled)
    with uno.lock:
        assert uno.model.enabled is False
    counter, rotor, speed = pan_axis(uno)
    assert speed == 0
    assert counter == rotor, "the Uno's counter drifted from the shaft"
    assert wait_until(lambda: g.pan == pytest.approx(counter / STEPS_PER_DEG, abs=1e-9))

    g.aim(0.0)  # refused while e-stopped
    time.sleep(0.2)
    assert pan_axis(uno)[0] == counter

    g.arm()
    assert wait_until(lambda: uno.model.enabled)
    g.aim(0.0)
    assert wait_until(lambda: settled_at(uno, 0))


def test_idle_power_down_then_resume(uno, make_gimbal):
    g = make_gimbal(idle_disable_s=0.3)
    g.aim(45.0)
    assert wait_until(lambda: settled_at(uno, 200))
    deadline = time.monotonic() + 3
    while g.drivers_enabled and time.monotonic() < deadline:
        g.stop()  # the vision loop calls this every frame in stop mode
        time.sleep(0.05)
    with uno.lock:
        assert uno.model.enabled is False
    g.aim(-45.0)
    assert wait_until(lambda: settled_at(uno, -200))
    assert uno.model.enabled is True


def test_zero_moves_the_frame_not_the_shaft(uno, make_gimbal):
    g = make_gimbal()
    g.aim(45.0)
    assert wait_until(lambda: settled_at(uno, 200))
    g.zero()
    assert wait_until(lambda: pan_axis(uno)[0] == 0)
    assert pan_axis(uno)[1] == 200  # the shaft didn't move
    g.aim(45.0, epoch=g.frame_epoch)
    assert wait_until(lambda: pan_axis(uno)[:2] == (200, 400))


def test_live_speed_change_reaches_the_uno(uno, make_gimbal):
    g = make_gimbal()
    g.set_motion_limits(1234.0, 5678.0)
    assert wait_until(lambda: (uno.model.max_speed, uno.model.accel) == (1234.0, 5678.0))
