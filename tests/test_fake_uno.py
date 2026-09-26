"""tools/fake_uno.py's UnoModel must behave like firmware/coop_motors.ino.

These drive the model directly (no sockets, no threads) with simulated time, so they are
deterministic. The emulator is only useful if it is faithful: a bug here would let the
end-to-end tests pass against behavior the real Uno doesn't have.
"""
import pytest

from tools.fake_uno import UnoModel, sscanf_longs


def booted(**kwargs):
    m = UnoModel(**kwargs)
    m.boot()
    return m


def lines(model):
    return model.drain_output().decode().splitlines()


def run_for(model, seconds, keepalive=True):
    """Advance in 0.1 s chunks, sending heartbeats like the Pi does unless keepalive=False."""
    t = 0.0
    while t < seconds - 1e-9:
        if keepalive:
            model.feed(b"H\n")
        model.advance(0.1)
        t += 0.1


# ---- sscanf("%ld %ld") emulation ----

@pytest.mark.parametrize("text,count,expected", [
    (" 5 7", 2, (2, [5, 7])),
    (" -12 +3", 2, (2, [-12, 3])),
    ("5-3", 2, (2, [5, -3])),       # "%ld %ld": the space matches zero or more blanks
    (" 5", 2, (1, [5])),
    ("", 2, (-1, [])),              # EOF before the first conversion
    ("   ", 2, (-1, [])),
    (" x", 2, (0, [])),             # matching failure
    (" 5 x", 2, (1, [5])),
    (" 1", 1, (1, [1])),
])
def test_sscanf_longs_matches_c_semantics(text, count, expected):
    assert sscanf_longs(text, count) == expected


# ---- boot and reports ----

def test_boot_prints_ready_then_reports_every_50ms():
    m = booted()
    assert lines(m) == ["READY"]
    m.advance(0.26)
    reports = lines(m)
    assert len(reports) == 5
    assert all(r == "P 0 0" for r in reports)


def test_output_uses_println_line_endings():
    m = booted()
    assert m.drain_output() == b"READY\r\n"


# ---- commands ----

def test_T_moves_to_target_with_a_trapezoid_profile():
    m = booted()
    m.feed(b"C 1000 4000\nT 400 0\n")
    m.advance(0.05)
    early = m.axes[0].counter
    assert 0 < early < 400
    # Accelerating at 4000 steps/s^2 from rest, 0.05 s covers about 0.5*4000*0.05^2 = 5 steps.
    assert early == pytest.approx(5, abs=2)
    run_for(m, 1.0)
    assert m.axes[0].counter == 400
    assert m.axes[0].speed == 0
    assert m.axes[1].counter == 0


def test_speed_never_exceeds_max_speed():
    m = booted()
    m.feed(b"C 500 50000\nT 100000 0\n")
    peak = 0.0
    for _ in range(50):
        m.feed(b"H\n")
        m.advance(0.02)
        peak = max(peak, abs(m.axes[0].speed))
    assert peak == pytest.approx(500, abs=1)


def test_negative_targets_work():
    m = booted()
    m.feed(b"T -300 0\n")
    run_for(m, 1.0)
    assert m.axes[0].counter == -300


def test_S_decelerates_instead_of_stopping_dead():
    m = booted()
    m.feed(b"C 2000 6000\nT 100000 0\n")
    run_for(m, 0.5)  # 2000 steps/s reached after 0.33 s
    assert m.axes[0].speed == pytest.approx(2000, abs=1)
    before = m.axes[0].counter
    m.feed(b"S\n")
    run_for(m, 1.0)
    travelled = m.axes[0].counter - before
    # v^2 / (2a) = 2000^2 / 12000 = 333 steps of braking distance.
    assert travelled == pytest.approx(334, abs=15)
    assert m.axes[0].speed == 0


def test_Z_with_arguments_sets_position_without_moving():
    m = booted()
    m.feed(b"Z 400 0\n")
    m.advance(0.06)
    assert lines(m)[-1] == "P 400 0"
    assert m.axes[0].rotor == 0  # nothing physically moved


def test_bare_or_malformed_Z_zeroes_like_the_firmware():
    m = booted()
    m.feed(b"Z 400 0\n")
    m.feed(b"Z\n")
    assert m.axes[0].counter == 0
    m.feed(b"Z 5\n")  # only one number: sscanf returns 1, the sketch falls back to 0, 0
    assert m.axes[0].counter == 0


def test_E0_cuts_torque_but_the_counter_keeps_counting():
    """The real failure mode: AccelStepper still 'steps' with the drivers disabled."""
    m = booted()
    m.feed(b"E 0\nT 200 0\n")
    run_for(m, 1.0)
    assert m.axes[0].counter == 200
    assert m.axes[0].rotor == 0
    m.feed(b"E 1\nT 0 0\n")
    run_for(m, 1.0)
    assert m.axes[0].counter == 0
    assert m.axes[0].rotor == -200


def test_E_without_argument_changes_nothing():
    m = booted()
    m.feed(b"E 0\nE\n")
    assert m.enabled is False


def test_T_with_one_number_is_ignored():
    m = booted()
    m.feed(b"T 500\n")
    run_for(m, 0.5)
    assert m.axes[0].counter == 0


def test_carriage_returns_ignored_and_long_lines_truncated():
    m = booted()
    m.feed(b"T 40 0\r\n")
    run_for(m, 0.5)
    assert m.axes[0].counter == 40
    # The buffer keeps 47 characters and drops the rest of the line: here that's the numbers,
    # so the command parses as a bare "T" and is ignored.
    m.feed(b"T" + b" " * 50 + b"999 0\n")
    run_for(m, 0.5)
    assert m.axes[0].counter == 40
    m.feed(b"T" + b" " * 40 + b"80 0\n")  # 46 characters: fits
    run_for(m, 0.5)
    assert m.axes[0].counter == 80


def test_unknown_commands_ignored():
    m = booted()
    m.feed(b"Q 1 2\nhello\n\n")
    m.advance(0.06)
    assert lines(m)[-1] == "P 0 0"


def test_bytes_before_boot_are_lost():
    m = UnoModel()
    m.feed(b"T 100 0\n")  # still in the bootloader
    m.boot()
    run_for(m, 0.5)
    assert m.axes[0].counter == 0


# ---- watchdog ----

def test_watchdog_stops_motion_after_2s_of_silence():
    m = booted()
    m.feed(b"C 500 2000\nT 100000 0\n")
    run_for(m, 1.9, keepalive=False)
    assert m.axes[0].speed > 0
    run_for(m, 1.0, keepalive=False)
    assert m.axes[0].speed == 0
    assert m.watchdog_tripped


def test_heartbeats_keep_the_watchdog_quiet():
    m = booted()
    m.feed(b"C 500 2000\nT 100000 0\n")
    run_for(m, 3.0)
    assert m.axes[0].speed == pytest.approx(500, abs=1)


def test_unknown_command_does_not_feed_the_watchdog():
    m = booted()
    m.feed(b"C 500 2000\nT 100000 0\n")
    for _ in range(30):
        m.feed(b"Q\n")
        m.advance(0.1)
    assert m.watchdog_tripped


# ---- reset ----

def test_reset_zeroes_the_counter_but_not_the_rotor():
    m = booted()
    m.feed(b"T 300 0\n")
    run_for(m, 1.0)
    m.reset()
    m.boot()
    assert m.axes[0].counter == 0
    assert m.axes[0].rotor == 300
    assert m.enabled is True
    assert (m.max_speed, m.accel) == (2000.0, 6000.0)


# ---- the TCP server ----

def test_replug_is_a_power_on_reset_not_a_resume():
    """Unplugging mid-move and plugging back in must not finish the old move."""
    import time

    from tools.fake_uno import FakeUnoServer

    with FakeUnoServer(boot_delay_s=0.01) as server:
        with server.lock:
            server.model.boot()
            server.model.feed(b"C 1000 100000\nT 100000 0\n")
        time.sleep(0.1)
        server.unplug()
        with server.lock:
            frozen = server.model.axes[0].rotor
        assert frozen > 0
        server.replug()
        time.sleep(0.2)
        with server.lock:
            axis = server.model.axes[0]
            assert axis.rotor == frozen
            assert axis.counter == 0
            assert server.model.booted


@pytest.mark.parametrize("target,speed,accel", [(400, 4000, 20000), (37, 2000, 6000), (-1234, 3000, 9000),
                                                 (1, 2000, 6000), (5000, 500, 100)])
def test_moves_never_overshoot_the_target(target, speed, accel):
    m = booted()
    m.feed(f"C {speed} {accel}\nT {target} 0\n".encode())
    sign = 1 if target > 0 else -1
    furthest = 0
    for _ in range(int(60 / 0.01)):
        m.feed(b"H\n")
        m.advance(0.01)
        furthest = max(furthest, sign * m.axes[0].counter)
        if m.axes[0].counter == target and m.axes[0].speed == 0:
            break
    assert m.axes[0].counter == target and m.axes[0].speed == 0
    assert furthest == abs(target)
