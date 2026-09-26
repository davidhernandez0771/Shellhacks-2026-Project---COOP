#!/usr/bin/env bash
# Compile firmware/coop_motors for the Uno and run it in simavr, counting real STEP pulses.
# Linux only. Needs: sudo apt install gcc-avr avr-libc arduino-core-avr simavr libsimavr-dev (libelf-dev on some distros)
# plus AccelStepper: git clone --depth 1 https://github.com/waspinator/AccelStepper "$ACCEL"
# Usage: ACCEL=/path/to/AccelStepper bash tools/firmware_sim/build_and_run.sh [scenario...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ACCEL="${ACCEL:?set ACCEL to an AccelStepper checkout}"
OUT="${OUT:-$(mktemp -d)}"
CORE=/usr/share/arduino/hardware/arduino/avr/cores/arduino
VAR=/usr/share/arduino/hardware/arduino/avr/variants/standard
DEFS="-mmcu=atmega328p -DF_CPU=16000000L -DARDUINO=10806 -DARDUINO_AVR_UNO -DARDUINO_ARCH_AVR -I$CORE -I$VAR -I$ACCEL/src"
CXX="avr-g++ -c -g -Os -std=gnu++11 -fpermissive -fno-exceptions -ffunction-sections -fdata-sections -fno-threadsafe-statics -flto $DEFS"
CC="avr-gcc -c -g -Os -std=gnu11 -ffunction-sections -fdata-sections -flto -fno-fat-lto-objects $DEFS"
cd "$OUT"
{ echo '#include <Arduino.h>'; echo '#line 1 "coop_motors.ino"'; cat "$REPO/firmware/coop_motors/coop_motors.ino"; } > sketch.cpp
$CXX -Wall -Wextra sketch.cpp -o sketch.o
$CXX -w "$ACCEL/src/AccelStepper.cpp" -o accel.o
for f in "$CORE"/*.c; do $CC -w "$f" -o "$(basename "$f").o"; done
for f in "$CORE"/*.cpp; do $CXX -w "$f" -o "$(basename "$f").o"; done
for f in "$CORE"/*.S; do avr-gcc -c -x assembler-with-cpp -flto $DEFS "$f" -o "$(basename "$f").o"; done
avr-gcc -Os -flto -fuse-linker-plugin -Wl,--gc-sections -mmcu=atmega328p -o sketch.elf ./*.o -lm
avr-size -C --mcu=atmega328p sketch.elf
SIMAVR="-I/usr/include/simavr -I/usr/include/simavr/avr"
gcc -O2 -o harness "$HERE/harness.c" $SIMAVR -lsimavr 2>/dev/null \
  || gcc -O2 -o harness "$HERE/harness.c" $SIMAVR -lsimavr -lelf  # some distros need libelf
for s in "${@:-move naive_estop coop_estop watchdog zero5 disabled_T}"; do
  for one in $s; do ./harness sketch.elf "$one" | grep -v '^Loaded'; done
done
