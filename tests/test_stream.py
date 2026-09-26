"""Flask MJPEG stream + control API (coop/stream.py), via the Flask test client.

/video's body is an unbounded MJPEG generator that only ends when the client disconnects,
so tests only assert on the response's status/mimetype and never read the streamed body
(resp.data / resp.get_data() would block forever waiting for a frame that never comes).
"""
from coop.config import MotorConfig
from coop.control import Control
from coop.stream import SharedState, create_app


def make_client(motors_cfg=None):
    state = SharedState()
    control = Control(motors_cfg or MotorConfig())
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


def test_status_endpoint_merges_state_with_server_time_and_live_mode():
    state, control, client = make_client()
    state.publish(b"x", {"fps": 9.0, "target": None})
    control.set_mode("manual")

    resp = client.get("/api/status")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["fps"] == 9.0
    assert body["target"] is None
    assert body["mode"] == "manual"
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


def test_set_mode_endpoint_updates_control():
    _, control, client = make_client()
    resp = client.post("/api/mode", json={"mode": "stop"})
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}
    assert control.mode == "stop"


def test_set_mode_endpoint_rejects_unknown_mode():
    _, control, client = make_client()
    resp = client.post("/api/mode", json={"mode": "orbit"})
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["ok"] is False
    assert control.mode == "auto"


def test_set_target_endpoint_requires_id_field():
    _, _, client = make_client()
    resp = client.post("/api/target", json={})
    assert resp.status_code == 400


def test_set_target_endpoint_locks_target_and_switches_to_auto():
    _, control, client = make_client()
    resp = client.post("/api/target", json={"id": 7})
    assert resp.status_code == 200
    assert control.locked_id == 7
    assert control.mode == "auto"


def test_aim_endpoint_rejects_outside_manual_mode():
    _, control, client = make_client()
    assert control.mode == "auto"
    resp = client.post("/api/aim", json={"pan": 10.0, "tilt": 0.0})
    assert resp.status_code == 400


def test_aim_endpoint_clamps_within_configured_limits():
    _, control, client = make_client(MotorConfig(pan_limits_deg=(-20.0, 20.0)))
    control.set_mode("manual")
    resp = client.post("/api/aim", json={"pan": 999.0, "tilt": 0.0})
    assert resp.status_code == 200
    assert control.manual_pan == 20.0


def test_aim_endpoint_rejects_non_numeric_body():
    _, control, client = make_client()
    control.set_mode("manual")
    resp = client.post("/api/aim", json={"pan": "far", "tilt": 0.0})
    assert resp.status_code == 400


def test_nudge_endpoint_accumulates_aim():
    _, control, client = make_client()
    control.set_mode("manual")
    control.set_aim(5.0)
    resp = client.post("/api/nudge", json={"dpan": 2.0, "dtilt": 0.0})
    assert resp.status_code == 200
    assert control.manual_pan == 7.0


def test_aim_and_nudge_accept_a_body_without_tilt():
    _, control, client = make_client()
    control.set_mode("manual")
    assert client.post("/api/aim", json={"pan": 12.0}).status_code == 200
    assert control.manual_pan == 12.0
    assert client.post("/api/nudge", json={"dpan": -2.0}).status_code == 200
    assert control.manual_pan == 10.0


def test_aim_rejects_a_non_numeric_tilt_even_though_it_is_ignored():
    """Lenient about a missing tilt, but a malformed one is still a client bug worth a 400."""
    _, control, client = make_client()
    control.set_mode("manual")
    assert client.post("/api/aim", json={"pan": 1.0, "tilt": "up"}).status_code == 400


def test_home_endpoint_switches_to_manual_and_zeroes_aim():
    _, control, client = make_client()
    resp = client.post("/api/home", json={})
    assert resp.status_code == 200
    assert control.mode == "manual"
    assert control.manual_pan == 0.0


def test_events_endpoint_filters_by_since():
    _, control, client = make_client()
    control.set_mode("manual")
    control.set_mode("stop")

    all_events = client.get("/api/events").get_json()["events"]
    assert len(all_events) == 2

    last_seq = all_events[-1]["seq"]
    resp = client.get(f"/api/events?since={last_seq}")
    assert resp.get_json()["events"] == []


def test_aim_rejects_nan_and_infinity():
    """Python's JSON parser accepts NaN/Infinity; a NaN aim would crash the vision loop."""
    _, control, client = make_client()
    control.set_mode("manual")
    for raw in ('{"pan": NaN}', '{"pan": Infinity}', '{"dpan": -Infinity}'):
        route = "/api/nudge" if "dpan" in raw else "/api/aim"
        resp = client.post(route, data=raw, content_type="application/json")
        assert resp.status_code == 400, raw
    assert control.manual_pan == 0.0


# ---- e-stop, arm, zero ----

def test_estop_endpoint_engages_and_status_reports_it():
    state, control, client = make_client()
    state.publish(b"x", {"fps": 1.0})
    assert client.get("/api/status").get_json()["estop"] is False
    resp = client.post("/api/estop", json={})
    assert resp.status_code == 200 and resp.get_json() == {"ok": True}
    assert control.estopped and control.mode == "stop"
    assert client.get("/api/status").get_json()["estop"] is True


def test_estop_endpoint_needs_no_body():
    _, control, client = make_client()
    assert client.post("/api/estop").status_code == 200
    assert control.estopped


def test_moving_requests_fail_with_the_documented_error_while_estopped():
    _, control, client = make_client()
    client.post("/api/estop")
    for route, body in [("/api/mode", {"mode": "auto"}), ("/api/mode", {"mode": "manual"}),
                        ("/api/target", {"id": 3}), ("/api/home", {})]:
        resp = client.post(route, json=body)
        assert resp.status_code == 400, route
        assert resp.get_json() == {"ok": False, "error": "e-stop engaged; POST /api/arm first"}
    assert client.post("/api/mode", json={"mode": "stop"}).status_code == 200
    assert client.post("/api/target", json={"id": None}).status_code == 200


def test_arm_endpoint_releases_and_mode_stays_stop():
    _, control, client = make_client()
    client.post("/api/estop")
    resp = client.post("/api/arm", json={})
    assert resp.status_code == 200
    assert not control.estopped and control.mode == "stop"
    assert client.post("/api/mode", json={"mode": "auto"}).status_code == 200


def test_arm_endpoint_is_ok_when_not_engaged():
    _, control, client = make_client()
    assert client.post("/api/arm").status_code == 200
    assert not control.estopped


def test_zero_endpoint():
    _, control, client = make_client()
    control.set_target(5)
    resp = client.post("/api/zero", json={})
    assert resp.status_code == 200
    assert control.mode == "manual" and control.manual_pan == 0.0 and control.locked_id is None


def test_status_before_the_first_frame_has_mode_and_estop():
    _, _, client = make_client()
    body = client.get("/api/status").get_json()
    assert set(body) >= {"server_time", "mode", "estop"}
