"""tools/rehearsal.py: the synthetic road scene, its colour-blob detector, and the whole app on it."""
import sys

import flask
import pytest

import cooper.main
import cooper.stream
from tools import rehearsal
from tools.rehearsal import RoadScene, SceneDetector


@pytest.fixture
def scene():
    return RoadScene(width=640, height=480, hfov_deg=63.0)


def test_ground_points_move_down_and_outward_as_they_get_closer(scene):
    u_far, v_far = scene.project(0.0, 30.0)
    u_near, v_near = scene.project(0.0, 5.0)
    assert u_far == pytest.approx(320) and u_near == pytest.approx(320)
    assert scene.height / 2 < v_far < v_near < scene.height  # below the horizon, nearer = lower
    u_right, _ = scene.project(1.0, 5.0)
    u_right_far, _ = scene.project(1.0, 20.0)
    assert u_right > u_right_far > 320  # +X is right, and perspective pulls it to the centre


def test_box_height_scales_as_one_over_distance(scene):
    """What makes time-to-contact from scale honest: h is proportional to 1/Z."""
    h10 = scene.box(0.0, 10.0, 1.8, 1.5)
    h20 = scene.box(0.0, 20.0, 1.8, 1.5)
    height = lambda b: b[3] - b[1]
    assert height(h10) / height(h20) == pytest.approx(2.0, rel=0.02)
    assert h10[3] == pytest.approx(scene.project(0.0, 10.0)[1], abs=1)  # box sits on the ground


def test_the_script_shows_each_actor(scene):
    labels_at = lambda t: sorted(label for label, _ in scene.boxes(t).values())
    assert "car" in labels_at(2.0)                      # lead car far ahead, car in the next lane
    assert labels_at(12.5).count("person") == 1         # the pedestrian crossing
    cut_in = [b for slot, (lbl, b) in scene.boxes(6.0).items() if slot == RoadScene.CUT_IN]
    assert cut_in, "the cut-in car is visible while it changes lanes"


def test_the_scene_loops(scene):
    assert scene.boxes(3.0) == scene.boxes(3.0 + scene.period_s)


@pytest.mark.parametrize("t", [2.0, 5.0, 12.0, 17.0])  # times when no actor hides another
def test_detector_recovers_the_rendered_boxes(scene, t):
    truth = scene.boxes(t)
    found = SceneDetector().detect(scene.render(t))
    assert len(found) == len(truth)
    for d in found:
        label, box = truth[d.track_id // 100]
        assert d.label == label
        assert all(abs(a - b) <= 2 for a, b in zip(d.box, box)), (d.box, box)


def test_detector_gives_a_new_id_when_an_actor_reappears(scene):
    det = SceneDetector()
    first = {d.track_id for d in det.detect(scene.render(12.0))}
    det.detect(scene.render(0.5))                     # the pedestrian isn't in the scene yet
    again = {d.track_id for d in det.detect(scene.render(12.0))}
    person = lambda ids: next(i for i in ids if i // 100 == RoadScene.PEDESTRIAN)
    assert person(again) != person(first)             # like ByteTrack: a new track, a new ID


def test_the_whole_app_runs_on_the_scene(monkeypatch):
    apps = []
    real_create_app = cooper.stream.create_app
    monkeypatch.setattr(cooper.stream, "create_app",
                        lambda *a, **k: apps.append(real_create_app(*a, **k)) or apps[-1])
    monkeypatch.setattr(flask.Flask, "run", lambda self, *a, **k: None)
    monkeypatch.setattr(sys, "argv", ["pytest"])  # rehearsal.main sets it itself
    # rehearsal.main swaps cooper.main's Camera and Detector; restore them after this test.
    monkeypatch.setattr(cooper.main, "Camera", cooper.main.Camera)
    monkeypatch.setattr(cooper.main, "Detector", cooper.main.Detector)

    rehearsal.main(["--start-s", "12.0", "--frames", "10", "--port", "8123"])

    status = apps[0].test_client().get("/api/status").get_json()
    assert status["frame_seq"] >= 1
    assert "person" in {d["label"] for d in status["detections"]}
