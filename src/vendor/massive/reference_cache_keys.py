"""Redis keys for Massive reference-data cache (page/API hot reads).

Namespace mirrors IB ingestor style: data under ``massive:ingestor:cache:*``;
do not mix with ``massive:channel`` / ``massive:meta:*`` (realtime).
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Optional

# TTL seconds
CACHE_TTL_STOCK_SEC = 3600
CACHE_TTL_SEARCH_SEC = 120
CACHE_TTL_INSTRUMENT_TYPES_SEC = 86400
CACHE_TTL_PEERS_SEC = 1800

MASSIVE_INGESTOR_CACHE_PREFIX = "massive:ingestor:cache"


def normalize_symbol(symbol: str) -> str:
    return (symbol or "").strip().upper()


_MAX_Q = 64
_RE_SAFE_SEARCH = re.compile(r"[^a-z0-9._\s\-]")


def normalize_search_key(q: str) -> str:
    s = (q or "").strip().lower()[:_MAX_Q]
    s = _RE_SAFE_SEARCH.sub("", s)
    return s or ""


def key_stock(symbol: str) -> str:
    return f"{MASSIVE_INGESTOR_CACHE_PREFIX}:stock:{normalize_symbol(symbol)}"


def key_search(normalized_q: str) -> str:
    nq = normalize_search_key(normalized_q)
    if not nq:
        return f"{MASSIVE_INGESTOR_CACHE_PREFIX}:search:empty"
    h = hashlib.sha256(nq.encode("utf-8")).hexdigest()[:24]
    return f"{MASSIVE_INGESTOR_CACHE_PREFIX}:search:{h}"


def key_instrument_types(locale: str, asset_class: str) -> str:
    loc = (locale or "*").strip() or "*"
    ac = (asset_class or "*").strip() or "*"
    return f"{MASSIVE_INGESTOR_CACHE_PREFIX}:instrument_types:{loc}:{ac}"


def key_peers(symbol: str) -> str:
    return f"{MASSIVE_INGESTOR_CACHE_PREFIX}:peers:{normalize_symbol(symbol)}"


def invalidate_stock_cache(rds: Any, symbol: str) -> None:
    if not rds:
        return
    try:
        rds.delete(key_stock(symbol))
        rds.delete(key_peers(symbol))
    except Exception:
        pass


def redis_client_from_status_config(cfg: Any) -> Any:
    """Return a decode_responses Redis client, or None if unavailable."""
    if not cfg:
        return None
    try:
        import redis
        from src.core.redis_url import redis_url_from_config

        url = redis_url_from_config(cfg)
        if not url:
            return None
        return redis.from_url(url, decode_responses=True, socket_connect_timeout=2.0)
    except Exception:
        return None


def invalidate_search_caches(rds: Any) -> None:
    """Best-effort: delete search keys matching prefix (use SCAN in production if huge)."""
    if not rds:
        return
    try:
        pattern = f"{MASSIVE_INGESTOR_CACHE_PREFIX}:search:*"
        for k in rds.scan_iter(match=pattern, count=100):
            rds.delete(k)
    except Exception:
        pass
