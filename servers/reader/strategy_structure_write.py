"""Write strategy_structure and child tables. Used by POST/PUT structures API."""

import logging
from typing import Any, Dict, List, Optional

import psycopg2

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)


def _conn_from_config(status_config: Optional[dict]) -> Any:
    """Open a connection from status_config (postgres). Returns None if config invalid."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        params = _get_conn_params(status_config)
        return psycopg2.connect(**params)
    except Exception as e:
        logger.warning("strategy_structure_write connect failed: %s", e)
        return None


def _insert_legs(cur: Any, strategy_structure_id: int, legs: List[Dict[str, Any]]) -> None:
    for i, leg in enumerate(legs):
        if not isinstance(leg, dict):
            continue
        cur.execute(
            """
            INSERT INTO strategy_structure_leg (
                strategy_structure_id, sort_order, role, direction, option_right,
                quantity, strike, expiration
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                strategy_structure_id,
                i,
                leg.get("role"),
                leg.get("direction"),
                leg.get("option_right"),
                int(leg["quantity"]) if leg.get("quantity") is not None else 1,
                float(leg["strike"]) if leg.get("strike") is not None else None,
                str(leg["expiration"]).strip() if leg.get("expiration") is not None else None,
            ),
        )


def _insert_constraints(cur: Any, strategy_structure_id: int, constraints: List[Dict[str, Any]]) -> None:
    if not constraints or not isinstance(constraints, list):
        return
    for c in constraints:
        if not isinstance(c, dict) or not c.get("constraint_type"):
            continue
        cur.execute(
            """
            INSERT INTO strategy_structure_constraint (
                strategy_structure_id, constraint_type, constraint_value_text, constraint_value_int
            ) VALUES (%s, %s, %s, %s)
            """,
            (
                strategy_structure_id,
                (c.get("constraint_type") or "").strip(),
                c.get("constraint_value_text"),
                int(c["constraint_value_int"]) if c.get("constraint_value_int") is not None else None,
            ),
        )


def _insert_meta(cur: Any, strategy_structure_id: int, meta: List[Dict[str, Any]]) -> None:
    if not meta or not isinstance(meta, list):
        return
    for m in meta:
        if not isinstance(m, dict) or not m.get("meta_key"):
            continue
        cur.execute(
            """
            INSERT INTO strategy_structure_meta (
                strategy_structure_id, meta_key, meta_value_text
            ) VALUES (%s, %s, %s)
            """,
            (
                strategy_structure_id,
                (m.get("meta_key") or "").strip(),
                m.get("meta_value_text"),
            ),
        )


def create_structure(status_config: Optional[dict], payload: Dict[str, Any]) -> Optional[int]:
    """Insert strategy_structure (scalars + notes) and child rows. Returns strategy_structure_id or None."""
    name = (payload.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    structure_type = (payload.get("structure_type") or "").strip()
    if not structure_type:
        raise ValueError("structure_type is required")
    legs = payload.get("legs")
    if legs is None:
        raise ValueError("legs is required")
    if not isinstance(legs, list):
        raise ValueError("legs must be an array")

    version = int(payload["version"]) if payload.get("version") is not None else 1
    is_active = bool(payload["is_active"]) if payload.get("is_active") is not None else True
    notes = (payload.get("notes") or "").strip() or None
    constraints = payload.get("constraints")
    if constraints is not None and not isinstance(constraints, list):
        raise ValueError("constraints must be an array")
    meta = payload.get("meta")
    if meta is not None and not isinstance(meta, list):
        raise ValueError("meta must be an array")

    conn = _conn_from_config(status_config)
    if conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO strategy_structure (
                    name, structure_type, version, is_active, notes
                ) VALUES (%s, %s, %s, %s, %s)
                RETURNING strategy_structure_id
                """,
                (name, structure_type, version, is_active, notes),
            )
            row = cur.fetchone()
            if not row:
                return None
            sid = int(row[0])
            _insert_legs(cur, sid, legs)
            _insert_constraints(cur, sid, constraints or [])
            _insert_meta(cur, sid, meta or [])
        conn.commit()
        return sid
    except (ValueError, TypeError) as e:
        logger.warning("create_structure validation failed: %s", e)
        raise
    except Exception as e:
        logger.warning("create_structure failed: %s", e)
        conn.rollback()
        return None
    finally:
        try:
            conn.close()
        except Exception:
            pass


def update_structure(
    status_config: Optional[dict], strategy_structure_id: int, payload: Dict[str, Any]
) -> bool:
    """Update strategy_structure (scalars + notes) and replace child rows. Returns True on success."""
    name = (payload.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    structure_type = (payload.get("structure_type") or "").strip()
    if not structure_type:
        raise ValueError("structure_type is required")
    legs = payload.get("legs")
    if legs is None:
        raise ValueError("legs is required")
    if not isinstance(legs, list):
        raise ValueError("legs must be an array")

    version = int(payload["version"]) if payload.get("version") is not None else 1
    is_active = bool(payload["is_active"]) if payload.get("is_active") is not None else True
    notes = (payload.get("notes") or "").strip() or None
    constraints = payload.get("constraints")
    if constraints is not None and not isinstance(constraints, list):
        raise ValueError("constraints must be an array")
    meta = payload.get("meta")
    if meta is not None and not isinstance(meta, list):
        raise ValueError("meta must be an array")

    conn = _conn_from_config(status_config)
    if conn is None:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE strategy_structure SET
                    name = %s, structure_type = %s, version = %s, is_active = %s, notes = %s, updated_at = now()
                WHERE strategy_structure_id = %s
                """,
                (name, structure_type, version, is_active, notes, strategy_structure_id),
            )
            if cur.rowcount == 0:
                conn.rollback()
                return False
            cur.execute("DELETE FROM strategy_structure_leg WHERE strategy_structure_id = %s", (strategy_structure_id,))
            cur.execute("DELETE FROM strategy_structure_constraint WHERE strategy_structure_id = %s", (strategy_structure_id,))
            cur.execute("DELETE FROM strategy_structure_meta WHERE strategy_structure_id = %s", (strategy_structure_id,))
            _insert_legs(cur, strategy_structure_id, legs)
            _insert_constraints(cur, strategy_structure_id, constraints or [])
            _insert_meta(cur, strategy_structure_id, meta or [])
        conn.commit()
        return True
    except (ValueError, TypeError) as e:
        logger.warning("update_structure validation failed: %s", e)
        raise
    except Exception as e:
        logger.warning("update_structure failed: %s", e)
        conn.rollback()
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass
