"""Shared test fixtures: a fake serial port that stands in for the Arduino Uno."""
import queue

import pytest


class FakeSerial:
    """Mimics pyserial's Serial: a byte-line queue in, a list of written lines out.

    Sends "READY\\n" as the first line read, matching the real Uno's boot message, so the
    Gimbal handshake in cooper.motors succeeds without a real port.
    """

    def __init__(self, port, baudrate, timeout=0.1):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.sent = []
        self.closed = False
        self._incoming = queue.Queue()
        self._incoming.put(b"READY\n")

    def push(self, line: bytes):
        self._incoming.put(line)

    def write(self, data: bytes):
        self.sent.append(data.decode())

    def readline(self):
        try:
            return self._incoming.get(timeout=self.timeout)
        except queue.Empty:
            return b""

    def close(self):
        self.closed = True


@pytest.fixture
def fake_serial_factory(monkeypatch):
    """Patches serial.Serial; returns the list of FakeSerial instances it creates."""
    created = []

    def factory(port, baud, timeout=0.1):
        inst = FakeSerial(port, baud, timeout)
        created.append(inst)
        return inst

    monkeypatch.setattr("serial.Serial", factory)
    return created


@pytest.fixture(autouse=True)
def no_local_settings_file(monkeypatch, tmp_path):
    """Tests never read the developer's own cooper.toml (it could point at a real Uno)."""
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", tmp_path / "cooper.toml")
