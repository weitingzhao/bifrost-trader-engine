"""Pytest fixtures for Bifrost Trader Engine tests."""

import sys
from pathlib import Path

import pytest
import yaml

# Ensure project root is in path for src imports
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


@pytest.fixture
def project_root() -> Path:
    return _project_root()


@pytest.fixture
def config_path(project_root: Path) -> Path:
    """Path to config file. Prefer example so tests get a valid ``ib.host`` shape without local overrides."""
    example = project_root / "config" / "config.yaml.example"
    if example.exists():
        return example
    return project_root / "config" / "config.yaml"


@pytest.fixture
def config(config_path: Path) -> dict:
    """Load config dict from YAML."""
    with open(config_path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


@pytest.fixture
def ib_config(config: dict) -> dict:
    """Effective IB connection dict from ``get_effective_ib_config`` (``ib.host`` + optional ``ib.secondary``)."""
    from src.app.config import get_effective_ib_config

    return get_effective_ib_config(config)


@pytest.fixture
def connector(ib_config: dict):
    """IBConnector instance from config. Use with pytest -m ib for live tests."""
    from src.daemon.connector.ib import IBConnector

    return IBConnector(
        host=ib_config.get("host", "127.0.0.1"),
        port=ib_config.get("port", 4001),
        client_id=ib_config.get("client_id_daemon", 1),
        connect_timeout=float(ib_config.get("connect_timeout") or 60.0),
    )
