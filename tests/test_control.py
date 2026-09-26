"""Shared control state behind the HTTP API (coop/control.py): mode, target lock, manual
aim, and the event log described in docs/API.md."""
import pytest

from coop.config import MotorConfig
from coop.control import Control, ControlError


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
        c.set_aim(10.0, 0.0)


def test_aim_clamps_to_configured_limits():
    c = make_control(pan_limits_deg=(-20.0, 20.0), tilt_limits_deg=(-10.0, 10.0))
    c.set_mode("manual")
    c.set_aim(999.0, -999.0)
    assert c.manual_aim == (20.0, -10.0)


def test_nudge_accumulates_from_current_aim_and_clamps():
    c = make_control(pan_limits_deg=(-20.0, 20.0), tilt_limits_deg=(-10.0, 10.0))
    c.set_mode("manual")
    c.set_aim(15.0, 5.0)
    c.nudge(10.0, -20.0)
    assert c.manual_aim == (20.0, -10.0)


def test_nudge_requires_manual_mode():
    c = make_control()
    with pytest.raises(ControlError):
        c.nudge(1.0, 0.0)


def test_home_zeroes_aim_and_switches_to_manual():
    c = make_control()
    c.set_mode("stop")
    c.home()
    assert c.mode == "manual"
    assert c.manual_aim == (0.0, 0.0)


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
