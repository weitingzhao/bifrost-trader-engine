"""Massive job queue (job_massive_backfill) and option bars read helpers."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)


def insert_job_massive_backfill(
    status_config: dict,
    kind: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Optional[int]:
    """Insert pending job_massive_backfill. Returns job_massive_backfill_id or None."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO job_massive_backfill (kind, payload, status, created_at, updated_at)
                    VALUES (%s, %s, 'pending', now(), now())
                    RETURNING job_massive_backfill_id
                    """,
                    ((kind or "").strip(), json.dumps(payload or {})),
                )
                row = cur.fetchone()
            conn.commit()
            return int(row[0]) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("insert_job_massive_backfill failed: %s", e)
        return None


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
    """Latest snapshot per contract_key (distinct on)."""
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
