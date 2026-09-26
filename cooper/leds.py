"""The two warning LEDs: yellow = warning, red = danger, both off = clear.

On a Raspberry Pi they're driven through gpiozero; anywhere else (a laptop, CI) they're a
mock that keeps the same state, so the dashboard shows what the LEDs would do. The choice:

1. [leds] enabled = false (or --no-leds)            -> mock
2. /proc/device-tree/model doesn't say Raspberry Pi -> mock (gpiozero is never imported)
3. gpiozero can't be imported or the pins can't be claimed -> mock, with the reason logged
4. otherwise                                         -> gpio
"""
import logging
from pathlib import Path

from .risk import DANGER, WARNING

log = logging.getLogger("cooper.leds")

MODEL_PATH = Path("/proc/device-tree/model")


def _gpiozero_led(pin):
    from gpiozero import LED  # imported lazily: only ever on a Pi

    return LED(pin)


def _is_raspberry_pi(model_path):
    try:
        return "Raspberry Pi" in Path(model_path).read_text(errors="ignore")
    except OSError:
        return False


class Leds:
    def __init__(self, cfg, model_path=MODEL_PATH, led_factory=_gpiozero_led):
        self.state = {"yellow": False, "red": False}
        self._pins = None
        if not cfg.enabled:
            self.mode, self.mode_reason = "mock", "disabled in the config"
        elif not _is_raspberry_pi(model_path):
            self.mode, self.mode_reason = "mock", "not a Raspberry Pi"
        else:
            claimed = {}
            try:
                claimed["yellow"] = led_factory(cfg.yellow_pin)
                claimed["red"] = led_factory(cfg.red_pin)
                self._pins = claimed
                self.mode, self.mode_reason = "gpio", f"GPIO{cfg.yellow_pin} yellow, GPIO{cfg.red_pin} red"
            except Exception as e:  # ImportError, or gpiozero's pin errors (busy, no permission)
                for pin in claimed.values():  # release a pin claimed before the failure
                    pin.close()
                self.mode, self.mode_reason = "mock", f"gpiozero unavailable: {e}"
        log.info("LEDs: %s (%s)", self.mode, self.mode_reason)

    def set(self, level):
        want = {"yellow": level == WARNING, "red": level == DANGER}
        for name, on in want.items():
            if on == self.state[name]:
                continue  # write GPIO only on a change, not every frame
            self.state[name] = on
            if self._pins is not None:
                self._pins[name].on() if on else self._pins[name].off()
            else:
                log.info("LED (mock) %s %s", name, "on" if on else "off")

    def close(self):
        self.set("clear")
        if self._pins is not None:
            for pin in self._pins.values():
                pin.close()
            self._pins = None
