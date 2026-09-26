"""Shared test fixtures."""
import pytest


@pytest.fixture(autouse=True)
def no_local_settings_file(monkeypatch, tmp_path):
    """Tests never read the developer's own cooper.toml."""
    monkeypatch.setattr("cooper.settings.DEFAULT_PATH", tmp_path / "cooper.toml")
