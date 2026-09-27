"""People/vehicle detection with YOLO plus ByteTrack IDs (via Ultralytics)."""
from dataclasses import dataclass


@dataclass
class Detection:
    track_id: int | None
    label: str
    conf: float
    box: tuple[int, int, int, int]  # x1, y1, x2, y2

    @property
    def center(self):
        x1, y1, x2, y2 = self.box
        return (x1 + x2) / 2, (y1 + y2) / 2

    @property
    def area(self):
        x1, y1, x2, y2 = self.box
        return (x2 - x1) * (y2 - y1)


class Detector:
    def __init__(self, cfg):
        from ultralytics import YOLO  # imported lazily so the rest of the package loads without it

        self.cfg = cfg
        self.model = YOLO(cfg.model)

    def detect(self, frame):
        result = self.model.track(
            frame,
            imgsz=self.cfg.imgsz,
            conf=self.cfg.conf,
            classes=list(self.cfg.classes),
            persist=True,
            tracker="bytetrack.yaml",
            verbose=False,
        )[0]

        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return []

        ids = boxes.id.int().tolist() if boxes.id is not None else [None] * len(boxes)
        return [
            Detection(tid, result.names[cls], conf, tuple(xyxy))
            for xyxy, conf, cls, tid in zip(
                boxes.xyxy.int().tolist(), boxes.conf.tolist(), boxes.cls.int().tolist(), ids
            )
        ]
