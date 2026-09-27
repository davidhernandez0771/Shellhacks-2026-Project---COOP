"""Per-object constant-velocity Kalman filter in image space (cooper/predictor.py).

State x = [u, v, h, u', v', h']: the box's bottom-centre (u, v), its height h, and their
rates, all in pixels and pixels/second.
"""
import numpy as np
import pytest

from cooper.config import PredictionConfig
from cooper.detector import Detection
from cooper.predictor import TrackFilter, Tracks

CFG = PredictionConfig()
FPS = 30.0


def box(u, v, h, aspect=0.5):
    """Box (x1, y1, x2, y2) whose bottom-centre is (u, v) and height h."""
    w = h * aspect
    return (u - w / 2, v - h, u + w / 2, v)


def run_linear(f, u0, v0, h0, du, dv, dh, seconds, t0=0.0):
    """Feed noise-free constant-velocity motion; return the last time."""
    n = int(seconds * FPS)
    for i in range(n + 1):
        t = t0 + i / FPS
        f.update(box(u0 + du * (t - t0), v0 + dv * (t - t0), h0 + dh * (t - t0)), t)
    return t0 + n / FPS


def test_first_update_sets_the_state_from_the_box_bottom_centre():
    f = TrackFilter(CFG)
    f.update((100, 50, 140, 150), 0.0)
    assert f.position == (120.0, 150.0, 100.0)
    assert f.velocity == (0.0, 0.0, 0.0)
    assert f.hits == 1


def test_it_learns_a_constant_velocity():
    f = TrackFilter(CFG)
    run_linear(f, 100, 300, 50, du=60, dv=30, dh=20, seconds=2.0)
    du, dv, dh = f.velocity
    assert du == pytest.approx(60, abs=1)
    assert dv == pytest.approx(30, abs=1)
    assert dh == pytest.approx(20, abs=1)
    assert f.hits == 61


def test_predict_extrapolates_at_constant_velocity():
    f = TrackFilter(CFG)
    t = run_linear(f, 100, 300, 50, du=60, dv=30, dh=20, seconds=2.0)
    # Truth at t + 0.5 s, by hand: u = 100 + 60*2.5, v = 300 + 30*2.5, h = 50 + 20*2.5.
    u, v, h = f.predict(0.5)
    assert (u, v, h) == pytest.approx((250, 375, 100), abs=1.5)
    assert t == pytest.approx(2.0)


def test_path_samples_every_step_up_to_the_horizon():
    f = TrackFilter(CFG)
    run_linear(f, 100, 300, 50, du=60, dv=0, dh=0, seconds=2.0)
    path = f.path(horizon_s=1.5, step_s=0.1)
    assert [round(p[0], 2) for p in path] == [round(0.1 * k, 2) for k in range(1, 16)]
    t_last, u_last, v_last, h_last = path[-1]
    assert (u_last, v_last, h_last) == pytest.approx((100 + 60 * 3.5, 300, 50), abs=1.5)


def reference_filter(measurements, cfg):
    """The full 6-state filter written straight from the equations in docs/MATH.md, with
    numpy matrices. The production filter is the factored form; they must agree."""
    x = P = None
    t_prev = None
    q = np.array([cfg.accel_std_px_s2, cfg.accel_std_px_s2, cfg.height_accel_std_px_s2]) ** 2
    R = np.diag([cfg.meas_std_px ** 2] * 3)
    H = np.hstack([np.eye(3), np.zeros((3, 3))])
    for z, t in measurements:
        z = np.asarray(z, float)
        if x is None:
            x = np.concatenate([z, np.zeros(3)])
            P = np.diag([cfg.meas_std_px ** 2] * 3 + [cfg.init_vel_std_px_s ** 2] * 3)
            t_prev = t
            continue
        dt = t - t_prev
        t_prev = t
        F = np.eye(6)
        F[:3, 3:] = dt * np.eye(3)
        Q = np.zeros((6, 6))
        for i in range(3):
            Q[i, i] = q[i] * dt ** 4 / 4
            Q[i, i + 3] = Q[i + 3, i] = q[i] * dt ** 3 / 2
            Q[i + 3, i + 3] = q[i] * dt ** 2
        x = F @ x
        P = F @ P @ F.T + Q
        S = H @ P @ H.T + R
        K = P @ H.T @ np.linalg.inv(S)
        x = x + K @ (z - H @ x)
        P = (np.eye(6) - K @ H) @ P
    return x, P


def test_the_factored_filter_equals_the_full_six_state_filter():
    rng = np.random.default_rng(7)
    t, measurements = 0.0, []
    for i in range(40):
        t += rng.uniform(0.02, 0.12)  # uneven frame times, as on the Pi
        z = (200 + 50 * t + rng.normal(0, 3), 320 + 10 * t * t + rng.normal(0, 3), 60 + 8 * t + rng.normal(0, 2))
        measurements.append((z, t))
    f = TrackFilter(CFG)
    for (u, v, h), t in measurements:
        f.update(box(u, v, h), t)
    x_ref, _ = reference_filter(measurements, CFG)
    # Equal states after 40 noisy, uneven steps means every Kalman gain matched, so P did too.
    assert f.position + f.velocity == pytest.approx(tuple(x_ref), abs=1e-6)


def test_time_to_contact_from_scale_growth():
    """Closing at 10 m/s from 20 m on a 1.5 m tall car (f = 522 px): h = 522*1.5/Z.
    At t = 1.0 s, Z = 10 m, so the true time to contact is 1.0 s.

    At constant closing speed h accelerates (h'' = 2 h'^2 / h), which a constant-velocity
    filter follows with a lag: it underestimates h', so tau comes out late, never early.
    With the default noise that bias is about +36 % here (docs/MATH.md)."""
    f = TrackFilter(CFG)
    for i in range(31):
        t = i / FPS
        z = 20.0 - 10.0 * t
        f.update(box(320, 240 + 678 / z, 522 * 1.5 / z), t)
    assert 1.0 <= f.ttc() <= 1.45


def test_no_time_to_contact_from_growth_that_could_be_jitter():
    """Two boxes 1 px apart: h' is positive but far inside its own uncertainty, so this is
    no evidence the object is closing (without the gate: tau of about 1.3 s, a false alarm)."""
    f = TrackFilter(CFG)
    f.update(box(320, 300, 40), 0.0)
    f.update(box(320, 300, 41), 1 / FPS)
    assert f.velocity[2] > 0
    assert f.ttc() is None


def test_no_time_to_contact_while_the_box_shrinks_or_holds():
    shrinking, steady = TrackFilter(CFG), TrackFilter(CFG)
    run_linear(shrinking, 320, 300, 80, du=0, dv=-5, dh=-10, seconds=1.0)
    run_linear(steady, 320, 300, 80, du=0, dv=0, dh=0, seconds=1.0)
    assert shrinking.ttc() is None
    assert steady.ttc() is None


def test_a_box_cut_short_by_an_occluder_does_not_move_the_ground_point():
    """A person walking behind a nearer car: for a few frames the detector sees only their
    head, so the box's bottom edge jumps ~70 px up onto the car's roof. That measurement is
    far outside the filter's innovation gate, so v and h coast on the prediction instead."""
    f = TrackFilter(CFG)
    t = run_linear(f, 200, 300, 80, du=100, dv=0, dh=0, seconds=1.0)
    for i in range(1, 11):                                   # 1/3 s of truncated boxes
        u = 200 + 100 * (t + i / FPS)
        f.update(box(u, 230, 9), t + i / FPS)
    u, v, h = f.position
    assert v == pytest.approx(300, abs=3) and h == pytest.approx(80, abs=3)
    assert u == pytest.approx(200 + 100 * (t + 10 / FPS), abs=3)   # u, still consistent, kept updating
    assert f.velocity[1] == pytest.approx(0, abs=5)


def test_a_half_second_occlusion_is_coasted_through_without_a_velocity_kick():
    """The rehearsal's pedestrian behind the next-lane car: 16 frames (0.53 s) where only an
    8 px sliver shows, bottom edge 73 px too high. Coasting widens each axis's gate, and v's
    alone would open wide enough to swallow the bad bottom edge before the person reappears.
    v and h come from the same bottom edge, so they're gated together: h's 90 % collapse
    keeps both coasting, and the person reappears exactly where predicted."""
    f = TrackFilter(CFG)
    t = run_linear(f, 100, 302, 81, du=133, dv=0, dh=0, seconds=1.0, )
    for i in range(1, 17):
        tt = t + i / FPS
        u = 100 + 133 * tt
        f.update((u - 12, 221, u + 12, 229), tt)            # the sliver above the occluder
        _, v, h = f.position
        assert v == pytest.approx(302, abs=5), f"{i} frames in"
        assert abs(f.velocity[1]) < 20, f"{i} frames in"
    tt = t + 17 / FPS
    f.update(box(100 + 133 * tt, 302, 81), tt)              # back in full view
    assert f.position[1] == pytest.approx(302, abs=2)


def test_a_lasting_change_is_followed_not_coasted_through_forever():
    """If the 'outlier' persists it's real (or the tracker swapped objects): after at most
    max_coast_s the axes restart on it (a coasting gate also widens, so it may get in sooner)."""
    f = TrackFilter(CFG)
    t = run_linear(f, 200, 300, 80, du=0, dv=0, dh=0, seconds=1.0)
    for i in range(1, int((CFG.max_coast_s + 0.3) * FPS)):
        f.update(box(200, 230, 40), t + i / FPS)
    u, v, h = f.position
    assert v == pytest.approx(230, abs=2) and h == pytest.approx(40, abs=2)


def test_aspect_follows_the_latest_box():
    f = TrackFilter(CFG)
    f.update((0, 0, 30, 60), 0.0)
    f.update((0, 0, 60, 60), 0.1)
    assert f.aspect == 1.0


# ---- Tracks: one filter per ByteTrack ID ----

def det(track_id, u, v, h, label="car"):
    return Detection(track_id, label, 0.8, tuple(round(c) for c in box(u, v, h)))


def test_tracks_keep_one_filter_per_id():
    tracks = Tracks(CFG)
    out = tracks.update([det(1, 100, 300, 50), det(2, 400, 350, 80)], 0.0)
    assert [t.id for t in out] == [1, 2]
    out = tracks.update([det(1, 102, 300, 50), det(2, 400, 350, 80)], 1 / FPS)
    assert [t.filter.hits for t in out] == [2, 2]
    assert out[0].label == "car" and out[0].box == det(1, 102, 300, 50).box


def test_tracks_ignore_detections_without_an_id():
    assert Tracks(CFG).update([Detection(None, "car", 0.5, (0, 0, 10, 10))], 0.0) == []


def test_a_track_coasts_through_a_short_gap_then_is_forgotten():
    tracks = Tracks(CFG)
    tracks.update([det(5, 100, 300, 50)], 0.0)
    assert tracks.update([], 0.2) == []                                  # not visible: not returned
    back = tracks.update([det(5, 100, 300, 50)], CFG.lost_timeout_s - 0.05)
    assert back[0].filter.hits == 2                                      # same filter, kept its history
    tracks.update([], 1.0)
    later = tracks.update([det(5, 100, 300, 50)], 1.0 + CFG.lost_timeout_s + 0.1)
    assert later[0].filter.hits == 1                                     # forgotten, started fresh
