"""Live MJPEG stream + status/control API, served to any browser on the network.

Route handlers only touch the Control object (never the Gimbal directly) — see
docs/API.md for the wire contract and docs/TERMINALS.md's Requests section for how
coop/main.py's loop turns Control's state into motor motion each frame.
"""
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request

from .control import ControlError

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class SharedState:
    """Latest annotated frame and telemetry, handed from the main loop to web clients."""

    def __init__(self):
        self._cond = threading.Condition()
        self._jpeg = None
        self._seq = 0
        self.status = {}

    def publish(self, jpeg, status):
        with self._cond:
            self._jpeg = jpeg
            self._seq += 1
            self.status = {**status, "frame_seq": self._seq}
            self._cond.notify_all()

    def frames(self):
        seq = 0  # _seq is 0 until the first publish, so this waits for a real frame
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._seq != seq, timeout=1.0)
                if self._seq == seq:
                    continue
                seq, jpeg = self._seq, self._jpeg
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"


def _ok(**fields):
    return jsonify({"ok": True, **fields})


def _error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


def create_app(state, control):
    app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")

    @app.route("/")
    def index():
        return app.send_static_file("index.html")

    @app.route("/video")
    def video():
        return Response(state.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.route("/api/status")
    def status():
        payload = dict(state.status)
        payload["server_time"] = time.time()
        payload["mode"] = control.mode  # authoritative even if the main loop hasn't published yet
        return jsonify(payload)

    @app.route("/api/events")
    def events():
        since = request.args.get("since", default=0, type=int)
        return jsonify({"events": control.events_since(since)})

    @app.route("/api/mode", methods=["POST"])
    def set_mode():
        body = request.get_json(silent=True) or {}
        try:
            control.set_mode(body.get("mode"))
        except ControlError as e:
            return _error(str(e))
        return _ok()

    @app.route("/api/target", methods=["POST"])
    def set_target():
        body = request.get_json(silent=True) or {}
        if "id" not in body:
            return _error("missing 'id'")
        try:
            control.set_target(body["id"])
        except ControlError as e:
            return _error(str(e))
        return _ok()

    @app.route("/api/aim", methods=["POST"])
    def aim():
        body = request.get_json(silent=True) or {}
        try:
            pan, tilt = float(body["pan"]), float(body["tilt"])
        except (KeyError, TypeError, ValueError):
            return _error("pan and tilt must be numbers")
        try:
            control.set_aim(pan, tilt)
        except ControlError as e:
            return _error(str(e))
        return _ok()

    @app.route("/api/nudge", methods=["POST"])
    def nudge():
        body = request.get_json(silent=True) or {}
        try:
            dpan, dtilt = float(body["dpan"]), float(body["dtilt"])
        except (KeyError, TypeError, ValueError):
            return _error("dpan and dtilt must be numbers")
        try:
            control.nudge(dpan, dtilt)
        except ControlError as e:
            return _error(str(e))
        return _ok()

    @app.route("/api/home", methods=["POST"])
    def home():
        control.home()
        return _ok()

    return app


def serve_in_background(state, control, cfg):
    app = create_app(state, control)
    thread = threading.Thread(
        target=lambda: app.run(host=cfg.host, port=cfg.port, threaded=True, use_reloader=False),
        name="web",
        daemon=True,
    )
    thread.start()
    return thread
