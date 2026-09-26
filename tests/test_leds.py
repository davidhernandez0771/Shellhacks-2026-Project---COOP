"""The two warning LEDs (cooper/leds.py): gpiozero on a Pi, a mock everywhere else."""
import sys

import pytest

from cooper.config import LedConfig
from cooper.leds import Leds
from cooper.risk import CLEAR, DANGER, WARNING

PI_MODEL = "Raspberry Pi 5 Model B Rev 1.0\x00"


class FakePin:
    """Stands in for gpiozero.LED: remembers whether it is lit and every write."""

    def __init__(self, pin):
        self.pin, self.is_lit, self.writes, self.closed = pin, False, 0, False

    def on(self):
        self.is_lit, self.writes = True, self.writes + 1

    def off(self):
        self.is_lit, self.writes = False, self.writes + 1

    def close(self):
        self.closed = True


@pytest.fixture
def pi(tmp_path):
    model = tmp_path / "model"
    model.write_text(PI_MODEL)
    pins = {}

    def factory(pin):
        pins[pin] = FakePin(pin)
        return pins[pin]

    return model, factory, pins


def test_off_a_pi_it_is_a_mock_and_never_touches_gpio(tmp_path):
    touched = []
    leds = Leds(LedConfig(), model_path=tmp_path / "missing", led_factory=touched.append)
    assert leds.mode == "mock"
    assert touched == []


def test_another_board_is_a_mock(tmp_path):
    model = tmp_path / "model"
    model.write_text("Rockchip RK3588 board\x00")
    assert Leds(LedConfig(), model_path=model, led_factory=FakePin).mode == "mock"


def test_on_a_pi_it_drives_the_configured_pins(pi):
    model, factory, pins = pi
    leds = Leds(LedConfig(yellow_pin=5, red_pin=6), model_path=model, led_factory=factory)
    assert leds.mode == "gpio"
    assert sorted(pins) == [5, 6]


def test_disabled_is_a_mock_even_on_a_pi(pi):
    model, factory, pins = pi
    assert Leds(LedConfig(enabled=False), model_path=model, led_factory=factory).mode == "mock"
    assert pins == {}


def test_a_pi_without_gpiozero_falls_back_to_mock(pi):
    model, _, _ = pi

    def no_gpiozero(pin):
        raise ImportError("No module named 'gpiozero'")

    leds = Leds(LedConfig(), model_path=model, led_factory=no_gpiozero)
    assert leds.mode == "mock"
    assert "gpiozero" in leds.mode_reason


@pytest.mark.parametrize("level,yellow,red", [
    (CLEAR, False, False),
    (WARNING, True, False),
    (DANGER, False, True),   # red overrides yellow: only one LED is ever lit
])
def test_levels_map_to_the_leds(pi, level, yellow, red):
    model, factory, pins = pi
    cfg = LedConfig()
    leds = Leds(cfg, model_path=model, led_factory=factory)
    leds.set(level)
    assert (pins[cfg.yellow_pin].is_lit, pins[cfg.red_pin].is_lit) == (yellow, red)
    assert leds.state == {"yellow": yellow, "red": red}


def test_gpio_is_written_only_when_a_led_changes(pi):
    model, factory, pins = pi
    cfg = LedConfig()
    leds = Leds(cfg, model_path=model, led_factory=factory)
    before = pins[cfg.yellow_pin].writes + pins[cfg.red_pin].writes
    for _ in range(30):                     # one second of frames at the same level
        leds.set(WARNING)
    after_warning = pins[cfg.yellow_pin].writes + pins[cfg.red_pin].writes
    leds.set(DANGER)
    after_danger = pins[cfg.yellow_pin].writes + pins[cfg.red_pin].writes
    assert after_warning - before == 1      # yellow on
    assert after_danger - after_warning == 2  # yellow off, red on


def test_close_turns_both_off_and_releases_the_pins(pi):
    model, factory, pins = pi
    cfg = LedConfig()
    leds = Leds(cfg, model_path=model, led_factory=factory)
    leds.set(DANGER)
    leds.close()
    assert not pins[cfg.red_pin].is_lit and pins[cfg.red_pin].closed and pins[cfg.yellow_pin].closed


def test_the_mock_still_reports_what_the_leds_would_show(tmp_path):
    leds = Leds(LedConfig(), model_path=tmp_path / "missing")
    leds.set(WARNING)
    assert leds.state == {"yellow": True, "red": False}


def test_on_this_machine_the_defaults_give_a_mock_without_importing_gpiozero():
    """The laptop and CI case: no Pi, so gpiozero must not even be imported."""
    sys.modules.pop("gpiozero", None)
    leds = Leds(LedConfig())
    assert leds.mode == "mock"
    assert "gpiozero" not in sys.modules


def test_if_the_second_pin_fails_the_first_is_released(pi):
    model, _, _ = pi
    claimed = []

    def factory(pin):
        if claimed:
            raise RuntimeError(f"GPIO{pin} is busy")
        claimed.append(FakePin(pin))
        return claimed[-1]

    leds = Leds(LedConfig(), model_path=model, led_factory=factory)
    assert leds.mode == "mock"
    assert claimed[0].closed
