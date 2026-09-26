"""cooper.toml: loading, validation and in-place saving (cooper/settings.py)."""
import tomllib
from pathlib import Path

import pytest

from cooper.config import Config
from cooper.settings import SettingsError, load_config, save_settings, validate_config

REPO = Path(__file__).resolve().parent.parent


def write(tmp_path, text, name="cooper.toml"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def test_missing_default_file_means_defaults(tmp_path):
    assert load_config(tmp_path / "cooper.toml") == Config()


def test_explicitly_requested_file_must_exist(tmp_path):
    with pytest.raises(SettingsError, match="not found"):
        load_config(tmp_path / "nope.toml", required=True)


def test_file_overrides_defaults(tmp_path):
    path = write(tmp_path, """
[camera]
source = "webcam"
width = 800
hfov_deg = 60               # an int is fine for a float setting

[detector]
conf = 0.5
classes = [0, 2]
""")
    cfg = load_config(path)
    assert cfg.camera.source == "webcam"
    assert cfg.camera.width == 800
    assert cfg.camera.hfov_deg == 60.0 and isinstance(cfg.camera.hfov_deg, float)
    assert cfg.detector.conf == 0.5
    assert cfg.detector.classes == (0, 2)
    assert cfg.stream == Config().stream  # untouched sections keep their defaults


@pytest.mark.parametrize("section", ["motors", "tracking", "sim"])
def test_the_old_gimbal_sections_are_unknown(tmp_path, section):
    """A cooper.toml copied from the gimbal era fails loudly instead of being half-applied."""
    with pytest.raises(SettingsError, match=rf"unknown section \[{section}\]"):
        load_config(write(tmp_path, f"[{section}]\nx = 1\n"))


def test_unknown_section_is_an_error_listing_the_valid_ones(tmp_path):
    path = write(tmp_path, "[detectr]\nconf = 0.5\n")
    with pytest.raises(SettingsError) as e:
        load_config(path)
    assert "[detectr]" in str(e.value) and "detector" in str(e.value)


def test_unknown_key_is_an_error_suggesting_the_right_one(tmp_path):
    path = write(tmp_path, "[detector]\ncnof = 0.5\n")
    with pytest.raises(SettingsError) as e:
        load_config(path)
    assert "cnof" in str(e.value) and "Did you mean 'conf'?" in str(e.value)


def test_top_level_keys_are_an_error(tmp_path):
    path = write(tmp_path, "conf = 0.5\n")
    with pytest.raises(SettingsError, match="section"):
        load_config(path)


@pytest.mark.parametrize("text", [
    '[camera]\nwidth = "640"\n',
    "[camera]\nwidth = 640.0\n",
    "[stream]\nannotate = 1\n",
    "[detector]\nconf = true\n",
    '[detector]\nclasses = ["a", "b"]\n',
    "[detector]\nclasses = 2\n",
    "[detector]\nclasses = [0, 2.5]\n",
])
def test_wrong_types_are_errors(tmp_path, text):
    with pytest.raises(SettingsError):
        load_config(write(tmp_path, text))


def test_syntax_error_names_the_file(tmp_path):
    path = write(tmp_path, "[detector\n")
    with pytest.raises(SettingsError, match="cooper.toml"):
        load_config(path)


@pytest.mark.parametrize("section,key,value", [
    ("detector", "conf", 1.5),
    ("detector", "imgsz", 300),              # YOLO needs a multiple of 32
    ("detector", "classes", (0, -1)),
    ("camera", "source", "usb"),
    ("camera", "hfov_deg", 0.0),
    ("camera", "width", 0),
    ("stream", "port", 70000),
    ("stream", "jpeg_quality", 0),
])
def test_validate_rejects_out_of_range_values(section, key, value):
    cfg = Config()
    setattr(getattr(cfg, section), key, value)
    with pytest.raises(SettingsError, match=key):
        validate_config(cfg)


def test_defaults_are_valid():
    validate_config(Config())


def test_example_file_matches_the_defaults():
    """cooper.example.toml documents every default; this keeps it from drifting."""
    example = REPO / "cooper.example.toml"
    assert load_config(example, required=True) == Config()


def test_example_file_lists_every_setting():
    import dataclasses

    data = tomllib.loads((REPO / "cooper.example.toml").read_text(encoding="utf-8"))
    for section in dataclasses.fields(Config):
        listed = set(data.get(section.name, {}))
        expected = {f.name for f in dataclasses.fields(getattr(Config(), section.name))}
        assert listed == expected, f"[{section.name}] in cooper.example.toml"


# ---- saving ----

def test_save_updates_values_in_place_and_keeps_comments(tmp_path):
    path = write(tmp_path, """# my rig
[detector]
conf = 0.4   # tuned on the bench
imgsz = 320

[camera]
# the dashcam
width = 800
""")
    save_settings(path, {"detector": {"conf": 0.25}, "stream": {"annotate": True}})
    text = path.read_text(encoding="utf-8")
    assert "# my rig" in text and "# the dashcam" in text
    assert "conf = 0.25   # tuned on the bench" in text
    data = tomllib.loads(text)
    assert data["detector"] == {"conf": 0.25, "imgsz": 320}
    assert data["camera"] == {"width": 800}
    assert data["stream"] == {"annotate": True}


def test_save_creates_missing_sections_and_file(tmp_path):
    path = tmp_path / "cooper.toml"
    save_settings(path, {"detector": {"conf": 0.55}, "stream": {"jpeg_quality": 60}})
    cfg = load_config(path)
    assert cfg.detector.conf == 0.55
    assert cfg.stream.jpeg_quality == 60


def test_save_round_trips_floats_exactly(tmp_path):
    path = tmp_path / "cooper.toml"
    save_settings(path, {"camera": {"hfov_deg": 60.1 + 0.2}})
    assert load_config(path).camera.hfov_deg == 60.1 + 0.2


def test_save_rejects_unknown_keys_and_leaves_the_file_alone(tmp_path):
    path = write(tmp_path, "[detector]\nconf = 0.4\n")
    before = path.read_text(encoding="utf-8")
    with pytest.raises(SettingsError):
        save_settings(path, {"detector": {"confidence": 0.3}})
    assert path.read_text(encoding="utf-8") == before


def test_save_refuses_a_file_it_cannot_parse(tmp_path):
    path = write(tmp_path, "[detector\n")
    with pytest.raises(SettingsError):
        save_settings(path, {"detector": {"conf": 0.3}})
    assert path.read_text(encoding="utf-8") == "[detector\n"


def test_save_handles_a_dotted_table_it_cannot_edit_safely(tmp_path):
    """A layout the line editor doesn't understand must fail loudly, never corrupt the file."""
    path = write(tmp_path, "detector.conf = 0.4\n")
    before = path.read_text(encoding="utf-8")
    with pytest.raises(SettingsError):
        save_settings(path, {"detector": {"conf": 0.3}})
    assert path.read_text(encoding="utf-8") == before


def test_save_reports_filesystem_errors_as_settings_errors(tmp_path):
    with pytest.raises(SettingsError, match="can't write"):
        save_settings(tmp_path / "no-such-dir" / "cooper.toml", {"detector": {"conf": 0.3}})


def test_save_reports_an_undecodable_file(tmp_path):
    path = tmp_path / "cooper.toml"
    path.write_bytes(b"\xff\xfe[detector]\n")
    with pytest.raises(SettingsError):
        save_settings(path, {"detector": {"conf": 0.3}})


def test_load_reports_an_undecodable_file(tmp_path):
    path = tmp_path / "cooper.toml"
    path.write_bytes(b"[detector]\nconf = 0.2 # \xff\n")
    with pytest.raises(SettingsError):
        load_config(path)


def test_save_refuses_an_edit_that_would_change_something_else(tmp_path):
    """A key-like line inside a multi-line string would be rewritten too; the re-parse
    check notices the string changed and refuses, leaving the file untouched."""
    text = '[camera]\nsource = """\nwidth = 640\n"""\nwidth = 640\n'
    path = write(tmp_path, text)
    with pytest.raises(SettingsError, match="safely"):
        save_settings(path, {"camera": {"width": 800}})
    assert path.read_text(encoding="utf-8") == text
