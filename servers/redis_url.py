"""Build redis:// URL from merged status config (same rules as Redis quotes client)."""

from __future__ import annotations

from typing import Any, Dict, Optional


def redis_url_from_config(config: Dict[str, Any]) -> Optional[str]:
    """Return redis URL if redis/realtime enabled; else None."""
    rc = config.get("redis") or {}
    realtime_cfg = config.get("realtime") or {}
    enabled = bool(rc.get("enabled", False) or realtime_cfg.get("enabled", False))
    if not enabled:
        return None
    host = (rc.get("host") or "127.0.0.1").strip()
    port = int(rc.get("port", 6379))
    db = int(rc.get("db", 0))
    password = (rc.get("password") or "").strip()
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"
