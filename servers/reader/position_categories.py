"""Position categories CRUD: read and write position_categories / position_category_tags."""

import logging
from typing import Any, Dict, List, Optional

from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)


def get_position_categories(conn: Any) -> List[Dict[str, Any]]:
    if conn is None:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, name, description, sort_order, created_at, updated_at
                FROM position_categories
                ORDER BY COALESCE(sort_order, 999), name
                """
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows] if rows else []
    except Exception as e:
        logger.debug("get_position_categories failed: %s", e)
        return []


def create_position_category(
    conn: Any,
    name: str,
    description: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> Optional[int]:
    if not name or not str(name).strip() or conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO position_categories (name, description, sort_order, updated_at)
                VALUES (%s, %s, %s, now())
                RETURNING id
                """,
                (str(name).strip(), (description or "").strip() or None, sort_order),
            )
            row = cur.fetchone()
        conn.commit()
        return int(row[0]) if row and row[0] is not None else None
    except Exception as e:
        logger.debug("create_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return None


def update_position_category(
    conn: Any,
    category_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> bool:
    if conn is None:
        return False
    try:
        updates = ["updated_at = now()"]
        vals: List[Any] = []
        if name is not None:
            updates.append("name = %s")
            vals.append(str(name).strip() if str(name).strip() else None)
        if description is not None:
            updates.append("description = %s")
            vals.append(str(description).strip() or None)
        if sort_order is not None:
            updates.append("sort_order = %s")
            vals.append(sort_order)
        if not vals:
            return True
        vals.append(category_id)
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE position_categories SET {', '.join(updates)} WHERE id = %s",
                tuple(vals),
            )
        conn.commit()
        return True
    except Exception as e:
        logger.debug("update_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def delete_position_category(conn: Any, category_id: int) -> bool:
    if conn is None:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM position_categories WHERE id = %s", (category_id,))
        conn.commit()
        return True
    except Exception as e:
        logger.debug("delete_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def set_position_category_tag(
    conn: Any,
    account_id: str,
    contract_key: str,
    category_id: Optional[int],
) -> bool:
    if not account_id or not str(account_id).strip() or not contract_key or not str(contract_key).strip() or conn is None:
        return False
    try:
        acc = str(account_id).strip()
        ck = str(contract_key).strip()
        with conn.cursor() as cur:
            if category_id is None:
                cur.execute(
                    "DELETE FROM position_category_tags WHERE account_id = %s AND contract_key = %s",
                    (acc, ck),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO position_category_tags (account_id, contract_key, category_id)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (account_id, contract_key) DO UPDATE SET category_id = EXCLUDED.category_id
                    """,
                    (acc, ck, category_id),
                )
        conn.commit()
        return True
    except Exception as e:
        logger.debug("set_position_category_tag failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False
