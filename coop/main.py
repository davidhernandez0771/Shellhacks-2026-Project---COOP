"""COOP main loop: capture -> detect/track -> predict -> aim steppers -> stream.

Run with:  python -m coop.main [--source webcam] [--no-motors]
"""
import argparse
import logging
import math
import time

import cv2

from .camera import Camera
from .config import Config
from .detector import Detector
from .motors import Gimbal
from .predictor import KalmanPredictor
from .sim import VirtualGimbal
from .stream import SharedState, serve_in_background

log = logging.getLogger("coop")


def pixel_to_offset_deg(x, y, width, height, hfov, vfov):
    """Angle of pixel (x, y) from the optical axis (pinhole model). +pan right, +tilt up."""
    nx = (x - width / 2) / (width / 2)
    ny = (height / 2 - y) / (height / 2)
    pan = math.degrees(math.atan(nx * math.tan(math.radians(hfov / 2))))
    tilt = math.degrees(math.atan(ny * math.tan(math.radians(vfov / 2))))
    return pan, tilt


def choose_target(detections, current_id, priority):
    """Stick with the current track if it's still visible, else pick by class priority then size."""
    if current_id is not None:
        for d in detections:
            if d.track_id == current_id:
                return d

    def rank(d):
        cls_rank = priority.index(d.label) if d.label in priority else len(priority)
        return (cls_rank, -d.area)

    candidates = [d for d in detections if d.track_id is not None]
    return min(candidates, key=rank) if candidates else None


def annotate(frame, detections, target, aim_px):
    for d in detections:
        x1, y1, x2, y2 = d.box
        color = (0, 0, 255) if d is target else (0, 200, 0)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, f"{d.label} #{d.track_id} {d.conf:.2f}", (x1, y1 - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    if aim_px is not None:
        cv2.drawMarker(frame, aim_px, (255, 200, 0), cv2.MARKER_CROSS, 20, 2)
    h, w = frame.shape[:2]
    cv2.drawMarker(frame, (w // 2, h // 2), (255, 255, 255), cv2.MARKER_TILTED_CROSS, 12, 1)
    return frame


def main():
    parser = argparse.ArgumentParser(description="COOP tracking camera")
    parser.add_argument("--source", choices=["auto", "picamera", "webcam"])
    parser.add_argument("--no-motors", action="store_true", help="run steppers in mock mode")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    cfg = Config()
    if args.source:
        cfg.camera.source = args.source
    if args.no_motors:
        cfg.motors.enabled = False
    if args.port:
        cfg.stream.port = args.port

    camera = Camera(cfg.camera)
    detector = Detector(cfg.detector)
    gimbal = Gimbal(cfg.motors)
    virtual_gimbal = VirtualGimbal(cfg.camera, cfg.sim)
    predictor = KalmanPredictor()
    state = SharedState()
    serve_in_background(state, cfg.stream)
    log.info("Dashboard at http://<pi-address>:%d", cfg.stream.port)

    cam, trk = cfg.camera, cfg.tracking
    target_id, last_seen = None, 0.0
    fps, last_frame_t = 0.0, time.monotonic()

    try:
        while True:
            frame = camera.read()
            if frame is None:
                time.sleep(0.01)
                continue
            now = time.monotonic()
            pan, tilt = gimbal.angles
            if gimbal.mock and cfg.sim.enabled:
                frame = virtual_gimbal.crop(frame, pan, tilt)
            h, w = frame.shape[:2]

            detections = detector.detect(frame)
            target = choose_target(detections, target_id, trk.priority)
            aim_px = None

            if target is not None:
                target_id, last_seen = target.track_id, now
                off_pan, off_tilt = pixel_to_offset_deg(*target.center, w, h, cam.hfov_deg, cam.vfov_deg)
                predictor.update((pan + off_pan, tilt + off_tilt), now)
                aim_pan, aim_tilt = predictor.predict(trk.lead_time_s)
                gimbal.aim(aim_pan, aim_tilt, trk.deadband_deg)

                # Show where the predictor is aiming, projected back into the current frame.
                ax = w / 2 + (w / 2) * math.tan(math.radians(aim_pan - pan)) / math.tan(math.radians(cam.hfov_deg / 2))
                ay = h / 2 - (h / 2) * math.tan(math.radians(aim_tilt - tilt)) / math.tan(math.radians(cam.vfov_deg / 2))
                aim_px = (int(ax), int(ay))
            elif target_id is not None and now - last_seen > trk.lost_timeout_s:
                log.info("Lost target #%s", target_id)
                target_id = None
                predictor.reset()

            dt = now - last_frame_t
            last_frame_t = now
            fps = 0.9 * fps + 0.1 * (1.0 / dt if dt > 0 else 0.0)

            annotate(frame, detections, target, aim_px)
            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, cfg.stream.jpeg_quality])
            if ok:
                state.publish(jpeg.tobytes(), {
                    "fps": round(fps, 1),
                    "detections": [{"id": d.track_id, "label": d.label, "conf": round(d.conf, 2)} for d in detections],
                    "target": None if target is None else {"id": target.track_id, "label": target.label},
                    "gimbal": {"pan": round(pan, 1), "tilt": round(tilt, 1), "mock": gimbal.mock},
                    "velocity_deg_s": [round(v, 1) for v in predictor.velocity],
                })
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        gimbal.close()
        camera.close()


if __name__ == "__main__":
    main()
