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
class MotorConfig:
    enabled: bool = True
    # Step/dir driver (A4988 / DRV8825 / TMC2209). Pins are BCM numbers.
    steps_per_rev: int = 200
    microsteps: int = 16
    gear_ratio: float = 1.0  # output turns per motor turn denominator, e.g. 3.0 for a 1:3 belt
    pan_step_pin: int = 17
    pan_dir_pin: int = 27
    tilt_enabled: bool = False
    tilt_step_pin: int = 22
    tilt_dir_pin: int = 23
    enable_pin: int | None = 24  # driver EN (active low); None if tied to GND
    pan_limits_deg: tuple = (-170.0, 170.0)
    tilt_limits_deg: tuple = (-30.0, 45.0)
    max_steps_per_sec: float = 3000.0
    min_steps_per_sec: float = 200.0
    accel_steps_per_sec2: float = 8000.0


@dataclass
class TrackingConfig:
    priority: tuple = ("person", "car", "truck", "bus", "motorcycle")
    lead_time_s: float = 0.15  # how far ahead the predictor aims (covers pipeline latency)
    lost_timeout_s: float = 1.0  # drop the target after this long unseen
    deadband_deg: float = 1.0  # ignore aim changes smaller than this to avoid jitter


@dataclass
class StreamConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    jpeg_quality: int = 70


@dataclass
class Config:
    camera: CameraConfig = field(default_factory=CameraConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    motors: MotorConfig = field(default_factory=MotorConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
