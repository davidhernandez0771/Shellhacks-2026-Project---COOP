"""Live MJPEG stream + status API, served to any browser on the network."""
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify

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
            self.status = status
            self._cond.notify_all()

    def frames(self):
        seq = -1
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._seq != seq, timeout=1.0)
                if self._seq == seq:
                    continue
                seq, jpeg = self._seq, self._jpeg
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"


def create_app(state):
    app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")

    @app.route("/")
    def index():
        return app.send_static_file("index.html")

    @app.route("/video")
    def video():
        return Response(state.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.route("/api/status")
    def status():
        return jsonify(state.status | {"server_time": time.time()})

    return app


def serve_in_background(state, cfg):
    app = create_app(state)
    thread = threading.Thread(
        target=lambda: app.run(host=cfg.host, port=cfg.port, threaded=True, use_reloader=False),
        name="web",
        daemon=True,
    )
    thread.start()
    return thread
