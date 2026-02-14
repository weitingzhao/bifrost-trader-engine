#!/usr/bin/env python3
"""Entry point: run the gamma scalping daemon."""

import asyncio
import logging
import os
import sys

# Add project root so "src" and "config" are resolvable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.engine.daemon import run_daemon

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(run_daemon(config_path))
