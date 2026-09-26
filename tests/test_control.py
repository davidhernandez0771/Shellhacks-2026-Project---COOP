"""Shared control state behind the HTTP API (cooper/control.py): mode, target lock, manual
aim, and the event log described in docs/API.md."""
import pytest

from cooper.config import MotorConfig
from cooper.control import Control, ControlError


def make_control(**overrides):
    cfg = MotorConfig()
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return Control(cfg)


def test_starts_in_auto_mode_with_no_target():
    c = make_control()
    assert c.mode == "auto"
    assert c.locked_id is None


def test_set_mode_rejects_unknown_mode():
    c = make_control()
    with pytest.raises(ControlError):
        c.set_mode("chase")
    assert c.mode == "auto"


def test_set_mode_logs_an_event_only_on_real_change():
    c = make_control()
    c.set_mode("manual")
    c.set_mode("manual")  # no-op; must not double-log
    mode_events = [e for e in c.events_since(0) if e["type"] == "mode_changed"]
    assert len(mode_events) == 1
    assert mode_events[0]["mode"] == "manual"


def test_set_target_locks_id_and_switches_to_auto():
    c = make_control()
    c.set_mode("manual")
    c.set_target(7)
    assert c.locked_id == 7
    assert c.mode == "auto"


def test_set_target_clears_lock_with_none():
    c = make_control()
    c.set_target(7)
    c.set_target(None)
    assert c.locked_id is None


def test_set_target_rejects_non_integer_id():
    c = make_control()
    with pytest.raises(ControlError):
        c.set_target("7")


def test_aim_requires_manual_mode():
    c = make_control()
    assert c.mode == "auto"
    with pytest.raises(ControlError):
        c.set_aim(10.0)


def test_aim_clamps_to_configured_limits():
    c = make_control(pan_limits_deg=(-20.0, 20.0))
    c.set_mode("manual")
    c.set_aim(999.0)
    assert c.manual_pan == 20.0
    c.set_aim(-999.0)
    assert c.manual_pan == -20.0


def test_nudge_accumulates_from_current_aim_and_clamps():
    c = make_control(pan_limits_deg=(-20.0, 20.0))
    c.set_mode("manual")
    c.set_aim(15.0)
    c.nudge(3.0)
    assert c.manual_pan == 18.0
    c.nudge(10.0)
    assert c.manual_pan == 20.0


def test_nudge_requires_manual_mode():
    c = make_control()
    with pytest.raises(ControlError):
        c.nudge(1.0)


def test_home_zeroes_aim_and_switches_to_manual():
    c = make_control()
    c.set_mode("stop")
    c.home()
    assert c.mode == "manual"
    assert c.manual_pan == 0.0


def test_events_since_only_returns_newer_events():
    c = make_control()
    c.set_mode("manual")
    c.set_mode("stop")
    events = c.events_since(0)
    assert len(events) == 2
    assert c.events_since(events[-1]["seq"]) == []


def test_log_event_appends_arbitrary_event_types():
    c = make_control()
    c.log_event("motor_connected", port="COM5")
    last = c.events_since(0)[-1]
    assert last["type"] == "motor_connected"
    assert last["port"] == "COM5"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_aim_and_nudge_reject_non_finite_values(bad):
    c = make_control()
    c.set_mode("manual")
    with pytest.raises(ControlError):
        c.set_aim(bad)
    with pytest.raises(ControlError):
        c.nudge(bad)
    assert c.manual_pan == 0.0


# ---- e-stop, arm, zero (Control's side; the Gimbal's is in test_safety.py) ----

class FakeGimbal:
    def __init__(self, pan=0.0):
        self.pan = pan
        self.calls = []
        self.estopped = False

    def estop(self):
        self.calls.append("estop")
        self.estopped = True

    def arm(self):
        self.calls.append("arm")
        was, self.estopped = self.estopped, False
        return was

    def zero(self):
        self.calls.append("zero")
        self.pan = 0.0


def bound_control(pan=0.0, **overrides):
    c = make_control(**overrides)
    g = FakeGimbal(pan)
    c.bind_gimbal(g)
    return c, g


def types(c):
    return [e["type"] for e in c.events_since(0)]


def test_estop_stops_the_gimbal_forces_stop_mode_and_clears_the_lock():
    c, g = bound_control()
    c.set_target(7)
    c.estop()
    assert g.calls == ["estop"]
    assert c.estopped
    assert c.mode == "stop"
    assert c.locked_id is None
    assert "estop" in types(c)


def test_estop_calls_the_gimbal_before_anything_else():
    """The motor command must not wait behind bookkeeping: the gimbal sees it first."""
    order = []
    c, g = bound_control()
    g.estop = lambda: order.append(("gimbal", c.mode))
    c.estop()
    assert order == [("gimbal", "auto")]


def test_estop_is_idempotent():
    c, g = bound_control()
    c.estop()
    c.estop()
    assert types(c).count("estop") == 1
    assert g.calls == ["estop", "estop"]  # re-sent to the motors anyway: it's cheap and safe


@pytest.mark.parametrize("action", [
    lambda c: c.set_mode("auto"),
    lambda c: c.set_mode("manual"),
    lambda c: c.set_target(3),
    lambda c: c.home(),
])
def test_estop_blocks_anything_that_would_move(action):
    c, _ = bound_control()
    c.estop()
    with pytest.raises(ControlError, match="e-stop engaged"):
        action(c)
    assert c.mode == "stop"


def test_estop_still_allows_stop_and_clearing_the_lock():
    c, _ = bound_control()
    c.estop()
    c.set_mode("stop")
    c.set_target(None)
    assert c.mode == "stop"


def test_arm_releases_but_stays_in_stop_mode():
    c, g = bound_control()
    c.estop()
    assert c.arm() is True
    assert g.calls == ["estop", "arm"]
    assert not c.estopped
    assert c.mode == "stop"
    assert types(c)[-1] == "armed"
    c.set_mode("manual")  # now allowed


def test_arm_without_estop_does_nothing():
    c, g = bound_control()
    assert c.arm() is False
    assert g.calls == []
    assert "armed" not in types(c)


def test_zero_switches_to_manual_at_zero_and_clears_the_lock():
    c, g = bound_control(pan=33.0)
    c.set_target(4)
    c.zero()
    assert g.calls == ["zero"]
    assert c.mode == "manual"
    assert c.manual_pan == 0.0
    assert c.locked_id is None
    assert "zeroed" in types(c)


def test_zero_during_estop_stays_stopped():
    c, g = bound_control(pan=33.0)
    c.estop()
    c.zero()
    assert g.calls == ["estop", "zero"]
    assert c.mode == "stop"
    assert c.estopped


def test_entering_manual_holds_the_current_pan():
    """Switching to manual must not jump back to an old manual setpoint."""
    c, g = bound_control()
    c.set_mode("manual")
    c.set_aim(40.0)
    c.set_mode("auto")
    g.pan = -12.5  # auto tracking moved the camera
    c.set_mode("manual")
    assert c.manual_pan == -12.5


def test_entering_manual_clamps_the_held_pan_to_the_limits():
    c, g = bound_control(pan=25.0, pan_limits_deg=(-20.0, 20.0))
    c.set_mode("manual")
    assert c.manual_pan == 20.0


def test_staying_in_manual_keeps_the_setpoint():
    c, g = bound_control()
    c.set_mode("manual")
    c.set_aim(10.0)
    g.pan = 3.0  # still on its way
    c.set_mode("manual")
    assert c.manual_pan == 10.0


def test_control_without_a_gimbal_still_tracks_estop_state():
    c = make_control()
    c.estop()
    assert c.estopped and c.mode == "stop"
    c.zero()
    assert c.arm() is True


def test_an_estop_during_arm_wins():
    """E-STOP pressed while an arm is in flight must leave the system e-stopped."""
    import threading

    c, g = bound_control()
    c.estop()
    in_arm = threading.Event()
    release = threading.Event()
    real_arm = g.arm

    def slow_arm():
        in_arm.set()
        release.wait(2)
        return real_arm()

    g.arm = slow_arm
    armer = threading.Thread(target=c.arm)
    armer.start()
    assert in_arm.wait(2)
    stopper = threading.Thread(target=c.estop)
    stopper.start()
    stopper.join(0.2)
    release.set()
    armer.join(2)
    stopper.join(2)
    assert c.estopped
    assert g.estopped, "the motors must end up e-stopped too"
