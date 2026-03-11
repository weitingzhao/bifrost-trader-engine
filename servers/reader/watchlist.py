"""Watchlist: conn-based read/write. Used by common.StatusReader."""

import logging
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)


def get_watchlist(conn: Any) -> List[Dict[str, Any]]:
    """Return all watchlist rows (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source, created_at)."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source,
                       extract(epoch from created_at) AS created_at
                FROM watchlist ORDER BY created_at DESC
                """
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as e:
        logger.debug("get_watchlist failed: %s", e)
        return []


def add_watchlist(
    conn: Any,
    contract_key: str,
    symbol: Optional[str] = None,
    sec_type: Optional[str] = None,
    expiry: Optional[str] = None,
    strike: Optional[float] = None,
    option_right: Optional[str] = None,
    display_label: Optional[str] = None,
    source: str = "manual",
) -> bool:
    """Insert or replace watchlist row by contract_key. Returns True on success.
    If contract_key contains no '|', treat as stock symbol and normalize to SYMBOL|STK|||."""
    raw = (contract_key or "").strip()
    if not raw:
        return False
    if "|" not in raw:
        contract_key = f"{raw}|STK|||"
        if symbol is None:
            symbol = raw
        if sec_type is None or sec_type == "":
            sec_type = "STK"
    else:
        contract_key = raw
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO watchlist (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (contract_key) DO UPDATE SET
                    symbol = EXCLUDED.symbol, sec_type = EXCLUDED.sec_type, expiry = EXCLUDED.expiry,
                    strike = EXCLUDED.strike, option_right = EXCLUDED.option_right,
                    display_label = EXCLUDED.display_label, source = EXCLUDED.source
                """,
                (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source),
            )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("add_watchlist failed: %s", e)
        return False


def delete_watchlist(conn: Any, contract_key: Optional[str] = None, id_: Optional[int] = None) -> bool:
    """Delete one watchlist entry by contract_key or id. Returns True on success."""
    try:
        with conn.cursor() as cur:
            if id_ is not None:
                cur.execute("DELETE FROM watchlist WHERE id = %s", (id_,))
            elif contract_key and contract_key.strip():
                cur.execute("DELETE FROM watchlist WHERE contract_key = %s", (contract_key.strip(),))
            else:
                return False
        conn.commit()
        return True
    except Exception as e:
        logger.debug("delete_watchlist failed: %s", e)
        return False
