"""The real coop.motors.Gimbal against tools/fake_uno.py over a local TCP socket.

Unlike test_motors.py's FakeSerial (which records lines), the emulator runs the firmware's
logic in real time, so these check outcomes: the shaft (`rotor`) ends up where the Pi
thinks it is, across moves, reconnects and driver power-downs.
"""
import time

import pytest

import coop.motors as motors_mod
from coop.config import MotorConfig
from coop.motors import Gimbal
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
    assert wait_until(lambda: g.pan == pytest.approx(90.0, abs=0.3))

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
