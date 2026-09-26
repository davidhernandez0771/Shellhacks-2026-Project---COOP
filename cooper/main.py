"""COOPER main loop: capture -> detect/track -> predict every object -> judge risk -> LEDs -> stream.

Run with:  python -m cooper.main [--source webcam] [--no-leds]
"""
import argparse
import logging
import time

import cv2

from .camera import Camera, FrameGrabber
from . import settings
from .control import Control
from .detector import Detector
from .diag import RateMeter, SystemMonitor
from .leds import Leds
from .predictor import Tracks
from .risk import RiskJudge
from .settings import LiveSettings, SettingsError, load_config
from .stream import SharedState, serve_in_background

log = logging.getLogger("cooper")


def _smooth(avg, sample, alpha=0.2):
    """Exponential moving average; the first sample starts it."""
    return sample if avg is None else (1 - alpha) * avg + alpha * sample


def _object_json(o):
    return {
        "id": o.id, "label": o.label, "conf": round(o.conf, 2), "box": list(o.box),
        "level": o.level, "kind": o.kind, "reason": o.reason,
        "path": [[round(u, 1), round(v, 1)] for u, v in o.path],
        "velocity": [round(c, 1) for c in o.velocity],
        "ttc_s": None if o.ttc is None else round(o.ttc, 2),
        "time_to_lane_s": o.time_to_lane,
    }


def annotate(frame, detections):
    for d in detections:
        x1, y1, x2, y2 = d.box
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 200, 0), 2)
        cv2.putText(frame, f"{d.label} #{d.track_id} {d.conf:.2f}", (x1, y1 - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 0), 1)
    return frame


def main():
    parser = argparse.ArgumentParser(description="COOPER dashcam")
    parser.add_argument("--source", choices=["auto", "picamera", "webcam"])
    parser.add_argument("--port", type=int)
    parser.add_argument("--annotate", action="store_true", help="draw boxes into the /video stream")
    parser.add_argument("--no-leds", action="store_true", help="mock the LEDs even on a Pi")
    parser.add_argument("--config", help="settings file (default: cooper.toml in the repo root, if present)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    try:
        cfg = load_config(args.config, required=args.config is not None)
    except SettingsError as e:
        parser.error(str(e))
    log.info("Settings: %s", args.config or (settings.DEFAULT_PATH if settings.DEFAULT_PATH.exists()
                                            else "built-in defaults (no cooper.toml)"))
    if args.source:
        cfg.camera.source = args.source
    if args.port:
        cfg.stream.port = args.port
    if args.annotate:
        cfg.stream.annotate = True
    if args.no_leds:
        cfg.leds.enabled = False

    camera = Camera(cfg.camera)
    detector = Detector(cfg.detector)
    control = Control()
    leds = Leds(cfg.leds)
    tracks = Tracks(cfg.prediction)
    judge = RiskJudge(cfg.risk)
    state = SharedState()
    monitor = SystemMonitor(leds_mode=lambda: leds.mode)
    live_settings = LiveSettings(cfg, path=args.config or settings.DEFAULT_PATH, control=control)
    serve_in_background(state, control, cfg.stream, diag=monitor.snapshot, settings=live_settings)
    log.info("Dashboard at http://localhost:%d", cfg.stream.port)

    rate = RateMeter()
    infer_ms = latency_ms = None  # smoothed, for diag
    level = "clear"

    grabber = FrameGrabber(camera)  # started last: nothing between here and `try` can fail
    try:
        while True:
            frame, now = grabber.read()  # newest frame and its capture time; stale ones dropped
            if frame is None:
                continue
            h, w = frame.shape[:2]

            t_infer = time.monotonic()
            detections = detector.detect(frame)
            infer_ms = _smooth(infer_ms, (time.monotonic() - t_infer) * 1000.0)

            # Each object's filter is updated at the moment its frame was captured.
            assessment = judge.update(tracks.update(detections, now), w, h, now)
            leds.set(assessment.level)
            if assessment.level != level:
                level = assessment.level
                log.info("Risk: %s%s", level, f" ({assessment.reason})" if assessment.reason else "")
                control.log_event("risk_changed", level=level, reason=assessment.reason)

            fps = rate.update(now)  # from capture times, so it's the processed-frame rate

            if cfg.stream.annotate:
                frame = annotate(frame, detections)

            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, cfg.stream.jpeg_quality])
            if ok:
                # Capture -> detect -> predict -> risk -> LEDs -> encode, for this frame.
                latency_ms = _smooth(latency_ms, (time.monotonic() - now) * 1000.0)
                lane = cfg.risk.lane
                state.publish(jpeg.tobytes(), {
                    "fps": round(fps, 1),
                    "frame": {"w": w, "h": h},
                    "objects": [_object_json(o) for o in assessment.objects],
                    "risk": {"level": assessment.level, "reason": assessment.reason},
                    "leds": {**leds.state, "mode": leds.mode},
                    "lane": [[lane[i], lane[i + 1]] for i in range(0, 8, 2)],
                    "diag": {
                        "fps": round(fps, 1),
                        "capture_fps": round(grabber.capture_fps, 1),
                        "infer_ms": round(infer_ms, 1),
                        "latency_ms": round(latency_ms, 1),
                    },
                })
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        leds.close()
        grabber.close()
        camera.close()


if __name__ == "__main__":
    main()
