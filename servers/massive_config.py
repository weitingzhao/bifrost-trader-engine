"""Massive (Polygon) API settings from merged YAML + env."""

from __future__ import annotations

import os
from typing import Any, Dict


def get_massive_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    """Return api_key, rest_base, tier, trades_enabled. Key never logged in full."""
    m = config.get("massive") or {}
    api_key = (os.environ.get("MASSIVE_API_KEY") or os.environ.get("POLYGON_API_KEY") or m.get("api_key") or "").strip()
    tier = (m.get("tier") or "starter").strip().lower()
    if tier not in ("starter", "developer"):
        tier = "starter"
    feats = m.get("features") or {}
    trades_default = tier == "developer"
    trades_enabled = bool(feats.get("trades_enabled", trades_default))
    rest_base = (m.get("rest_base") or "https://api.polygon.io").rstrip("/")
    ws_url = (m.get("ws_url") or "wss://socket.polygon.io/options").strip()
    return {
        "api_key": api_key,
        "rest_base": rest_base,
        "ws_url": ws_url,
        "tier": tier,
        "trades_enabled": trades_enabled,
    }


def get_expiration_cache_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    """TTL and behavior for option expiration list (PostgreSQL cache + REST fallback)."""
    m = config.get("massive") or {}
    ec = m.get("expiration_cache") or {}
    return {
        "enabled": bool(ec.get("enabled", True)),
        "ttl_trading_sec": int(ec.get("ttl_trading_sec", 3600)),
        "ttl_off_hours_sec": int(ec.get("ttl_off_hours_sec", 43200)),
        "stale_while_revalidate": bool(ec.get("stale_while_revalidate", True)),
        "beat_batch_size": int(ec.get("beat_batch_size", 12)),
    }


def massive_delay_notice_english() -> str:
    return "Data delayed by 15 minutes (Options Starter). Not for live trading decisions."
