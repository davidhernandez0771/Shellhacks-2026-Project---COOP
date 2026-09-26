"""Stepper pan/tilt through an Arduino Uno running firmware/coop_motors.

The Uno does the step timing (AccelStepper driving TMC2209s); the Pi only sends target
positions over USB serial. See the .ino file for the protocol. Positions on the wire are
microsteps; everything in Python is degrees.

Without an Arduino (or with motors disabled) the gimbal runs in mock mode and simulates
the motion, so the rest of the pipeline and the dashboard behave normally. If the link
drops after connecting (cable pulled, Uno reset, USB brownout), a background thread keeps
retrying the connection. Meanwhile `mock` is True but the position is NOT simulated: the
real motors are stopped, so `angles` holds the last position the Uno reported.

Opening the port resets the Uno, which restarts its step counter at 0 wherever the axis
happens to be. The first connection accepts that (power-on position = 0 deg); every
reconnect sends "Z <pan> <tilt>" with the last reported position, so the Uno's counter,
the Pi's angles and the configured limits stay in the same frame of reference.
"""
import logging
import threading
import time

log = logging.getLogger(__name__)

ARDUINO_USB_VIDS = {0x2341, 0x2A03, 0x1A86}  # Arduino, Arduino.org, CH340 clones
HEARTBEAT_S = 0.5  # firmware stops the motors after 2 s of silence
RECONNECT_S = 3.0  # delay between reconnect attempts


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
    def __init__(self, cfg, on_event=None):
        self.cfg = cfg
        self._on_event = on_event or (lambda *a, **k: None)
        base = cfg.steps_per_rev * cfg.microsteps / 360.0
        self._steps_per_deg = (base * cfg.pan_gear_ratio, base * cfg.tilt_gear_ratio)
        self._pos = [0, 0]  # microsteps, as last reported (or simulated)
        self._hw_pos = None  # last position the Uno reported; None until the first connect
        self._target = [0, 0]
        self._state_lock = threading.Lock()  # guards _serial, _pos and _hw_pos
        self._write_lock = threading.Lock()
        self._running = True
        self._serial = None
        self._last_sim = time.monotonic()
        self._thread = None

        if cfg.enabled:
            self._thread = threading.Thread(target=self._supervisor, name="motor-serial", daemon=True)
            self._thread.start()
        else:
            log.info("Motors disabled by config; running in mock mode")

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

            with self._state_lock:
                self._serial = ser
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

        with self._state_lock:
            restore = self._hw_pos
            self._pos = list(restore) if restore is not None else [0, 0]
            self._hw_pos = list(self._pos)
        zero = "Z" if restore is None else f"Z {restore[0]} {restore[1]}"
        ser.write(f"C {int(self.cfg.max_steps_per_sec)} {int(self.cfg.accel_steps_per_sec2)}\n{zero}\n".encode())
        return ser

    def _send(self, ser, line):
        with self._write_lock:
            ser.write((line + "\n").encode())

    def _reader(self, ser):
        last_heartbeat = time.monotonic()
        try:
            self._send(ser, f"T {self._target[0]} {self._target[1]}")  # resume where we left off
        except Exception as e:
            log.error("Motor serial link failed: %s", e)
            return
        while self._running:
            try:
                parts = ser.readline().decode(errors="ignore").split()
                if len(parts) == 3 and parts[0] == "P":
                    pos = [int(parts[1]), int(parts[2])]
                    with self._state_lock:
                        self._pos = pos
                        self._hw_pos = list(pos)
                if time.monotonic() - last_heartbeat > HEARTBEAT_S:
                    self._send(ser, "H")
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
        with self._state_lock:
            if self._serial is None and self._hw_pos is None:  # never had hardware: simulate
                self._simulate()
            pos = list(self._pos)
        return pos[0] / self._steps_per_deg[0], pos[1] / self._steps_per_deg[1]

    def aim(self, pan_deg, tilt_deg, deadband_deg=0.0):
        pan = _clamp(pan_deg, self.cfg.pan_limits_deg)
        tilt = _clamp(tilt_deg, self.cfg.tilt_limits_deg) if self.cfg.tilt_enabled else 0.0
        target = [round(pan * self._steps_per_deg[0]), round(tilt * self._steps_per_deg[1])]

        moved_deg = max(abs(target[i] - self._target[i]) / self._steps_per_deg[i] for i in range(2))
        if moved_deg <= deadband_deg:
            return
        self._target = target
        self._send_if_connected(f"T {target[0]} {target[1]}")

    def stop(self):
        """Decelerate to a stop and hold the current position (used for mode == 'stop')."""
        with self._state_lock:
            self._target = list(self._pos)
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
