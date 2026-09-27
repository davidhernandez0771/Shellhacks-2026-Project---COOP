"""Flask MJPEG stream + status API (cooper/stream.py), via the Flask test client.

/video's body is an unbounded MJPEG generator that only ends when the client disconnects,
so tests only assert on the response's status/mimetype and never read the streamed body
(resp.data / resp.get_data() would block forever waiting for a frame that never comes).
"""
from cooper.control import Control
from cooper.stream import SharedState, create_app


def make_client():
    state = SharedState()
    control = Control()
    return state, control, create_app(state, control).test_client()


def test_shared_state_starts_with_empty_status():
    assert SharedState().status == {}


def test_publish_updates_status_and_frame_sequence():
    state = SharedState()
    state.publish(b"jpeg-bytes", {"fps": 12.3})
    assert state.status == {"fps": 12.3, "frame_seq": 1}
    assert state._seq == 1

    state.publish(b"jpeg-bytes", {"fps": 12.3})
    assert state.status["frame_seq"] == 2


def test_frames_generator_yields_an_mjpeg_chunk_with_the_published_frame():
    state = SharedState()
    state.publish(b"jpeg-bytes-1", {"fps": 12.3})
    chunk = next(state.frames())
    assert chunk.startswith(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n")
    assert b"jpeg-bytes-1" in chunk


def test_status_endpoint_merges_state_with_server_time():
    state, _, client = make_client()
    state.publish(b"x", {"fps": 9.0, "detections": []})

    resp = client.get("/api/status")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["fps"] == 9.0
    assert body["detections"] == []
    assert body["frame_seq"] == 1
    assert "server_time" in body


def test_index_serves_the_dashboard_html():
    _, _, client = make_client()
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.mimetype == "text/html"


def test_video_route_is_an_mjpeg_stream():
    state, _, client = make_client()
    state.publish(b"fakejpeg", {})  # a frame must exist or the view raises on a None jpeg
    resp = client.get("/video")
    assert resp.status_code == 200
    assert resp.mimetype == "multipart/x-mixed-replace"


def test_events_endpoint_filters_by_since():
    _, control, client = make_client()
    control.log_event("settings_changed", changed={}, saved=False)
    control.log_event("settings_changed", changed={}, saved=True)

    all_events = client.get("/api/events").get_json()["events"]
    assert len(all_events) == 2

    last_seq = all_events[-1]["seq"]
    resp = client.get(f"/api/events?since={last_seq}")
    assert resp.get_json()["events"] == []


def test_status_before_the_first_frame_is_just_server_time_and_diag():
    _, _, client = make_client()
    body = client.get("/api/status").get_json()
    assert set(body) == {"server_time", "diag"}
