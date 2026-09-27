"""Motion prediction: a constant-velocity Kalman filter per tracked object, in image space.

The camera rides with the car, so what matters for a collision is motion *relative to the
camera*, which is exactly what the image shows. Each object is filtered on the bottom-centre
of its box (u, v), where it touches the road, and the box height h, which grows as the
object gets closer.

    state        x = [u, v, h, u', v', h']          (px, px/s)
    measurement  z = [u, v, h]                      (from the YOLO box)
    x_k = F x_{k-1} + w,  F = [[I, dt I], [0, I]],   w ~ N(0, Q)
    z_k = H x_k + n,      H = [I 0],                 n ~ N(0, R)

Q is the discretised white-acceleration model, per axis q * [[dt^4/4, dt^3/2], [dt^3/2, dt^2]],
and R = diag(sigma_z^2). F, H, Q and R are all block-diagonal per axis, and so is the
initial covariance, so the 6-state filter factors exactly into three independent 2-state
filters, one per axis. That's what this module runs: a few dozen scalar operations per
object per frame instead of 6x6 matrix products. docs/MATH.md has the derivation;
tests/test_predictor.py checks this against the full 6x6 form.

Innovation gate: a measurement with |z - p| > gate_sigma * sqrt(S) on an axis is
inconsistent with the track, typically a box cut short by an occluder, whose bottom edge is
then the occluder's roof, not the road. v and h both come from that bottom edge (v = y2,
h = y2 - y1), so they're gated together: if either is outside its gate, both coast on the
prediction. u has its own gate. If an axis keeps rejecting for max_coast_s the change is
real (or the tracker swapped objects) and it restarts on the new value.
"""


class _Axis:
    """One axis of the filter: position p, rate r, covariance [[a, b], [b, c]]."""

    __slots__ = ("p", "r", "a", "b", "c", "q", "rr", "rv", "accepted_t")

    def __init__(self, z, q, meas_var, init_rate_var, t):
        self.q, self.rr, self.rv = q, meas_var, init_rate_var
        self._start(z, t)

    def _start(self, z, t):
        self.p, self.r = z, 0.0
        self.a, self.b, self.c = self.rr, 0.0, self.rv
        self.accepted_t = t

    def predict(self, dt):
        """x = F x, P = F P F^T + Q."""
        q = self.q
        self.p += self.r * dt
        self.a, self.b, self.c = (self.a + 2 * dt * self.b + dt * dt * self.c + q * dt ** 4 / 4,
                                  self.b + dt * self.c + q * dt ** 3 / 2,
                                  self.c + q * dt * dt)

    def in_gate(self, z, gate_sigma):
        """Is z within gate_sigma standard deviations of the prediction (S = P_uu + R)?"""
        y = z - self.p
        return y * y <= gate_sigma * gate_sigma * (self.a + self.rr)

    def correct(self, z, t, accept, max_coast_s):
        if not accept:
            if t - self.accepted_t > max_coast_s:
                self._start(z, t)  # rejected for too long: the change is real
            return                 # else coast: the prediction stands
        # Update: S = a + R, K = [a, b] / S, x += K (z - p), P = (I - K H) P.
        a, b, c = self.a, self.b, self.c
        s = a + self.rr
        k0, k1 = a / s, b / s
        y = z - self.p
        self.p += k0 * y
        self.r += k1 * y
        self.a, self.b, self.c = (1 - k0) * a, (1 - k0) * b, c - k1 * b
        self.accepted_t = t


class TrackFilter:
    def __init__(self, cfg):
        self.cfg = cfg
        self._axes = None  # u, v, h
        self._t = None
        self.hits = 0
        self.aspect = 1.0  # width / height of the latest box, to rebuild predicted boxes

    def update(self, box, t):
        x1, y1, x2, y2 = box
        h = max(y2 - y1, 1e-6)
        z = ((x1 + x2) / 2, y2, h)
        self.aspect = (x2 - x1) / h
        self.hits += 1
        if self._axes is None:
            cfg = self.cfg
            meas, vel = cfg.meas_std_px ** 2, cfg.init_vel_std_px_s ** 2
            qs = (cfg.accel_std_px_s2 ** 2, cfg.accel_std_px_s2 ** 2, cfg.height_accel_std_px_s2 ** 2)
            self._axes = [_Axis(zi, q, meas, vel, t) for zi, q in zip(z, qs)]
        else:
            dt = max(t - self._t, 1e-3)
            g = self.cfg.gate_sigma
            for axis in self._axes:
                axis.predict(dt)
            u_ok = self._axes[0].in_gate(z[0], g)
            vh_ok = self._axes[1].in_gate(z[1], g) and self._axes[2].in_gate(z[2], g)  # one bottom edge
            for axis, zi, ok in zip(self._axes, z, (u_ok, vh_ok, vh_ok)):
                axis.correct(zi, t, ok, self.cfg.max_coast_s)
        self._t = t

    @property
    def position(self):
        """(u, v, h) now: bottom-centre and height, px."""
        return tuple(a.p for a in self._axes)

    @property
    def velocity(self):
        """(u', v', h') in px/s."""
        return tuple(a.r for a in self._axes)

    def predict(self, dt):
        """(u, v, h) `dt` seconds after the last update, at constant velocity."""
        return tuple(a.p + a.r * dt for a in self._axes)

    def path(self, horizon_s, step_s):
        """[(t, u, v, h)] at t = step_s, 2 step_s, ... up to horizon_s."""
        n = int(round(horizon_s / step_s))
        return [(k * step_s, *self.predict(k * step_s)) for k in range(1, n + 1)]

    def ttc(self):
        """Time to contact from scale growth, tau = h / h', in seconds; None unless the box
        is growing by more than growth_min_sigma standard deviations of h'.

        For an object at distance Z closing at speed -Z', h is proportional to 1/Z, so
        h / h' = Z / (-Z'): the time until it reaches the camera at its current speed. The
        significance gate keeps detector jitter on a steady box from reading as closing."""
        axis = self._axes[2]
        if axis.r <= 0 or axis.r <= self.cfg.growth_min_sigma * axis.c ** 0.5:
            return None
        return axis.p / axis.r


class Track:
    """A ByteTrack ID and its filter, with its latest detection."""

    __slots__ = ("id", "label", "conf", "box", "filter", "last_seen")

    def __init__(self, track_id, cfg):
        self.id = track_id
        self.filter = TrackFilter(cfg)
        self.label, self.conf, self.box, self.last_seen = None, 0.0, None, None


class Tracks:
    """One TrackFilter per ByteTrack ID. update() returns the tracks seen this frame."""

    def __init__(self, cfg):
        self.cfg = cfg
        self._tracks = {}

    def update(self, detections, t):
        seen = []
        for d in detections:
            if d.track_id is None:  # ByteTrack hasn't confirmed it yet: no identity to follow
                continue
            track = self._tracks.get(d.track_id)
            if track is None:
                track = self._tracks[d.track_id] = Track(d.track_id, self.cfg)
            track.label, track.conf, track.box, track.last_seen = d.label, d.conf, d.box, t
            track.filter.update(d.box, t)
            seen.append(track)
        for track_id in [i for i, tr in self._tracks.items() if t - tr.last_seen > self.cfg.lost_timeout_s]:
            del self._tracks[track_id]
        return seen
