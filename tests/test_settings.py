"""coop.toml: loading, validation and in-place saving (coop/settings.py)."""
import tomllib
from pathlib import Path

import pytest

from coop.config import Config
from coop.settings import SettingsError, load_config, save_settings, validate_config

REPO = Path(__file__).resolve().parent.parent


def write(tmp_path, text, name="coop.toml"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def test_missing_default_file_means_defaults(tmp_path):
    assert load_config(tmp_path / "coop.toml") == Config()


def test_explicitly_requested_file_must_exist(tmp_path):
    with pytest.raises(SettingsError, match="not found"):
        load_config(tmp_path / "nope.toml", required=True)


def test_file_overrides_defaults(tmp_path):
    path = write(tmp_path, """
[motors]
pan_invert = true
microsteps = 16
pan_gear_ratio = 3          # an int is fine for a float setting
pan_limits_deg = [-90, 90]
port = "socket://localhost:5555"

[tracking]
lead_time_s = 0.2

[detector]
conf = 0.5
""")
    cfg = load_config(path)
    assert cfg.motors.pan_invert is True
    assert cfg.motors.microsteps == 16
    assert cfg.motors.pan_gear_ratio == 3.0 and isinstance(cfg.motors.pan_gear_ratio, float)
    assert cfg.motors.pan_limits_deg == (-90.0, 90.0)
    assert all(isinstance(v, float) for v in cfg.motors.pan_limits_deg)
    assert cfg.motors.port == "socket://localhost:5555"
    assert cfg.tracking.lead_time_s == 0.2
    assert cfg.detector.conf == 0.5
    assert cfg.camera == Config().camera  # untouched sections keep their defaults


def test_unknown_section_is_an_error_listing_the_valid_ones(tmp_path):
    path = write(tmp_path, "[motor]\npan_invert = true\n")
    with pytest.raises(SettingsError) as e:
        load_config(path)
    assert "[motor]" in str(e.value) and "motors" in str(e.value)


def test_unknown_key_is_an_error_suggesting_the_right_one(tmp_path):
    path = write(tmp_path, "[motors]\npan_inverted = true\n")
    with pytest.raises(SettingsError) as e:
        load_config(path)
    assert "pan_inverted" in str(e.value) and "pan_invert" in str(e.value)


def test_top_level_keys_are_an_error(tmp_path):
    path = write(tmp_path, "pan_invert = true\n")
    with pytest.raises(SettingsError, match="section"):
        load_config(path)


@pytest.mark.parametrize("text", [
    '[motors]\nmicrosteps = "8"\n',
    "[motors]\nmicrosteps = 8.0\n",
    "[motors]\npan_invert = 1\n",
    "[detector]\nconf = true\n",
    '[motors]\npan_limits_deg = ["a", "b"]\n',
    "[motors]\npan_limits_deg = 90\n",
    "[detector]\nclasses = [0, 2.5]\n",
])
def test_wrong_types_are_errors(tmp_path, text):
    with pytest.raises(SettingsError):
        load_config(write(tmp_path, text))


def test_syntax_error_names_the_file(tmp_path):
    path = write(tmp_path, "[motors\n")
    with pytest.raises(SettingsError, match="coop.toml"):
        load_config(path)


@pytest.mark.parametrize("section,key,value", [
    ("detector", "conf", 1.5),
    ("detector", "imgsz", 300),              # YOLO needs a multiple of 32
    ("tracking", "lead_time_s", -0.1),
    ("tracking", "deadband_deg", 50.0),
    ("motors", "microsteps", 3),
    ("motors", "steps_per_rev", 0),
    ("motors", "pan_gear_ratio", 0.0),
    ("motors", "pan_limits_deg", (10.0, -10.0)),
    ("motors", "pan_limits_deg", (10.0, 90.0)),  # must include the power-on position 0
    ("motors", "pan_limits_deg", (-10.0, 10.0, 20.0)),
    ("motors", "max_steps_per_sec", 10000.0),
    ("motors", "accel_steps_per_sec2", 0.0),
    ("motors", "idle_disable_s", 0.5),        # 0 (off) or at least 1 s
    ("motors", "idle_disable_s", -1.0),
    ("camera", "source", "usb"),
    ("camera", "hfov_deg", 0.0),
    ("camera", "width", 0),
    ("stream", "port", 70000),
    ("stream", "jpeg_quality", 0),
    ("sim", "world_hfov_deg", 30.0),          # must exceed the camera's hfov
])
def test_validate_rejects_out_of_range_values(section, key, value):
    cfg = Config()
    setattr(getattr(cfg, section), key, value)
    with pytest.raises(SettingsError, match=key):
        validate_config(cfg)


def test_defaults_are_valid():
    validate_config(Config())


def test_example_file_matches_the_defaults():
    """coop.example.toml documents every default; this keeps it from drifting."""
    example = REPO / "coop.example.toml"
    assert load_config(example, required=True) == Config()


def test_example_file_lists_every_setting():
    import dataclasses

    data = tomllib.loads((REPO / "coop.example.toml").read_text(encoding="utf-8"))
    for section in dataclasses.fields(Config):
        listed = set(data.get(section.name, {}))
        expected = {f.name for f in dataclasses.fields(getattr(Config(), section.name))}
        assert listed == expected, f"[{section.name}] in coop.example.toml"


# ---- saving ----

def test_save_updates_values_in_place_and_keeps_comments(tmp_path):
    path = write(tmp_path, """# my rig
[tracking]
lead_time_s = 0.15   # tuned on the bench
deadband_deg = 1.0

[motors]
# the belt
pan_gear_ratio = 3.0
""")
    save_settings(path, {"tracking": {"lead_time_s": 0.25}, "motors": {"pan_invert": True}})
    text = path.read_text(encoding="utf-8")
    assert "# my rig" in text and "# the belt" in text
    assert "lead_time_s = 0.25   # tuned on the bench" in text
    data = tomllib.loads(text)
    assert data["tracking"] == {"lead_time_s": 0.25, "deadband_deg": 1.0}
    assert data["motors"] == {"pan_gear_ratio": 3.0, "pan_invert": True}


def test_save_creates_missing_sections_and_file(tmp_path):
    path = tmp_path / "coop.toml"
    save_settings(path, {"detector": {"conf": 0.55}, "motors": {"max_steps_per_sec": 1500.0}})
    cfg = load_config(path)
    assert cfg.detector.conf == 0.55
    assert cfg.motors.max_steps_per_sec == 1500.0


def test_save_round_trips_floats_exactly(tmp_path):
    path = tmp_path / "coop.toml"
    save_settings(path, {"tracking": {"lead_time_s": 0.1 + 0.2}})
    assert load_config(path).tracking.lead_time_s == 0.1 + 0.2


def test_save_rejects_unknown_keys_and_leaves_the_file_alone(tmp_path):
    path = write(tmp_path, "[tracking]\nlead_time_s = 0.15\n")
    before = path.read_text(encoding="utf-8")
    with pytest.raises(SettingsError):
        save_settings(path, {"tracking": {"lead": 0.3}})
    assert path.read_text(encoding="utf-8") == before


def test_save_refuses_a_file_it_cannot_parse(tmp_path):
    path = write(tmp_path, "[tracking\n")
    with pytest.raises(SettingsError):
        save_settings(path, {"tracking": {"lead_time_s": 0.3}})
    assert path.read_text(encoding="utf-8") == "[tracking\n"


def test_save_handles_a_dotted_table_it_cannot_edit_safely(tmp_path):
    """A layout the line editor doesn't understand must fail loudly, never corrupt the file."""
    path = write(tmp_path, "tracking.lead_time_s = 0.15\n")
    before = path.read_text(encoding="utf-8")
    with pytest.raises(SettingsError):
        save_settings(path, {"tracking": {"lead_time_s": 0.3}})
    assert path.read_text(encoding="utf-8") == before
