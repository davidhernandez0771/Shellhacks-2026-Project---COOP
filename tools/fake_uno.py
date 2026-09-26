"""Fake Arduino Uno: an emulator of firmware/coop_motors.ino on a TCP socket.

Lets the real cooper.motors.Gimbal (and tools/jog.py, and the whole app) run against
something that speaks the exact firmware protocol, with no hardware:

    python -m tools.fake_uno --port 5555
    python -m cooper.main --source webcam --motor-port socket://localhost:5555
    python -m tools.jog --port socket://localhost:5555

pyserial opens "socket://host:port" URLs like a serial port, so nothing in cooper/ knows it
isn't talking to a Uno. Works the same on Windows, macOS and Linux.

What it emulates (see the .ino for the source of truth):
- Each new connection is a DTR reset, like opening the Uno's USB port: the bootloader eats
  bytes for `boot_delay_s`, then "READY", step counters at 0, drivers enabled, limits
  2000 steps/s and 6000 steps/s^2.
- "P <pan> <tilt>" every 50 ms; T / C / Z / S / E / H parsed with the firmware's exact
  rules (47-character line buffer, CR ignored, sscanf("%ld %ld") quirks such as "Z 5"
  zeroing both axes); only those six letters feed the 2 s watchdog.
- AccelStepper-like motion: trapezoidal speed profile, stop() braking over v^2/2a + 1 steps,
  setCurrentPosition() stopping dead.
- Each axis tracks two positions: `counter` (what the firmware reports) and `rotor` (where
  the shaft physically is). They differ in the one way that matters: with the drivers
  disabled (E 0) AccelStepper keeps counting steps the motor never makes. A reset zeroes
  the counter but not the rotor. Tests use this to prove the Pi never loses position.
"""
import argparse
import logging
import math
import select
import socket
import threading
import time

log = logging.getLogger("fake_uno")

REPORT_S = 0.05  # REPORT_MS
WATCHDOG_S = 2.0  # WATCHDOG_MS
LINE_MAX = 47  # char buf[48] minus the terminator
DEFAULT_MAX_SPEED = 2000.0  # setLimits(2000, 6000) in setup()
DEFAULT_ACCEL = 6000.0
SUBSTEP_S = 0.0005  # integration step; well under one step period at 2000 steps/s
BOOT_DELAY_S = 1.5  # Uno bootloader after a DTR reset, roughly
LONG_MIN, LONG_MAX = -(2**31), 2**31 - 1


def sscanf_longs(text, count):
    """C's sscanf(text, "%ld %ld"[, count]). Returns (return value, parsed numbers).

    The return value is the number of conversions, or -1 (EOF) if the input ended before
    the first one. The space in the format matches zero or more blanks.
    """
    values = []
    i, n = 0, len(text)
    for _ in range(count):
        while i < n and text[i] in " \t\n\r\f\v":
            i += 1
        if i == n:
            return (-1 if not values else len(values)), values
        j = i
        if text[j] in "+-":
            j += 1
        k = j
        while k < n and text[k].isdigit():
            k += 1
        if k == j:
            return len(values), values
        values.append(max(LONG_MIN, min(LONG_MAX, int(text[i:k]))))
        i = k
    return len(values), values


class Axis:
    """One AccelStepper in DRIVER mode, plus the physical shaft it's meant to turn."""

    def __init__(self):
        self.counter = 0  # AccelStepper::currentPosition()
        self.rotor = 0  # physical position, in the same microstep units
        self.target = 0
        self.speed = 0.0  # steps/s, signed
        self._frac = 0.0

    def reset(self):
        """MCU reset: counters restart, the shaft stays where it is."""
        self.counter = self.target = 0
        self.speed = self._frac = 0.0

    def set_current_position(self, pos):
        self.counter = self.target = pos
        self.speed = self._frac = 0.0

    def stop(self, accel):
        """AccelStepper::stop(): brake as hard as the acceleration allows."""
        if self.speed != 0.0:
            steps = int(self.speed * self.speed / (2.0 * accel)) + 1
            self.target = self.counter + (steps if self.speed > 0 else -steps)

    def advance(self, dt, max_speed, accel, enabled):
        dist = self.target - self.counter
        stop_steps = self.speed * self.speed / (2.0 * accel)
        if dist == 0 and stop_steps <= 1:
            self.speed = self._frac = 0.0
            return
        direction = (1 if dist > 0 else -1) if dist != 0 else (-1 if self.speed > 0 else 1)
        moving_away = self.speed * direction < 0
        remaining = abs(dist - self._frac)  # from the true (fractional) position
        if moving_away or (self.speed * direction > 0 and stop_steps >= remaining):
            dv = min(abs(self.speed), accel * dt)
            self.speed -= math.copysign(dv, self.speed)
        else:
            self.speed += direction * accel * dt
        self.speed = max(-max_speed, min(max_speed, self.speed))

        self._frac += self.speed * dt
        while abs(self._frac) >= 1.0:
            self._step(1 if self._frac > 0 else -1, enabled)
            # Arriving with (almost) no braking left: stop here, like computeNewSpeed() does,
            # instead of letting the integration's leftover speed carry one step past.
            if self.counter == self.target and self.speed * self.speed / (2.0 * accel) <= 2:
                self.speed = self._frac = 0.0
                break

    def _step(self, d, enabled):
        self._frac -= d
        self.counter += d
        if enabled:
            self.rotor += d


class UnoModel:
    """The sketch's state machine, driven by feed() and advance(). Not thread-safe."""

    def __init__(self):
        self.axes = [Axis(), Axis()]  # pan (X), tilt (Y)
        self.booted = False
        self.enabled = True  # EN pin low = drivers on
        self.max_speed = DEFAULT_MAX_SPEED
        self.accel = DEFAULT_ACCEL
        self.watchdog_tripped = False
        self.commands = []  # every line handle() acted on, for tests and --verbose
        self._t = 0.0
        self._last_command = 0.0
        self._last_report = 0.0
        self._buf = bytearray()
        self._out = bytearray()

    # ---- lifecycle ----

    def reset(self):
        """DTR reset: back into the bootloader. The shafts don't move."""
        for axis in self.axes:
            axis.reset()
        self.booted = False
        self._buf.clear()

    def boot(self):
        """setup(): drivers on, default limits, watchdog armed, READY."""
        self.booted = True
        self.enabled = True
        self.max_speed, self.accel = DEFAULT_MAX_SPEED, DEFAULT_ACCEL
        self.watchdog_tripped = False
        self._t = self._last_command = self._last_report = 0.0
        self._out += b"READY\r\n"

    def drain_output(self):
        out, self._out = bytes(self._out), bytearray()
        return out

    # ---- serial input (the top of loop()) ----

    def feed(self, data):
        if not self.booted:
            return  # the bootloader swallows it
        for c in data:
            if c == 0x0A:  # '\n'
                if self._buf:
                    self._handle(self._buf.decode("ascii", errors="replace"))
                self._buf.clear()
            elif c != 0x0D and len(self._buf) < LINE_MAX:
                self._buf.append(c)

    def _handle(self, line):
        cmd, rest = line[0], line[1:]
        if cmd == "T":
            n, v = sscanf_longs(rest, 2)
            if n == 2:
                self.axes[0].target, self.axes[1].target = v
        elif cmd == "C":
            n, v = sscanf_longs(rest, 2)
            if n == 2:
                self._set_limits(*v)
        elif cmd == "Z":
            n, v = sscanf_longs(rest, 2)
            a, b = v if n == 2 else (0, 0)
            self.axes[0].set_current_position(a)
            self.axes[1].set_current_position(b)
        elif cmd == "S":
            for axis in self.axes:
                axis.stop(self.accel)
        elif cmd == "E":
            n, v = sscanf_longs(rest, 1)
            if n == 1:
                self.enabled = v[0] != 0
        elif cmd == "H":
            pass
        else:
            return  # unknown commands don't feed the watchdog
        self.commands.append(line)
        self._last_command = self._t
        self.watchdog_tripped = False

    def _set_limits(self, max_speed, accel):
        # AccelStepper::setMaxSpeed / setAcceleration take the magnitude; accel 0 is ignored.
        self.max_speed = abs(float(max_speed))
        if accel != 0:
            self.accel = abs(float(accel))

    # ---- time (the rest of loop()) ----

    def advance(self, dt):
        if not self.booted:
            return
        steps = max(1, math.ceil(dt / SUBSTEP_S - 1e-9))
        h = dt / steps
        for _ in range(steps):
            self._t += h
            if not self.watchdog_tripped and self._t - self._last_command > WATCHDOG_S:
                for axis in self.axes:
                    axis.stop(self.accel)
                self.watchdog_tripped = True
            for axis in self.axes:
                axis.advance(h, self.max_speed, self.accel, self.enabled)
            if self._t - self._last_report >= REPORT_S - 1e-9:
                self._last_report = self._t
                self._out += f"P {self.axes[0].counter} {self.axes[1].counter}\r\n".encode()


class FakeUnoServer:
    """Serves a UnoModel on a TCP port in real time. One client at a time, like a COM port.

    `unplug()` cuts power and the connection (connections are refused until `replug()`),
    `drop()` just breaks the current connection. Each new connection resets the Uno.
    """

    def __init__(self, host="127.0.0.1", port=0, boot_delay_s=BOOT_DELAY_S):
        self.model = UnoModel()
        self.lock = threading.RLock()  # hold it to inspect `model` from another thread
        self.boot_delay_s = boot_delay_s
        self.connections = 0
        self._listener = socket.create_server((host, port))
        self.host = host
        self.port = self._listener.getsockname()[1]
        self._client = None
        self._powered = True
        self._boot_at = None
        self._running = False
        self._thread = None

    @property
    def url(self):
        return f"socket://{self.host}:{self.port}"

    @property
    def connected(self):
        with self.lock:
            return self._client is not None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._run, name="fake-uno", daemon=True)
        self._thread.start()
        return self

    def close(self):
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=2)
        with self.lock:
            self._drop_client()
        self._listener.close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.close()

    def unplug(self):
        with self.lock:
            self._powered = False
            self._drop_client()
            log.info("unplugged")

    def replug(self):
        """Power returns: the Uno boots from scratch (nobody is listening for its READY)."""
        with self.lock:
            self._powered = True
            self.model.reset()
            self._boot_at = time.monotonic() + self.boot_delay_s
            log.info("plugged back in")

    def drop(self):
        with self.lock:
            self._drop_client()

    def _drop_client(self):
        if self._client is not None:
            try:
                self._client.close()
            except OSError:
                pass
            self._client = None

    def _run(self):
        last = time.monotonic()
        while self._running:
            with self.lock:
                socks = [self._listener] + ([self._client] if self._client else [])
            try:
                readable, _, _ = select.select(socks, [], [], 0.001)
            except (OSError, ValueError):
                readable = []  # a socket was closed under us; loop again
            now = time.monotonic()
            with self.lock:
                if self._listener in readable:
                    self._accept(now)
                if self._client is not None and self._client in readable:
                    self._receive()
                if self._powered:
                    if self._boot_at is not None and now >= self._boot_at:
                        self._boot_at = None
                        self.model.boot()
                    self.model.advance(now - last)
                out = self.model.drain_output()
                if out and self._client is not None:
                    try:
                        self._client.sendall(out)
                    except OSError:
                        self._drop_client()
            last = now

    def _accept(self, now):
        try:
            conn, _ = self._listener.accept()
        except OSError:
            return
        if not self._powered:
            conn.close()  # no USB device: the "port" opens but nothing ever answers
            return
        self._drop_client()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._client = conn
        self.connections += 1
        self.model.reset()
        self._boot_at = now + self.boot_delay_s
        log.info("connection %d: reset", self.connections)

    def _receive(self):
        try:
            data = self._client.recv(4096)
        except OSError:
            data = b""
        if not data:
            self._drop_client()  # the Pi closed the port; the Uno keeps running
            return
        before = len(self.model.commands)
        self.model.feed(data)
        for line in self.model.commands[before:]:
            if line != "H":
                log.debug("<- %s", line)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Emulate the COOPER Uno firmware on a TCP port.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("--boot-delay", type=float, default=BOOT_DELAY_S,
                        help="seconds between a connection and READY (default %(default)s)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every command")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)s %(message)s")

    server = FakeUnoServer(args.host, args.port, args.boot_delay).start()
    print(f"Fake Uno listening. Point COOPER at it with:  --motor-port {server.url}")
    print("Ctrl+C to quit.")
    try:
        while True:
            time.sleep(1.0)
            with server.lock:
                pan = server.model.axes[0]
                state = "on" if server.model.enabled else "OFF"
                wd = "  watchdog-stopped" if server.model.watchdog_tripped else ""
                link = "connected" if server._client else "waiting"
            print(f"[{link}] pan counter {pan.counter:>7}  rotor {pan.rotor:>7}  "
                  f"speed {pan.speed:>7.0f}  drivers {state}{wd}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
