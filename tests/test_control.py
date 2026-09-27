"""Shared state behind the HTTP API (cooper/control.py): the event log."""
import threading

from cooper.control import EVENT_LOG_SIZE, Control


def test_starts_with_no_events():
    assert Control().events_since(0) == []


def test_events_since_only_returns_newer_events():
    c = Control()
    c.log_event("settings_changed", changed={}, saved=False)
    c.log_event("settings_changed", changed={}, saved=True)
    events = c.events_since(0)
    assert [e["seq"] for e in events] == [1, 2]
    assert c.events_since(events[-1]["seq"]) == []
    assert c.events_since(1) == events[1:]


def test_log_event_keeps_type_fields_and_a_timestamp():
    c = Control()
    c.log_event("risk_changed", level="warning", reason="cut-in")
    last = c.events_since(0)[-1]
    assert last["type"] == "risk_changed"
    assert last["level"] == "warning" and last["reason"] == "cut-in"
    assert last["t"] > 0


def test_the_log_is_bounded_and_seq_keeps_counting():
    c = Control()
    for _ in range(EVENT_LOG_SIZE + 5):
        c.log_event("x")
    events = c.events_since(0)
    assert len(events) == EVENT_LOG_SIZE
    assert events[-1]["seq"] == EVENT_LOG_SIZE + 5


def test_concurrent_logging_never_reuses_a_seq():
    c = Control()
    threads = [threading.Thread(target=lambda: [c.log_event("x") for _ in range(50)]) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    seqs = [e["seq"] for e in c.events_since(0)]
    assert len(seqs) == len(set(seqs)) == 200
