"""Motion prediction: constant-velocity Kalman filter over the target's world angle.

We filter in world angles (gimbal angle + offset in frame) rather than pixels, so the
camera's own rotation doesn't look like target motion.
"""
import numpy as np

_H = np.array([[1.0, 0, 0, 0], [0, 1.0, 0, 0]])


class KalmanPredictor:
    def __init__(self, process_noise=200.0, measurement_noise=0.5):
        self.q = process_noise  # how much the target may accelerate (deg/s^2)^2
        self.r = measurement_noise  # detection jitter (deg^2)
        self.reset()

    def reset(self):
        self.x = None  # state: [pan, tilt, pan_vel, tilt_vel]
        self.P = None
        self._last_t = None

    @property
    def active(self):
        return self.x is not None

    @property
    def velocity(self):
        return (0.0, 0.0) if self.x is None else (float(self.x[2]), float(self.x[3]))

    def update(self, measurement, t):
        z = np.asarray(measurement, dtype=float)
        if self.x is None:
            self.x = np.array([z[0], z[1], 0.0, 0.0])
            self.P = np.diag([self.r, self.r, 100.0, 100.0])
            self._last_t = t
            return

        dt = max(t - self._last_t, 1e-3)
        self._last_t = t

        F = np.eye(4)
        F[0, 2] = F[1, 3] = dt
        Q = self.q * np.diag([dt**4 / 4, dt**4 / 4, dt**2, dt**2])
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + Q

        S = _H @ self.P @ _H.T + self.r * np.eye(2)
        K = self.P @ _H.T @ np.linalg.inv(S)
        self.x = self.x + K @ (z - _H @ self.x)
        self.P = (np.eye(4) - K @ _H) @ self.P

    def predict(self, lead_s):
        """Where the target should be `lead_s` seconds from the last update."""
        return (
            float(self.x[0] + self.x[2] * lead_s),
            float(self.x[1] + self.x[3] * lead_s),
        )
