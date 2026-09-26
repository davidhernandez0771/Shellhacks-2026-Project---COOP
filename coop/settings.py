"""Settings file (coop.toml) on top of the coop/config.py defaults.

Load order: the dataclass defaults, then coop.toml next to the repo (if it exists), then
command-line flags. coop.example.toml documents every key; copy it to coop.toml and delete
what you don't change. coop.toml is gitignored, so each machine keeps its own.

The file mirrors Config: one [section] per Config field (camera, detector, motors, ...),
one key per dataclass field. Unknown sections or keys and wrong types are errors, not
warnings: a typo like `pan_inverted = true` silently ignored is how a motor ends up
spinning the wrong way on demo day.
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

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "coop.toml"

MICROSTEP_CHOICES = (1, 2, 4, 8, 16, 32, 64, 128, 256)

# Numeric ranges shared by file validation and live tuning (GET /api/settings "ranges").
RANGES = {
    ("tracking", "lead_time_s"): (0.0, 1.0),
    ("tracking", "deadband_deg"): (0.0, 10.0),
    ("detector", "conf"): (0.05, 0.95),
    # AccelStepper on a 16 MHz Uno manages roughly 4000 steps/s in total.
    ("motors", "max_steps_per_sec"): (50.0, 4000.0),
    ("motors", "accel_steps_per_sec2"): (100.0, 50000.0),
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

    cam, det, mot, sim, stream = cfg.camera, cfg.detector, cfg.motors, cfg.sim, cfg.stream
    check(cam.source in ("auto", "picamera", "webcam"), "source", "must be auto, picamera or webcam")
    check(cam.width > 0 and cam.height > 0, "width", "width and height must be positive")
    check(cam.fps > 0, "fps", "must be positive")
    check(0 < cam.hfov_deg < 180 and 0 < cam.vfov_deg < 180, "hfov_deg",
          "hfov_deg and vfov_deg must be between 0 and 180")
    check(det.imgsz >= 32 and det.imgsz % 32 == 0, "imgsz", "must be a multiple of 32 (e.g. 256, 320, 416)")
    check(mot.microsteps in MICROSTEP_CHOICES, "microsteps", f"must be one of {MICROSTEP_CHOICES}")
    check(mot.steps_per_rev > 0, "steps_per_rev", "must be positive")
    check(mot.pan_gear_ratio > 0, "pan_gear_ratio", "must be positive")
    check(len(mot.pan_limits_deg) == 2, "pan_limits_deg", "must be [min, max]")
    lo, hi = mot.pan_limits_deg
    check(lo < hi, "pan_limits_deg", "min must be below max")
    check(lo <= 0 <= hi, "pan_limits_deg", "must include 0 (the power-on position)")
    check(-360 <= lo and hi <= 360, "pan_limits_deg", "must stay within -360..360")
    check(mot.idle_disable_s == 0 or mot.idle_disable_s >= 1, "idle_disable_s",
          "must be 0 (never) or at least 1 second")
    check(mot.baud > 0, "baud", "must be positive")
    check(cam.webcam_index >= 0, "webcam_index", "must be 0 or more")
    check(all(c >= 0 for c in det.classes), "classes", "COCO class ids are 0 or more")
    check(cfg.tracking.lost_timeout_s > 0, "lost_timeout_s", "must be positive")
    check(cfg.tracking.reassociate_deg >= 0, "reassociate_deg", "must be 0 or more")
    check(sim.world_hfov_deg > cam.hfov_deg and sim.world_hfov_deg < 180, "world_hfov_deg",
          "must be wider than camera.hfov_deg and below 180")
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
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".coop-", suffix=".toml")
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
LIVE_KEYS = {
    "lead_time_s": "tracking",
    "deadband_deg": "tracking",
    "conf": "detector",
    "max_steps_per_sec": "motors",
    "accel_steps_per_sec2": "motors",
    "pan_invert": "motors",
}


class LiveSettings:
    """Validates, applies and optionally saves the live-tunable settings.

    The vision loop reads cfg.tracking / cfg.detector every frame, so plain attribute
    writes take effect on the next frame. Motor settings go through the Gimbal, which
    re-sends C to the Uno and moves frame_epoch on for pan_invert.
    """

    def __init__(self, cfg, path=None, gimbal=None, control=None):
        self.cfg = cfg
        self.path = Path(path) if path is not None else DEFAULT_PATH
        self._gimbal = gimbal
        self._control = control
        self._lock = threading.Lock()

    def current(self):
        return {key: getattr(getattr(self.cfg, section), key) for key, section in LIVE_KEYS.items()}

    def snapshot(self):
        mot = self.cfg.motors
        steps_per_deg = (self._gimbal.steps_per_deg if self._gimbal is not None
                         else mot.steps_per_rev * mot.microsteps / 360.0 * mot.pan_gear_ratio)
        return {
            "settings": self.current(),
            "ranges": {key: list(RANGES[(section, key)]) for key, section in LIVE_KEYS.items()
                       if (section, key) in RANGES},
            "steps_per_deg": round(steps_per_deg, 4),
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
                                    f"{', '.join(LIVE_KEYS)} (others need coop.toml and a restart)."
                                    f"{_suggest(key, LIVE_KEYS)}")
            section = LIVE_KEYS[key]
            if key == "pan_invert":
                if not isinstance(value, bool):
                    raise SettingsError("pan_invert must be true or false")
            else:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise SettingsError(f"{key} must be a number")
                value = float(value)
                lo, hi = RANGES[(section, key)]
                if not lo <= value <= hi:
                    raise SettingsError(f"{key}: {value} is outside {lo}..{hi}")
            changes[key] = value
        return changes, save

    def update(self, body):
        """Apply a POST /api/settings body. Returns {"settings", "saved"}; raises
        SettingsError (and changes nothing) if any part is invalid or the save fails."""
        changes, save = self._validate(body)
        with self._lock:
            mot = self.cfg.motors
            if "pan_invert" in changes and changes["pan_invert"] != mot.pan_invert:
                if self._control is not None and self._control.mode != "stop":
                    raise SettingsError("pan_invert can only change in stop mode "
                                        "(it reverses what every angle means)")
            saved = False
            if save and changes:
                grouped = {}
                for key, value in changes.items():
                    grouped.setdefault(LIVE_KEYS[key], {})[key] = value
                save_settings(self.path, grouped)  # raises before anything is applied
                saved = True

            speed = changes.get("max_steps_per_sec", mot.max_steps_per_sec)
            accel = changes.get("accel_steps_per_sec2", mot.accel_steps_per_sec2)
            if (speed, accel) != (mot.max_steps_per_sec, mot.accel_steps_per_sec2):
                if self._gimbal is not None:
                    self._gimbal.set_motion_limits(speed, accel)
                else:
                    mot.max_steps_per_sec, mot.accel_steps_per_sec2 = speed, accel
            if "pan_invert" in changes and changes["pan_invert"] != mot.pan_invert:
                if self._gimbal is not None:
                    self._gimbal.set_pan_invert(changes["pan_invert"])
                else:
                    mot.pan_invert = changes["pan_invert"]
            for key in ("lead_time_s", "deadband_deg", "conf"):
                if key in changes:
                    setattr(getattr(self.cfg, LIVE_KEYS[key]), key, changes[key])
            current = self.current()
        if changes and self._control is not None:
            self._control.log_event("settings_changed", changed=changes, saved=saved)
        return {"settings": current, "saved": saved}
