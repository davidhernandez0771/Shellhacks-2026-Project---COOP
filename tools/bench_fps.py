"""YOLO speed on this machine: PyTorch vs NCNN at several input sizes, plus the NCNN export.

    python -m tools.bench_fps --export               # once: export NCNN models (needs internet
                                                     #   the first time for yolo11n.pt)
    python -m tools.bench_fps                        # benchmark 256/320/416, torch and ncnn
    python -m tools.bench_fps --imgsz 320 --backends ncnn --frames 100

Each run times the same call COOP makes (model.track with ByteTrack, COOP's classes and
confidence) on a fixed image, after a warm-up, and prints a Markdown table to paste into
docs/HARDWARE_TEST.md. To use a result, set in coop.toml:

    [detector]
    model = "yolo11n_imgsz320_ncnn_model"
    imgsz = 320        # an NCNN model must run at the size it was exported at

NCNN models are exported per input size into <model>_imgsz<N>_ncnn_model/ (gitignored).
"""
import argparse
import statistics
import sys
import time
from pathlib import Path

if __package__ in (None, ""):  # allow `python tools/bench_fps.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SIZES = (256, 320, 416)
BACKENDS = ("torch", "ncnn")


def ncnn_model_path(model, imgsz):
    p = Path(model)
    return str(p.with_name(f"{p.stem}_imgsz{imgsz}_ncnn_model"))


def summarize(seconds):
    ms = sorted(s * 1000.0 for s in seconds)
    mean = statistics.fmean(ms)
    p90 = ms[min(len(ms) - 1, int(round(0.9 * (len(ms) - 1))))]
    return {"mean_ms": mean, "p90_ms": p90, "fps": 1000.0 / mean, "n": len(ms)}


def format_table(rows):
    """rows: [(backend, imgsz, summary)] -> Markdown table plus the fastest line."""
    lines = ["| backend | imgsz | mean ms | p90 ms | fps |", "|---|---|---|---|---|"]
    for backend, imgsz, s in rows:
        lines.append(f"| {backend} | {imgsz} | {s['mean_ms']:.1f} | {s['p90_ms']:.1f} | {s['fps']:.1f} |")
    best = max(rows, key=lambda r: r[2]["fps"])
    lines.append("")
    lines.append(f"Fastest: {best[0]} @ {best[1]} ({best[2]['fps']:.1f} fps)")
    return "\n".join(lines)


def export_ncnn(model, imgsz):
    """Export `model` to NCNN at `imgsz` (skipped if already there). Returns the folder."""
    import shutil

    from ultralytics import YOLO

    target = Path(ncnn_model_path(model, imgsz))
    if target.exists():
        print(f"  {target} exists, skipping")
        return str(target)
    exported = Path(YOLO(model).export(format="ncnn", imgsz=imgsz))
    if exported.resolve() != target.resolve():
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(exported), str(target))
    print(f"  exported {target}")
    return str(target)


def load_image(path):
    import cv2
    import numpy as np

    if path:
        img = cv2.imread(path)
        if img is None:
            raise SystemExit(f"can't read image {path}")
        return img
    try:
        from ultralytics.utils import ASSETS

        img = cv2.imread(str(ASSETS / "bus.jpg"))  # ships with ultralytics: people and a bus
        if img is not None:
            return cv2.resize(img, (640, 480))
    except ImportError:
        pass
    return np.random.default_rng(0).integers(0, 255, (480, 640, 3), dtype=np.uint8)


def bench(model_path, imgsz, frame, frames, warmup, conf, classes):
    from ultralytics import YOLO

    model = YOLO(model_path, task="detect")
    kwargs = dict(imgsz=imgsz, conf=conf, classes=list(classes), persist=True,
                  tracker="bytetrack.yaml", verbose=False)
    for _ in range(warmup):
        model.track(frame, **kwargs)
    times = []
    for _ in range(frames):
        t0 = time.perf_counter()
        model.track(frame, **kwargs)
        times.append(time.perf_counter() - t0)
    return summarize(times)


def main(argv=None):
    from coop.config import DetectorConfig

    det = DetectorConfig()
    parser = argparse.ArgumentParser(description="Benchmark YOLO (PyTorch vs NCNN) on this machine.")
    parser.add_argument("--model", default=det.model, help="PyTorch weights (default %(default)s)")
    parser.add_argument("--imgsz", type=int, nargs="+", default=list(SIZES))
    parser.add_argument("--backends", nargs="+", choices=BACKENDS, default=list(BACKENDS))
    parser.add_argument("--frames", type=int, default=50)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--image", help="test image (default: ultralytics' bus.jpg at 640x480)")
    parser.add_argument("--export", action="store_true", help="export NCNN models for each --imgsz, then exit")
    args = parser.parse_args(argv)

    if args.export:
        for size in args.imgsz:
            export_ncnn(args.model, size)
        return 0

    frame = load_image(args.image)
    rows = []
    for backend in args.backends:
        for size in args.imgsz:
            path = args.model if backend == "torch" else ncnn_model_path(args.model, size)
            if backend == "ncnn" and not Path(path).exists():
                print(f"skip ncnn @ {size}: {path} missing (run with --export first)")
                continue
            print(f"{backend} @ {size} ...", flush=True)
            rows.append((backend, size, bench(path, size, frame, args.frames, args.warmup,
                                              det.conf, det.classes)))
    if not rows:
        return 1
    print()
    print(format_table(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
