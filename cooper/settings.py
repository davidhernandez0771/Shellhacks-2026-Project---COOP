"""Settings file (cooper.toml) on top of the cooper/config.py defaults.

Load order: the dataclass defaults, then cooper.toml next to the repo (if it exists), then
command-line flags. cooper.example.toml documents every key; copy it to cooper.toml and delete
what you don't change. cooper.toml is gitignored, so each machine keeps its own.

The file mirrors Config: one [section] per Config field (camera, detector, stream, ...),
one key per dataclass field. Unknown sections or keys and wrong types are errors, not
warnings: a typo silently ignored is how a threshold ends up at its default on demo day.
"""
from __future__ import annotations

import dataclasses
import difflib
import math
import os
import re
import tempfile
import threading
import tomllib
from pathlib import Path

from .config import Config

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "cooper.toml"

# Numeric ranges shared by file validation and live tuning (GET /api/settings "ranges").
RANGES = {
    ("detector", "conf"): (0.05, 0.95),
}


class SettingsError(ValueError):
    """The settings file (or a live settings change) is invalid."""


# ---- loading ----

def load_config(path=None, required=False):
    """Defaults overridden by the TOML file at `path` (DEFAULT_PATH if None).

    A missing file means "all defaults" unless `required` (an explicit --config).
    """
    path = Path(path) if path is not None else DEFAULT_PATH
    cfg = Config()
    if not path.exists():
        if required:
            raise SettingsError(f"settings file not found: {path}")
        return cfg
    apply_overrides(cfg, _read_toml(path), source=str(path))
    validate_config(cfg)
    return cfg


def _read_toml(path):
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except (tomllib.TOMLDecodeError, UnicodeDecodeError, OSError) as e:
        raise SettingsError(f"{path}: {e}") from None


def _suggest(name, options):
    close = difflib.get_close_matches(name, options, n=1)
    return f" Did you mean '{close[0]}'?" if close else ""


def apply_overrides(cfg, data, source="settings"):
    sections = {f.name for f in dataclasses.fields(cfg)}
    for section, values in data.items():
        if not isinstance(values, dict):
            raise SettingsError(f"{source}: '{section}' must be inside a [section] "
                                f"(one of {', '.join(sorted(sections))})")
        if section not in sections:
            raise SettingsError(f"{source}: unknown section [{section}]; valid sections are "
                                f"{', '.join(sorted(sections))}.{_suggest(section, sections)}")
        target = getattr(cfg, section)
        fields = {f.name: f for f in dataclasses.fields(target)}
        for key, value in values.items():
            if key not in fields:
                raise SettingsError(f"{source}: unknown key '{key}' in [{section}]; valid keys are "
                                    f"{', '.join(fields)}.{_suggest(key, fields)}")
            default = getattr(type(target)(), key)
            setattr(target, key, _coerce(value, default, f"[{section}] {key}"))


def _coerce(value, default, where):
    """`value` converted to the type of `default`, or SettingsError."""
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        raise SettingsError(f"{where} must be true or false, got {value!r}")
    if isinstance(default, int):
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        raise SettingsError(f"{where} must be a whole number, got {value!r}")
    if isinstance(default, float):
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return float(value)
        raise SettingsError(f"{where} must be a number, got {value!r}")
    if isinstance(default, str):
        if isinstance(value, str):
            return value
        raise SettingsError(f"{where} must be a string, got {value!r}")
    if isinstance(default, tuple):
        if not isinstance(value, list):
            raise SettingsError(f"{where} must be a list like {list(default)}, got {value!r}")
        element = default[0] if default else value[0] if value else None
        return tuple(_coerce(v, element, where) for v in value) if element is not None else ()
    raise SettingsError(f"{where}: unsupported setting type")  # pragma: no cover


# ---- validation ----

def validate_config(cfg):
    """Raise SettingsError naming the first invalid setting."""
    def check(ok, key, message):
        if not ok:
            raise SettingsError(f"{key}: {message}")

    for (section, key), (lo, hi) in RANGES.items():
        value = getattr(getattr(cfg, section), key)
        check(lo <= value <= hi, key, f"{value} is outside {lo}..{hi}")

    cam, det, stream = cfg.camera, cfg.detector, cfg.stream
    check(cam.source in ("auto", "picamera", "webcam"), "source", "must be auto, picamera or webcam")
    check(cam.width > 0 and cam.height > 0, "width", "width and height must be positive")
    check(cam.fps > 0, "fps", "must be positive")
    check(0 < cam.hfov_deg < 180 and 0 < cam.vfov_deg < 180, "hfov_deg",
          "hfov_deg and vfov_deg must be between 0 and 180")
    check(det.imgsz >= 32 and det.imgsz % 32 == 0, "imgsz", "must be a multiple of 32 (e.g. 256, 320, 416)")
    check(cam.webcam_index >= 0, "webcam_index", "must be 0 or more")
    check(all(c >= 0 for c in det.classes), "classes", "COCO class ids are 0 or more")
    check(1 <= stream.port <= 65535, "port", "must be 1..65535")
    check(1 <= stream.jpeg_quality <= 100, "jpeg_quality", "must be 1..100")


# ---- saving ----

def _format(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)  # repr round-trips floats exactly
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_format(v) for v in value) + "]"
    raise SettingsError(f"can't save {value!r}")


_HEADER = re.compile(r"^\s*\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$")
_KEY = re.compile(r"^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)")
_SIMPLE_VALUE = re.compile(r"^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)([^#\"'\[\]]*?)(\s*#.*)?$")


def save_settings(path, updates):
    """Write {section: {key: value}} into the TOML file at `path`, editing lines in place so
    comments and other settings survive. Creates the file if needed. All-or-nothing: the
    result is re-parsed and checked before it replaces the file."""
    path = Path(path)
    apply_overrides(Config(), {s: dict(v) for s, v in updates.items()}, source="save")  # names and types
    try:
        text = path.read_text(encoding="utf-8") if path.exists() else ""
    except (OSError, UnicodeDecodeError) as e:
        raise SettingsError(f"can't read {path}: {e}") from None
    before = _parse_text(text, path)

    lines = text.splitlines()
    pending = {s: dict(v) for s, v in updates.items()}
    headers = {}
    section = None
    for i, line in enumerate(lines):
        m = _HEADER.match(line)
        if m:
            section = m.group(1)
            headers.setdefault(section, i)
            continue
        m = _KEY.match(line)
        if m and section in pending and m.group(2) in pending[section]:
            key = m.group(2)
            new = _format(pending[section].pop(key))
            simple = _SIMPLE_VALUE.match(line)
            comment = (simple.group(5) or "") if simple else ""
            lines[i] = f"{m.group(1)}{key}{m.group(3)}{new}{comment}"

    for sec, values in pending.items():  # keys not in the file yet
        if not values:
            continue
        new_lines = [f"{k} = {_format(v)}" for k, v in values.items()]
        if sec in headers:
            at = headers[sec] + 1
            lines[at:at] = new_lines
            headers = {s: (i + len(new_lines) if i >= at else i) for s, i in headers.items()}
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines += [f"[{sec}]", *new_lines]

    result = "\n".join(lines) + "\n"
    after = _parse_text(result, path, saving=True)
    expected = {s: dict(v) for s, v in before.items()}
    for sec, values in updates.items():
        expected.setdefault(sec, {}).update(
            {k: list(v) if isinstance(v, tuple) else v for k, v in values.items()})
    if after != expected:
        raise SettingsError(f"couldn't update {path} safely (unusual layout?); edit it by hand")

    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".cooper-", suffix=".toml")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(result)
        os.replace(tmp, path)
    except OSError as e:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise SettingsError(f"can't write {path}: {e}") from None


def _parse_text(text, path, saving=False):
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        what = "couldn't update" if saving else "can't parse"
        raise SettingsError(f"{what} {path}: {e}; fix or delete the file") from None


# ---- live tuning (GET/POST /api/settings) ----

# Setting name -> Config section. Names are unique across sections, so the API is flat.
# Every live setting is a number with an entry in RANGES.
LIVE_KEYS = {
    "conf": "detector",
}


class LiveSettings:
    """Validates, applies and optionally saves the live-tunable settings.

    The vision loop reads its config sections every frame, so plain attribute writes take
    effect on the next frame.
    """

    def __init__(self, cfg, path=None, control=None):
        self.cfg = cfg
        self.path = Path(path) if path is not None else DEFAULT_PATH
        self._control = control
        self._lock = threading.Lock()

    def current(self):
        return {key: getattr(getattr(self.cfg, section), key) for key, section in LIVE_KEYS.items()}

    def snapshot(self):
        return {
            "settings": self.current(),
            "ranges": {key: list(RANGES[(section, key)]) for key, section in LIVE_KEYS.items()},
            "file": str(self.path),
        }

    def _validate(self, body):
        if not isinstance(body, dict):
            raise SettingsError("body must be a JSON object")
        save = body.get("save", False)
        if not isinstance(save, bool):
            raise SettingsError("save must be true or false")
        changes = {}
        for key, value in body.items():
            if key == "save":
                continue
            if key not in LIVE_KEYS:
                raise SettingsError(f"unknown setting '{key}'; live settings are "
                                    f"{', '.join(LIVE_KEYS)} (others need cooper.toml and a restart)."
                                    f"{_suggest(key, LIVE_KEYS)}")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise SettingsError(f"{key} must be a number")
            value = float(value)
            lo, hi = RANGES[(LIVE_KEYS[key], key)]
            if not lo <= value <= hi:
                raise SettingsError(f"{key}: {value} is outside {lo}..{hi}")
            changes[key] = value
        return changes, save

    def update(self, body):
        """Apply a POST /api/settings body. With "save": true, all live settings (after the
        change) are written to the file. Returns {"settings", "saved"}; raises SettingsError
        (and changes nothing) if any part is invalid or the save fails."""
        changes, save = self._validate(body)
        with self._lock:
            if save:
                # Persist every live value as it will be after this request, not just the keys
                # sent: "apply" now and "save" later must not lose the applied change.
                grouped = {}
                for key, value in {**self.current(), **changes}.items():
                    grouped.setdefault(LIVE_KEYS[key], {})[key] = value
                save_settings(self.path, grouped)  # raises before anything is applied
            for key, value in changes.items():
                setattr(getattr(self.cfg, LIVE_KEYS[key]), key, value)
            current = self.current()
        if (changes or save) and self._control is not None:
            self._control.log_event("settings_changed", changed=changes, saved=save)
        return {"settings": current, "saved": save}
