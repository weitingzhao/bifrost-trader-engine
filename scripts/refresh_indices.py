#!/usr/bin/env python3
"""Refresh reference index daily bars from TradingView and write to stock_day.

Run manually or via cron (e.g. daily after US close). See docs/INDEX_DATA_SOURCES.md.

Usage:
  python scripts/refresh_indices.py [config_path]
"""

import logging
import os
import sys
from pathlib import Path

if __name__ == "__main__":
    _root = Path(__file__).resolve().parent.parent
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    os.chdir(_root)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = (Path(args[0]).resolve() if args else _root / "config" / "config.yaml")
    if not config_path.is_file():
        logger.error("Config not found: %s", config_path)
        return 1

    try:
        from src.app.gs_trading import read_config
        from servers.reader import StatusReader
        from servers.index_data_client import refresh_reference_indices
    except ImportError as e:
        logger.error("Import failed: %s", e)
        return 1

    config, _ = read_config(str(config_path))
    if not config.get("reference_indices"):
        logger.info("No reference_indices in config; nothing to do.")
        return 0

    reader = StatusReader(config)
    result = refresh_reference_indices(config, reader=reader)
    if result.get("errors"):
        for err in result["errors"]:
            logger.warning("Index refresh error: %s", err)
    if result.get("updated"):
        logger.info("Updated indices: %s", result["updated"])
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
