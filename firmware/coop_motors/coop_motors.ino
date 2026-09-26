// COOP motor controller: Arduino Uno + 2x TMC2209 (standalone STEP/DIR) + NEMA 17.
//
// The Pi sends target positions over USB serial; AccelStepper does the step timing.
// Protocol (115200 baud, newline-terminated ASCII, positions in microsteps):
//   Pi -> Uno:  T <pan> <tilt>        move to target
//               C <max_speed> <accel> set motion limits (steps/s, steps/s^2)
//               Z                     current position becomes 0,0
//               S                     decelerate to a stop
//               E <0|1>               disable/enable drivers
//               H                     heartbeat
//   Uno -> Pi:  READY                 after boot
//               P <pan> <tilt>        current position, every 50 ms
//
// Safety: if the Pi goes quiet for WATCHDOG_MS the motors decelerate to a stop.
//
// Pinout matches the Arduino CNC Shield V3 (X = pan, Y = tilt).
// Requires the "AccelStepper" library (Library Manager).

#include <AccelStepper.h>

const uint8_t PAN_STEP = 2;
const uint8_t PAN_DIR = 5;
const uint8_t TILT_STEP = 3;
const uint8_t TILT_DIR = 6;
const uint8_t EN_PIN = 8;  // TMC2209 EN is active low

const unsigned long REPORT_MS = 50;
const unsigned long WATCHDOG_MS = 2000;

AccelStepper pan(AccelStepper::DRIVER, PAN_STEP, PAN_DIR);
AccelStepper tilt(AccelStepper::DRIVER, TILT_STEP, TILT_DIR);

char buf[48];
uint8_t len = 0;
unsigned long lastReport = 0;
unsigned long lastCommand = 0;
bool watchdogTripped = false;

void setLimits(float maxSpeed, float accel) {
  pan.setMaxSpeed(maxSpeed);
  pan.setAcceleration(accel);
  tilt.setMaxSpeed(maxSpeed);
  tilt.setAcceleration(accel);
}

void handle(char *line) {
  long a, b;
  switch (line[0]) {
    case 'T':
      if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) {
        pan.moveTo(a);
        tilt.moveTo(b);
      }
      break;
    case 'C':
      if (sscanf(line + 1, "%ld %ld", &a, &b) == 2) setLimits(a, b);
      break;
    case 'Z':
      pan.setCurrentPosition(0);
      tilt.setCurrentPosition(0);
      break;
    case 'S':
      pan.stop();
      tilt.stop();
      break;
    case 'E':
      if (sscanf(line + 1, "%ld", &a) == 1) digitalWrite(EN_PIN, a ? LOW : HIGH);
      break;
    case 'H':
      break;
    default:
      return;
  }
  lastCommand = millis();
  watchdogTripped = false;
}

void setup() {
  Serial.begin(115200);
  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, LOW);
  setLimits(2000, 6000);
  lastCommand = millis();
  Serial.println(F("READY"));
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      buf[len] = '\0';
      if (len > 0) handle(buf);
      len = 0;
    } else if (c != '\r' && len < sizeof(buf) - 1) {
      buf[len++] = c;
    }
  }

  if (!watchdogTripped && millis() - lastCommand > WATCHDOG_MS) {
    pan.stop();
    tilt.stop();
    watchdogTripped = true;
  }

  pan.run();
  tilt.run();

  if (millis() - lastReport >= REPORT_MS) {
    lastReport = millis();
    Serial.print('P');
    Serial.print(' ');
    Serial.print(pan.currentPosition());
    Serial.print(' ');
    Serial.println(tilt.currentPosition());
  }
}
