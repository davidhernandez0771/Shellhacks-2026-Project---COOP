// Runs the real compiled COOP firmware in simavr and scripts it over UART.
// Physical shaft = STEP (PD2) rising edges while EN (PB0) is low, signed by DIR (PD5).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sim_avr.h"
#include "sim_elf.h"
#include "avr_uart.h"
#include "avr_ioport.h"

static avr_t *avr;
static long rotor = 0;
static int dir_high = 0, en_low = 1;
static char line[128]; static int ll = 0;
static long last_p = 0; static int ready = 0;
static double now(void) { return (double)avr->cycle / avr->frequency; }

static void uart_out(struct avr_irq_t *irq, uint32_t v, void *p) {
  char c = (char)v;
  if (c == '\n') { line[ll] = 0; if (!strncmp(line, "READY", 5)) ready = 1;
    else if (line[0] == 'P') last_p = strtol(line + 2, NULL, 10); ll = 0; }
  else if (c != '\r' && ll < 127) line[ll++] = c;
}
static void step_pin(struct avr_irq_t *irq, uint32_t v, void *p) { if (v && en_low) rotor += dir_high ? 1 : -1; }
static void dir_pin(struct avr_irq_t *irq, uint32_t v, void *p) { dir_high = v; }
static void en_pin(struct avr_irq_t *irq, uint32_t v, void *p) { en_low = !v; }

static void run_for(double s) { double end = now() + s; while (now() < end) avr_run(avr); }
static void send(const char *s) { for (; *s; s++) { avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_INPUT), *s); run_for(0.0001); } }
static void run_with_heartbeat(double s) { double end = now() + s; while (now() < end) { run_for(0.25); send("H\n"); } }

int main(int argc, char **argv) {
  elf_firmware_t f = {{0}};
  if (elf_read_firmware(argv[1], &f)) return 1;
  avr = avr_make_mcu_by_name("atmega328p"); avr_init(avr); avr_load_firmware(avr, &f);
  avr->frequency = 16000000;
  uint32_t flags = 0; avr_ioctl(avr, AVR_IOCTL_UART_GET_FLAGS('0'), &flags);
  flags &= ~AVR_UART_FLAG_STDIO; avr_ioctl(avr, AVR_IOCTL_UART_SET_FLAGS('0'), &flags);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_out, NULL);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('D'), 2), step_pin, NULL);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('D'), 5), dir_pin, NULL);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('B'), 0), en_pin, NULL);
  while (!ready && now() < 3) avr_run(avr);
  printf("ready=%d at %.3fs\n", ready, now());
  const char *scenario = argv[2];

  if (!strcmp(scenario, "move")) {            // plain move: arrival and overshoot
    send("C 2000 6000\nT 400 0\n"); run_with_heartbeat(1.0);
    printf("move400 counter=%ld rotor=%ld\n", last_p, rotor);
    send("T -1234 0\n"); run_with_heartbeat(2.0);
    printf("move-1234 counter=%ld rotor=%ld\n", last_p, rotor);
  } else if (!strcmp(scenario, "naive_estop")) {   // S then E 0 immediately
    send("C 2000 6000\nT 100000 0\n"); run_with_heartbeat(0.6);
    long at = last_p; send("S\nE 0\n"); run_with_heartbeat(1.0);
    printf("naive at=%ld counter=%ld rotor=%ld drift=%ld\n", at, last_p, rotor, last_p - rotor);
  } else if (!strcmp(scenario, "coop_estop")) {    // S, wait until still, then E 0
    send("C 2000 6000\nT 100000 0\n"); run_with_heartbeat(0.6);
    long at = last_p; send("S\n"); run_with_heartbeat(0.7); send("E 0\n"); run_with_heartbeat(0.3);
    printf("coop at=%ld braking=%ld counter=%ld rotor=%ld drift=%ld\n", at, last_p - at, last_p, rotor, last_p - rotor);
  } else if (!strcmp(scenario, "watchdog")) {
    send("C 500 2000\nT 100000 0\n"); run_for(1.5); long a = last_p; run_for(1.5);
    printf("watchdog at1.5=%ld final=%ld rotor=%ld (sim t=%.2f)\n", a, last_p, rotor, now());
  } else if (!strcmp(scenario, "zero5")) {
    send("Z 400 0\n"); run_for(0.1); printf("Z400 -> %ld\n", last_p);
    send("Z 5\n"); run_for(0.1); printf("Z5 -> %ld\n", last_p);
  } else if (!strcmp(scenario, "disabled_T")) {
    send("E 0\nT 200 0\n"); run_with_heartbeat(1.0);
    printf("disabledT counter=%ld rotor=%ld\n", last_p, rotor);
  }
  return 0;
}
