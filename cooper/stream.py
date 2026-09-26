"""Live MJPEG stream + status API, served to any browser on the network.

The vision loop publishes each frame and its status through SharedState. /api/settings and
/api/lane go through cooper.settings.LiveSettings, and /api/events through
cooper.control.Control. See docs/API.md for the wire contract.
"""
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request

from .diag import DIAG_KEYS
from .settings import SettingsError

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


def create_app(state, control, diag=None, settings=None):
    """`diag`: optional callable returning live health readings (cooper.diag.SystemMonitor.snapshot).
    `settings`: optional cooper.settings.LiveSettings behind /api/settings (404 without one)."""
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
        merged = dict.fromkeys(DIAG_KEYS)
        merged.update(payload.get("diag") or {})  # the vision loop's per-frame timings
        if diag is not None:
            merged.update(diag())
        payload["diag"] = merged
        return jsonify(payload)

    @app.route("/api/events")
    def events():
        since = request.args.get("since", default=0, type=int)
        return jsonify({"events": control.events_since(since)})

    @app.route("/api/settings", methods=["GET"])
    def get_settings():
        if settings is None:
            return _error("live settings not available", 404)
        return jsonify(settings.snapshot())

    @app.route("/api/settings", methods=["POST"])
    def post_settings():
        if settings is None:
            return _error("live settings not available", 404)
        body = request.get_json(silent=True)
        try:
            result = settings.update(body)
        except SettingsError as e:
            return _error(str(e))
        return _ok(**result)

    @app.route("/api/lane", methods=["POST"])
    def post_lane():
        if settings is None:
            return _error("live settings not available", 404)
        try:
            result = settings.update_lane(request.get_json(silent=True))
        except SettingsError as e:
            return _error(str(e))
        return _ok(**result)

    return app


def serve_in_background(state, control, cfg, diag=None, settings=None):
    app = create_app(state, control, diag=diag, settings=settings)
    thread = threading.Thread(
        target=lambda: app.run(host=cfg.host, port=cfg.port, threaded=True, use_reloader=False),
        name="web",
        daemon=True,
    )
    thread.start()
    return thread
