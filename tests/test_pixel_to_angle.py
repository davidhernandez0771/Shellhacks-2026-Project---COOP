"""Pixel -> world-angle offset math (the pinhole model in cooper.main)."""
import pytest

from cooper.main import pixel_to_offset_deg

W, H = 640, 480
HFOV, VFOV = 63.0, 49.0


def test_center_pixel_is_zero_offset():
    pan, tilt = pixel_to_offset_deg(W / 2, H / 2, W, H, HFOV, VFOV)
    assert pan == pytest.approx(0.0)
    assert tilt == pytest.approx(0.0)


def test_left_and_right_edges_are_half_fov_and_opposite_sign():
    pan_left, _ = pixel_to_offset_deg(0, H / 2, W, H, HFOV, VFOV)
    pan_right, _ = pixel_to_offset_deg(W, H / 2, W, H, HFOV, VFOV)
    assert pan_left == pytest.approx(-HFOV / 2)
    assert pan_right == pytest.approx(HFOV / 2)


def test_top_is_positive_tilt_bottom_is_negative():
    """+tilt is up, so the top of the frame (y=0) is a positive offset."""
    _, tilt_top = pixel_to_offset_deg(W / 2, 0, W, H, HFOV, VFOV)
    _, tilt_bottom = pixel_to_offset_deg(W / 2, H, W, H, HFOV, VFOV)
    assert tilt_top == pytest.approx(VFOV / 2)
    assert tilt_bottom == pytest.approx(-VFOV / 2)


def test_pan_increases_monotonically_with_x():
    xs = [0, W / 4, W / 2, 3 * W / 4, W]
    pans = [pixel_to_offset_deg(x, H / 2, W, H, HFOV, VFOV)[0] for x in xs]
    assert pans == sorted(pans)


def test_tilt_increases_monotonically_as_y_decreases():
    ys = [0, H / 4, H / 2, 3 * H / 4, H]
    tilts = [pixel_to_offset_deg(W / 2, y, W, H, HFOV, VFOV)[1] for y in ys]
    assert tilts == sorted(tilts, reverse=True)


def test_horizontal_and_vertical_fov_are_independent():
    """Widening vfov must not change the pan result for the same pixel."""
    pan_a, _ = pixel_to_offset_deg(0, H / 2, W, H, HFOV, 10.0)
    pan_b, _ = pixel_to_offset_deg(0, H / 2, W, H, HFOV, 90.0)
    assert pan_a == pytest.approx(pan_b)
