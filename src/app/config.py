"""Load YAML config with env overrides. Used by daemon entry and callers that need (config, resolved_path)."""

import os
from pathlib import Path
from typing import Optional

import yaml


def read_config(config_path: Optional[str] = None) -> tuple[dict, str]:
    """Load YAML config with env overrides for IB. Returns (config, resolved_path)."""
    config_path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(config_path).exists():
        config_path = "config/config.yaml.example"
    config_path = str(Path(config_path).resolve())
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    return config, config_path
