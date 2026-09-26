"""Stepper pan/tilt through an Arduino Uno running firmware/coop_motors.

The Uno does the step timing (AccelStepper driving TMC2209s); the Pi only sends target
positions over USB serial. See the .ino file for the protocol. Positions on the wire are
microsteps; everything in Python is degrees.

Without an Arduino (or with motors disabled) the gimbal runs in mock mode and simulates
the motion, so the rest of the pipeline and the dashboard behave normally.
"""
import logging
import threading
import time

log = logging.getLogger(__name__)

ARDUINO_USB_VIDS = {0x2341, 0x2A03, 0x1A86}  # Arduino, Arduino.org, CH340 clones
HEARTBEAT_S = 0.5  # firmware stops the motors after 2 s of silence


def find_arduino_port():
    from serial.tools import list_ports

    for p in list_ports.comports():
        if p.vid in ARDUINO_USB_VIDS:
            return p.device
    return None


def _clamp(value, limits):
    lo, hi = limits
    return min(max(value, lo), hi)


class Gimbal:
    def __init__(self, cfg):
        self.cfg = cfg
        base = cfg.steps_per_rev * cfg.microsteps / 360.0
        self._steps_per_deg = (base * cfg.pan_gear_ratio, base * cfg.tilt_gear_ratio)
        self._pos = [0, 0]  # microsteps, as last reported (or simulated)
        self._target = [0, 0]
        self._write_lock = threading.Lock()
        self._running = True
        self._serial = None

        if cfg.enabled:
            try:
                self._serial = self._connect()
            except Exception as e:
                log.warning("Motor controller unavailable (%s); motors in mock mode", e)

        self.mock = self._serial is None
        if self.mock:
            log.info("Motors running in mock mode")
            self._last_sim = time.monotonic()
        else:
            self._thread = threading.Thread(target=self._reader, name="motor-serial", daemon=True)
            self._thread.start()

    def _connect(self):
        import serial

        port = find_arduino_port() if self.cfg.port == "auto" else self.cfg.port
        if port is None:
            raise RuntimeError("no Arduino found on USB")

        ser = serial.Serial(port, self.cfg.baud, timeout=0.1)
        deadline = time.monotonic() + 4.0  # opening the port resets the Uno
        while time.monotonic() < deadline:
            if ser.readline().strip() == b"READY":
                break
        else:
            ser.close()
            raise RuntimeError(f"no READY from {port}; is the firmware flashed?")

        ser.write(f"C {int(self.cfg.max_steps_per_sec)} {int(self.cfg.accel_steps_per_sec2)}\nZ\n".encode())
        log.info("Motor controller connected on %s", port)
        return ser

    def _send(self, line):
        with self._write_lock:
            self._serial.write((line + "\n").encode())

    def _reader(self):
        last_heartbeat = time.monotonic()
        while self._running:
            try:
                parts = self._serial.readline().decode(errors="ignore").split()
                if len(parts) == 3 and parts[0] == "P":
                    self._pos = [int(parts[1]), int(parts[2])]
                if time.monotonic() - last_heartbeat > HEARTBEAT_S:
                    self._send("H")
                    last_heartbeat = time.monotonic()
            except ValueError:
                continue  # garbled line
            except Exception as e:
                log.error("Motor serial link failed: %s", e)
                return

    def _simulate(self):
        now = time.monotonic()
        max_move = self.cfg.max_steps_per_sec * (now - self._last_sim)
        self._last_sim = now
        for i in range(2):
            delta = self._target[i] - self._pos[i]
            self._pos[i] += max(-max_move, min(max_move, delta))

    @property
    def angles(self):
        if self.mock:
            self._simulate()
        return self._pos[0] / self._steps_per_deg[0], self._pos[1] / self._steps_per_deg[1]

    def aim(self, pan_deg, tilt_deg, deadband_deg=0.0):
        pan = _clamp(pan_deg, self.cfg.pan_limits_deg)
        tilt = _clamp(tilt_deg, self.cfg.tilt_limits_deg) if self.cfg.tilt_enabled else 0.0
        target = [round(pan * self._steps_per_deg[0]), round(tilt * self._steps_per_deg[1])]

        moved_deg = max(abs(target[i] - self._target[i]) / self._steps_per_deg[i] for i in range(2))
        if moved_deg <= deadband_deg:
            return
        self._target = target
        if not self.mock:
            self._send(f"T {target[0]} {target[1]}")

    def close(self):
        self._running = False
        if self._serial is not None:
            try:
                self._send("S")
            finally:
                self._thread.join(timeout=1)
                self._serial.close()
