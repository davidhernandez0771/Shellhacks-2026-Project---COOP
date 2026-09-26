"""Target selection: stick with the current track, else pick by class priority then size."""
from cooper.detector import Detection
from cooper.main import choose_target

PRIORITY = ("person", "car", "truck", "bus", "motorcycle")


def make_detection(track_id, label, box=(0, 0, 10, 10), conf=0.9):
    return Detection(track_id=track_id, label=label, conf=conf, box=box)


def test_no_detections_returns_none():
    assert choose_target([], current_id=None, priority=PRIORITY) is None


def test_sticks_with_current_target_even_if_lower_priority_or_smaller():
    current = make_detection(5, "car", box=(0, 0, 5, 5))
    other = make_detection(6, "person", box=(0, 0, 100, 100))
    result = choose_target([current, other], current_id=5, priority=PRIORITY)
    assert result is current


def test_falls_back_to_priority_when_current_target_gone():
    person = make_detection(1, "person", box=(0, 0, 5, 5))
    car = make_detection(2, "car", box=(0, 0, 100, 100))
    result = choose_target([person, car], current_id=99, priority=PRIORITY)
    assert result is person  # priority beats size


def test_picks_largest_within_same_class_when_no_current_target():
    small = make_detection(1, "car", box=(0, 0, 5, 5))
    large = make_detection(2, "car", box=(0, 0, 50, 50))
    result = choose_target([small, large], current_id=None, priority=PRIORITY)
    assert result is large


def test_ignores_detections_without_a_track_id():
    untracked = make_detection(None, "person", box=(0, 0, 100, 100))
    result = choose_target([untracked], current_id=None, priority=PRIORITY)
    assert result is None


def test_unknown_label_ranks_after_all_known_priorities():
    known = make_detection(1, "motorcycle", box=(0, 0, 5, 5))
    unknown = make_detection(2, "bicycle", box=(0, 0, 500, 500))
    result = choose_target([known, unknown], current_id=None, priority=PRIORITY)
    assert result is known
