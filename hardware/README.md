# Hardware

Owner: design & hardware teammate. Keep this file up to date when the wiring changes. Pin numbers live in `cooper/config.py` (`LedConfig`) and can be overridden under `[leds]` in `cooper.toml`.

## Architecture
```
car 12 V socket ──► USB-C PD car charger (5 V, 5 A) ──USB-C──► Raspberry Pi 5 ──22-pin ribbon──► OV5647 camera
                                                                   │
                                                                   ├─ GPIO17 ──330 Ω──► yellow LED ──► GND
                                                                   └─ GPIO27 ──330 Ω──► red LED ────► GND
```
COOPER is a fixed dashcam: nothing moves. The Pi runs everything (vision, prediction, risk) and drives the two LEDs directly from its GPIO.

## Bill of materials
| Part | Qty | Notes |
|---|---|---|
| Raspberry Pi 5, 8 GB | 1 | + active cooler (a parked car gets hot) |
| OV5647 5 MP camera, 3.6 mm, 75° | 1 | Non-IR |
| Pi 5 camera cable, 15→22 pin | 1 | ✅ have it |
| USB-C PD car charger, 27 W (5 V / 5 A) | 1 | + a short USB-C cable. A weaker charger causes under-voltage throttling |
| LED, yellow, 5 mm | 1 | Warning |
| LED, red, 5 mm | 1 | Danger |
| Resistor, 330 Ω | 2 | One per LED |
| Female-to-male jumper wires | 4 | Or solder to the header |
| microSD card, 32 GB+ | 1 | Raspberry Pi OS Bookworm, 64-bit |
| Windshield mount / enclosure | 1 | Designed by the hardware lead |

## Wiring: LEDs
**The pin numbers are placeholders (TODO): confirm them when wiring, then set them in `cooper.toml`.**

| LED | GPIO (BCM) | Physical pin | Series resistor | Cathode (short leg) to |
|---|---|---|---|---|
| Yellow (warning) | **GPIO17** (TODO) | 11 | 330 Ω, between the pin and the anode (long leg) | GND, physical pin 9 |
| Red (danger) | **GPIO27** (TODO) | 13 | 330 Ω, between the pin and the anode (long leg) | GND, physical pin 14 |

```toml
[leds]
yellow_pin = 17   # BCM numbering, not physical pin numbers
red_pin = 27
```

- **Why 330 Ω:** Pi GPIO is 3.3 V and a yellow or red LED drops about 2.0 V, so (3.3 − 2.0) / 330 ≈ 4 mA: clearly visible, and well under the Pi's per-pin limit (16 mA). Brighter LEDs for daylight can go down to 150 Ω (≈ 9 mA). Never connect an LED without a resistor.
- **BCM vs physical numbers:** gpiozero uses BCM numbers (GPIO17), not header positions (pin 11). `pinout` on the Pi prints the map.
- Only one LED is lit at a time: yellow = warning, red = danger, both off = clear.
- The software drives them through gpiozero with the lgpio backend (the Pi 5's GPIO is on the RP1 chip, which the old RPi.GPIO library doesn't support); `scripts/setup_pi.sh` installs both from apt.

## Power
- **Use a USB-C PD car charger rated for 5 V / 5 A (27 W).** A Pi 5 running YOLO draws a lot of current; a weak charger causes under-voltage throttling or reboots. Check with `vcgencmd get_throttled` (`0x0` = OK) or the dashboard's Power reading.
- On a charger that can't negotiate 5 A the Pi limits its USB ports to 600 mA and shows a boot warning. COOPER uses no USB devices, so that's harmless.
- **The car cuts power when the ignition turns off,** which is an unclean shutdown for the SD card. For the hackathon that's acceptable; a clean shutdown on ignition-off is on the "what's next" list.
- Cabin heat: a car in the sun passes 60 °C inside. Keep the active cooler, and watch `cpu_temp_c` (the Pi 5 throttles at 80–85 °C).

## Mounting and the lane
- Mount the camera **centred** behind the windshield (next to the rear-view mirror), **level**, looking straight down the road, and rigid: a mount that shakes makes every box jitter.
- The software's "my lane" is a region of the image, so it's only right for one mount position. After mounting, calibrate it from the dashboard (**Edit lane** → drag the corners onto your lane out to ~15 m → **Apply and save**); it's stored under `[risk] lane` in `cooper.toml`. `docs/HARDWARE_TEST.md` has the steps.
- Keep the LEDs where the driver sees them without looking away from the road (top of the dashboard, near the windshield base).

## Files
Put CAD, STL and wiring diagrams in this folder.
