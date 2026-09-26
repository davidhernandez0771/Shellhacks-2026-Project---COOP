"""COOP main loop: capture -> detect/track -> predict -> aim the pan stepper -> stream.

Run with:  python -m coop.main [--source webcam] [--no-motors]
"""
import argparse
import logging
import math
import time

import cv2

from .camera import Camera, FrameGrabber
from . import settings
from .control import Control
from .detector import Detector
from .diag import SystemMonitor
from .motors import Gimbal
from .predictor import KalmanPredictor
from .settings import SettingsError, load_config
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


def reassociate(detections, label, predicted, gimbal_angles, frame_size, fov, max_deg):
    """Closest same-label tracked detection to `predicted` (world pan, tilt), within max_deg."""
    best, best_dist = None, max_deg
    for d in detections:
        if d.track_id is None or d.label != label:
            continue
        off_pan, off_tilt = pixel_to_offset_deg(*d.center, *frame_size, *fov)
        dist = math.hypot(gimbal_angles[0] + off_pan - predicted[0], gimbal_angles[1] + off_tilt - predicted[1])
        if dist < best_dist:
            best, best_dist = d, dist
    return best


def _find(detections, track_id):
    return next((d for d in detections if d.track_id == track_id), None) if track_id is not None else None


def _smooth(avg, sample, alpha=0.2):
    """Exponential moving average; the first sample starts it."""
    return sample if avg is None else (1 - alpha) * avg + alpha * sample


def _clamp(value, limits):
    lo, hi = limits
    return min(max(value, lo), hi)


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
    parser.add_argument("--annotate", action="store_true", help="draw boxes into the /video stream")
    parser.add_argument("--config", help="settings file (default: coop.toml in the repo root, if present)")
    parser.add_argument("--motor-port", help='Uno serial port or URL, e.g. /dev/ttyACM0, COM5, '
                                             'socket://localhost:5555 (tools/fake_uno.py)')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    try:
        cfg = load_config(args.config, required=args.config is not None)
    except SettingsError as e:
        parser.error(str(e))
    log.info("Settings: %s", args.config or (settings.DEFAULT_PATH if settings.DEFAULT_PATH.exists()
                                            else "built-in defaults (no coop.toml)"))
    if args.motor_port:
        cfg.motors.port = args.motor_port
    if args.source:
        cfg.camera.source = args.source
    if args.no_motors:
        cfg.motors.enabled = False
    if args.port:
        cfg.stream.port = args.port
    if args.annotate:
        cfg.stream.annotate = True

    camera = Camera(cfg.camera)
    grabber = FrameGrabber(camera)
    detector = Detector(cfg.detector)
    control = Control(cfg.motors)
    gimbal = Gimbal(cfg.motors, on_event=control.log_event)
    control.bind_gimbal(gimbal)
    virtual_gimbal = VirtualGimbal(cfg.camera, cfg.sim)
    predictor = KalmanPredictor()
    state = SharedState()
    monitor = SystemMonitor(link_state=lambda: gimbal.link_state)
    serve_in_background(state, control, cfg.stream, diag=monitor.snapshot)
    log.info("Dashboard at http://localhost:%d", cfg.stream.port)

    cam, trk, mot = cfg.camera, cfg.tracking, cfg.motors
    target_id, target_label, last_seen = None, None, 0.0
    prev_locked = None
    aim_pan = 0.0  # last commanded pan, reported as gimbal.target_pan
    fps, last_frame_t = 0.0, time.monotonic()
    infer_ms = latency_ms = None  # smoothed, for diag
    prev_epoch = gimbal.frame_epoch

    try:
        while True:
            frame, now = grabber.read()  # newest frame and its capture time; stale ones dropped
            if frame is None:
                continue
            epoch = gimbal.frame_epoch  # read before the angle: aims computed from it carry it
            pan = gimbal.pan
            tilt = 0.0  # pan-only: the camera's tilt is fixed, so world tilt = in-frame offset
            if epoch != prev_epoch:
                # "Zero here" or a pan_invert flip changed what every angle means, so the
                # predictor's world-angle history is meaningless now.
                predictor.reset()
                target_id, prev_epoch = None, epoch
            # Gate on config, not gimbal.mock: mock is also true while a real Uno is (re)connecting,
            # and cropping the real camera frame then would corrupt every angle.
            if not cfg.motors.enabled and cfg.sim.enabled:
                frame = virtual_gimbal.crop(frame, pan, tilt)
            h, w = frame.shape[:2]

            mode, locked = control.mode, control.locked_id
            if locked != prev_locked:
                last_seen = now  # a fresh lock gets the full lost_timeout_s grace period
                prev_locked = locked

            t_infer = time.monotonic()
            detections = detector.detect(frame)
            infer_ms = _smooth(infer_ms, (time.monotonic() - t_infer) * 1000.0)
            # An operator lock beats auto-selection: follow only that ID, coasting while it's occluded.
            target = _find(detections, locked if locked is not None else target_id)
            reassociated = False
            if (target is None and target_id is not None and predictor.active
                    and locked in (None, target_id)):
                target = reassociate(detections, target_label, predictor.predict(now - last_seen),
                                     (pan, tilt), (w, h), (cam.hfov_deg, cam.vfov_deg), trk.reassociate_deg)
                if target is not None:
                    reassociated = True
                    log.info("Target #%s re-identified as #%s", target_id, target.track_id)
                    if locked is not None:
                        control.set_target(target.track_id)
                        locked = prev_locked = target.track_id
            if target is None and locked is None:
                target = choose_target(detections, None, trk.priority)

            if target is not None:
                if target.track_id != target_id:
                    control.log_event("target_acquired", id=target.track_id, label=target.label)
                    if not reassociated:
                        predictor.reset()  # don't blend the old target's motion into the new one
                target_id, target_label, last_seen = target.track_id, target.label, now
                off_pan, off_tilt = pixel_to_offset_deg(*target.center, w, h, cam.hfov_deg, cam.vfov_deg)
                predictor.update((pan + off_pan, tilt + off_tilt), now)
            elif (target_id is not None or locked is not None) and now - last_seen > trk.lost_timeout_s:
                lost_id = locked if locked is not None else target_id
                log.info("Lost target #%s", lost_id)
                control.log_event("target_lost", id=lost_id)
                if locked is not None:
                    control.set_target(None)
                target_id = None
                predictor.reset()

            lead_aim = None  # the predictor's world (pan, tilt) aim point, auto mode only
            if mode == "manual":
                aim_pan = control.manual_pan
                gimbal.aim(aim_pan, epoch=epoch)
            elif mode == "stop":
                gimbal.stop()
                aim_pan = pan
            elif target is not None:
                lead_aim = predictor.predict(trk.lead_time_s)
                aim_pan = lead_aim[0]
                gimbal.aim(aim_pan, trk.deadband_deg, epoch=epoch)
            aim_pan = _clamp(aim_pan, mot.pan_limits_deg)

            dt = now - last_frame_t  # between capture times, so it's the processed-frame rate
            last_frame_t = now
            fps = 0.9 * fps + 0.1 * (1.0 / dt if dt > 0 else 0.0)

            if cfg.stream.annotate:
                aim_px = None
                if lead_aim is not None:
                    # Where the predictor is aiming, projected back into the current frame.
                    ax = w / 2 + (w / 2) * math.tan(math.radians(aim_pan - pan)) / math.tan(math.radians(cam.hfov_deg / 2))
                    ay = h / 2 - (h / 2) * math.tan(math.radians(lead_aim[1] - tilt)) / math.tan(math.radians(cam.vfov_deg / 2))
                    aim_px = (int(ax), int(ay))
                annotate(frame, detections, target, aim_px)

            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, cfg.stream.jpeg_quality])
            if ok:
                # Capture -> detect -> predict -> motor command -> encode, for this frame.
                latency_ms = _smooth(latency_ms, (time.monotonic() - now) * 1000.0)
                state.publish(jpeg.tobytes(), {
                    "fps": round(fps, 1),
                    "mode": mode,
                    "frame": {"w": w, "h": h, "hfov_deg": cam.hfov_deg, "vfov_deg": cam.vfov_deg},
                    "target": None if target is None else {
                        "id": target.track_id, "label": target.label, "conf": round(target.conf, 2),
                        "box": list(target.box), "locked": target.track_id == locked,
                    },
                    "detections": [
                        {"id": d.track_id, "label": d.label, "conf": round(d.conf, 2), "box": list(d.box)}
                        for d in detections if d.track_id is not None  # unconfirmed tracks can't be locked
                    ],
                    "gimbal": {
                        "pan": round(pan, 1), "tilt": 0.0,
                        "target_pan": round(aim_pan, 1), "target_tilt": 0.0,
                        # Pan-only build; the tilt fields stay for dashboards that read them.
                        "pan_limits": list(mot.pan_limits_deg), "tilt_limits": [0, 0],
                        "tilt_enabled": False,
                        "mock": gimbal.mock,
                        "drivers_enabled": gimbal.drivers_enabled,
                    },
                    "velocity_deg_s": [round(v, 1) for v in predictor.velocity],
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
        gimbal.close()
        grabber.close()
        camera.close()


if __name__ == "__main__":
    main()
