"""Jog the pan motor over serial, no camera or vision: the first thing to run on new hardware.

    python -m tools.jog                              # interactive, finds the Uno on USB
    python -m tools.jog --port /dev/ttyACM0          # or COM5, or socket://localhost:5555
    python -m tools.jog --goto 90                    # one move, wait until it arrives, exit
    python -m tools.jog --by -10
    python -m tools.jog --zero                       # "here is 0" (see the note below)

Keys (interactive):  <- / -> or a / d  jog by the step    [ / ]  smaller / bigger step
                     0 or h  go to 0     z  zero here     s or space  stop
                     e  e-stop / re-arm (drivers off / on) q or Esc  quit

It drives the real coop.motors.Gimbal with the settings from coop.toml (microsteps, gear
ratio, pan_invert, limits, speed), so what you check here is what COOP will do. Close COOP
first: only one program can hold the serial port.

Note: opening the port resets the Uno, which makes wherever the shaft is right now 0. So
point the camera forward before starting (or jog it there and press z).
"""
import argparse
import os
import sys
import time
from pathlib import Path

if __package__ in (None, ""):  # allow `python tools/jog.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from coop.motors import Gimbal
from coop.settings import SettingsError, load_config

STEPS = (0.5, 1.0, 5.0, 10.0, 45.0)
CONNECT_TIMEOUT_S = 8.0
ARRIVE_TIMEOUT_S = 30.0

HELP = ("<-/-> or a/d jog   [ ] step   0/h home   z zero here   s/space stop   "
        "e e-stop/arm   q quit")


def _clamp(value, limits):
    lo, hi = limits
    return min(max(value, lo), hi)


class Jogger:
    """Key -> gimbal action. Keeps its own target so repeated jogs add up even mid-move."""

    def __init__(self, gimbal, step=5.0):
        self.gimbal = gimbal
        self.step = min(STEPS, key=lambda s: abs(s - step))
        self.target = gimbal.pan

    def _go(self, target):
        self.target = _clamp(target, self.gimbal.cfg.pan_limits_deg)
        self.gimbal.aim(self.target)

    def handle(self, key):
        """Apply one key. Returns "quit" to exit, else None."""
        if key in ("right", "d"):
            self._go(self.target + self.step)
        elif key in ("left", "a"):
            self._go(self.target - self.step)
        elif key in ("]", "+"):
            self.step = STEPS[min(STEPS.index(self.step) + 1, len(STEPS) - 1)]
        elif key in ("[", "-"):
            self.step = STEPS[max(STEPS.index(self.step) - 1, 0)]
        elif key in ("0", "h"):
            self._go(0.0)
        elif key == "z":
            self.gimbal.zero()
            self.target = 0.0
        elif key in ("s", " "):
            self.gimbal.stop()
            self.target = self.gimbal.pan
        elif key == "e":
            if self.gimbal.estopped:
                self.gimbal.arm()
                self.target = self.gimbal.pan
            else:
                self.gimbal.estop()
        elif key in ("q", "esc"):
            return "quit"
        return None

    def status_line(self):
        g = self.gimbal
        flags = "  E-STOP" if g.estopped else ("" if g.drivers_enabled else "  drivers off")
        return (f"pan {g.pan:+8.2f} deg   target {self.target:+8.2f}   step {self.step:g} deg   "
                f"[{g.link_state}]{flags}")


class KeyReader:
    """Single keypresses without Enter, on Windows (msvcrt) and POSIX terminals (termios)."""

    def __enter__(self):
        if os.name == "nt":
            import msvcrt

            self._msvcrt = msvcrt
        else:
            import termios
            import tty

            self._fd = sys.stdin.fileno()
            self._old = termios.tcgetattr(self._fd)
            tty.setcbreak(self._fd)  # keeps Ctrl+C working
        return self

    def __exit__(self, *exc):
        if os.name != "nt":
            import termios

            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old)

    def get(self, timeout):
        """A key name ("left", "right", "esc") or character, or None after `timeout` s."""
        if os.name == "nt":
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if self._msvcrt.kbhit():
                    ch = self._msvcrt.getwch()
                    if ch in ("\x00", "\xe0"):
                        return {"K": "left", "M": "right"}.get(self._msvcrt.getwch())
                    return "esc" if ch == "\x1b" else ch.lower()
                time.sleep(0.01)
            return None
        import select

        if not select.select([sys.stdin], [], [], timeout)[0]:
            return None
        ch = os.read(self._fd, 1).decode(errors="ignore")
        if ch != "\x1b":
            return ch.lower()
        seq = ""
        while select.select([sys.stdin], [], [], 0.02)[0] and len(seq) < 4:
            seq += os.read(self._fd, 1).decode(errors="ignore")
        return {"[C": "right", "[D": "left", "OC": "right", "OD": "left"}.get(seq, "esc" if not seq else None)


def wait_for_arrival(gimbal, target, timeout=ARRIVE_TIMEOUT_S):
    """True once the reported pan is within one microstep of target and has settled."""
    tolerance = 1.0 / gimbal.steps_per_deg + 1e-6
    deadline = time.monotonic() + timeout
    settled_since = None
    while time.monotonic() < deadline:
        if abs(gimbal.pan - target) <= tolerance:
            settled_since = settled_since or time.monotonic()
            if time.monotonic() - settled_since >= 0.3:
                return True
        else:
            settled_since = None
        time.sleep(0.02)
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(description="Jog the COOP pan motor over serial (no vision).")
    parser.add_argument("--port", help="serial port or URL (default: motors.port from coop.toml, i.e. auto)")
    parser.add_argument("--config", help="settings file (default: coop.toml if present)")
    parser.add_argument("--step", type=float, default=5.0, help="jog step in degrees (default 5)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--goto", type=float, metavar="DEG", help="move to an absolute angle and exit")
    group.add_argument("--by", type=float, metavar="DEG", help="move by a relative angle and exit")
    group.add_argument("--zero", action="store_true", help="make the current position 0 and exit")
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config, required=args.config is not None).motors
    except SettingsError as e:
        print(f"settings: {e}", file=sys.stderr)
        return 2
    cfg.enabled = True
    if args.port:
        cfg.port = args.port

    gimbal = Gimbal(cfg)
    try:
        deadline = time.monotonic() + CONNECT_TIMEOUT_S
        while gimbal.mock and time.monotonic() < deadline:
            time.sleep(0.05)
        if gimbal.mock:
            print(f"no Uno answered on {cfg.port} within {CONNECT_TIMEOUT_S:.0f} s "
                  "(flashed? port busy? close COOP first)", file=sys.stderr)
            return 1
        print(f"Connected on {cfg.port}. {cfg.microsteps} microsteps, gear {cfg.pan_gear_ratio:g}:1, "
              f"{gimbal.steps_per_deg:.3f} microsteps/deg, invert={cfg.pan_invert}, "
              f"limits {list(cfg.pan_limits_deg)}")

        if args.zero:
            gimbal.zero()
            print("Zeroed: this position is now 0.")
            return 0
        if args.goto is not None or args.by is not None:
            target = args.goto if args.goto is not None else gimbal.pan + args.by
            target = _clamp(target, cfg.pan_limits_deg)
            gimbal.aim(target)
            arrived = wait_for_arrival(gimbal, target)
            print(f"pan {gimbal.pan:+.2f} deg (target {target:+.2f})")
            if not arrived:
                print("did not arrive in time", file=sys.stderr)
                return 1
            return 0

        jogger = Jogger(gimbal, args.step)
        print(HELP)
        with KeyReader() as keys:
            while True:
                key = keys.get(0.1)
                if key is not None and jogger.handle(key) == "quit":
                    break
                print("\r" + jogger.status_line() + "   ", end="", flush=True)
        print()
        return 0
    except KeyboardInterrupt:
        print()
        return 0
    finally:
        gimbal.close()


if __name__ == "__main__":
    sys.exit(main())
