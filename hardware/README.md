# Hardware

Owner: design & hardware teammate. Keep this file up to date when the wiring changes, and mirror any pin changes in `coop/config.py` (`MotorConfig`).

## Bill of materials
| Part | Qty | Notes |
|---|---|---|
| Raspberry Pi 5, 8 GB | 1 | Official 27 W USB-C PSU recommended |
| OV5647 5 MP camera, 3.6 mm, 75° | 1 | Non-IR (no night vision) |
| Pi 5 camera cable, 15→22 pin | 1 | **Required**: the Pi 5 uses the smaller 22-pin connector |
| Stepper motor (pan) | 1 | e.g. NEMA 17 |
| Stepper motor (tilt) | 0–1 | Optional; set `tilt_enabled = True` |
| Step/dir driver | 1 per motor | A4988 / DRV8825 / TMC2209 |
| Motor power supply | 1 | 12 V typical; **never** power motors from the Pi's 5 V pin |
| Active cooler for the Pi 5 | 1 | YOLO keeps the CPU busy |

## Default wiring (BCM numbering)
| Signal | Pi GPIO | Physical pin |
|---|---|---|
| Pan STEP | GPIO17 | 11 |
| Pan DIR | GPIO27 | 13 |
| Tilt STEP | GPIO22 | 15 |
| Tilt DIR | GPIO23 | 16 |
| Drivers EN (shared, active low) | GPIO24 | 18 |
| Logic GND | GND | 6 / 14 / 20 |

- Connect the driver's logic VDD to the Pi's **3.3 V** (pin 1), and its motor VMOT to the external supply.
- Tie the Pi GND and the motor supply GND together.
- Put a ≥100 µF capacitor across VMOT/GND at each driver.
- Set the driver current limit before you connect the motor.

## Mechanics
- Set `gear_ratio` in `MotorConfig` if the pan uses a belt or gears. For example, a 20T pulley driving a 60T pulley is `3.0`.
- Set `microsteps` to match the driver's MS pins or its UART configuration.
- The software treats the startup position as 0°. Point the camera forward before powering on, or add a limit switch for homing later.

## Files
Put CAD, STL and wiring diagrams in this folder.
