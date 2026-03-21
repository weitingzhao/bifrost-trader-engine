"""resolve_startup_config_path for run_engine / run_server / run_celery."""

import os
from pathlib import Path

import pytest

from src.app.config import config_profile_from_resolved_path, resolve_startup_config_path


@pytest.fixture
def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def test_resolve_default_dev(project_root: Path) -> None:
    os.environ.pop("BIFROST_CONFIG", None)
    os.environ.pop("BIFROST_ENV", None)
    p, rest = resolve_startup_config_path(str(project_root), [])
    assert "config.dev.yaml" in p or "config.yaml" in p
    assert rest == []


def test_resolve_prod_flag(project_root: Path) -> None:
    os.environ.pop("BIFROST_CONFIG", None)
    os.environ.pop("BIFROST_ENV", None)
    p, rest = resolve_startup_config_path(str(project_root), ["--prod"])
    assert "config.prod.yaml" in p
    assert rest == []


def test_resolve_explicit_path(project_root: Path) -> None:
    os.environ.pop("BIFROST_CONFIG", None)
    explicit = str(project_root / "config" / "config.yaml.example")
    p, rest = resolve_startup_config_path(str(project_root), [explicit])
    assert p.endswith("config.yaml.example")
    assert rest == []


def test_config_profile_from_resolved_path() -> None:
    assert config_profile_from_resolved_path("/x/config/config.dev.yaml") == "dev"
    assert config_profile_from_resolved_path("/x/config/config.prod.yaml") == "prod"
    assert config_profile_from_resolved_path("/x/config/config.yaml") is None
    assert config_profile_from_resolved_path("/custom/other.yaml") is None


def test_bifrost_config_env_wins(project_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = str(project_root / "config" / "config.yaml.example")
    monkeypatch.setenv("BIFROST_CONFIG", target)
    p, rest = resolve_startup_config_path(str(project_root), ["--prod", "ignored"])
    assert p == str(Path(target).resolve())
    assert rest == ["--prod", "ignored"]
