"""Settings: IB config, Flex config. Conn-based and status_config-based APIs."""

import logging
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)

_VALID_IB_PORT_TYPES = frozenset(("tws_live", "tws_paper", "gateway"))


# ----- Conn-based (for common.StatusReader delegation) -----

def get_ib_config(conn: Any) -> Optional[Dict[str, Any]]:
    """Return settings row id=1: ib_host, port_type, client_ids, ib_primary_account_id, ib2_*, flex_default_range_days, flex_init_range_days. None if table missing."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT ib_host, ib_port_type, "
                "COALESCE(ib_client_id_daemon, 1) AS ib_client_id_daemon, "
                "COALESCE(ib_client_id_listener, 2) AS ib_client_id_listener, "
                "COALESCE(ib_client_id_account, 100) AS ib_client_id_account, "
                "COALESCE(ib_client_id_markets, 101) AS ib_client_id_markets, "
                "COALESCE(ib_client_id_worker_market, 500) AS ib_client_id_worker_market, "
                "ib_primary_account_id, flex_default_range_days, flex_init_range_days "
                "FROM settings WHERE id = 1"
            )
            row = cur.fetchone()
        if row is None:
            return None
        out = {
            "ib_host": (row.get("ib_host") or "127.0.0.1").strip(),
            "ib_port_type": (row.get("ib_port_type") or "tws_paper").strip().lower(),
            "ib_client_id_daemon": int(row["ib_client_id_daemon"]) if row.get("ib_client_id_daemon") is not None else 1,
            "ib_client_id_listener": int(row["ib_client_id_listener"]) if row.get("ib_client_id_listener") is not None else 2,
            "ib_client_id_account": int(row["ib_client_id_account"]) if row.get("ib_client_id_account") is not None else 4,
            "ib_client_id_markets": int(row["ib_client_id_markets"]) if row.get("ib_client_id_markets") is not None else 10,
            "ib_client_id_worker_market": int(row["ib_client_id_worker_market"]) if row.get("ib_client_id_worker_market") is not None else 500,
        }
        if row.get("flex_default_range_days") is not None:
            try:
                out["flex_default_range_days"] = max(1, int(row["flex_default_range_days"]))
            except (TypeError, ValueError):
                out["flex_default_range_days"] = 30
        else:
            out["flex_default_range_days"] = 30
        if row.get("flex_init_range_days") is not None:
            try:
                out["flex_init_range_days"] = max(1, int(row["flex_init_range_days"]))
            except (TypeError, ValueError):
                out["flex_init_range_days"] = 360
        else:
            out["flex_init_range_days"] = 360
        if row.get("ib_primary_account_id") is not None and str(row.get("ib_primary_account_id")).strip():
            out["ib_primary_account_id"] = str(row["ib_primary_account_id"]).strip()
        else:
            out["ib_primary_account_id"] = None
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur_s:
                cur_s.execute(
                    "SELECT stream_primary_account_id, stream_secondary_account_id FROM settings WHERE id = 1"
                )
                r_s = cur_s.fetchone()
            if r_s and (r_s.get("stream_primary_account_id") or "").strip():
                out["stream_primary_account_id"] = str(r_s["stream_primary_account_id"]).strip()
            else:
                out["stream_primary_account_id"] = None
            if r_s and (r_s.get("stream_secondary_account_id") or "").strip():
                out["stream_secondary_account_id"] = str(r_s["stream_secondary_account_id"]).strip()
            else:
                out["stream_secondary_account_id"] = None
        except Exception:
            out["stream_primary_account_id"] = None
            out["stream_secondary_account_id"] = None
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur2:
                cur2.execute(
                    "SELECT ib2_host, ib2_port_type, ib2_client_id_listener, ib2_client_id_account FROM settings WHERE id = 1"
                )
                r2 = cur2.fetchone()
            if r2:
                # Always return DB values for client IDs (Settings display and status).
                out["ib2_client_id_listener"] = int(r2.get("ib2_client_id_listener") or 3)
                out["ib2_client_id_account"] = int(r2.get("ib2_client_id_account") or 102)
                if (r2.get("ib2_host") or "").strip():
                    out["ib2_host"] = (r2.get("ib2_host") or "").strip()
                    out["ib2_port_type"] = (r2.get("ib2_port_type") or "tws_paper").strip().lower()
                else:
                    out["ib2_host"] = None
                    out["ib2_port_type"] = None
            else:
                out["ib2_host"] = None
                out["ib2_port_type"] = None
                out["ib2_client_id_listener"] = 3
                out["ib2_client_id_account"] = 102
        except Exception:
            out["ib2_host"] = None
            out["ib2_port_type"] = None
            out["ib2_client_id_listener"] = 3
            out["ib2_client_id_account"] = 102
        return out
    except Exception as e:
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT ib_host, ib_port_type FROM settings WHERE id = 1")
                row = cur.fetchone()
            if row is None:
                return None
            return {
                "ib_host": (row.get("ib_host") or "127.0.0.1").strip(),
                "ib_port_type": (row.get("ib_port_type") or "tws_paper").strip().lower(),
                "ib_client_id_daemon": 1,
                "ib_client_id_listener": 2,
                "ib_client_id_account": 100,
                "ib_client_id_markets": 101,
                "ib_client_id_worker_market": 500,
                "ib_primary_account_id": None,
                "flex_default_range_days": 30,
                "flex_init_range_days": 360,
                "ib2_host": None,
                "ib2_port_type": None,
                "ib2_client_id_listener": 3,
                "ib2_client_id_account": 102,
                "stream_primary_account_id": None,
                "stream_secondary_account_id": None,
            }
        except Exception as e2:
            logger.debug("get_ib_config failed: %s", e2)
            return None


def get_flex_config(conn: Any, purpose: Optional[str] = None) -> Any:
    """If purpose is None: return { host_token, secondary_token, rows }. If purpose is set: return list of { token, query_id, role, query_label, purpose }."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT ib_flex_host_token, ib_flex_secondary_token FROM settings WHERE id = 1"
            )
            settings_row = cur.fetchone()
        host_tok = (settings_row.get("ib_flex_host_token") or "").strip() if settings_row else ""
        sec_tok = (settings_row.get("ib_flex_secondary_token") or "").strip() if settings_row else ""
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if purpose is not None:
                cur.execute(
                    "SELECT query_host_id, query_secondary_id, query_label, purpose FROM flex_accounts WHERE purpose = %s ORDER BY sort_order, id",
                    (purpose,),
                )
            else:
                cur.execute(
                    "SELECT query_host_id, query_secondary_id, query_label, purpose FROM flex_accounts ORDER BY sort_order, id"
                )
            rows = cur.fetchall()
        if purpose is not None:
            out = []
            for r in rows:
                qh_raw = (r.get("query_host_id") or "").strip()
                qs_raw = (r.get("query_secondary_id") or "").strip()
                label = (r.get("query_label") or "").strip()
                purp = (r.get("purpose") or "").strip()
                qh_ids = [x.strip() for x in qh_raw.split(",") if x.strip()]
                qs_ids = [x.strip() for x in qs_raw.split(",") if x.strip()]
                if host_tok:
                    for qid in qh_ids:
                        out.append({"token": host_tok, "query_id": qid, "role": "primary", "query_label": label or None, "purpose": purp or None})
                if sec_tok:
                    for qid in qs_ids:
                        out.append({"token": sec_tok, "query_id": qid, "role": "secondary", "query_label": label or None, "purpose": purp or None})
            return out
        out_rows = []
        for r in rows:
            item = {
                "query_host_id": (r.get("query_host_id") or "").strip(),
                "query_secondary_id": (r.get("query_secondary_id") or "").strip() or None,
            }
            if r.get("query_label") is not None and str(r.get("query_label")).strip():
                item["query_label"] = str(r["query_label"]).strip()
            if r.get("purpose") is not None and str(r.get("purpose")).strip():
                item["purpose"] = str(r["purpose"]).strip()
            out_rows.append(item)
        return {"host_token": host_tok or None, "secondary_token": sec_tok or None, "rows": out_rows}
    except Exception as e:
        logger.debug("get_flex_config failed: %s", e)
        return [] if purpose is not None else {"host_token": None, "secondary_token": None, "rows": []}


def get_flex_default_range_dates(conn: Any) -> Tuple[str, str]:
    """Return (from_date, to_date) in yyyyMMdd for Flex default range. Uses settings.flex_default_range_days; to_date = yesterday."""
    days = 30
    try:
        ib = get_ib_config(conn)
        if ib and ib.get("flex_default_range_days") is not None:
            days = max(1, int(ib["flex_default_range_days"]))
    except Exception:
        pass
    yesterday = date.today() - timedelta(days=1)
    start = yesterday - timedelta(days=days)
    return start.strftime("%Y%m%d"), yesterday.strftime("%Y%m%d")


def get_flex_executions_stats(conn: Any) -> Dict[str, Any]:
    """Return basic stats for executions imported from Flex (source='flex_trades')."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS count,
                    COUNT(DISTINCT account_id) AS accounts,
                    MIN(exec_time)::date AS min_date,
                    MAX(exec_time)::date AS max_date
                FROM account_executions
                WHERE source = %s
                """,
                ("flex_trades",),
            )
            row = cur.fetchone() or {}
        return {
            "count": int(row.get("count") or 0),
            "accounts": int(row.get("accounts") or 0),
            "min_date": row.get("min_date"),
            "max_date": row.get("max_date"),
        }
    except Exception as e:
        logger.warning("get_flex_executions_stats failed: %s", e)
        return {"count": 0, "accounts": 0, "min_date": None, "max_date": None}


def get_flex_init_range_dates(conn: Any) -> Tuple[str, str]:
    """Return (from_date, to_date) in yyyyMMdd for Flex initial/full pull. Uses settings.flex_init_range_days; to_date = yesterday."""
    days = 360
    try:
        ib = get_ib_config(conn)
        if ib and ib.get("flex_init_range_days") is not None:
            days = max(1, int(ib["flex_init_range_days"]))
    except Exception:
        pass
    yesterday = date.today() - timedelta(days=1)
    start = yesterday - timedelta(days=days)
    return start.strftime("%Y%m%d"), yesterday.strftime("%Y%m%d")


# ----- Module-level (status_config) for re-export -----

def write_ib_config(
    status_config: dict,
    ib_host: str,
    ib_port_type: str,
    ib_client_id_daemon: int = 1,
    ib_client_id_listener: int = 2,
    ib_client_id_account: int = 100,
    ib_client_id_markets: int = 101,
    ib_client_id_worker_market: int = 500,
    ib_primary_account_id: Optional[str] = None,
    ib2_host: Optional[str] = None,
    ib2_port_type: Optional[str] = None,
    ib2_client_id_listener: Optional[int] = None,
    ib2_client_id_account: Optional[int] = None,
    stream_primary_account_id: Optional[str] = None,
    stream_secondary_account_id: Optional[str] = None,
) -> bool:
    """Update settings (id=1): ib_host, port_type, client_ids, ib_primary_account_id, ib2_*, stream_*_account_id. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    host = (ib_host or "").strip() or "127.0.0.1"
    port_type = (ib_port_type or "").strip().lower() or "tws_paper"
    if port_type not in _VALID_IB_PORT_TYPES:
        port_type = "tws_paper"
    cid_d = max(1, int(ib_client_id_daemon)) if ib_client_id_daemon is not None else 1
    cid_l = max(1, int(ib_client_id_listener)) if ib_client_id_listener is not None else 2
    cid_a = max(1, int(ib_client_id_account)) if ib_client_id_account is not None else 100
    cid_m = max(1, int(ib_client_id_markets)) if ib_client_id_markets is not None else 101
    cid_w = max(1, int(ib_client_id_worker_market)) if ib_client_id_worker_market is not None else 500
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for col, default in (
                    ("ib_client_id_daemon", 1),
                    ("ib_client_id_listener", 2),
                    ("ib_client_id_account", 100),
                    ("ib_client_id_markets", 101),
                    ("ib_client_id_worker_market", 500),
                ):
                    cur.execute(f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} integer DEFAULT {default}")
                cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_primary_account_id text")
                cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS stream_primary_account_id text")
                cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS stream_secondary_account_id text")
                primary_val = (ib_primary_account_id or "").strip() or None
                stream_primary_val = (stream_primary_account_id or "").strip() or None
                stream_secondary_val = (stream_secondary_account_id or "").strip() or None
                for col, default in (
                    ("ib2_host", "text"),
                    ("ib2_port_type", "text DEFAULT 'tws_paper'"),
                    ("ib2_client_id_listener", "integer DEFAULT 3"),
                    ("ib2_client_id_account", "integer DEFAULT 102"),
                ):
                    cur.execute(f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} {default}")
                cur.execute("ALTER TABLE settings DROP COLUMN IF EXISTS ib2_client_id_markets")
                ib2_h = (ib2_host or "").strip() or None
                ib2_pt = (ib2_port_type or "").strip().lower() or None
                if ib2_pt and ib2_pt not in _VALID_IB_PORT_TYPES:
                    ib2_pt = "tws_paper"
                cid2_l = int(ib2_client_id_listener) if ib2_client_id_listener is not None else 3
                cid2_a = int(ib2_client_id_account) if ib2_client_id_account is not None else 102
                cur.execute(
                    """
                    INSERT INTO settings (id, ib_host, ib_port_type, ib_client_id_daemon, ib_client_id_listener, ib_client_id_account, ib_client_id_markets, ib_client_id_worker_market, ib_primary_account_id, ib2_host, ib2_port_type, ib2_client_id_listener, ib2_client_id_account, stream_primary_account_id, stream_secondary_account_id)
                    VALUES (1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        ib_host = EXCLUDED.ib_host,
                        ib_port_type = EXCLUDED.ib_port_type,
                        ib_client_id_daemon = EXCLUDED.ib_client_id_daemon,
                        ib_client_id_listener = EXCLUDED.ib_client_id_listener,
                        ib_client_id_account = EXCLUDED.ib_client_id_account,
                        ib_client_id_markets = EXCLUDED.ib_client_id_markets,
                        ib_client_id_worker_market = EXCLUDED.ib_client_id_worker_market,
                        ib_primary_account_id = EXCLUDED.ib_primary_account_id,
                        ib2_host = EXCLUDED.ib2_host,
                        ib2_port_type = EXCLUDED.ib2_port_type,
                        ib2_client_id_listener = EXCLUDED.ib2_client_id_listener,
                        ib2_client_id_account = EXCLUDED.ib2_client_id_account,
                        stream_primary_account_id = EXCLUDED.stream_primary_account_id,
                        stream_secondary_account_id = EXCLUDED.stream_secondary_account_id
                    """,
                    (host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w, primary_val, ib2_h, ib2_pt, cid2_l, cid2_a, stream_primary_val, stream_secondary_val),
                )
            conn.commit()
            logger.info(
                "[R-A3] write_ib_config: wrote settings id=1 host=%r port_type=%r",
                host, port_type,
            )
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_ib_config failed: %s", e)
        return False


def write_flex_config(
    status_config: dict,
    host_token: Optional[str],
    secondary_token: Optional[str],
    accounts: List[Dict[str, Any]],
    flex_default_range_days: Optional[int] = None,
    flex_init_range_days: Optional[int] = None,
) -> bool:
    """Write Flex tokens to settings and replace flex_accounts with rows. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                days_val = max(1, int(flex_default_range_days)) if flex_default_range_days is not None else None
                init_val = max(1, int(flex_init_range_days)) if flex_init_range_days is not None else None
                cur.execute(
                    "UPDATE settings SET ib_flex_host_token = %s, ib_flex_secondary_token = %s, "
                    "flex_default_range_days = COALESCE(%s, flex_default_range_days), flex_init_range_days = COALESCE(%s, flex_init_range_days) WHERE id = 1",
                    ((host_token or "").strip() or None, (secondary_token or "").strip() or None, days_val, init_val),
                )
                cur.execute("DELETE FROM flex_accounts")
                for i, a in enumerate(accounts):
                    if not isinstance(a, dict):
                        continue
                    qh = (a.get("query_host_id") or "").strip()
                    if not qh:
                        continue
                    qs = (a.get("query_secondary_id") or "").strip() or None
                    query_label = (a.get("query_label") or "").strip() or None
                    purpose = (a.get("purpose") or "cash_transactions").strip() or "cash_transactions"
                    cur.execute(
                        "INSERT INTO flex_accounts (sort_order, query_label, purpose, query_host_id, query_secondary_id) VALUES (%s, %s, %s, %s, %s)",
                        (i, query_label, purpose, qh, qs),
                    )
            conn.commit()
            logger.info("write_flex_config: wrote tokens to settings and %d Flex row(s)", len([x for x in accounts if isinstance(x, dict) and (x.get("query_host_id") or "").strip()]))
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_flex_config failed: %s", e)
        return False


__all__ = [
    "write_ib_config",
    "write_flex_config",
]
