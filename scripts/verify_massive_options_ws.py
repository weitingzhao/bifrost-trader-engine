#!/usr/bin/env python3
"""
Verify Massive / Polygon Options WebSocket connectivity (Starter tier).

Prerequisites
─────────────
  • A valid Massive (Polygon) API key configured in your YAML config
    (massive.api_key) or via MASSIVE_API_KEY / POLYGON_API_KEY env var.
  • Network access to wss://socket.polygon.io (or the ws_url override).
  • The `websockets` Python package (pip install websockets).

Usage
─────
  python scripts/verify_massive_options_ws.py --config config/config.dev.yaml
  python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel "O:SPY251219C00600000"
  python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --messages 20 --timeout 60

The script connects, authenticates, subscribes to an options channel,
prints the first N messages (default 5), then exits.  A non-zero exit
code means authentication or subscription failed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

logger = logging.getLogger("verify_massive_ws")


def _load_settings(config_path: str | None) -> dict:
    from src.app.config import read_config
    from src.vendor.massive.config import get_massive_settings

    cfg, _ = read_config(config_path)
    return get_massive_settings(cfg)


async def run(
    ws_url: str,
    api_key: str,
    channel: str,
    max_messages: int,
    timeout_sec: float,
) -> bool:
    import websockets

    uri = ws_url
    logger.info("Connecting to %s …", uri)

    async with websockets.connect(uri) as ws:  # type: ignore[attr-defined]
        # Polygon WS sends a welcome message on connect
        welcome = await asyncio.wait_for(ws.recv(), timeout=10)
        welcome_data = json.loads(welcome)
        logger.info("← welcome: %s", json.dumps(welcome_data, indent=2))

        # Authenticate
        auth_msg = json.dumps({"action": "auth", "params": api_key})
        await ws.send(auth_msg)
        logger.info("→ auth sent")

        auth_resp = await asyncio.wait_for(ws.recv(), timeout=10)
        auth_data = json.loads(auth_resp)
        logger.info("← auth response: %s", json.dumps(auth_data, indent=2))

        # Check auth status
        if isinstance(auth_data, list):
            statuses = [m.get("status") for m in auth_data if isinstance(m, dict)]
            if "auth_failed" in statuses:
                logger.error("Authentication FAILED — check API key and tier entitlements.")
                return False
            if "auth_success" not in statuses:
                logger.warning("Unexpected auth response (no auth_success): %s", statuses)

        # Subscribe to channel
        # Polygon options channels: Q (quotes), T (trades), A (aggregates), AM (minute aggs)
        # Starter tier typically allows delayed quotes (Q.*) and aggregates (A.*, AM.*)
        sub_msg = json.dumps({"action": "subscribe", "params": channel})
        await ws.send(sub_msg)
        logger.info("→ subscribe: %s", channel)

        count = 0
        needs_delayed = False
        deadline = asyncio.get_event_loop().time() + timeout_sec
        while count < max_messages:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            data = json.loads(raw)
            count += 1
            logger.info("← message #%d: %s", count, json.dumps(data, indent=2)[:500])
            if isinstance(data, list):
                msgs = [str(m.get("message", "")).lower() for m in data if isinstance(m, dict)]
                if any("delayed" in msg or "don't have access real-time" in msg for msg in msgs):
                    needs_delayed = True
                    break

        if count == 0:
            logger.warning("Timeout reached with no data messages. "
                           "The channel may be inactive outside market hours, "
                           "or your tier may not include this data.")

    if needs_delayed:
        return await _try_delayed(ws_url, api_key, channel, max_messages, timeout_sec)
    return count > 0


async def _try_delayed(
    original_url: str,
    api_key: str,
    channel: str,
    max_messages: int,
    timeout_sec: float,
) -> bool:
    """Fallback: Starter tier often requires wss://delayed.polygon.io/options."""
    import websockets

    delayed_url = original_url.replace("://socket.polygon.io", "://delayed.polygon.io")
    if delayed_url == original_url:
        delayed_url = "wss://delayed.polygon.io/options"
    logger.info("Retrying on delayed endpoint: %s", delayed_url)

    async with websockets.connect(delayed_url) as ws:  # type: ignore[attr-defined]
        welcome = await asyncio.wait_for(ws.recv(), timeout=10)
        logger.info("← welcome: %s", json.dumps(json.loads(welcome), indent=2))

        await ws.send(json.dumps({"action": "auth", "params": api_key}))
        logger.info("→ auth sent")
        auth_resp = await asyncio.wait_for(ws.recv(), timeout=10)
        auth_data = json.loads(auth_resp)
        logger.info("← auth: %s", json.dumps(auth_data, indent=2))
        if isinstance(auth_data, list) and any(
            isinstance(m, dict) and m.get("status") == "auth_failed" for m in auth_data
        ):
            logger.error("Auth failed on delayed endpoint.")
            return False

        await ws.send(json.dumps({"action": "subscribe", "params": channel}))
        logger.info("→ subscribe: %s", channel)

        count = 0
        deadline = asyncio.get_event_loop().time() + timeout_sec
        while count < max_messages:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            data = json.loads(raw)
            count += 1
            logger.info("← delayed #%d: %s", count, json.dumps(data, indent=2)[:500])

        logger.info("Done (delayed) — received %d message(s).", count)
        return count > 0

    logger.info("Done — received %d message(s).", count)
    return count > 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify Massive Options WebSocket")
    parser.add_argument("--config", type=str, default=None, help="Path to YAML config")
    parser.add_argument("--channel", type=str, default=None,
                        help="WS channel to subscribe (default: Q.O:SPY251219C00600000)")
    parser.add_argument("--messages", type=int, default=5, help="Number of messages to capture")
    parser.add_argument("--timeout", type=float, default=30.0, help="Overall timeout in seconds")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s  %(message)s")

    cfg_path = args.config
    if not cfg_path:
        for candidate in ("config/config.dev.yaml", "config/config.prod.yaml"):
            if (Path(_project_root) / candidate).exists():
                cfg_path = str(Path(_project_root) / candidate)
                break

    settings = _load_settings(cfg_path)
    api_key = settings["api_key"]
    ws_url = settings["ws_url"]

    if not api_key:
        logger.error("No Massive API key found. Set massive.api_key in config or MASSIVE_API_KEY env var.")
        sys.exit(1)

    # Default channel: delayed option quotes for a liquid SPY contract
    channel = args.channel or "Q.O:SPY251219C00600000"

    ok = asyncio.run(run(ws_url, api_key, channel, args.messages, args.timeout))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
