#!/usr/bin/env python3
"""
Debug script to isolate IB connection issues.
Run with: python scripts/debug_connect.py [config_path]
Use --debug for verbose ib_insync logs.
"""

import asyncio
import logging
import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

# Parse args before imports
debug = "--debug" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
config_path = args[0] if args else os.path.join(_PROJECT_ROOT, "config", "config.yaml")
if not os.path.isabs(config_path):
    config_path = os.path.join(_PROJECT_ROOT, config_path)

logging.basicConfig(
    level=logging.DEBUG if debug else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
if debug:
    logging.getLogger("ib_insync").setLevel(logging.DEBUG)

logger = logging.getLogger(__name__)


async def main() -> None:
    import yaml
    from src.connector.ib import IBConnector

    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    ib_cfg = cfg.get("ib", {})
    host = ib_cfg.get("host", "127.0.0.1")
    port = ib_cfg.get("port", 4001)
    client_id = ib_cfg.get("client_id", 1)
    timeout = ib_cfg.get("connect_timeout", 60.0)

    logger.info("Config: %s:%s clientId=%s timeout=%.0fs", host, port, client_id, timeout)
    connector = IBConnector(host=host, port=port, client_id=client_id, connect_timeout=timeout)

    logger.info("Step 1: connect()...")
    ok = await connector.connect()
    if not ok:
        logger.error("Connect failed")
        return

    logger.info("Step 2: get_positions()...")
    positions = await connector.get_positions()
    logger.info("Positions: %s", len(positions))

    logger.info("Step 3: get_underlying_price(NVDA)...")
    spot = await connector.get_underlying_price("NVDA")
    logger.info("NVDA spot: %s", spot)

    logger.info("Step 4: disconnect()...")
    await connector.disconnect()
    logger.info("Done.")


if __name__ == "__main__":
    asyncio.run(main())
