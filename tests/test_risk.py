"""Risk rules (cooper/risk.py): lane geometry, in-lane danger, predicted-path and
time-to-contact warnings, and the hysteresis that keeps the LEDs from flickering.

The default lane in a 640x480 frame, by hand from RiskConfig.lane (normalized TL, TR, BR, BL):
TL (281.6, 288), TR (358.4, 288), BR (505.6, 480), BL (134.4, 480). At row y = 384 (halfway
down) it spans x = 208..432. Its side lines meet near (320, 238), just below the horizon.
"""
import dataclasses

import pytest

from cooper.config import PredictionConfig, RiskConfig
from cooper.detector import Detection
from cooper.predictor import Tracks
from cooper.risk import (CLEAR, DANGER, WARNING, Hysteresis, RiskJudge, corridor_span, edge_in_lane,
                         lane_pixels, row_span, ttc_warning)

W, H = 640, 480
FPS = 30.0
CFG = RiskConfig()
LANE = lane_pixels(CFG.lane, W, H)


# ---- geometry ----

def test_lane_pixels_scales_the_normalized_corners():
    flat = [c for corner in LANE for c in corner]
    assert flat == pytest.approx([281.6, 288, 358.4, 288, 505.6, 480, 134.4, 480])


@pytest.mark.parametrize("y,want", [
    (384, (208.0, 432.0)),
    (288, (281.6, 358.4)),
    (480, (134.4, 505.6)),
    (250, None),   # beyond the far end of the lane
    (490, None),   # below it
])
def test_row_span(y, want):
    got = row_span(LANE, y)
    assert got == (None if want is None else pytest.approx(want))


def test_corridor_extends_the_lane_sides_past_its_far_end():
    # At y = 274 (14 px above the lane's top edge) the side lines are 10.733 px further in.
    assert corridor_span(LANE, 274, margin=0.0) == pytest.approx((292.333, 347.667), abs=1e-3)
    # A 25 % margin widens it by a quarter of its width (55.333 px) on each side.
    assert corridor_span(LANE, 274, margin=0.25) == pytest.approx((278.5, 361.5), abs=1e-3)
    assert corridor_span(LANE, 230, margin=0.25) is None  # past the vanishing point


@pytest.mark.parametrize("x1,x2,want", [
    (270, 370, True),    # fully inside
    (150, 250, True),    # 42 of 100 px inside: 42 % >= 20 %
    (100, 220, False),   # 12 of 120 px inside: 10 % < 20 %: a car in the next lane, just touching
    (440, 500, False),   # entirely right of the lane
])
def test_edge_in_lane_needs_a_minimum_overlap(x1, x2, want):
    assert edge_in_lane(LANE, x1, x2, 384, min_overlap=0.2) is want


# ---- the rules, on real filters ----

def box(u, v, h, aspect):
    w = h * aspect
    return (round(u - w / 2), round(v - h), round(u + w / 2), round(v))


def run(objects, seconds=0.5, cfg=CFG, judge=None):
    """Drive Tracks + RiskJudge with objects moving at constant rates.

    objects: {id: (label, u, v, h, du, dv, dh, aspect)}. Returns (assessment, judge)."""
    tracks, judge = Tracks(PredictionConfig()), judge or RiskJudge(cfg)
    result = None
    for i in range(int(seconds * FPS) + 1):
        t = i / FPS
        dets = [Detection(tid, label, 0.8, box(u + du * t, v + dv * t, h + dh * t, aspect))
                for tid, (label, u, v, h, du, dv, dh, aspect) in objects.items()]
        result = judge.update(tracks.update(dets, t), W, H, t)
    return result, judge


def only(result):
    assert len(result.objects) == 1
    return result.objects[0]


def test_an_object_in_the_lane_is_danger():
    result, _ = run({7: ("car", 320, 384, 100, 0, 0, 0, 1.0)})
    assert result.level == DANGER and result.raw_level == DANGER
    obj = only(result)
    assert obj.level == DANGER and obj.kind == "in_lane"
    assert "#7" in result.reason


def test_a_car_beyond_the_far_end_of_the_lane_is_clear():
    result, _ = run({1: ("car", 320, 250, 40, 0, 0, 0, 1.2)})
    assert result.level == CLEAR and only(result).kind is None


def test_a_car_in_the_next_lane_just_touching_it_is_clear():
    result, _ = run({4: ("car", 160, 384, 60, 0, 0, 0, 2.0)})  # bottom edge 100..220
    assert result.level == CLEAR


def test_a_path_into_the_lane_within_the_horizon_is_a_warning():
    # Bottom edge 70..130 at y = 384, moving right at 100 px/s. It needs 12 px (20 % of 60)
    # inside the lane, whose left side is at 208: right edge 220, centre 190, so 0.9 s away.
    result, _ = run({3: ("person", 100, 384, 120, 100, 0, 0, 0.5)}, seconds=0.5)
    obj = only(result)
    assert obj.kind == "path" and obj.level == WARNING
    assert result.level == WARNING
    # After 0.5 s the centre is at 150, so 40 px (0.4 s) to go.
    assert obj.time_to_lane == pytest.approx(0.4, abs=0.1)


def test_a_path_that_reaches_the_lane_after_the_horizon_is_clear():
    # At 40 px/s the same person needs 2.25 s, beyond the 1.5 s horizon.
    result, _ = run({3: ("person", 60, 384, 120, 40, 0, 0, 0.5)}, seconds=0.3)
    assert result.level == CLEAR


def test_no_path_warning_until_the_filter_has_enough_history():
    # Two frames only: the second is a 20 px jump (detector noise), not real motion.
    tracks, judge = Tracks(PredictionConfig()), RiskJudge(CFG)
    judge.update(tracks.update([Detection(3, "person", 0.8, box(100, 384, 120, 0.5))], 0.0), W, H, 0.0)
    result = judge.update(tracks.update([Detection(3, "person", 0.8, box(120, 384, 120, 0.5))], 1 / FPS),
                          W, H, 1 / FPS)
    assert only(result).kind is None


def test_a_fast_growing_box_ahead_is_a_time_to_contact_warning():
    # Bottom fixed at y = 274 (in the corridor, above the lane), h 40 px growing 30 px/s:
    # tau = h / h' = 1.33 s at the start, less as it grows. The path never reaches the lane.
    result, _ = run({1: ("car", 320, 274, 40, 0, 0, 30, 0.5)}, seconds=0.5)
    obj = only(result)
    assert obj.kind == "ttc" and obj.level == WARNING
    # After 0.5 s: h = 55, h' = 30, so tau = 1.83 s.
    assert obj.ttc == pytest.approx(1.83, rel=0.15)


def test_time_to_contact_outside_the_corridor_is_ignored():
    result, _ = run({4: ("car", 100, 274, 40, 0, 0, 30, 0.5)}, seconds=0.5)  # next lane over
    assert result.level == CLEAR


def test_time_to_contact_on_a_tiny_far_box_is_ignored():
    # 15 px tall: one pixel of jitter is 7 % of h, so its scale rate is noise.
    result, _ = run({1: ("car", 320, 274, 15, 0, 0, 12, 1.0)}, seconds=0.3)
    assert result.level == CLEAR


def test_danger_beats_warning_and_names_the_danger():
    result, _ = run({7: ("car", 320, 400, 100, 0, 0, 0, 1.0),
                     3: ("person", 100, 384, 120, 100, 0, 0, 0.5)}, seconds=0.5)
    assert result.level == DANGER
    assert "#7" in result.reason


def test_the_lane_is_read_live_from_the_config():
    cfg = dataclasses.replace(CFG)
    judge = RiskJudge(cfg)
    result, _ = run({7: ("car", 320, 384, 100, 0, 0, 0, 1.0)}, cfg=cfg, judge=judge)
    assert result.raw_level == DANGER
    cfg.lane = (0.0, 0.6, 0.1, 0.6, 0.1, 1.0, 0.0, 1.0)  # a lane at the far left edge
    result, _ = run({7: ("car", 320, 384, 100, 0, 0, 0, 1.0)}, cfg=cfg, judge=judge)
    assert result.raw_level == CLEAR


# ---- TTC latch ----

@pytest.mark.parametrize("tau,latched,want", [
    (1.9, False, True),    # below ttc_warn_s: starts warning
    (2.2, False, False),   # between the thresholds, not yet warning: stays off
    (2.2, True, True),     # between the thresholds, already warning: stays on
    (2.6, True, False),    # above ttc_clear_s: releases
    (None, True, False),   # not closing any more
])
def test_ttc_warning_has_hysteresis(tau, latched, want):
    assert ttc_warning(tau, latched, CFG) is want


# ---- level hysteresis ----

def steps(h, levels, dt=1 / FPS):
    return [h.step(level, f"r{i}", i * dt)[0] for i, level in enumerate(levels)]


def test_one_frame_is_not_enough_to_light_up():
    assert steps(Hysteresis(2, 0.5), [DANGER, CLEAR, CLEAR]) == [CLEAR, CLEAR, CLEAR]


def test_two_frames_in_a_row_light_up():
    assert steps(Hysteresis(2, 0.5), [DANGER, DANGER]) == [CLEAR, DANGER]


def test_a_level_holds_for_hold_s_after_its_condition_ends():
    h = Hysteresis(2, 0.5)
    out = steps(h, [DANGER] * 3 + [CLEAR] * 20)  # condition last seen at t = 2/30 s
    first_clear = out.index(CLEAR, 3)
    assert first_clear * (1 / FPS) == pytest.approx(2 / 30 + 0.5, abs=1 / FPS)
    assert all(level == DANGER for level in out[1:first_clear])


def test_danger_falls_back_to_warning_while_the_warning_still_holds():
    out = steps(Hysteresis(2, 0.5), [DANGER] * 3 + [WARNING] * 30)
    assert out[-1] == WARNING
    assert CLEAR not in out[1:]


def test_a_flickering_input_does_not_flicker_the_output():
    raw = [DANGER, DANGER, CLEAR] * 20  # the detector drops the object every third frame
    out = steps(Hysteresis(2, 0.5), raw)
    toggles = sum(1 for a, b in zip(out, out[1:]) if a != b)
    assert toggles == 1  # off -> on once, then held through every gap


def test_the_reason_is_kept_while_a_level_is_held():
    h = Hysteresis(2, 0.5)
    h.step(DANGER, "car #7 in your lane", 0.0)
    h.step(DANGER, "car #7 in your lane", 0.033)
    assert h.step(CLEAR, "", 0.066) == (DANGER, "car #7 in your lane")
