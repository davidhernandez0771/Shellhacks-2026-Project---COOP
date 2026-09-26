# Firmware in a simulator

Runs the **real** `firmware/coop_motors` (compiled with avr-gcc against the Arduino AVR core
and AccelStepper) on a simulated ATmega328P ([simavr](https://github.com/buserror/simavr)),
scripts it over its UART, and counts the actual STEP pulses on D2 (only while EN on D8 is
low, signed by DIR on D5). That measures the shaft independently of the firmware's own step
counter, which is how it checks the claims the rest of the code relies on.

```bash
sudo apt install gcc-avr avr-libc arduino-core-avr simavr libsimavr-dev libelf-dev
git clone --depth 1 https://github.com/waspinator/AccelStepper /tmp/AccelStepper
ACCEL=/tmp/AccelStepper bash tools/firmware_sim/build_and_run.sh
```

Scenarios (`harness.c`): `move`, `naive_estop` (S then E 0 at once), `coop_estop` (S, wait
until still, E 0: what `coop/motors.py` does), `watchdog`, `zero5`, `disabled_T`.

Results on 2026-09-26 (Arduino AVR core 1.8.6, AccelStepper 1.64), next to
`tools/fake_uno.py` running the same scripts:

| Scenario | Firmware (simavr) | fake_uno |
|---|---|---|
| `T 400 0`, `T -1234 0` | counter = shaft = 400, then -1234 | same |
| position 0.6 s into a 2000 steps/s move | 1158 | 1167 |
| naive e-stop: counter minus shaft | **334 steps (75 deg) lost** | 334 |
| braking distance after `S` at 2000 steps/s | 341 | 334 |
| COOP e-stop: counter minus shaft | 0 | 0 |
| watchdog (500 steps/s, silence): at 1.5 s / final | 687 / 999 | 687 / 1000 |
| `Z 5` | zeroes the counter | same |
| `E 0` then `T 200 0`: counter / shaft | 200 / 0 | 200 / 0 |

Linux only, and not part of CI (it needs the AVR toolchain). Re-run it whenever the `.ino`
or the serial protocol changes.
