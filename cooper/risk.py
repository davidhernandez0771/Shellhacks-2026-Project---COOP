"""Collision risk: clear / warning / danger, from the lane and every object's predicted path.

Rules, per object (docs/MATH.md has the geometry):
- danger:  its box's bottom edge (where it meets the road) is in the lane now.
- warning: its predicted bottom edge enters the lane within horizon_s, or its time to contact
           from scale growth (tau = h / h') is short while it's in the lane's corridor (the lane
           extended to the horizon and widened by lane_margin).
The frame's level is the worst object's. Hysteresis turns that into what the LEDs show: a
level lights after enter_frames frames in a row and stays lit hold_s after its condition ends.

All geometry is in pixels of the current frame; the lane is stored normalized (0..1).
"""
from dataclasses import dataclass, field

CLEAR, WARNING, DANGER = "clear", "warning", "danger"
_RANK = {CLEAR: 0, WARNING: 1, DANGER: 2}


# ---- lane geometry ----

def lane_pixels(lane, width, height):
    """Normalized (x, y) * 4 in order TL, TR, BR, BL -> [(x, y)] in pixels."""
    return [(lane[i] * width, lane[i + 1] * height) for i in range(0, 8, 2)]


def row_span(poly, y):
    """(x_left, x_right) where the horizontal line at y crosses the convex polygon, or None."""
    xs = []
    n = len(poly)
    for i in range(n):
        (xa, ya), (xb, yb) = poly[i], poly[(i + 1) % n]
        if ya == yb:
            if y == ya:
                xs += [xa, xb]
        elif min(ya, yb) <= y <= max(ya, yb):
            xs.append(xa + (xb - xa) * (y - ya) / (yb - ya))
    return (min(xs), max(xs)) if xs else None


def _x_on_line(p, q, y):
    (xa, ya), (xb, yb) = p, q
    return xa + (xb - xa) * (y - ya) / (yb - ya)


def corridor_span(poly, y, margin):
    """Span at row y of the lane's side lines extended beyond its far end (towards the
    vanishing point), widened by `margin` of its width on each side. None below the lane's
    near edge or past the point where the sides meet."""
    tl, tr, br, bl = poly
    if y > max(bl[1], br[1]):
        return None
    x0, x1 = _x_on_line(bl, tl, y), _x_on_line(br, tr, y)
    if x1 <= x0:
        return None
    pad = margin * (x1 - x0)
    return x0 - pad, x1 + pad


def _overlaps(span, x1, x2, min_overlap):
    if span is None:
        return False
    overlap = min(x2, span[1]) - max(x1, span[0])
    return overlap > 0 and overlap >= min_overlap * max(x2 - x1, 1e-6)


def edge_in_lane(poly, x1, x2, y, min_overlap):
    """Is at least `min_overlap` of the horizontal edge x1..x2 at row y inside the lane?"""
    return _overlaps(row_span(poly, y), x1, x2, min_overlap)


def ttc_warning(tau, latched, cfg):
    """TTC hysteresis for one object: on below ttc_warn_s, off only above ttc_clear_s."""
    if tau is None:
        return False
    return tau < (cfg.ttc_clear_s if latched else cfg.ttc_warn_s)


# ---- per-frame assessment ----

@dataclass
class ObjectRisk:
    id: int
    label: str
    conf: float
    box: tuple
    level: str = CLEAR
    kind: str | None = None          # "in_lane", "path", "ttc" or None
    reason: str = ""
    path: list = field(default_factory=list)  # predicted bottom-centre [(u, v)], step_s apart
    velocity: tuple = (0.0, 0.0)     # (u', v') px/s
    ttc: float | None = None         # seconds, when the box is significantly growing
    time_to_lane: float | None = None  # seconds until the predicted path enters the lane


@dataclass
class Assessment:
    level: str          # after hysteresis: what the LEDs show
    reason: str
    raw_level: str      # this frame alone
    objects: list


class Hysteresis:
    """Per level: on after `enter_frames` consecutive frames at or above it, off once it
    hasn't been seen for `hold_s`. The output is the highest level that is on."""

    def __init__(self, enter_frames, hold_s):
        self.enter_frames, self.hold_s = enter_frames, hold_s
        self._state = {lvl: {"on": False, "streak": 0, "last": None, "reason": ""} for lvl in (WARNING, DANGER)}

    def step(self, level, reason, t):
        for lvl, st in self._state.items():
            if _RANK[level] >= _RANK[lvl]:
                st["streak"] += 1
                st["last"] = t
                if level == lvl or not st["on"]:
                    st["reason"] = reason
                if st["streak"] >= self.enter_frames:
                    st["on"] = True
            else:
                st["streak"] = 0
                if st["on"] and t - st["last"] >= self.hold_s:
                    st["on"] = False
        for lvl in (DANGER, WARNING):
            if self._state[lvl]["on"]:
                return lvl, self._state[lvl]["reason"]
        return CLEAR, ""


class RiskJudge:
    """Turns this frame's tracks into an Assessment. Reads `cfg` (RiskConfig) every frame,
    so live changes to the lane and thresholds apply on the next frame."""

    def __init__(self, cfg):
        self.cfg = cfg
        self._latched = set()  # IDs whose TTC warning is on
        self._hysteresis = Hysteresis(cfg.enter_frames, cfg.hold_s)

    def update(self, tracks, width, height, t):
        cfg = self.cfg
        lane = lane_pixels(cfg.lane, width, height)
        objects = [self._assess(tr, lane) for tr in tracks]
        self._latched &= {o.id for o in objects}

        raw, reason = CLEAR, ""
        danger = [o for o in objects if o.level == DANGER]
        warning = [o for o in objects if o.level == WARNING]
        if danger:
            raw, reason = DANGER, max(danger, key=lambda o: o.box[3]).reason  # the nearest
        elif warning:
            raw, reason = WARNING, min(warning, key=_urgency).reason
        self._hysteresis.enter_frames, self._hysteresis.hold_s = cfg.enter_frames, cfg.hold_s
        level, shown = self._hysteresis.step(raw, reason, t)
        return Assessment(level, shown, raw, objects)

    def _assess(self, track, lane):
        cfg, f = self.cfg, track.filter
        x1, _, x2, y2 = track.box
        name = f"{track.label} #{track.id}"
        obj = ObjectRisk(track.id, track.label, track.conf, tuple(track.box))
        path = f.path(cfg.horizon_s, cfg.step_s)
        obj.path = [(u, v) for _, u, v, _ in path]
        obj.velocity = f.velocity[:2]
        obj.ttc = f.ttc()

        if edge_in_lane(lane, x1, x2, y2, cfg.min_overlap):
            obj.level, obj.kind, obj.reason = DANGER, "in_lane", f"{name} in your lane"
            return obj
        trusted = f.hits >= f.cfg.min_hits
        if trusted:
            for dt, u, v, h in path:
                half = h * f.aspect / 2
                if edge_in_lane(lane, u - half, u + half, v, cfg.min_overlap):
                    obj.time_to_lane = dt
                    obj.level, obj.kind = WARNING, "path"
                    obj.reason = f"{name} heading into your lane in {dt:.1f} s"
                    break

        in_corridor = _overlaps(corridor_span(lane, y2, cfg.lane_margin), x1, x2, cfg.min_overlap)
        tall_enough = f.position[2] >= cfg.ttc_min_height_px
        if trusted and in_corridor and tall_enough and ttc_warning(obj.ttc, track.id in self._latched, cfg):
            self._latched.add(track.id)
            if obj.kind is None:
                obj.level, obj.kind = WARNING, "ttc"
                obj.reason = f"{name} closing fast: contact in {obj.ttc:.1f} s"
        else:
            self._latched.discard(track.id)
        return obj


def _urgency(obj):
    times = [x for x in (obj.time_to_lane, obj.ttc if obj.kind == "ttc" else None) if x is not None]
    return min(times, default=float("inf"))
