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
class PredictionConfig:
    """Per-object constant-velocity Kalman filter on the box's bottom-centre (u, v) and height
    h, in pixels (cooper/predictor.py, docs/MATH.md)."""
    # Process noise: how hard objects may accelerate in the image. A car 10 m away changing
    # lanes at 3 m/s^2 is about 160 px/s^2 at 640 px wide; nearer objects move more.
    accel_std_px_s2: float = 400.0      # for u and v
    height_accel_std_px_s2: float = 150.0  # for h (an object approaching or receding)
    meas_std_px: float = 3.0            # YOLO box jitter
    init_vel_std_px_s: float = 300.0    # a new track's velocity is unknown: this uncertain
    lost_timeout_s: float = 0.5         # forget a track unseen this long (ByteTrack's ID gaps)
    min_hits: int = 3                   # measurements before its velocity is trusted for warnings
    # Time to contact counts only when the box's growth rate h' exceeds this many of its own
    # standard deviations (from the filter's covariance): otherwise it could be jitter.
    growth_min_sigma: float = 2.0
    # Innovation gate: a measurement further than this many standard deviations from the
    # prediction is treated as corrupt (a box cut short by an occluder) and the filter coasts
    # (v and h together: they share the bottom edge)...
    gate_sigma: float = 4.0
    # ...for at most this long; then the new value is taken as real and the axis restarts.
    max_coast_s: float = 1.0


@dataclass
class RiskConfig:
    """Clear / warning / danger (cooper/risk.py, docs/MATH.md)."""
    # "My lane": the road right in front of the car, as four corners in normalized frame
    # coordinates (0..1, origin top-left), in order top-left, top-right, bottom-right,
    # bottom-left: x, y for each. Adjustable live from the dashboard.
    lane: tuple = (0.44, 0.60, 0.56, 0.60, 0.79, 1.00, 0.21, 1.00)
    horizon_s: float = 1.5       # how far ahead each object's path is predicted
    step_s: float = 0.1          # path sample spacing
    min_overlap: float = 0.2     # share of an object's bottom edge that must be inside the lane
    lane_margin: float = 0.25    # TTC corridor: the lane extended to the horizon, widened by this share each side
    ttc_warn_s: float = 2.0      # time-to-contact below this starts a warning...
    ttc_clear_s: float = 2.5     # ...which ends only above this
    ttc_min_height_px: float = 24.0  # smaller boxes' scale rate is mostly jitter
    enter_frames: int = 2        # frames in a row a level must be seen before it lights
    hold_s: float = 0.5          # a level stays lit this long after its condition ends


@dataclass
class LedConfig:
    """Yellow = warning, red = danger, driven by gpiozero on the Pi (cooper/leds.py)."""
    enabled: bool = True         # false = mock LEDs even on a Pi (same as --no-leds)
    # BCM GPIO numbers. TODO: confirm pins with the wiring (hardware/README.md); placeholders.
    yellow_pin: int = 17         # TODO: placeholder (physical pin 11)
    red_pin: int = 27            # TODO: placeholder (physical pin 13)


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
    prediction: PredictionConfig = field(default_factory=PredictionConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    leds: LedConfig = field(default_factory=LedConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
