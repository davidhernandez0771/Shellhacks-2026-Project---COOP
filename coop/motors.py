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

Driver power (E 0 / E 1). With the drivers disabled AccelStepper still counts the steps it
would have made, so the Uno's counter drifts from the shaft unless nothing is moving. Two
rules follow, and every path here keeps them:
- Power down only once the reported position has been still for STILL_S (the e-stop also
  has a deadline, the worst-case braking time, in case reports stop arriving).
- Never send T while the drivers are off: aim() sends E 1 first (idle power-down), or
  refuses outright (e-stop, until arm()).
The Uno boots with its drivers enabled, so the reconnect handshake re-sends E 0 if needed.

`frame_epoch` counts changes to what an angle means (zero(), set_pan_invert()). The
vision loop passes the epoch it read its angles in to aim(), and an aim computed in an
old frame is dropped instead of moving the camera to the wrong place.

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
# "Stopped" = no position change for this long. P reports come every 50 ms, and at the
# slowest allowed acceleration (100 steps/s^2) AccelStepper's first step takes ~96 ms.
STILL_S = 0.25
ESTOP_MARGIN_S = 0.3  # added to the worst-case braking time for the e-stop deadline
ESTOP_POLL_S = 0.02


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
        self._last_move = time.monotonic()  # when the reported position last changed
        self._estopped = False
        self._estop_gen = 0  # bumped by estop()/arm(); a power-down watcher only acts on its own
        self._drivers_enabled = True  # what we last told the Uno (it boots enabled)
        self._hold_since = None  # when stop() started holding; None while aiming
        self._epoch = 0
        # Lock order: _write_lock, then _state_lock. _write_lock makes "decide what to send"
        # and "send it" one step, so two threads can't reorder commands on the wire.
        self._state_lock = threading.Lock()  # guards everything above plus _serial
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

    # ---- state ----

    @property
    def mock(self):
        with self._state_lock:
            return self._serial is None

    @property
    def link_state(self):
        """"connected", "reconnecting" (enabled but no Uno right now) or "mock" (disabled)."""
        if not self.cfg.enabled:
            return "mock"
        return "reconnecting" if self.mock else "connected"

    @property
    def estopped(self):
        with self._state_lock:
            return self._estopped

    @property
    def drivers_enabled(self):
        with self._state_lock:
            return self._drivers_enabled

    @property
    def frame_epoch(self):
        with self._state_lock:
            return self._epoch

    # ---- link ----

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
                    self._last_move = time.monotonic()
                    target = self._target
                    if self._estopped:
                        self._drivers_enabled = False  # the Uno just rebooted: nothing is moving
                    power_off = not self._drivers_enabled
                zero = "Z" if restore is None else f"Z {restore} 0"
                handshake = f"C {int(self.cfg.max_steps_per_sec)} {int(self.cfg.accel_steps_per_sec2)}\n{zero}\n"
                if power_off:
                    handshake += "E 0\n"  # it booted with the drivers on
                ser.write(handshake.encode())
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
                        if pos != self._pos:
                            self._last_move = time.monotonic()
                        self._pos = pos
                        self._hw_pos = pos
                if time.monotonic() - last_heartbeat > HEARTBEAT_S:
                    self._send(ser, "H")
                    last_heartbeat = time.monotonic()
                self._maybe_idle_disable()
            except ValueError:
                continue  # garbled line
            except Exception as e:
                log.error("Motor serial link failed: %s", e)
                return

    def _send_if_connected(self, line):
        with self._state_lock:
            ser = self._serial
        if ser is None:
            return
        try:
            self._send(ser, line)
        except Exception:
            pass  # the supervisor thread will notice the link is down and reconnect

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

    def aim(self, pan_deg, deadband_deg=0.0, epoch=None):
        """Drive toward pan_deg (clamped to the limits). Ignored during an e-stop, when not
        finite, or when `epoch` (the frame_epoch the angle was computed in) is out of date."""
        if not math.isfinite(pan_deg):
            log.warning("Ignoring non-finite aim %r", pan_deg)
            return
        pan = _clamp(pan_deg, self.cfg.pan_limits_deg)
        with self._write_lock:
            with self._state_lock:
                if self._estopped or (epoch is not None and epoch != self._epoch):
                    return
                self._hold_since = None
                reenable = not self._drivers_enabled
                self._drivers_enabled = True
                target = self._deg_to_steps(pan)
                move = abs(target - self._target) / self.steps_per_deg > deadband_deg
                if move:
                    self._target = target
            if reenable:
                self._send_if_connected("E 1")  # before any T: steps sent while off are lost
            if move:
                self._send_if_connected(f"T {target} 0")

    def stop(self):
        """Decelerate to a stop and hold the current position (used for mode == 'stop').
        After cfg.idle_disable_s of holding, the drivers are powered down."""
        with self._write_lock:
            with self._state_lock:
                self._target = round(self._pos)
                if self._hold_since is None:
                    self._hold_since = time.monotonic()
            self._send_if_connected("S")
        self._maybe_idle_disable()

    def _maybe_idle_disable(self):
        idle_s = self.cfg.idle_disable_s
        with self._write_lock:
            with self._state_lock:
                now = time.monotonic()
                if (idle_s <= 0 or self._hold_since is None or not self._drivers_enabled
                        or self._estopped or now - self._hold_since < idle_s
                        or (self._serial is not None and now - self._last_move < STILL_S)):
                    return
                self._drivers_enabled = False
            self._send_if_connected("E 0")
        log.info("Stopped for %.0fs; motor drivers powered down", idle_s)
        self._on_event("motors_idle", after_s=idle_s)

    # ---- safety ----

    def estop(self):
        """Emergency stop: brake now (S), then cut driver power (E 0) as soon as the axis is
        still, or at the worst-case braking deadline. aim() is refused until arm()."""
        with self._write_lock:
            with self._state_lock:
                self._estopped = True
                self._estop_gen += 1
                gen = self._estop_gen
                self._target = round(self._pos)
                self._hold_since = None
                started = time.monotonic()
            self._send_if_connected("S")
        brake_s = self.cfg.max_steps_per_sec / self.cfg.accel_steps_per_sec2
        deadline = started + brake_s + ESTOP_MARGIN_S
        threading.Thread(target=self._estop_power_down, args=(gen, started, deadline),
                         name="estop", daemon=True).start()
        log.warning("E-STOP")

    def _estop_power_down(self, gen, started, deadline):
        while True:
            with self._write_lock:
                with self._state_lock:
                    if gen != self._estop_gen or not self._estopped or not self._drivers_enabled:
                        return  # re-armed, superseded, or already off
                    now = time.monotonic()
                    connected = self._serial is not None
                    still = now - max(self._last_move, started) >= STILL_S
                    # Disconnected: the Uno isn't moving anything; the handshake sends E 0.
                    done = not connected or still or now >= deadline
                    if done:
                        self._drivers_enabled = False
                if done:
                    if connected:
                        self._send_if_connected("E 0")
                    return
            time.sleep(ESTOP_POLL_S)

    def arm(self):
        """Release the e-stop and power the drivers back on. Returns False if not e-stopped."""
        with self._write_lock:
            with self._state_lock:
                if not self._estopped:
                    return False
                self._estopped = False
                self._estop_gen += 1
                self._drivers_enabled = True
                self._target = round(self._pos)
                self._hold_since = None
            self._send_if_connected("E 1")
        log.info("E-stop released")
        return True

    def zero(self):
        """"Set zero here": the current position becomes pan 0 (Z). Bumps frame_epoch."""
        with self._write_lock:
            with self._state_lock:
                self._pos = self._target = 0
                if self._hw_pos is not None:
                    self._hw_pos = 0
                self._last_sim = time.monotonic()
                self._epoch += 1
            self._send_if_connected("Z")

    # ---- live settings ----

    def set_motion_limits(self, max_steps_per_sec, accel_steps_per_sec2):
        with self._write_lock:
            self.cfg.max_steps_per_sec = float(max_steps_per_sec)
            self.cfg.accel_steps_per_sec2 = float(accel_steps_per_sec2)
            self._send_if_connected(f"C {int(max_steps_per_sec)} {int(accel_steps_per_sec2)}")

    def set_pan_invert(self, invert):
        """Flip which way +pan turns. Every angle changes meaning, so frame_epoch moves on."""
        with self._write_lock:
            with self._state_lock:
                if bool(invert) == self.cfg.pan_invert:
                    return
                self.cfg.pan_invert = bool(invert)
                self._epoch += 1

    def close(self):
        self._running = False
        self._send_if_connected("S")
        if self._thread is not None:
            self._thread.join(timeout=1)
        with self._state_lock:
            ser, self._serial = self._serial, None
        if ser is not None:
            ser.close()
