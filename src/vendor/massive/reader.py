"""Massive job queue (job_massive_backfill) and option bars read helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import date as date_type
from datetime import datetime, time
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2 import ProgrammingError
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)


def canonical_payload_hash(kind: str, payload: Optional[Dict[str, Any]] = None) -> str:
    """Deterministic SHA-256 of kind + payload for job deduplication."""
    canonical = (kind or "").strip() + ":" + json.dumps(payload or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def insert_job_massive_backfill(
    status_config: dict,
    kind: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[int], bool]:
    """Insert pending job_massive_backfill with dedup.

    Returns (job_id, deduplicated).  If an identical pending/running job exists,
    returns that job's id with deduplicated=True instead of inserting a new row.
    """
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None, False
    kind_clean = (kind or "").strip()
    ph = canonical_payload_hash(kind_clean, payload)
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT job_massive_backfill_id FROM job_massive_backfill
                    WHERE kind = %s AND payload_hash = %s AND status IN ('pending', 'running')
                    LIMIT 1
                    """,
                    (kind_clean, ph),
                )
                existing = cur.fetchone()
                if existing:
                    conn.rollback()
                    return int(existing[0]), True

                cur.execute(
                    """
                    INSERT INTO job_massive_backfill (kind, payload, payload_hash, status, created_at, updated_at)
                    VALUES (%s, %s, %s, 'pending', now(), now())
                    RETURNING job_massive_backfill_id
                    """,
                    (kind_clean, json.dumps(payload or {}), ph),
                )
                row = cur.fetchone()
            conn.commit()
            return (int(row[0]) if row else None), False
        finally:
            conn.close()
    except Exception as e:
        logger.warning("insert_job_massive_backfill failed: %s", e)
        return None, False


def get_watchlist_optionable_stk_symbols(status_config: dict) -> List[str]:
    """Distinct STK symbols on watchlist with optionable=true (for Massive EOD scope)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT symbol FROM watchlist
                    WHERE sec_type = 'STK' AND optionable = true AND symbol IS NOT NULL AND trim(symbol) <> ''
                    ORDER BY symbol
                    """
                )
                return [str(r[0]).strip().upper() for r in cur.fetchall() if r and r[0]]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_watchlist_optionable_stk_symbols failed: %s", e)
        return []


def update_job_massive_backfill_celery_task_id(
    status_config: dict, job_id: int, celery_task_id: str
) -> bool:
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE job_massive_backfill
                    SET celery_task_id = %s, updated_at = now()
                    WHERE job_massive_backfill_id = %s
                    """,
                    (celery_task_id, job_id),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_job_massive_backfill_celery_task_id failed: %s", e)
        return False


def get_job_massive_backfill(status_config: dict, job_id: Any) -> Optional[Dict[str, Any]]:
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        jid = int(job_id)
    except (TypeError, ValueError):
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT job_massive_backfill_id, kind, payload, status, result, celery_task_id, created_at, updated_at
                    FROM job_massive_backfill
                    WHERE job_massive_backfill_id = %s
                    """,
                    (jid,),
                )
                row = cur.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("get_job_massive_backfill failed: %s", e)
        return None


def list_job_massive_backfill(
    status_config: dict,
    limit: int = 50,
    offset: int = 0,
    status_filter: Optional[str] = None,
    kind_filter: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Latest Massive sync jobs, newest first."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    lim = max(1, min(int(limit), 100))
    off = max(0, int(offset))
    conditions: List[str] = []
    params_list: List[Any] = []
    if status_filter and str(status_filter).strip():
        conditions.append("status = %s")
        params_list.append(str(status_filter).strip())
    if kind_filter and str(kind_filter).strip():
        conditions.append("kind = %s")
        params_list.append(str(kind_filter).strip().lower())
    where_sql = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"""
        SELECT job_massive_backfill_id, kind, payload, status, result, celery_task_id, created_at, updated_at
        FROM job_massive_backfill
        {where_sql}
        ORDER BY created_at DESC
        LIMIT %s OFFSET %s
    """
    params_list.extend([lim, off])
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(sql, tuple(params_list))
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.warning("list_job_massive_backfill failed: %s", e)
        return []


_VALID_MASSIVE_JOB_STATUS = frozenset({"pending", "running", "done", "failed"})


def delete_job_massive_backfill(status_config: dict, job_id: Any) -> bool:
    """Delete one job_massive_backfill row by id. Returns True if deleted or not found."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        jid = int(job_id)
    except (TypeError, ValueError):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM job_massive_backfill WHERE job_massive_backfill_id = %s",
                    (jid,),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_job_massive_backfill failed: %s", e)
        return False


def delete_all_job_massive_backfill(status_config: dict, status_filter: Optional[str] = None) -> int:
    """Delete all Massive jobs, or only rows matching status. Returns number of rows deleted."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    sf = (status_filter or "").strip().lower()
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                if sf in _VALID_MASSIVE_JOB_STATUS:
                    cur.execute(
                        "DELETE FROM job_massive_backfill WHERE status = %s",
                        (sf,),
                    )
                else:
                    cur.execute("DELETE FROM job_massive_backfill")
                deleted = cur.rowcount
            conn.commit()
            return int(deleted)
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_all_job_massive_backfill failed: %s", e)
        return 0


def trim_job_massive_backfill(status_config: dict, keep: int = 200) -> int:
    """Keep the newest `keep` rows by job_massive_backfill_id; delete older. Returns deleted count."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    k = max(1, min(int(keep), 50_000))
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    WITH kept AS (
                        SELECT job_massive_backfill_id FROM job_massive_backfill
                        ORDER BY job_massive_backfill_id DESC
                        LIMIT %s
                    )
                    DELETE FROM job_massive_backfill
                    WHERE job_massive_backfill_id NOT IN (SELECT job_massive_backfill_id FROM kept)
                    """,
                    (k,),
                )
                deleted = cur.rowcount
            conn.commit()
            return int(deleted)
        finally:
            conn.close()
    except Exception as e:
        logger.warning("trim_job_massive_backfill failed: %s", e)
        return 0


def _publish_massive_job_redis(job_id: int, status: str, result: Optional[Dict[str, Any]] = None) -> None:
    """Optional: notify subscribers (e.g. future WS) when a job reaches a terminal state."""
    try:
        import redis

        from servers.celery_app import broker_url

        r = redis.from_url(broker_url, socket_connect_timeout=2.0)
        r.publish(
            f"massive:job:{job_id}",
            json.dumps({"job_id": job_id, "status": status, "result": result}),
        )
    except Exception:
        pass


def update_job_massive_backfill_result(
    status_config: dict,
    job_id: int,
    status: str,
    result: Optional[Dict[str, Any]] = None,
) -> bool:
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE job_massive_backfill
                    SET status = %s, result = %s, updated_at = now()
                    WHERE job_massive_backfill_id = %s
                    """,
                    (status, json.dumps(result) if result is not None else None, job_id),
                )
            conn.commit()
            if status in ("done", "failed"):
                _publish_massive_job_redis(job_id, status, result)
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_job_massive_backfill_result failed: %s", e)
        return False


def get_option_open_interest_daily(
    status_config: dict,
    symbol: str,
    expiry: Optional[str] = None,
    limit: int = 100,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Latest OI rows for symbol (optional expiry and trade_date range)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if expiry and date_from and date_to:
                    cur.execute(
                        """
                        SELECT contract_key, symbol, expiry, strike, option_right, trade_date, open_interest, source
                        FROM option_open_interest_daily
                        WHERE symbol = %s AND expiry = %s
                          AND trade_date >= %s::date AND trade_date <= %s::date
                        ORDER BY trade_date DESC
                        LIMIT %s
                        """,
                        (sym, expiry.strip(), date_from[:10], date_to[:10], max(1, min(500, limit))),
                    )
                elif expiry:
                    cur.execute(
                        """
                        SELECT contract_key, symbol, expiry, strike, option_right, trade_date, open_interest, source
                        FROM option_open_interest_daily
                        WHERE symbol = %s AND expiry = %s
                        ORDER BY trade_date DESC
                        LIMIT %s
                        """,
                        (sym, expiry.strip(), max(1, min(500, limit))),
                    )
                elif date_from and date_to:
                    cur.execute(
                        """
                        SELECT contract_key, symbol, expiry, strike, option_right, trade_date, open_interest, source
                        FROM option_open_interest_daily
                        WHERE symbol = %s
                          AND trade_date >= %s::date AND trade_date <= %s::date
                        ORDER BY trade_date DESC
                        LIMIT %s
                        """,
                        (sym, date_from[:10], date_to[:10], max(1, min(500, limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT contract_key, symbol, expiry, strike, option_right, trade_date, open_interest, source
                        FROM option_open_interest_daily
                        WHERE symbol = %s
                        ORDER BY trade_date DESC
                        LIMIT %s
                        """,
                        (sym, max(1, min(500, limit))),
                    )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_option_open_interest_daily failed: %s", e)
        return []


def get_option_trades(
    status_config: dict,
    symbol: str,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT contract_key, trade_ts, price, size, exchange, massive_trade_id
                    FROM option_trades
                    WHERE symbol = %s
                    ORDER BY trade_ts DESC
                    LIMIT %s
                    """,
                    (sym, max(1, min(500, limit))),
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_option_trades failed: %s", e)
        return []


def get_option_snapshots_latest(
    status_config: dict,
    contract_keys: List[str],
    source: str = "massive",
) -> List[Dict[str, Any]]:
    """Latest snapshot per contract_key.

    Tries the materialized view ``option_snapshots_latest`` first (fast path).
    Falls back to ``DISTINCT ON`` from the base ``option_snapshots`` table if
    the view does not exist or the query fails.
    """
    if not contract_keys or not status_config or (
        status_config.get("sink") != "postgres" and not status_config.get("postgres")
    ):
        return []
    keys = [k for k in contract_keys if k and str(k).strip()][:120]
    if not keys:
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Try MV first
                mv_ok = False
                try:
                    cur.execute(
                        "SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'option_snapshots_latest' LIMIT 1"
                    )
                    if cur.fetchone():
                        cur.execute(
                            """
                            SELECT contract_key, snapshot_ts, last, bid, ask, mid,
                                   iv, delta, gamma, theta, vega, open_interest, underlying_price, source
                            FROM option_snapshots_latest
                            WHERE contract_key = ANY(%s) AND source = %s
                            """,
                            (keys, source),
                        )
                        mv_ok = True
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass

                if not mv_ok:
                    cur.execute(
                        """
                        SELECT DISTINCT ON (contract_key)
                            contract_key, snapshot_ts, last, bid, ask, mid,
                            iv, delta, gamma, theta, vega, open_interest, underlying_price, source
                        FROM option_snapshots
                        WHERE contract_key = ANY(%s) AND source = %s
                        ORDER BY contract_key, snapshot_ts DESC
                        """,
                        (keys, source),
                    )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_option_snapshots_latest failed: %s", e)
        return []


def get_corporate_actions(
    status_config: dict,
    symbol: str,
    action_type: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Corporate actions from massive_corporate_action, newest ex_date first."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                conditions = ["symbol = %s"]
                args: list = [sym]
                if action_type and action_type.strip():
                    conditions.append("action_type = %s")
                    args.append(action_type.strip().lower())
                where = " AND ".join(conditions)
                args.append(max(1, min(500, limit)))
                cur.execute(
                    f"""
                    SELECT symbol, action_type, ex_date, record_date, payment_date,
                           ratio_from, ratio_to, amount, description, source, created_at
                    FROM massive_corporate_action
                    WHERE {where}
                    ORDER BY ex_date DESC
                    LIMIT %s
                    """,
                    tuple(args),
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_corporate_actions failed: %s", e)
        return []


def _norm_expiry_db(expiry: str) -> str:
    e = (expiry or "").strip()
    if len(e) >= 10 and e[4] == "-":
        return e[:4] + e[5:7] + e[8:10]
    return e


def get_option_bars(
    status_config: dict,
    symbol: str,
    expiry: str,
    strike: float,
    option_right: str,
    period: str,
    source: str = "massive",
    limit: int = 200,
) -> List[Dict[str, Any]]:
    """OHLC for one option contract from option_day (1 D) or option_min."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    per = (period or "1 min").strip()
    sym = (symbol or "").strip().upper()
    exp = _norm_expiry_db(expiry)
    r = (option_right or "").strip().upper()
    if r in ("CALL",):
        r = "C"
    if r in ("PUT",):
        r = "P"
    if not sym or not exp:
        return []
    src = (source or "massive").strip().lower()
    if src not in ("ib", "massive"):
        src = "massive"
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if per.upper() == "1 D":
                    cur.execute(
                        """
                        SELECT extract(epoch from bar_time) AS time, open, high, low, close, volume, source
                        FROM option_day
                        WHERE symbol = %s AND expiry = %s AND strike = %s AND option_right = %s AND source = %s
                        ORDER BY bar_time DESC NULLS LAST
                        LIMIT %s
                        """,
                        (sym, exp, float(strike), r, src, max(1, min(500, limit))),
                    )
                else:
                    cur.execute(
                        """
                        SELECT extract(epoch from bar_time) AS time, open, high, low, close, volume, source
                        FROM option_min
                        WHERE symbol = %s AND expiry = %s AND strike = %s AND option_right = %s
                          AND period = %s AND source = %s
                        ORDER BY bar_time DESC NULLS LAST
                        LIMIT %s
                        """,
                        (sym, exp, float(strike), r, per, src, max(1, min(500, limit))),
                    )
                rows = cur.fetchall()
            return [dict(x) for x in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_option_bars failed: %s", e)
        return []


def count_pending_massive_jobs(status_config: dict) -> int:
    """Count job_massive_backfill rows with status pending or running."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT count(*)::int FROM job_massive_backfill
                    WHERE status IN ('pending', 'running')
                    """
                )
                row = cur.fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except Exception as e:
        logger.debug("count_pending_massive_jobs failed: %s", e)
        return 0


def get_report_max_pain_rows(
    status_config: dict,
    *,
    symbol: Optional[str] = None,
    expiry: Optional[str] = None,
    trade_date_gte: Optional[str] = None,
    trade_date_lte: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Query report_option_max_pain_daily (source=massive)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    lim = max(1, min(int(limit), 500))
    sym = (symbol or "").strip().upper() or None
    exp = (expiry or "").strip() or None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                conds = ["source = 'massive'"]
                args: List[Any] = []
                if sym:
                    conds.append("symbol = %s")
                    args.append(sym)
                if exp:
                    conds.append("expiry = %s")
                    args.append(exp)
                if trade_date_gte:
                    conds.append("trade_date >= %s")
                    args.append(trade_date_gte)
                if trade_date_lte:
                    conds.append("trade_date <= %s")
                    args.append(trade_date_lte)
                where = " AND ".join(conds)
                args.append(lim)
                cur.execute(
                    f"""
                    SELECT report_option_max_pain_daily_id, symbol, expiry, trade_date,
                           max_pain_strike, underlying_close, total_oi, computation_detail, source, created_at
                    FROM report_option_max_pain_daily
                    WHERE {where}
                    ORDER BY trade_date DESC, symbol, expiry
                    LIMIT %s
                    """,
                    tuple(args),
                )
                return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_report_max_pain_rows failed: %s", e)
        return []


def get_report_max_pain_latest_batch(
    status_config: dict,
    *,
    symbol: Optional[str] = None,
    limit: int = 80,
) -> tuple[List[Dict[str, Any]], Optional[str]]:
    """Rows for the latest trade_date present in report_option_max_pain_daily; returns (rows, trade_date_iso)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return [], None
    lim = max(1, min(int(limit), 500))
    sym = (symbol or "").strip().upper() or None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT MAX(trade_date) FROM report_option_max_pain_daily WHERE source = 'massive'"
                )
                r0 = cur.fetchone()
                max_d = r0[0] if r0 else None
                if max_d is None:
                    return [], None
                td = max_d.isoformat() if hasattr(max_d, "isoformat") else str(max_d)
                if sym:
                    cur.execute(
                        """
                        SELECT report_option_max_pain_daily_id, symbol, expiry, trade_date,
                               max_pain_strike, underlying_close, total_oi, computation_detail, source, created_at
                        FROM report_option_max_pain_daily
                        WHERE source = 'massive' AND trade_date = %s AND symbol = %s
                        ORDER BY symbol, expiry
                        LIMIT %s
                        """,
                        (max_d, sym, lim),
                    )
                else:
                    cur.execute(
                        """
                        SELECT report_option_max_pain_daily_id, symbol, expiry, trade_date,
                               max_pain_strike, underlying_close, total_oi, computation_detail, source, created_at
                        FROM report_option_max_pain_daily
                        WHERE source = 'massive' AND trade_date = %s
                        ORDER BY symbol, expiry
                        LIMIT %s
                        """,
                        (max_d, lim),
                    )
                return [dict(r) for r in cur.fetchall()], td
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_report_max_pain_latest_batch failed: %s", e)
        return [], None


def get_massive_daily_checklist_data(
    status_config: dict,
    symbols: List[str],
    trade_date: str,
) -> Dict[str, Any]:
    """Per-symbol daily dimension status for UI checklist (PG + optional Redis WS).

    *trade_date* is the US session calendar date (YYYY-MM-DD) to evaluate against.
    """
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return {"trade_date": trade_date, "symbols": {}, "error": "postgres not configured"}
    syms = [s.strip().upper() for s in symbols if s and str(s).strip()][:80]
    if not syms:
        return {"trade_date": trade_date, "symbols": {}}

    out_symbols: Dict[str, Any] = {}
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for sym in syms:
                    ck_prefix = f"{sym}|OPT|"
                    # Chain snapshot (Massive) on trade_date in America/New_York
                    cur.execute(
                        """
                        SELECT COUNT(*)::int, MAX(snapshot_ts)
                        FROM option_snapshots
                        WHERE source = 'massive'
                          AND contract_key LIKE %s
                          AND (snapshot_ts AT TIME ZONE 'America/New_York')::date = %s::date
                        """,
                        (ck_prefix + "%", trade_date),
                    )
                    snap_row = cur.fetchone()
                    snap_cnt = int(snap_row[0]) if snap_row else 0
                    snap_max = snap_row[1]
                    if snap_cnt > 0:
                        daily_snapshot = {
                            "status": "complete",
                            "rows": snap_cnt,
                            "last_ts": snap_max.isoformat() if snap_max else None,
                        }
                    else:
                        daily_snapshot = {"status": "missing", "rows": 0}

                    cur.execute(
                        """
                        SELECT COUNT(*)::int, MAX(trade_date)
                        FROM option_open_interest_daily
                        WHERE symbol = %s AND source = 'massive' AND trade_date = %s::date
                        """,
                        (sym, trade_date),
                    )
                    oi_row = cur.fetchone()
                    oi_cnt = int(oi_row[0]) if oi_row else 0
                    if oi_cnt > 0:
                        daily_oi = {"status": "complete", "rows": oi_cnt, "trade_date": trade_date}
                    else:
                        cur.execute(
                            """
                            SELECT MAX(trade_date) FROM option_open_interest_daily
                            WHERE symbol = %s AND source = 'massive'
                            """,
                            (sym,),
                        )
                        ld = cur.fetchone()[0]
                        daily_oi = {
                            "status": "missing",
                            "last_trade_date": ld.isoformat() if ld is not None and hasattr(ld, "isoformat") else None,
                        }

                    cur.execute(
                        """
                        SELECT COUNT(*)::int
                        FROM report_option_max_pain_daily
                        WHERE symbol = %s AND source = 'massive' AND trade_date = %s::date
                        """,
                        (sym, trade_date),
                    )
                    mp_cnt = int(cur.fetchone()[0])
                    if mp_cnt > 0:
                        daily_mp = {"status": "complete", "rows": mp_cnt, "trade_date": trade_date}
                    else:
                        daily_mp = {"status": "missing"}

                    cur.execute(
                        """
                        SELECT MAX(created_at) FROM massive_corporate_action
                        WHERE symbol = %s AND source = 'massive'
                        """,
                        (sym,),
                    )
                    mx = cur.fetchone()[0]
                    if mx is not None:
                        from datetime import datetime, timezone

                        now = datetime.now(timezone.utc)
                        if getattr(mx, "tzinfo", None) is None:
                            mx_aware = mx.replace(tzinfo=timezone.utc)
                        else:
                            mx_aware = mx.astimezone(timezone.utc)
                        age_sec = (now - mx_aware).total_seconds()
                        if age_sec <= 7 * 86400:
                            daily_corp = {
                                "status": "complete",
                                "last_sync": mx.isoformat() if hasattr(mx, "isoformat") else str(mx),
                            }
                        else:
                            daily_corp = {
                                "status": "partial",
                                "last_sync": mx.isoformat() if hasattr(mx, "isoformat") else str(mx),
                            }
                    else:
                        daily_corp = {"status": "missing"}

                    out_symbols[sym] = {
                        "daily-snapshot": daily_snapshot,
                        "daily-oi": daily_oi,
                        "daily-max-pain": daily_mp,
                        "daily-corporate": daily_corp,
                    }
        finally:
            conn.close()
    except Exception as e:
        logger.warning("get_massive_daily_checklist_data failed: %s", e)
        return {"trade_date": trade_date, "symbols": out_symbols, "error": str(e)}

    # WS status: global (same for all symbols)
    ws_block: Dict[str, Any] = {"status": "missing", "connected": False}
    try:
        from servers.redis_url import redis_url_from_config

        rurl = redis_url_from_config(status_config)
        if rurl:
            import redis

            r = redis.from_url(rurl, decode_responses=True)
            h = r.hgetall("massive:meta:status")
            if h:
                connected = h.get("connected") == "1"
                lm = h.get("last_msg_ts")
                age_s: Optional[float] = None
                if lm is not None:
                    try:
                        import time as _time

                        age_s = max(0.0, _time.time() - float(lm))
                    except (TypeError, ValueError):
                        age_s = None
                if connected and age_s is not None and age_s < 120:
                    ws_block = {"status": "complete", "connected": True, "last_msg_age_s": age_s}
                elif connected:
                    ws_block = {"status": "degraded", "connected": True, "last_msg_age_s": age_s}
                else:
                    ws_block = {"status": "degraded", "connected": False, "last_msg_age_s": age_s}
    except Exception:
        pass

    for sym in out_symbols:
        out_symbols[sym]["daily-ws-alive"] = dict(ws_block)

    return {"trade_date": trade_date, "symbols": out_symbols}


def get_latest_massive_job_by_kind(
    status_config: dict, kind: str
) -> Optional[Dict[str, Any]]:
    """Latest job row for a given kind (newest first)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    k = (kind or "").strip().lower()
    if not k:
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT job_massive_backfill_id, kind, payload, status, result, celery_task_id, created_at, updated_at
                    FROM job_massive_backfill
                    WHERE kind = %s
                    ORDER BY job_massive_backfill_id DESC
                    LIMIT 1
                    """,
                    (k,),
                )
                row = cur.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_latest_massive_job_by_kind failed: %s", e)
        return None


def _stock_close_on_date(cur: Any, symbol: str, trade_date: date_type) -> Optional[float]:
    """Latest stock_day close on calendar day (if any)."""
    try:
        cur.execute(
            """
            SELECT close FROM stock_day
            WHERE symbol = %s AND (bar_time::date) = %s
            ORDER BY bar_time DESC
            LIMIT 1
            """,
            (symbol, trade_date),
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return float(row[0])
    except Exception:
        pass
    return None


def _recent_corporate_action_flag(cur: Any, symbol: str) -> bool:
    try:
        cur.execute(
            """
            SELECT EXISTS (
              SELECT 1 FROM massive_corporate_action
              WHERE symbol = %s AND source = 'massive'
                AND created_at >= (now() AT TIME ZONE 'utc') - interval '30 days'
            )
            """,
            (symbol,),
        )
        row = cur.fetchone()
        return bool(row and row[0])
    except Exception:
        return False


def compute_max_pain_live_from_db(
    status_config: dict,
    *,
    symbol: str,
    expiry: str,
    trade_date: Optional[str] = None,
) -> Dict[str, Any]:
    """Real-time Max Pain from option_open_interest_daily (no report table)."""
    from servers.reader.max_pain_math import (
        compute_max_pain_curve,
        normalize_expiry_for_oi,
        strike_map_for_expiry,
    )

    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = (symbol or "").strip().upper()
    exp = (expiry or "").strip()
    if not sym or not exp:
        return {"ok": False, "error": "symbol and expiry are required"}
    exp_norm = normalize_expiry_for_oi(exp)
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                td_use: Optional[date_type] = None
                if trade_date and str(trade_date).strip():
                    raw = str(trade_date).strip()[:10]
                    td_use = date_type.fromisoformat(raw)
                else:
                    cur.execute(
                        """
                        SELECT MAX(trade_date) FROM option_open_interest_daily
                        WHERE symbol = %s AND expiry = %s AND source = 'massive'
                        """,
                        (sym, exp_norm),
                    )
                    r0 = cur.fetchone()
                    if r0 and r0[0] is not None:
                        d0 = r0[0]
                        td_use = d0 if isinstance(d0, date_type) else date_type.fromisoformat(str(d0)[:10])
                if td_use is None:
                    return {
                        "ok": False,
                        "error": "No open interest rows for this symbol/expiry",
                        "symbol": sym,
                        "expiry": exp_norm,
                    }

                cur.execute(
                    """
                    SELECT expiry, strike, option_right, open_interest
                    FROM option_open_interest_daily
                    WHERE symbol = %s AND expiry = %s AND trade_date = %s AND source = 'massive'
                    """,
                    (sym, exp_norm, td_use),
                )
                raw_rows = [
                    {"expiry": row[0], "strike": row[1], "option_right": row[2], "open_interest": row[3]}
                    for row in cur.fetchall()
                ]
                skmap = strike_map_for_expiry(raw_rows, exp)
                if not skmap:
                    return {
                        "ok": False,
                        "error": "No OI rows for this expiry on trade_date",
                        "symbol": sym,
                        "expiry": exp_norm,
                        "trade_date": td_use.isoformat(),
                    }
                mp_strike, min_pain, points, total_oi = compute_max_pain_curve(skmap)
                underlying_close = _stock_close_on_date(cur, sym, td_use)
                corp_flag = _recent_corporate_action_flag(cur, sym)
        finally:
            conn.close()
    except Exception as e:
        logger.warning("compute_max_pain_live_from_db failed: %s", e)
        return {"ok": False, "error": str(e)}

    uc = underlying_close
    dist_pct: Optional[float] = None
    if uc is not None and uc > 0:
        dist_pct = abs(float(mp_strike) - float(uc)) / float(uc)

    return {
        "ok": True,
        "symbol": sym,
        "expiry": exp_norm,
        "trade_date": td_use.isoformat(),
        "max_pain_strike": mp_strike,
        "min_pain_value": min_pain,
        "total_oi": total_oi,
        "underlying_close": uc,
        "distance_to_max_pain_pct": dist_pct,
        "pain_by_strike": points,
        "recent_corporate_action": corp_flag,
    }


def compute_max_pain_history_from_db(
    status_config: dict,
    *,
    symbol: str,
    expiry: str,
    lookback_days: int = 90,
) -> Dict[str, Any]:
    """Time series of max pain per trade_date (recomputed from OI; no report table)."""
    from servers.reader.max_pain_math import (
        compute_max_pain_curve,
        normalize_expiry_for_oi,
        strike_map_for_expiry,
    )

    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return {"ok": False, "error": "PostgreSQL not configured", "series": []}
    sym = (symbol or "").strip().upper()
    exp = (expiry or "").strip()
    if not sym or not exp:
        return {"ok": False, "error": "symbol and expiry are required", "series": []}
    exp_norm = normalize_expiry_for_oi(exp)
    lb = max(7, min(int(lookback_days), 365))
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    WITH latest AS (
                      SELECT MAX(trade_date) AS max_td FROM option_open_interest_daily
                      WHERE symbol = %s AND expiry = %s AND source = 'massive'
                    )
                    SELECT o.trade_date, o.expiry, o.strike, o.option_right, o.open_interest
                    FROM option_open_interest_daily o, latest
                    WHERE o.symbol = %s AND o.expiry = %s AND o.source = 'massive'
                      AND latest.max_td IS NOT NULL
                      AND o.trade_date >= (latest.max_td - %s::integer)
                      AND o.trade_date <= latest.max_td
                    ORDER BY o.trade_date, o.strike
                    """,
                    (sym, exp_norm, sym, exp_norm, lb),
                )
                all_rows = cur.fetchall()
                cur.execute(
                    """
                    WITH latest AS (
                      SELECT MAX(trade_date) AS max_td FROM option_open_interest_daily
                      WHERE symbol = %s AND expiry = %s AND source = 'massive'
                    )
                    SELECT (o.bar_time::date) AS trade_date, o.close
                    FROM stock_day o, latest
                    WHERE o.symbol = %s AND latest.max_td IS NOT NULL
                      AND (o.bar_time::date) >= (latest.max_td - %s::integer)
                      AND (o.bar_time::date) <= latest.max_td
                    ORDER BY o.bar_time
                    """,
                    (sym, exp_norm, sym, lb),
                )
                stock_rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("compute_max_pain_history_from_db failed: %s", e)
        return {"ok": False, "error": str(e), "series": []}

    close_by_day: Dict[str, float] = {}
    for r in stock_rows:
        d0 = r[0]
        if d0 is None:
            continue
        d = d0.isoformat()[:10] if hasattr(d0, "isoformat") else str(d0)[:10]
        if r[1] is not None:
            close_by_day[d] = float(r[1])

    by_td: Dict[str, List[Dict[str, Any]]] = {}
    for row in all_rows:
        td0 = row[0]
        if td0 is None:
            continue
        td_s = td0.isoformat()[:10] if hasattr(td0, "isoformat") else str(td0)[:10]
        by_td.setdefault(td_s, []).append(
            {
                "expiry": row[1],
                "strike": row[2],
                "option_right": row[3],
                "open_interest": row[4],
            }
        )

    series: List[Dict[str, Any]] = []
    for td_s in sorted(by_td.keys()):
        raw_rows = by_td[td_s]
        skmap = strike_map_for_expiry(raw_rows, exp)
        if not skmap:
            continue
        mp_strike, _min_p, _pts, tot_oi = compute_max_pain_curve(skmap)
        series.append(
            {
                "trade_date": td_s,
                "max_pain_strike": mp_strike,
                "total_oi": tot_oi,
                "underlying_close": close_by_day.get(td_s),
            }
        )

    return {"ok": True, "symbol": sym, "expiry": exp_norm, "series": series}


def _right_from_ref_contract_type(ct: str) -> str:
    u = (ct or "").upper()
    if u in ("CALL", "C"):
        return "C"
    if u in ("PUT", "P"):
        return "P"
    return "C"


def is_us_equity_regular_session_et(now: Optional[datetime] = None) -> bool:
    """Weekday 09:30–16:00 America/New_York (no holiday calendar)."""
    et = ZoneInfo("America/New_York")
    dt = now or datetime.now(et)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=et)
    else:
        dt = dt.astimezone(et)
    if dt.weekday() >= 5:
        return False
    t = dt.time()
    return time(9, 30) <= t < time(16, 0)


def get_option_expirations_from_contracts_db(status_config: dict, symbol: str) -> List[str]:
    """Distinct expirations (YYYYMMDD) from option_contracts for an underlying."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT expiry FROM option_contracts
                    WHERE symbol = %s
                    ORDER BY expiry
                    """,
                    (sym,),
                )
                return [str(r[0]).strip() for r in cur.fetchall() if r and r[0]]
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_option_expirations_from_contracts_db failed: %s", e)
        return []


def get_strikes_for_expiry_from_contracts_db(
    status_config: dict, symbol: str, expiration: str
) -> List[float]:
    """Distinct strikes for symbol + expiry from option_contracts."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return []
    sym = (symbol or "").strip().upper()
    exp = _norm_expiry_db((expiration or "").strip())
    if not sym or len(exp) != 8 or not exp.isdigit():
        return []
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT strike FROM option_contracts
                    WHERE symbol = %s AND expiry = %s
                    ORDER BY strike
                    """,
                    (sym, exp),
                )
                out: List[float] = []
                for r in cur.fetchall():
                    if r and r[0] is not None:
                        try:
                            out.append(float(r[0]))
                        except (TypeError, ValueError):
                            pass
                return out
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_strikes_for_expiry_from_contracts_db failed: %s", e)
        return []


def get_option_expiration_cache_snapshot(
    status_config: dict, symbol: str, source: str = "massive"
) -> Optional[Tuple[List[str], Optional[datetime]]]:
    """Return (sorted expirations, max updated_at) or None if no rows / table missing."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT expiry, updated_at FROM option_expiration_cache
                    WHERE symbol = %s AND source = %s
                    ORDER BY expiry
                    """,
                    (sym, source),
                )
                rows = cur.fetchall()
            if not rows:
                return None
            exps: List[str] = []
            max_u: Optional[datetime] = None
            for r in rows:
                exps.append(str(r[0]).strip())
                u = r[1]
                if u is not None:
                    if hasattr(u, "tzinfo") and u.tzinfo is None:
                        u = u.replace(tzinfo=ZoneInfo("UTC"))
                    if max_u is None or u > max_u:
                        max_u = u
            return (exps, max_u)
        finally:
            conn.close()
    except ProgrammingError as e:
        if getattr(e, "pgcode", None) == "42P01":
            return None
        logger.debug("get_option_expiration_cache_snapshot: %s", e)
        return None
    except Exception as e:
        logger.debug("get_option_expiration_cache_snapshot failed: %s", e)
        return None


def replace_option_expiration_cache(
    status_config: dict,
    symbol: str,
    expirations: List[str],
    source: str = "massive",
) -> None:
    """Replace full expiration list for a symbol (full-chain refresh)."""
    sym = (symbol or "").strip().upper()
    if not sym or not status_config:
        return
    if not expirations:
        return
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM option_expiration_cache WHERE symbol = %s AND source = %s",
                    (sym, source),
                )
                for raw in expirations:
                    e = _norm_expiry_db(str(raw))
                    if len(e) != 8 or not e.isdigit():
                        continue
                    cur.execute(
                        """
                        INSERT INTO option_expiration_cache (symbol, expiry, source, last_seen_at, updated_at)
                        VALUES (%s, %s, %s, now(), now())
                        """,
                        (sym, e, source),
                    )
            conn.commit()
        finally:
            conn.close()
    except ProgrammingError as e:
        if getattr(e, "pgcode", None) == "42P01":
            return
        logger.warning("replace_option_expiration_cache failed: %s", e)
    except Exception as e:
        logger.warning("replace_option_expiration_cache failed: %s", e)


def upsert_option_contracts_from_reference_rows(
    status_config: dict,
    underlying: str,
    contract_rows: List[Dict[str, Any]],
) -> int:
    """Upsert option_contracts from Polygon reference contract rows."""
    from backend.massive.client import contract_key_from_parts

    underlying = (underlying or "").strip().upper()
    if not contract_rows or not underlying:
        return 0
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    n = 0
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for row in contract_rows:
                    exp = row.get("expiration_date") or row.get("expiration") or ""
                    if not exp:
                        continue
                    ed = _norm_expiry_db(str(exp)[:10])
                    if len(ed) != 8 or not ed.isdigit():
                        continue
                    sp = row.get("strike_price")
                    if sp is None:
                        continue
                    try:
                        strike = float(sp)
                    except (TypeError, ValueError):
                        continue
                    ort = _right_from_ref_contract_type(str(row.get("contract_type") or "call"))
                    ticker = (row.get("ticker") or "").strip() or None
                    ck = contract_key_from_parts(underlying, ed, strike, ort)
                    cur.execute(
                        """
                        INSERT INTO option_contracts (contract_key, symbol, expiry, strike, option_right, massive_option_ticker, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, now())
                        ON CONFLICT (contract_key) DO UPDATE SET
                          massive_option_ticker = COALESCE(EXCLUDED.massive_option_ticker, option_contracts.massive_option_ticker)
                        """,
                        (ck, underlying, ed, strike, ort, ticker),
                    )
                    n += 1
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("upsert_option_contracts_from_reference_rows failed: %s", e)
    return n


def refresh_expirations_from_massive_api(
    status_config: dict,
    config: dict,
    symbol: str,
    expiration_date: Optional[str] = None,
    include_debug: bool = False,
    skip_persist: bool = False,
) -> Dict[str, Any]:
    """Fetch expirations/strikes from Massive REST and persist contracts + expiration cache."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    ms = get_massive_settings(config)
    if not ms["api_key"]:
        return {"expirations": [], "strikes": [], "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    result = client.fetch_expirations_and_strikes(
        symbol,
        include_debug=include_debug,
        expiration_date=expiration_date,
        collect_contract_rows=True,
    )
    if status_config and not result.get("error") and not skip_persist:
        rows = result.get("contract_rows") or []
        try:
            upsert_option_contracts_from_reference_rows(status_config, symbol, rows)
            if not (expiration_date or "").strip():
                replace_option_expiration_cache(status_config, symbol, result.get("expirations") or [], source="massive")
        except Exception as e:
            logger.warning("refresh_expirations_from_massive_api persist failed: %s", e)
    return result


def refresh_expirations_watchlist_batch(
    status_config: dict,
    config: dict,
    symbols: List[str],
    *,
    max_symbols: int = 24,
) -> Dict[str, Any]:
    """Refresh expiration cache + contracts for a batch of underlyings (Celery beat)."""
    from backend.massive.config import get_massive_settings

    ms = get_massive_settings(config)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured", "refreshed": 0}
    syms = [s.strip().upper() for s in symbols if s]
    syms = list(dict.fromkeys(syms))[: max(1, max_symbols)]
    ok = 0
    errors: List[str] = []
    gap = 0.2
    for i, sym in enumerate(syms):
        if i > 0:
            time.sleep(gap)
        try:
            r = refresh_expirations_from_massive_api(
                status_config, config, sym, expiration_date=None, include_debug=False
            )
            if r.get("error"):
                errors.append(f"{sym}: {r.get('error')}")
            else:
                ok += 1
        except Exception as e:
            errors.append(f"{sym}: {e}")
    return {"ok": True, "refreshed": ok, "errors": errors[:20], "batch_size": len(syms)}
