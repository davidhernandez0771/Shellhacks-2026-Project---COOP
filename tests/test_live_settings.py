"""Live tuning: cooper.settings.LiveSettings and GET/POST /api/settings."""
import tomllib

import pytest

from cooper.config import Config
from cooper.control import Control
from cooper.settings import LiveSettings, SettingsError
from cooper.stream import SharedState, create_app


@pytest.fixture
def rig(tmp_path):
    cfg = Config()
    control = Control()
    live = LiveSettings(cfg, path=tmp_path / "cooper.toml", control=control)
    client = create_app(SharedState(), control, settings=live).test_client()
    return cfg, control, live, client, tmp_path / "cooper.toml"


def test_get_lists_values_ranges_and_file(rig):
    _, _, _, client, path = rig
    body = client.get("/api/settings").get_json()
    assert body["settings"] == {"conf": 0.4, "horizon_s": 1.5, "ttc_warn_s": 2.0, "ttc_clear_s": 2.5,
                                "hold_s": 0.5}
    assert body["ranges"]["conf"] == [0.05, 0.95]
    assert set(body["ranges"]) == set(body["settings"])
    assert body["file"] == str(path)


def test_risk_settings_apply_to_the_risk_config(rig):
    cfg, _, _, client, _ = rig
    resp = client.post("/api/settings", json={"horizon_s": 2.0, "ttc_warn_s": 1.5, "hold_s": 0.3})
    assert resp.status_code == 200
    assert (cfg.risk.horizon_s, cfg.risk.ttc_warn_s, cfg.risk.hold_s) == (2.0, 1.5, 0.3)


def test_a_change_that_breaks_a_cross_setting_rule_is_rejected(rig):
    """ttc_warn_s must stay below ttc_clear_s, or the TTC warning could never release."""
    cfg, _, _, client, _ = rig
    resp = client.post("/api/settings", json={"ttc_warn_s": 3.0})
    assert resp.status_code == 400 and "ttc_warn_s" in resp.get_json()["error"]
    assert cfg.risk.ttc_warn_s == 2.0
    both = client.post("/api/settings", json={"ttc_warn_s": 3.0, "ttc_clear_s": 3.5})
    assert both.status_code == 200 and cfg.risk.ttc_clear_s == 3.5


def test_post_applies_immediately(rig):
    cfg, _, _, client, path = rig
    resp = client.post("/api/settings", json={"conf": 0.6})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True and body["saved"] is False
    assert body["settings"]["conf"] == 0.6
    assert cfg.detector.conf == 0.6
    assert not path.exists()


def test_save_writes_every_live_setting_and_keeps_the_rest_of_the_file(rig):
    cfg, _, _, client, path = rig
    path.write_text("# mine\n[camera]\nwidth = 800\n", encoding="utf-8")
    resp = client.post("/api/settings", json={"conf": 0.3, "save": True})
    assert resp.get_json()["saved"] is True
    text = path.read_text(encoding="utf-8")
    assert "# mine" in text
    data = tomllib.loads(text)
    assert data["camera"] == {"width": 800}
    assert data["detector"] == {"conf": 0.3}


def test_apply_then_save_persists_the_earlier_change(rig):
    """The dashboard's Apply, then Save with nothing new: the change must reach the file."""
    _, _, _, client, path = rig
    client.post("/api/settings", json={"conf": 0.7})  # applied, not saved
    resp = client.post("/api/settings", json={"save": True})
    assert resp.status_code == 200 and resp.get_json()["saved"] is True
    assert tomllib.loads(path.read_text(encoding="utf-8"))["detector"]["conf"] == 0.7


def test_saved_file_loads_back_to_the_same_live_values(rig):
    from cooper.settings import load_config

    _, _, live, client, path = rig
    client.post("/api/settings", json={"conf": 0.55, "save": True})
    assert LiveSettings(load_config(path), path=path).current() == live.current()


@pytest.mark.parametrize("body,fragment", [
    ({"confidence": 0.3}, "unknown setting"),
    ({"imgsz": 256}, "unknown setting"),          # file-only, needs a restart
    ({"conf": 1.2}, "conf"),
    ({"conf": "0.5"}, "conf"),
    ({"conf": True}, "conf"),
    ({"save": "yes"}, "save"),
])
def test_invalid_changes_are_rejected_and_nothing_applies(rig, body, fragment):
    cfg, _, _, client, path = rig
    resp = client.post("/api/settings", json=body)
    assert resp.status_code == 400
    assert fragment in resp.get_json()["error"]
    assert cfg == Config()
    assert not path.exists()


def test_non_finite_numbers_are_rejected(rig):
    _, _, _, client, _ = rig
    resp = client.post("/api/settings", data='{"conf": NaN}', content_type="application/json")
    assert resp.status_code == 400


def test_body_must_be_an_object(rig):
    _, _, _, client, _ = rig
    assert client.post("/api/settings", json=[1, 2]).status_code == 400
    assert client.post("/api/settings", data="nope").status_code == 400


def test_changes_are_logged_as_an_event(rig):
    _, control, _, client, _ = rig
    client.post("/api/settings", json={"conf": 0.5, "save": True})
    event = control.events_since(0)[-1]
    assert event["type"] == "settings_changed"
    assert event["changed"] == {"conf": 0.5}
    assert event["saved"] is True


def test_a_bare_save_is_logged_too(rig):
    _, control, _, client, _ = rig
    client.post("/api/settings", json={"save": True})
    event = control.events_since(0)[-1]
    assert event["type"] == "settings_changed" and event["changed"] == {} and event["saved"] is True


def test_an_empty_body_changes_nothing_and_logs_nothing(rig):
    _, control, _, client, path = rig
    resp = client.post("/api/settings", json={})
    assert resp.status_code == 200 and resp.get_json()["saved"] is False
    assert control.events_since(0) == [] and not path.exists()


def test_a_failed_save_applies_nothing(rig):
    cfg, _, _, client, path = rig
    path.write_text("[detector\n", encoding="utf-8")  # unparseable: save must refuse
    resp = client.post("/api/settings", json={"conf": 0.3, "save": True})
    assert resp.status_code == 400
    assert cfg.detector.conf == 0.4


def test_works_without_control(tmp_path):
    cfg = Config()
    live = LiveSettings(cfg, path=tmp_path / "c.toml")
    live.update({"conf": 0.2})
    assert cfg.detector.conf == 0.2
    with pytest.raises(SettingsError):
        live.update({"nope": 1})


def test_settings_routes_404_when_not_configured():
    client = create_app(SharedState(), Control()).test_client()
    assert client.get("/api/settings").status_code == 404


# ---- the lane (POST /api/lane) ----

NEW_LANE = [[0.40, 0.55], [0.60, 0.55], [0.90, 1.0], [0.10, 1.0]]


def test_lane_applies_live_and_logs_it(rig):
    cfg, control, _, client, path = rig
    resp = client.post("/api/lane", json={"lane": NEW_LANE})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True and body["saved"] is False and body["lane"] == NEW_LANE
    assert cfg.risk.lane == (0.40, 0.55, 0.60, 0.55, 0.90, 1.0, 0.10, 1.0)
    assert not path.exists()
    event = control.events_since(0)[-1]
    assert event["type"] == "lane_changed" and event["lane"] == NEW_LANE and event["saved"] is False


def test_lane_save_writes_it_to_the_settings_file(rig):
    from cooper.settings import load_config

    _, _, _, client, path = rig
    assert client.post("/api/lane", json={"lane": NEW_LANE, "save": True}).get_json()["saved"] is True
    assert load_config(path).risk.lane == (0.40, 0.55, 0.60, 0.55, 0.90, 1.0, 0.10, 1.0)


def test_settings_report_the_lane_and_its_default(rig):
    _, _, _, client, _ = rig
    client.post("/api/lane", json={"lane": NEW_LANE})
    body = client.get("/api/settings").get_json()
    assert body["lane"] == NEW_LANE
    assert body["lane_default"] == [[0.44, 0.6], [0.56, 0.6], [0.79, 1.0], [0.21, 1.0]]


@pytest.mark.parametrize("body", [
    {},                                                               # no lane
    {"lane": NEW_LANE[:3]},                                           # three corners
    {"lane": [[0.4, 0.55], [0.6, 0.55], [0.9, 1.0], [0.1]]},          # a corner with one number
    {"lane": [[0.4, 0.55], [0.6, 0.55], [0.9, 1.0], ["a", 1.0]]},     # not a number
    {"lane": [[0.4, 0.55], [0.6, 0.55], [1.2, 1.0], [0.1, 1.0]]},     # off the frame
    {"lane": [[0.4, 1.0], [0.6, 1.0], [0.9, 0.5], [0.1, 0.5]]},       # upside down
    {"lane": [[0.4, 0.55], [0.6, 0.55], [0.9, 1.0], [True, 1.0]]},    # a boolean
    {"lane": NEW_LANE, "save": "yes"},
])
def test_invalid_lanes_are_rejected_and_nothing_changes(rig, body):
    cfg, control, _, client, path = rig
    resp = client.post("/api/lane", json=body)
    assert resp.status_code == 400 and resp.get_json()["ok"] is False
    assert cfg.risk.lane == Config().risk.lane
    assert control.events_since(0) == [] and not path.exists()


def test_lane_route_404_without_live_settings():
    client = create_app(SharedState(), Control()).test_client()
    assert client.post("/api/lane", json={"lane": NEW_LANE}).status_code == 404
