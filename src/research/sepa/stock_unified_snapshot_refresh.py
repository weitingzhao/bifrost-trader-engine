"""Refresh cache_stock_snapshot from Massive GET /v3/snapshot (stocks, ticker.any_of batches)."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import Json

from src.persistence.postgres.connection import _get_conn_params
from src.vendor.massive.client import MassiveClient
from src.vendor.massive.config import get_massive_settings

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 250
DEFAULT_INTER_CHUNK_SLEEP_SEC = 0.2

_UPSERT_SQL = """
INSERT INTO public.cache_stock_snapshot (
    symbol, fetched_at, updated_at, last_minute_updated, session, last_minute, payload, source
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (symbol) DO UPDATE SET
    fetched_at = EXCLUDED.fetched_at,
    updated_at = EXCLUDED.updated_at,
    last_minute_updated = EXCLUDED.last_minute_updated,
    session = EXCLUDED.session,
    last_minute = EXCLUDED.last_minute,
    payload = EXCLUDED.payload,
    source = EXCLUDED.source
"""


def _db_ok(status_config: Optional[dict]) -> bool:
    if not status_config:
        return False
    return status_config.get("sink") == "postgres" or bool(status_config.get("postgres"))


def _parse_last_minute_updated(last_minute: Any) -> Optional[datetime]:
    if not isinstance(last_minute, dict):
        return None
    for key in ("last_updated", "lastUpdated"):
        v = last_minute.get(key)
        if isinstance(v, str) and v.strip():
            s = v.strip().replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(s)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                continue
    t = last_minute.get("t")
    if t is None:
        return None
    try:
        tv = float(t)
    except (TypeError, ValueError):
        return None
    if tv > 1e17:
        return datetime.fromtimestamp(tv / 1e9, tz=timezone.utc)
    if tv > 1e12:
        return datetime.fromtimestamp(tv / 1000.0, tz=timezone.utc)
    if tv > 1e9:
        return datetime.fromtimestamp(tv, tz=timezone.utc)
    return None


def _load_universe_symbols(status_config: dict) -> List[str]:
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT symbol FROM public.v_sepa_us_equity_universe
                ORDER BY symbol
                """
            )
            rows = cur.fetchall() or []
        return [str(r[0]).strip().upper() for r in rows if r and r[0]]
    finally:
        conn.close()


def run_refresh_cache_stock_unified_snapshots(
    status_config: dict,
    merged_config: dict,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    inter_chunk_sleep_sec: float = DEFAULT_INTER_CHUNK_SLEEP_SEC,
    statement_timeout_ms: int = 600_000,
) -> Dict[str, Any]:
    """Fetch unified stock snapshots for all v_sepa_us_equity_universe symbols; UPSERT into cache_stock_snapshot."""
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    ms = get_massive_settings(merged_config or {})
    if not ms.get("api_key"):
        return {"ok": False, "error": "Massive API key not configured"}

    symbols = _load_universe_symbols(status_config)
    if not symbols:
        return {
            "ok": True,
            "symbols_total": 0,
            "chunks": 0,
            "rows_upserted": 0,
            "errors": [],
            "elapsed_ms": 0,
            "message": "Universe is empty — nothing to refresh.",
        }

    client = MassiveClient(api_key=ms["api_key"], rest_base=str(ms.get("rest_base") or "https://api.polygon.io"))
    chunk_size = max(1, min(int(chunk_size), 250))
    t0 = time.monotonic()
    errors: List[str] = []
    rows_upserted = 0
    chunks = 0

    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = {int(max(5_000, statement_timeout_ms))}")
        conn.commit()

        for i in range(0, len(symbols), chunk_size):
            chunks += 1
            chunk = symbols[i : i + chunk_size]
            tickers_str = ",".join(chunk)
            try:
                snap = client.fetch_unified_snapshot(
                    tickers=tickers_str,
                    asset_type="stocks",
                    limit=250,
                )
            except Exception as exc:
                errors.append(f"chunk {chunks}: {exc}")
                logger.warning("unified snapshot chunk failed: %s", exc)
                time.sleep(max(0.0, float(inter_chunk_sleep_sec)))
                continue

            if snap.get("error"):
                errors.append(f"chunk {chunks}: {snap.get('error')}")
                time.sleep(max(0.0, float(inter_chunk_sleep_sec)))
                continue

            results_list = snap.get("results") or []
            if not isinstance(results_list, list):
                results_list = []

            batch_ts = datetime.now(timezone.utc)
            with conn.cursor() as cur:
                for r in results_list:
                    if not isinstance(r, dict):
                        continue
                    if r.get("error") or r.get("message"):
                        continue
                    typ = (r.get("type") or r.get("asset_type") or "").strip().lower()
                    if typ and typ not in ("stocks", "stock"):
                        continue
                    sym = str(r.get("ticker") or "").strip().upper()
                    if not sym:
                        continue
                    session = r.get("session") if isinstance(r.get("session"), dict) else None
                    last_minute = r.get("last_minute") if isinstance(r.get("last_minute"), dict) else None
                    lmu = _parse_last_minute_updated(last_minute)
                    cur.execute(
                        _UPSERT_SQL,
                        (
                            sym,
                            batch_ts,
                            batch_ts,
                            lmu,
                            Json(session) if session is not None else None,
                            Json(last_minute) if last_minute is not None else None,
                            Json(r),
                            "massive",
                        ),
                    )
                    rows_upserted += 1
            conn.commit()
            time.sleep(max(0.0, float(inter_chunk_sleep_sec)))

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {
            "ok": True,
            "symbols_total": len(symbols),
            "chunks": chunks,
            "rows_upserted": rows_upserted,
            "errors": errors[:20],
            "elapsed_ms": elapsed_ms,
        }
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        logger.warning("run_refresh_cache_stock_unified_snapshots failed: %s", e)
        return {"ok": False, "error": str(e), "errors": errors[:20]}
    finally:
        conn.close()
