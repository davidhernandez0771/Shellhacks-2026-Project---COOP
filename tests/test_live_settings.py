"""Live tuning: coop.settings.LiveSettings and GET/POST /api/settings."""
import tomllib

import pytest

from coop.config import Config
from coop.control import Control
from coop.settings import LiveSettings, SettingsError
from coop.stream import SharedState, create_app


class FakeGimbal:
    def __init__(self, cfg):
        self.cfg = cfg
        self.calls = []
        self.steps_per_deg = 200 * 8 / 360.0

    def set_motion_limits(self, speed, accel):
        self.calls.append(("limits", speed, accel))
        self.cfg.max_steps_per_sec, self.cfg.accel_steps_per_sec2 = speed, accel

    def set_pan_invert(self, invert):
        self.calls.append(("invert", invert))
        self.cfg.pan_invert = invert


@pytest.fixture
def rig(tmp_path):
    cfg = Config()
    control = Control(cfg.motors)
    gimbal = FakeGimbal(cfg.motors)
    live = LiveSettings(cfg, path=tmp_path / "coop.toml", gimbal=gimbal, control=control)
    client = create_app(SharedState(), control, settings=live).test_client()
    return cfg, control, gimbal, live, client, tmp_path / "coop.toml"


def test_get_lists_values_ranges_and_units(rig):
    cfg, _, _, _, client, path = rig
    body = client.get("/api/settings").get_json()
    assert body["settings"] == {"lead_time_s": 0.15, "deadband_deg": 1.0, "conf": 0.4,
                                "max_steps_per_sec": 2000.0, "accel_steps_per_sec2": 6000.0,
                                "pan_invert": False}
    assert body["ranges"]["conf"] == [0.05, 0.95]
    assert set(body["ranges"]) == set(body["settings"]) - {"pan_invert"}
    assert body["steps_per_deg"] == pytest.approx(4.444, abs=1e-3)
    assert body["file"] == str(path)


def test_post_applies_immediately(rig):
    cfg, _, gimbal, _, client, path = rig
    resp = client.post("/api/settings", json={"lead_time_s": 0.25, "deadband_deg": 0.5, "conf": 0.6})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True and body["saved"] is False
    assert body["settings"]["lead_time_s"] == 0.25
    assert (cfg.tracking.lead_time_s, cfg.tracking.deadband_deg, cfg.detector.conf) == (0.25, 0.5, 0.6)
    assert not path.exists()


def test_speed_changes_go_to_the_uno_in_one_command(rig):
    cfg, _, gimbal, _, client, _ = rig
    client.post("/api/settings", json={"max_steps_per_sec": 1500, "accel_steps_per_sec2": 4000})
    assert gimbal.calls == [("limits", 1500.0, 4000.0)]
    client.post("/api/settings", json={"max_steps_per_sec": 1000})
    assert gimbal.calls[-1] == ("limits", 1000.0, 4000.0)
    assert isinstance(cfg.motors.max_steps_per_sec, float)


def test_unchanged_speed_is_not_resent(rig):
    _, _, gimbal, _, client, _ = rig
    client.post("/api/settings", json={"max_steps_per_sec": 2000.0, "lead_time_s": 0.2})
    assert gimbal.calls == []


def test_save_writes_only_the_sent_keys(rig):
    cfg, _, _, _, client, path = rig
    path.write_text("# mine\n[motors]\nmicrosteps = 16\n", encoding="utf-8")
    cfg.motors.microsteps = 16
    resp = client.post("/api/settings", json={"lead_time_s": 0.3, "save": True})
    assert resp.get_json()["saved"] is True
    text = path.read_text(encoding="utf-8")
    assert "# mine" in text
    data = tomllib.loads(text)
    assert data == {"motors": {"microsteps": 16}, "tracking": {"lead_time_s": 0.3}}


def test_save_with_nothing_to_save(rig):
    _, _, _, _, client, path = rig
    resp = client.post("/api/settings", json={"save": True})
    assert resp.status_code == 200 and resp.get_json()["saved"] is False
    assert not path.exists()


@pytest.mark.parametrize("body,fragment", [
    ({"lead_time": 0.3}, "unknown setting"),
    ({"microsteps": 16}, "unknown setting"),          # file-only, needs a restart
    ({"conf": 1.2}, "conf"),
    ({"conf": "0.5"}, "conf"),
    ({"conf": True}, "conf"),
    ({"pan_invert": 1}, "pan_invert"),
    ({"lead_time_s": -1}, "lead_time_s"),
    ({"max_steps_per_sec": 9000}, "max_steps_per_sec"),
    ({"save": "yes"}, "save"),
])
def test_invalid_changes_are_rejected_and_nothing_applies(rig, body, fragment):
    cfg, _, gimbal, _, client, path = rig
    before = Config()
    resp = client.post("/api/settings", json={"deadband_deg": 2.0, **body})
    assert resp.status_code == 400
    assert fragment in resp.get_json()["error"]
    assert cfg == before  # all-or-nothing: the valid deadband change didn't apply either
    assert gimbal.calls == [] and not path.exists()


def test_non_finite_numbers_are_rejected(rig):
    _, _, _, _, client, _ = rig
    resp = client.post("/api/settings", data='{"lead_time_s": NaN}', content_type="application/json")
    assert resp.status_code == 400


def test_body_must_be_an_object(rig):
    _, _, _, _, client, _ = rig
    assert client.post("/api/settings", json=[1, 2]).status_code == 400
    assert client.post("/api/settings", data="nope").status_code == 400


def test_pan_invert_only_changes_in_stop_mode(rig):
    cfg, control, gimbal, _, client, _ = rig
    resp = client.post("/api/settings", json={"pan_invert": True})
    assert resp.status_code == 400 and "stop" in resp.get_json()["error"]
    assert cfg.motors.pan_invert is False
    control.set_mode("stop")
    assert client.post("/api/settings", json={"pan_invert": True}).status_code == 200
    assert gimbal.calls == [("invert", True)]
    assert cfg.motors.pan_invert is True


def test_sending_the_current_invert_value_is_fine_in_any_mode(rig):
    _, _, gimbal, _, client, _ = rig
    assert client.post("/api/settings", json={"pan_invert": False}).status_code == 200
    assert gimbal.calls == []


def test_changes_are_logged_as_an_event(rig):
    _, control, _, _, client, _ = rig
    client.post("/api/settings", json={"lead_time_s": 0.2, "save": True})
    event = control.events_since(0)[-1]
    assert event["type"] == "settings_changed"
    assert event["changed"] == {"lead_time_s": 0.2}
    assert event["saved"] is True


def test_a_failed_save_applies_nothing(rig, monkeypatch):
    cfg, _, _, _, client, path = rig
    path.write_text("[tracking\n", encoding="utf-8")  # unparseable: save must refuse
    resp = client.post("/api/settings", json={"lead_time_s": 0.3, "save": True})
    assert resp.status_code == 400
    assert cfg.tracking.lead_time_s == 0.15


def test_works_without_a_gimbal_or_control(tmp_path):
    cfg = Config()
    live = LiveSettings(cfg, path=tmp_path / "c.toml")
    live.update({"max_steps_per_sec": 1200, "pan_invert": True})
    assert cfg.motors.max_steps_per_sec == 1200.0 and cfg.motors.pan_invert is True
    with pytest.raises(SettingsError):
        live.update({"nope": 1})


def test_settings_routes_404_when_not_configured():
    client = create_app(SharedState(), Control(Config().motors)).test_client()
    assert client.get("/api/settings").status_code == 404
