"""FrameGrabber (coop/camera.py): capture on its own thread, always hand over the newest frame."""
import threading
import time

import pytest

from coop.camera import FrameGrabber


class CountingCamera:
    """Frame i is the int i. `period` seconds per frame; optional failure at a given read."""

    def __init__(self, period=0.0, fail_at=None, exc=RuntimeError("camera unplugged"), nones=()):
        self.period = period
        self.fail_at = fail_at
        self.exc = exc
        self.nones = set(nones)
        self.reads = 0
        self.closed_reads = 0
        self.gate = threading.Event()
        self.gate.set()

    def read(self):
        self.gate.wait()
        self.reads += 1
        if self.fail_at is not None and self.reads >= self.fail_at:
            raise self.exc
        if self.period:
            time.sleep(self.period)
        return None if self.reads in self.nones else self.reads


@pytest.fixture
def grabbers():
    made = []
    yield made
    for g in made:
        g.close()


def test_hands_over_frames_with_their_capture_time(grabbers):
    g = FrameGrabber(CountingCamera(period=0.01))
    grabbers.append(g)
    before = time.monotonic()
    frame, t = g.read()
    assert frame >= 1
    assert before - 0.1 <= t <= time.monotonic()


def test_never_returns_the_same_frame_twice(grabbers):
    g = FrameGrabber(CountingCamera(period=0.02))
    grabbers.append(g)
    seen = [g.read()[0] for _ in range(5)]
    assert seen == sorted(set(seen))


def test_slow_consumer_gets_the_newest_frame_and_stale_ones_are_dropped(grabbers):
    cam = CountingCamera(period=0.005)
    g = FrameGrabber(cam)
    grabbers.append(g)
    g.read()
    time.sleep(0.2)  # "inference" takes a while; ~40 frames arrive meanwhile
    frame, _ = g.read()
    assert frame >= cam.reads - 1  # the newest (or the one just being captured)
    assert g.dropped > 10


def test_read_times_out_with_none_when_no_frame_arrives(grabbers):
    cam = CountingCamera()
    cam.gate.clear()  # camera blocks forever
    g = FrameGrabber(cam)
    grabbers.append(g)
    t0 = time.monotonic()
    assert g.read(timeout=0.15) == (None, None)
    assert 0.1 <= time.monotonic() - t0 < 1.0
    cam.gate.set()


def test_failed_reads_returning_none_are_skipped(grabbers):
    g = FrameGrabber(CountingCamera(period=0.01, nones={1, 2, 3}))
    grabbers.append(g)
    frame, _ = g.read()
    assert frame >= 4


def test_camera_error_reaches_the_consumer_after_the_pending_frame(grabbers):
    g = FrameGrabber(CountingCamera(fail_at=2))
    grabbers.append(g)
    frame, _ = g.read()
    assert frame == 1  # the good frame is not lost
    with pytest.raises(RuntimeError, match="camera unplugged"):
        g.read()


def test_keyboard_interrupt_from_the_camera_propagates(grabbers):
    g = FrameGrabber(CountingCamera(fail_at=2, exc=KeyboardInterrupt()))
    grabbers.append(g)
    g.read()
    with pytest.raises(KeyboardInterrupt):
        g.read()


def test_capture_stops_after_an_error(grabbers):
    cam = CountingCamera(fail_at=3)
    g = FrameGrabber(cam)
    grabbers.append(g)
    time.sleep(0.1)
    assert cam.reads == 3


def test_close_stops_capturing(grabbers):
    cam = CountingCamera(period=0.005)
    g = FrameGrabber(cam)
    g.read()
    g.close()
    reads = cam.reads
    time.sleep(0.05)
    assert cam.reads <= reads + 1


def test_capture_fps_is_measured(grabbers):
    g = FrameGrabber(CountingCamera(period=0.01))
    grabbers.append(g)
    time.sleep(0.4)
    assert 50 <= g.capture_fps <= 110
