"""Constant-velocity Kalman filter over the target's world angle."""
import pytest

from cooper.predictor import KalmanPredictor


def test_fresh_predictor_is_inactive():
    kp = KalmanPredictor()
    assert not kp.active
    assert kp.velocity == (0.0, 0.0)


def test_first_update_activates_but_has_no_velocity_yet():
    kp = KalmanPredictor()
    kp.update((10.0, -5.0), t=0.0)
    assert kp.active
    assert kp.velocity == (0.0, 0.0)
    assert kp.predict(0.0) == pytest.approx((10.0, -5.0))


def test_converges_to_true_constant_velocity():
    kp = KalmanPredictor()
    true_pan_vel = 10.0
    for i in range(10):
        t = i * 0.1
        kp.update((true_pan_vel * t, 0.0), t)
    pan_vel, tilt_vel = kp.velocity
    assert pan_vel == pytest.approx(true_pan_vel, abs=0.5)
    assert tilt_vel == pytest.approx(0.0, abs=0.5)


def test_predict_leads_target_using_estimated_velocity():
    kp = KalmanPredictor()
    true_vel = 10.0
    t = 0.0
    for i in range(10):
        t = i * 0.1
        kp.update((true_vel * t, 0.0), t)
    lead_pan, lead_tilt = kp.predict(0.15)
    assert lead_pan == pytest.approx(true_vel * (t + 0.15), abs=1.0)
    assert lead_tilt == pytest.approx(0.0, abs=0.5)


def test_reset_clears_state():
    kp = KalmanPredictor()
    kp.update((1.0, 2.0), t=0.0)
    kp.reset()
    assert not kp.active
    assert kp.velocity == (0.0, 0.0)


def test_repeated_timestamp_does_not_crash_or_divide_by_zero():
    """dt is clamped to a minimum, so a stalled clock must not produce a singular matrix."""
    kp = KalmanPredictor()
    kp.update((0.0, 0.0), t=1.0)
    kp.update((1.0, 0.0), t=1.0)
    assert kp.active
    assert all(v == v for v in kp.velocity)  # no NaNs
