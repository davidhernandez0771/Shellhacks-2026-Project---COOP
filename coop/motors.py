"""Stepper pan through an Arduino Uno running firmware/coop_motors.

The Uno does the step timing (AccelStepper driving a TMC2209); the Pi only sends target
positions over USB serial. See the .ino file for the protocol. Positions on the wire are
microsteps; everything in Python is degrees. The build is pan-only: the protocol still has
a tilt field (the firmware drives a second axis), and the Pi always sends 0 for it.

Without an Arduino (or with motors disabled) the gimbal runs in mock mode and simulates
the motion, so the rest of the pipeline and the dashboard behave normally. If the link
drops after connecting (cable pulled, Uno reset, USB brownout), a background thread keeps
retrying the connection. Meanwhile `mock` is True but the position is NOT simulated: the
real motors are stopped, so `pan` holds the last position the Uno reported.

Opening the port resets the Uno, which restarts its step counter at 0 wherever the axis
happens to be. The first connection accepts that (power-on position = 0 deg); every
reconnect sends "Z <pan> 0" with the last reported position, so the Uno's counter, the
Pi's angle and the configured limits stay in the same frame of reference.

`port` may also be a pyserial URL such as "socket://localhost:5555", which is how
tools/fake_uno.py (an emulator of the firmware) attaches.
"""
import logging
import math
import threading
import time

log = logging.getLogger(__name__)

ARDUINO_USB_VIDS = {0x2341, 0x2A03, 0x1A86}  # Arduino, Arduino.org, CH340 clones
HEARTBEAT_S = 0.5  # firmware stops the motors after 2 s of silence
RECONNECT_S = 3.0  # delay between reconnect attempts
READY_TIMEOUT_S = 4.0  # opening the port resets the Uno; its bootloader takes ~1.6 s


def find_arduino_port():
    from serial.tools import list_ports

    for p in list_ports.comports():
        if p.vid in ARDUINO_USB_VIDS:
            return p.device
    return None


def open_serial(port, baud):
    """Open a real port ("/dev/ttyACM0", "COM5") or a pyserial URL ("socket://host:port")."""
    import serial

    if "://" in port:
        return serial.serial_for_url(port, baudrate=baud, timeout=0.1)
    return serial.Serial(port, baud, timeout=0.1)


def _clamp(value, limits):
    lo, hi = limits
    return min(max(value, lo), hi)


class Gimbal:
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self._on_event = on_event or (lambda *a, **k: None)
        self._pos = 0  # wire microsteps, as last reported (or simulated)
        self._hw_pos = None  # last position the Uno reported; None until the first connect
        self._target = 0  # wire microsteps
        # Lock order: _write_lock, then _state_lock. _write_lock makes "decide what to send"
        # and "send it" one step, so two threads can't reorder commands on the wire.
        self._state_lock = threading.Lock()  # guards _serial, _pos, _hw_pos, _target
        self._write_lock = threading.RLock()
        self._running = True
        self._serial = None
        self._last_sim = time.monotonic()
        self._thread = None

        if cfg.enabled:
            self._thread = threading.Thread(target=self._supervisor, name="motor-serial", daemon=True)
            self._thread.start()
        else:
            log.info("Motors disabled by config; running in mock mode")

    # ---- units ----

    @property
    def steps_per_deg(self):
        cfg = self.cfg
        return cfg.steps_per_rev * cfg.microsteps / 360.0 * cfg.pan_gear_ratio

    def _sign(self):
        return -1 if self.cfg.pan_invert else 1

    def _deg_to_steps(self, deg):
        return round(deg * self.steps_per_deg) * self._sign()

    def _steps_to_deg(self, steps):
        return steps * self._sign() / self.steps_per_deg

    # ---- link ----

    @property
    def mock(self):
        with self._state_lock:
            return self._serial is None

    def _supervisor(self):
        """(Re)connect to the Uno for as long as the gimbal is alive, falling back to
        mock mode between attempts so the rest of the pipeline never blocks on hardware."""
        while self._running:
            try:
                ser = self._connect()
            except Exception as e:
                log.warning("Motor controller unavailable (%s); retrying in %.0fs", e, RECONNECT_S)
                time.sleep(RECONNECT_S)
                continue

            log.info("Motor controller connected on %s", ser.port)
            self._on_event("motor_connected", port=ser.port)

            self._reader(ser)  # blocks until the link drops or close() is called

            with self._state_lock:
                self._serial = None
            try:
                ser.close()
            except Exception:
                pass

            if self._running:
                log.warning("Motor link lost; retrying in %.0fs", RECONNECT_S)
                self._on_event("motor_disconnected")
                time.sleep(RECONNECT_S)

    def _connect(self):
        port = find_arduino_port() if self.cfg.port == "auto" else self.cfg.port
        if port is None:
            raise RuntimeError("no Arduino found on USB")

        ser = open_serial(port, self.cfg.baud)
        try:
            deadline = time.monotonic() + READY_TIMEOUT_S
            while time.monotonic() < deadline:
                if ser.readline().strip() == b"READY":
                    break
            else:
                raise RuntimeError(f"no READY from {port}; is the firmware flashed?")

            with self._write_lock:
                with self._state_lock:
                    restore = self._hw_pos
                    self._pos = restore if restore is not None else 0
                    self._hw_pos = self._pos
                    target = self._target
                zero = "Z" if restore is None else f"Z {restore} 0"
                ser.write(f"C {int(self.cfg.max_steps_per_sec)} {int(self.cfg.accel_steps_per_sec2)}\n{zero}\n".encode())
                ser.write(f"T {target} 0\n".encode())  # resume where we left off
                with self._state_lock:
                    self._serial = ser  # published only once the Uno is in our frame of reference
        except Exception:
            ser.close()
            raise
        return ser

    def _send(self, ser, line):
        with self._write_lock:
            ser.write((line + "\n").encode())

    def _reader(self, ser):
        last_heartbeat = time.monotonic()
        while self._running:
            try:
                parts = ser.readline().decode(errors="ignore").split()
                if len(parts) == 3 and parts[0] == "P":
                    pos = int(parts[1])  # parts[2] is the unused tilt axis
                    with self._state_lock:
                        self._pos = pos
                        self._hw_pos = pos
                if time.monotonic() - last_heartbeat > HEARTBEAT_S:
                    self._send(ser, "H")
                    last_heartbeat = time.monotonic()
            except ValueError:
                continue  # garbled line
            except Exception as e:
                log.error("Motor serial link failed: %s", e)
                return

    # ---- motion ----

    def _simulate(self):
        now = time.monotonic()
        max_move = self.cfg.max_steps_per_sec * (now - self._last_sim)
        self._last_sim = now
        delta = self._target - self._pos
        self._pos += max(-max_move, min(max_move, delta))

    @property
    def pan(self):
        """Current pan angle in degrees (reported by the Uno, or simulated in mock mode)."""
        with self._state_lock:
            if self._serial is None and self._hw_pos is None:  # never had hardware: simulate
                self._simulate()
            pos = self._pos
        return self._steps_to_deg(pos)

    def aim(self, pan_deg, deadband_deg=0.0):
        if not math.isfinite(pan_deg):
            log.warning("Ignoring non-finite aim %r", pan_deg)
            return
        pan = _clamp(pan_deg, self.cfg.pan_limits_deg)
        target = self._deg_to_steps(pan)
        with self._write_lock:
            with self._state_lock:
                if abs(target - self._target) / self.steps_per_deg <= deadband_deg:
                    return
                self._target = target
            self._send_if_connected(f"T {target} 0")

    def stop(self):
        """Decelerate to a stop and hold the current position (used for mode == 'stop')."""
        with self._write_lock:
            with self._state_lock:
                self._target = round(self._pos)
            self._send_if_connected("S")

    def _send_if_connected(self, line):
        with self._state_lock:
            ser = self._serial
        if ser is None:
            return
        try:
            self._send(ser, line)
        except Exception:
            pass  # the supervisor thread will notice the link is down and reconnect

    def close(self):
        self._running = False
        self._send_if_connected("S")
        if self._thread is not None:
            self._thread.join(timeout=1)
        with self._state_lock:
            ser, self._serial = self._serial, None
        if ser is not None:
            ser.close()
