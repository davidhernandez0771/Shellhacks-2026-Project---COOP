"""Stepper pan/tilt control through step/dir drivers.

Each axis runs its own thread that chases a target position with a trapezoidal speed
ramp. Off the Pi (or with motors disabled) the axes run in mock mode: positions still
update so the rest of the pipeline and the dashboard behave normally.
"""
import logging
import threading
import time

log = logging.getLogger(__name__)


def _output(pin, **kwargs):
    from gpiozero import OutputDevice

    return OutputDevice(pin, **kwargs)


class StepperAxis:
    def __init__(self, name, step_pin, dir_pin, limits_deg, cfg, mock):
        self.name = name
        self.limits = limits_deg
        self.steps_per_deg = cfg.steps_per_rev * cfg.microsteps * cfg.gear_ratio / 360.0
        self.max_rate = cfg.max_steps_per_sec
        self.min_rate = cfg.min_steps_per_sec
        self.accel = cfg.accel_steps_per_sec2

        self.position = 0  # steps; 0 = wherever the axis was at startup
        self.target = 0
        self._dir = 1
        self._step = self._dirpin = None
        if not mock:
            self._step = _output(step_pin)
            self._dirpin = _output(dir_pin)

        self._running = True
        self._thread = threading.Thread(target=self._run, name=f"stepper-{name}", daemon=True)
        self._thread.start()

    @property
    def angle(self):
        return self.position / self.steps_per_deg

    @property
    def target_angle(self):
        return self.target / self.steps_per_deg

    def set_target_angle(self, deg):
        lo, hi = self.limits
        self.target = round(min(max(deg, lo), hi) * self.steps_per_deg)

    def _run(self):
        rate = self.min_rate
        while self._running:
            diff = self.target - self.position
            if diff == 0:
                rate = self.min_rate
                time.sleep(0.002)
                continue

            direction = 1 if diff > 0 else -1
            if direction != self._dir:
                self._dir = direction
                rate = self.min_rate
                if self._dirpin is not None:
                    self._dirpin.value = direction > 0
                    time.sleep(0.00001)  # driver dir setup time

            # Decelerate when the remaining distance is within stopping distance.
            stopping_steps = rate * rate / (2 * self.accel)
            if abs(diff) <= stopping_steps:
                rate = max(self.min_rate, rate - self.accel / rate)
            else:
                rate = min(self.max_rate, rate + self.accel / rate)

            if self._step is not None:
                self._step.on()
                self._step.off()
            self.position += direction
            time.sleep(1.0 / rate)

    def close(self):
        self._running = False
        self._thread.join(timeout=1)
        for dev in (self._step, self._dirpin):
            if dev is not None:
                dev.close()


class Gimbal:
    def __init__(self, cfg):
        mock = not cfg.enabled
        self._enable = None
        if not mock:
            try:
                if cfg.enable_pin is not None:
                    # EN is active low on A4988/DRV8825/TMC2209: driving it low enables the driver.
                    self._enable = _output(cfg.enable_pin, active_high=False, initial_value=True)
            except Exception as e:
                log.warning("GPIO unavailable (%s); motors in mock mode", e)
                mock = True
        if mock:
            log.info("Motors running in mock mode")

        self.mock = mock
        self.pan = StepperAxis("pan", cfg.pan_step_pin, cfg.pan_dir_pin, cfg.pan_limits_deg, cfg, mock)
        self.tilt = (
            StepperAxis("tilt", cfg.tilt_step_pin, cfg.tilt_dir_pin, cfg.tilt_limits_deg, cfg, mock)
            if cfg.tilt_enabled
            else None
        )

    @property
    def angles(self):
        return self.pan.angle, (self.tilt.angle if self.tilt else 0.0)

    def aim(self, pan_deg, tilt_deg, deadband_deg=0.0):
        if abs(pan_deg - self.pan.target_angle) > deadband_deg:
            self.pan.set_target_angle(pan_deg)
        if self.tilt and abs(tilt_deg - self.tilt.target_angle) > deadband_deg:
            self.tilt.set_target_angle(tilt_deg)

    def close(self):
        self.pan.close()
        if self.tilt:
            self.tilt.close()
        if self._enable is not None:
            self._enable.off()
            self._enable.close()
