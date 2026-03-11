"""Settings: IB config, Flex config, key_value groups and key_value. Conn-based and status_config-based APIs."""

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
            with conn.cursor(cursor_factory=RealDictCursor) as cur2:
                cur2.execute(
                    "SELECT ib2_host, ib2_port_type, ib2_client_id_listener, ib2_client_id_account FROM settings WHERE id = 1"
                )
                r2 = cur2.fetchone()
            if r2 and (r2.get("ib2_host") or "").strip():
                out["ib2_host"] = (r2.get("ib2_host") or "").strip()
                out["ib2_port_type"] = (r2.get("ib2_port_type") or "tws_paper").strip().lower()
                out["ib2_client_id_listener"] = int(r2.get("ib2_client_id_listener") or 3)
                out["ib2_client_id_account"] = int(r2.get("ib2_client_id_account") or 102)
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


def get_key_value(conn: Any, key: str) -> Optional[str]:
    """Return value for key from key_value_config (any group)."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM key_value_config WHERE key = %s LIMIT 1", (key,))
            row = cur.fetchone()
            return (row[0].strip() if row and row[0] else None) if row else None
    except Exception as e:
        logger.debug("get_key_value failed: %s", e)
        return None


def get_key_value_in_group(conn: Any, key: str, group_name: str) -> Optional[str]:
    """Return value for key in the group with given name."""
    name = (group_name or "").strip()
    if not name or not (key or "").strip():
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT c.value FROM key_value_config c JOIN key_value_group g ON g.id = c.group_id WHERE g.name = %s AND c.key = %s LIMIT 1",
                (name, key.strip()),
            )
            row = cur.fetchone()
            return (row[0].strip() if row and row[0] else None) if row else None
    except Exception as e:
        logger.debug("get_key_value_in_group failed: %s", e)
        return None


def get_key_value_groups(conn: Any) -> List[Dict[str, Any]]:
    """Return list of {id, name, description, sort_order, created_at, updated_at} from key_value_group."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, name, description, sort_order, created_at, updated_at FROM key_value_group ORDER BY sort_order, id"
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as e:
        logger.debug("get_key_value_groups failed: %s", e)
        return []


def get_key_values_by_group(conn: Any, group_name: str) -> List[Dict[str, Any]]:
    """Return list of {group_id, key, value, description, updated_at} for the group with given name."""
    name = (group_name or "").strip()
    if not name:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT c.group_id, c.key, c.value, c.description, c.updated_at FROM key_value_config c "
                "JOIN key_value_group g ON g.id = c.group_id WHERE g.name = %s ORDER BY c.key",
                (name,),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as e:
        logger.debug("get_key_values_by_group failed: %s", e)
        return []


def get_all_key_values(conn: Any, group_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return list of {group_id, key, value, description, updated_at}. If group_name given, filter by it."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if (group_name or "").strip():
                cur.execute(
                    "SELECT c.group_id, c.key, c.value, c.description, c.updated_at FROM key_value_config c "
                    "JOIN key_value_group g ON g.id = c.group_id WHERE g.name = %s ORDER BY c.key",
                    (group_name.strip(),),
                )
            else:
                cur.execute(
                    "SELECT group_id, key, value, description, updated_at FROM key_value_config ORDER BY group_id, key"
                )
            return [dict(r) for r in cur.fetchall()]
    except Exception as e:
        logger.debug("get_all_key_values failed: %s", e)
        return []


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
) -> bool:
    """Update settings (id=1): ib_host, port_type, client_ids, ib_primary_account_id, ib2_*. Returns True on success."""
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
                primary_val = (ib_primary_account_id or "").strip() or None
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
                    INSERT INTO settings (id, ib_host, ib_port_type, ib_client_id_daemon, ib_client_id_listener, ib_client_id_account, ib_client_id_markets, ib_client_id_worker_market, ib_primary_account_id, ib2_host, ib2_port_type, ib2_client_id_listener, ib2_client_id_account)
                    VALUES (1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                        ib2_client_id_account = EXCLUDED.ib2_client_id_account
                    """,
                    (host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w, primary_val, ib2_h, ib2_pt, cid2_l, cid2_a),
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


def set_key_value(
    status_config: dict,
    key: str,
    value: str,
    description: Optional[str] = None,
    group_name: Optional[str] = None,
) -> bool:
    """Upsert one row in key_value_config. group_name required. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    key = (key or "").strip()
    if not key:
        return False
    name = (group_name or "").strip()
    if not name:
        return False
    value = (value or "").strip() if value is not None else ""
    gid = None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM key_value_group WHERE name = %s", (name,))
                row = cur.fetchone()
                gid = int(row[0]) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("set_key_value resolve group_name failed: %s", e)
        return False
    if gid is None:
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO key_value_config (group_id, key, value, description, updated_at)
                    VALUES (%s, %s, %s, %s, now())
                    ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value,
                        description = COALESCE(NULLIF(EXCLUDED.description, ''), key_value_config.description),
                        updated_at = now()
                    """,
                    (gid, key, value, (description or "").strip() or None),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("set_key_value failed: %s", e)
        return False


def delete_key_value(
    status_config: dict,
    key: str,
    group_name: Optional[str] = None,
) -> bool:
    """Delete one row from key_value_config. group_name required. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    key = (key or "").strip()
    if not key:
        return False
    name = (group_name or "").strip()
    if not name:
        return False
    gid = None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM key_value_group WHERE name = %s", (name,))
                row = cur.fetchone()
                gid = int(row[0]) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_key_value resolve group_name failed: %s", e)
        return False
    if gid is None:
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM key_value_config WHERE group_id = %s AND key = %s", (gid, key))
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_key_value failed: %s", e)
        return False


def create_key_value_group(
    status_config: dict,
    name: str,
    description: Optional[str] = None,
    sort_order: int = 0,
) -> Optional[int]:
    """Insert one row in key_value_group. Returns new id on success, None on failure."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    name = (name or "").strip()
    if not name:
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO key_value_group (name, description, sort_order) VALUES (%s, %s, %s) RETURNING id",
                    (name, (description or "").strip() or None, sort_order),
                )
                row = cur.fetchone()
                new_id = int(row[0]) if row else None
            conn.commit()
            return new_id
        finally:
            conn.close()
    except Exception as e:
        logger.warning("create_key_value_group failed: %s", e)
        return None


def update_key_value_group(
    status_config: dict,
    group_name: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> bool:
    """Update one row in key_value_group. group_name = existing group name. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    gname = (group_name or "").strip()
    if not gname:
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                updates = []
                args = []
                if name is not None:
                    updates.append("name = %s")
                    args.append(name.strip())
                if description is not None:
                    updates.append("description = %s")
                    args.append(description.strip() or None)
                if sort_order is not None:
                    updates.append("sort_order = %s")
                    args.append(sort_order)
                if not updates:
                    return True
                updates.append("updated_at = now()")
                args.append(gname)
                cur.execute(
                    f"UPDATE key_value_group SET {', '.join(updates)} WHERE name = %s",
                    args,
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_key_value_group failed: %s", e)
        return False


def delete_key_value_group(status_config: dict, group_name: str) -> bool:
    """Delete one group and its key_value_config rows. group_name = name to match. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    name = (group_name or "").strip()
    if not name:
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM key_value_group WHERE name = %s", (name,))
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_key_value_group failed: %s", e)
        return False


__all__ = [
    "write_ib_config",
    "write_flex_config",
    "set_key_value",
    "delete_key_value",
    "create_key_value_group",
    "update_key_value_group",
    "delete_key_value_group",
]
