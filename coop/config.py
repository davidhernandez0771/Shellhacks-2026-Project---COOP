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
    # Arduino Uno running firmware/coop_motors; pins live in the .ino file.
    port: str = "auto"  # "auto" finds the Uno on USB, or set e.g. "/dev/ttyACM0" / "COM5"
    baud: int = 115200
    # NEMA 17 (1.8 deg) on TMC2209. MS1/MS2 both low = 8 microsteps (TMC2209 default).
    steps_per_rev: int = 200
    microsteps: int = 8
    pan_gear_ratio: float = 1.0  # motor turns per camera turn, e.g. 3.0 for a 20T->60T belt
    # The build is pan-only: the firmware's tilt axis (Y) is always sent 0.
    pan_invert: bool = False  # flip if +pan turns the camera left instead of right
    pan_limits_deg: tuple = (-170.0, 170.0)  # keep cables from wrapping
    max_steps_per_sec: float = 2000.0  # microsteps/s; AccelStepper on a Uno tops out near 4000
    accel_steps_per_sec2: float = 6000.0


@dataclass
class TrackingConfig:
    priority: tuple = ("person", "car", "truck", "bus", "motorcycle")
    lead_time_s: float = 0.15  # how far ahead the predictor aims (covers pipeline latency)
    lost_timeout_s: float = 1.0  # drop the target after this long unseen
    deadband_deg: float = 1.0  # ignore aim changes smaller than this to avoid jitter
    # When the tracked ID vanishes (ByteTrack re-IDs boxes that jump while the gimbal slews),
    # adopt a same-class detection within this many degrees of the predicted world position.
    reassociate_deg: float = 5.0


@dataclass
class SimConfig:
    """Virtual gimbal (coop/sim.py): only used when the motors are in mock mode."""
    enabled: bool = True
    # Assumed horizontal FOV of the dev webcam, standing in for the world the real (narrower)
    # camera could scan by rotating; vertical FOV is derived from the webcam's aspect ratio.
    # Must exceed CameraConfig.hfov_deg or there's no room to pan. At 100 deg on a 16:9 webcam
    # the crop is ~half the width, giving about +-30 deg of visible pan.
    world_hfov_deg: float = 100.0


@dataclass
class StreamConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    jpeg_quality: int = 70
    # Burn boxes/aim marker into /video. Off by default: the dashboard draws its own overlay.
    annotate: bool = False


@dataclass
class Config:
    camera: CameraConfig = field(default_factory=CameraConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    motors: MotorConfig = field(default_factory=MotorConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    sim: SimConfig = field(default_factory=SimConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
