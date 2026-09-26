# Hardware

Owner: design & hardware teammate. Keep this file up to date when the wiring changes. Pin numbers live in `firmware/coop_motors/coop_motors.ino`; gearing, microsteps and limits live in `coop/config.py` (`MotorConfig`).

## Architecture
```
Pi 5 ──USB──► Arduino Uno ──STEP/DIR/EN──► TMC2209 (pan)  ──► NEMA 17
  │                         └────────────► TMC2209 (tilt) ──► NEMA 17
  └─ camera ribbon (22-pin)                    ▲
                                  12 V supply ─┘ (VM)
```
The Pi runs vision and sends target positions. The Uno generates the step pulses.

## Bill of materials
| Part | Qty | Notes |
|---|---|---|
| Raspberry Pi 5, 8 GB | 1 | Official 27 W USB-C PSU + active cooler |
| OV5647 5 MP camera, 3.6 mm, 75° | 1 | Non-IR |
| Pi 5 camera cable, 15→22 pin | 1 | ✅ have it |
| Arduino Uno + USB cable | 1 | Powered from the Pi's USB port |
| TMC2209 driver module | 1 per motor | Standalone STEP/DIR mode |
| NEMA 17 stepper | 1–2 | Pan (and optional tilt) |
| 12 V power supply (≥2 A) | 1 | Motors only; **never** from the Pi or Uno 5 V |
| 100 µF electrolytic capacitor | 1 per driver | Across VM/GND, close to the driver |
| Arduino CNC Shield V3 (optional) | 1 | Uses the same pinout and removes most of the wiring |

## Wiring: Uno ↔ TMC2209
| TMC2209 pin | Pan driver | Tilt driver |
|---|---|---|
| STEP | Uno D2 | Uno D3 |
| DIR | Uno D5 | Uno D6 |
| EN | Uno D8 (shared, low = on) | Uno D8 |
| MS1, MS2 | GND (= 8 microsteps) | GND |
| VIO | Uno 5V | Uno 5V |
| GND (logic) | Uno GND | Uno GND |
| VM | +12 V | +12 V |
| GND (power) | 12 V supply − | 12 V supply − |
| A1/A2, B1/B2 | Motor coil A, coil B | Motor coil A, coil B |
| PDN_UART | leave unconnected | leave unconnected |

- **Common ground:** the 12 V supply's − must connect to the Uno's GND.
- **Set the current limit (Vref) before you connect the motors.** Use the potentiometer and your module's Vref formula, which differs between brands. Aim for about 0.8–1.0 A RMS for a typical 1.5 A NEMA 17. The motor will run cooler and still have plenty of torque for a camera.
- **Never plug or unplug a motor while the driver is powered.** It can destroy the TMC2209.
- To find a motor's coil pairs: two wires that show low resistance between them belong to the same coil.
- For a different microstep setting, change `MotorConfig.microsteps` to match. The MS2/MS1 combinations are: 00 = 8, 01 = 32, 10 = 64, 11 = 16.

## Flashing the Uno
1. Install the Arduino IDE, then use Library Manager to install **AccelStepper** (by Mike McCauley).
2. Open `firmware/coop_motors/coop_motors.ino`, select Board **Arduino Uno** and the right port, then Upload.
3. Test: open the Serial Monitor at **115200** baud with the "Newline" line ending. You should see `READY`, followed by `P 0 0` lines. Type `T 800 0` to turn the pan motor, then `T 0 0` to bring it back.

## Mechanics
- The software treats the power-on position as 0°. Point the camera forward before starting, or add a limit switch for homing later.
- Set `pan_gear_ratio` / `tilt_gear_ratio` if you use belts or gears. For example, a 20T pulley driving a 60T pulley is `3.0`.
- Pan is limited to ±170° by default so the cables don't wrap. Change `pan_limits_deg` if you add a slip ring.

## Files
Put CAD, STL and wiring diagrams in this folder.
