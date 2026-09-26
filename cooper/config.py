"""Central configuration. Tune values here instead of hunting through modules."""
from dataclasses import dataclass, field


@dataclass
class CameraConfig:
    source: str = "auto"  # "picamera", "webcam", or "auto" (picamera, falling back to webcam)
    webcam_index: int = 0
    width: int = 640
    height: int = 480
    fps: int = 30
    # OV5647 with the 3.6mm lens is 75 deg diagonal -> roughly 63 x 49 deg at 4:3.
    hfov_deg: float = 63.0
    vfov_deg: float = 49.0


@dataclass
class DetectorConfig:
    model: str = "yolo11n.pt"  # auto-downloads on first run; export to NCNN on the Pi for speed
    imgsz: int = 320
    conf: float = 0.4
    classes: tuple = (0, 2, 3, 5, 7)  # COCO ids: person, car, motorcycle, bus, truck


@dataclass
class StreamConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    jpeg_quality: int = 70
    # Burn boxes into /video. Off by default: the dashboard draws its own overlay.
    annotate: bool = False


@dataclass
class Config:
    camera: CameraConfig = field(default_factory=CameraConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
