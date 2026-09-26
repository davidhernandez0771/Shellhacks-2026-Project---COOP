"""Reconnecting to the Uno must not shift the gimbal's frame of reference.

Opening the serial port resets the Uno, so its step counter restarts at 0 wherever the
axis stopped. Before the fix, the Pi then re-sent its last target in the old frame: a link
lost at pan 90 deg meant the camera turned a further 90 deg after reconnecting, past the
configured limits. Separately, the mock simulation kept "moving" the gimbal during the
outage, so even the Pi's idea of where the axis stopped drifted toward the old target.
"""
import threading
import time

import pytest

from cooper.config import MotorConfig
from cooper.motors import Gimbal
from tests.conftest import FakeSerial

STEPS_PER_DEG = 200 * 8 / 360.0  # MotorConfig defaults: 200 steps/rev, 8 microsteps, 1:1


def wait_until(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class DroppableSerial(FakeSerial):
    """A FakeSerial whose link can be cut on demand, like pulling the USB cable."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dropped = False

    def readline(self):
        if self.dropped:
            raise OSError("link dropped")
        return super().readline()


@pytest.fixture
def link(monkeypatch):
    """First connection is droppable; the second one waits until `allow_reconnect` is set."""
    import cooper.motors as motors_mod

    monkeypatch.setattr(motors_mod, "RECONNECT_S", 0.01)
    created = []
    allow_reconnect = threading.Event()

    def factory(port, baud, timeout=0.1):
        if created:
            allow_reconnect.wait(5)
            inst = FakeSerial(port, baud, timeout)
        else:
            inst = DroppableSerial(port, baud, timeout)
        created.append(inst)
        return inst

    monkeypatch.setattr("serial.Serial", factory)
    return created, allow_reconnect


def make_gimbal(events=None):
    cfg = MotorConfig()
    cfg.port = "FAKE0"
    cfg.max_steps_per_sec = 2000.0
    on_event = (lambda ev, **f: events.append(ev)) if events is not None else None
    return Gimbal(cfg, on_event=on_event)


@pytest.mark.parametrize("reported_deg", [90.0, 20.0], ids=["arrived", "mid-move"])
def test_reconnect_restores_last_reported_position(link, reported_deg):
    created, allow_reconnect = link
    events = []
    g = make_gimbal(events)
    try:
        assert wait_until(lambda: not g.mock)
        first = created[0]
        assert first.sent[0].endswith("\nZ\n")  # first connect: power-on position is 0

        g.aim(90.0)
        target = round(90.0 * STEPS_PER_DEG)
        reported = round(reported_deg * STEPS_PER_DEG)
        first.push(f"P {reported} 0\n".encode())
        assert wait_until(lambda: g.pan == pytest.approx(reported_deg, abs=0.2))

        first.dropped = True
        assert wait_until(lambda: "motor_disconnected" in events)

        # During the outage the real motors are stopped: angles must hold, not simulate
        # motion toward the 90 deg target.
        time.sleep(0.1)
        assert g.mock
        assert g.pan == pytest.approx(reported_deg, abs=0.2)

        allow_reconnect.set()
        assert wait_until(lambda: len(created) == 2 and not g.mock)
        second = created[1]
        assert wait_until(lambda: len(second.sent) >= 2)

        # Restore the Uno's counter to where the axis really is, then resume the same target.
        assert second.sent[0] == f"C 2000 6000\nZ {reported} 0\n"
        assert second.sent[1] == f"T {target} 0\n"
        assert g.pan == pytest.approx(reported_deg, abs=0.2)
    finally:
        g.close()


def test_mock_simulation_still_runs_before_any_hardware(monkeypatch):
    """Laptop dev (--no-motors) keeps the simulated motion the virtual gimbal relies on."""
    cfg = MotorConfig(enabled=False)
    g = Gimbal(cfg)
    try:
        g.aim(10.0)
        before = g.pan
        time.sleep(0.05)
        assert g.pan > before
    finally:
        g.close()
