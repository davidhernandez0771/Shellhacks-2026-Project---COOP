"""Camera check: grab frames through coop.camera.Camera, report resolution and FPS, save a still.

    python -m tools.camera_check                     # Pi camera (falls back to webcam)
    python -m tools.camera_check --source picamera --frames 150 --out still.jpg

Run it on the Pi before the full app: it proves Picamera2 works, shows the real delivered
frame rate, and the saved still lets you check colours (skin blue = red/blue swapped) and
orientation (text must read normally; something on the camera's right must appear on
the right of the image) before any motor moves.
"""
import argparse
import sys
import time
from pathlib import Path

if __package__ in (None, ""):  # allow `python tools/camera_check.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2

from coop.camera import Camera
from coop.settings import SettingsError, load_config


def measure(camera, frames=90):
    """Make `frames` read attempts. Returns width, height, fps (of good frames), failed
    count, time to the first frame and the last good frame."""
    t_start = time.monotonic()
    stamps, failed, last, first_s = [], 0, None, None
    for _ in range(frames):
        frame = camera.read()
        if frame is None:
            failed += 1
            continue
        now = time.monotonic()
        if first_s is None:
            first_s = now - t_start
        stamps.append(now)
        last = frame
    fps = (len(stamps) - 1) / (stamps[-1] - stamps[0]) if len(stamps) > 1 and stamps[-1] > stamps[0] else None
    h, w = (last.shape[:2] if last is not None else (None, None))
    return {"width": w, "height": h, "fps": fps, "failed": failed, "first_frame_s": first_s,
            "last_frame": last}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check the camera: resolution, FPS, and a saved still.")
    parser.add_argument("--source", choices=["auto", "picamera", "webcam"], help="default: camera.source from coop.toml")
    parser.add_argument("--frames", type=int, default=90, help="read attempts (default 90)")
    parser.add_argument("--out", default="camera_check.jpg", help="where to save the last frame")
    parser.add_argument("--config", help="settings file (default: coop.toml if present)")
    args = parser.parse_args(argv)

    try:
        cam_cfg = load_config(args.config, required=args.config is not None).camera
    except SettingsError as e:
        print(f"settings: {e}", file=sys.stderr)
        return 2
    if args.source:
        cam_cfg.source = args.source

    try:
        camera = Camera(cam_cfg)
    except Exception as e:  # ImportError (no picamera2), RuntimeError (nothing attached), ...
        print(f"Camera didn't open ({cam_cfg.source}): {e}\n"
              "On the Pi: check the ribbon cable and `rpicam-hello --list-cameras`.", file=sys.stderr)
        return 1
    try:
        stats = measure(camera, args.frames)
    finally:
        camera.close()

    if stats["last_frame"] is None:
        print(f"No frames in {args.frames} attempts. Check the ribbon cable and `rpicam-hello --list-cameras`.",
              file=sys.stderr)
        return 1
    w, h = stats["width"], stats["height"]
    print(f"Resolution:   {w}x{h} (configured {cam_cfg.width}x{cam_cfg.height})")
    if (w, h) != (cam_cfg.width, cam_cfg.height):
        print("  ! differs from the config: FOV maths in COOP assumes the configured size")
    fps = stats["fps"]
    print(f"Delivered:    {fps:.1f} fps (configured {cam_cfg.fps})" if fps else "Delivered:    only one frame")
    print(f"First frame:  {stats['first_frame_s']:.2f} s   failed grabs: {stats['failed']}")
    cv2.imwrite(args.out, stats["last_frame"])
    print(f"Saved still:  {args.out}")
    print("Check it: skin tones normal (not blue), text not mirrored, right side of the world on the right.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
