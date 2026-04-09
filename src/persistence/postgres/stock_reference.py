"""PostgreSQL helpers for stock reference data (Massive REST → stocks / edges / types)."""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from psycopg2.extras import execute_values

logger = logging.getLogger(__name__)

SYNC_KIND_UNIVERSE = "universe_stocks"


def next_cursor_from_api_response(data: Dict[str, Any]) -> Optional[str]:
    """Extract cursor for GET /v3/reference/tickers next page."""
    nu = data.get("next_url")
    if isinstance(nu, str) and nu.strip():
        qs = parse_qs(urlparse(nu).query)
        cur = qs.get("cursor") or qs.get("c")
        if cur and cur[0]:
            return cur[0].strip()
    nc = data.get("next_cursor")
    if isinstance(nc, str) and nc.strip():
        return nc.strip()
    return None


def _normalize_ticker_detail_body(body: Dict[str, Any]) -> Dict[str, Any]:
    """Polygon v3 reference ticker: single object may be under ``results``."""
    if not isinstance(body, dict):
        return {}
    r = body.get("results")
    if isinstance(r, dict):
        return r
    return body


def _parse_date(val: Any) -> Optional[date]:
    if val is None:
        return None
    s = str(val).strip()
    if len(s) >= 10:
        try:
            return date.fromisoformat(s[:10])
        except ValueError:
            return None
    return None


def _parse_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _parse_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _parse_bool(val: Any) -> Optional[bool]:
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    s = str(val).strip().lower()
    if s in ("true", "1", "yes"):
        return True
    if s in ("false", "0", "no"):
        return False
    return None


def row_from_ticker_list_item(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map All Tickers ``results[]`` item → column dict."""
    sym = (row.get("ticker") or row.get("symbol") or "").strip().upper()
    if not sym:
        return {}
    pe = (row.get("primary_exchange") or row.get("primary_exchange_mic") or "").strip() or None
    ex = pe or (row.get("exchange") or "").strip() or None
    return {
        "symbol": sym,
        "name": (row.get("name") or "").strip() or None,
        "exchange": ex,
        "instrument_type": (row.get("type") or "").strip() or None,
        "active": _parse_bool(row.get("active")),
        "market": (row.get("market") or "").strip() or None,
        "locale": (row.get("locale") or "").strip() or None,
        "primary_exchange": pe,
        "currency_name": (row.get("currency_name") or "").strip() or None,
        "cik": (row.get("cik") or "").strip() or None,
        "composite_figi": (row.get("composite_figi") or "").strip() or None,
        "share_class_figi": (row.get("share_class_figi") or "").strip() or None,
        "list_date": _parse_date(row.get("list_date")),
        "ticker_root": (row.get("ticker_root") or "").strip() or None,
        "sic_description": (row.get("sic_description") or "").strip() or None,
        "market_cap": _parse_float(row.get("market_cap")),
        "total_employees": _parse_int(row.get("total_employees")),
    }


def row_from_ticker_detail(body: Dict[str, Any]) -> Dict[str, Any]:
    """Map Ticker Overview response → column dict (merged with list fields)."""
    d = _normalize_ticker_detail_body(body)
    if not d:
        return {}
    if not (d.get("ticker") or "").strip():
        return {}
    base = row_from_ticker_list_item(d)
    addr = d.get("address") if isinstance(d.get("address"), dict) else {}
    brand = d.get("branding") if isinstance(d.get("branding"), dict) else {}
    out = dict(base)
    if isinstance(addr, dict):
        out["address_line1"] = (addr.get("address1") or addr.get("address_line_1") or "").strip() or None
        out["address_city"] = (addr.get("city") or "").strip() or None
        out["address_state"] = (addr.get("state") or "").strip() or None
        out["postal_code"] = (addr.get("postal_code") or "").strip() or None
    out["phone"] = (d.get("phone_number") or d.get("phone") or "").strip() or None
    desc = d.get("description")
    if isinstance(desc, str) and desc.strip():
        out["description"] = desc.strip()[:16000]
    if isinstance(brand, dict):
        out["icon_url"] = (brand.get("icon_url") or "").strip() or None
        out["logo_url"] = (brand.get("logo_url") or "").strip() or None
    ld = _parse_date(d.get("list_date"))
    if ld:
        out["list_date"] = ld
    mc = _parse_float(d.get("market_cap"))
    if mc is not None:
        out["market_cap"] = mc
    te = _parse_int(d.get("total_employees"))
    if te is not None:
        out["total_employees"] = te
    sic = (d.get("sic_description") or "").strip() or None
    if sic:
        out["sic_description"] = sic
    tr = (d.get("ticker_root") or "").strip() or None
    if tr:
        out["ticker_root"] = tr
    return out


def upsert_stock_row(cur: Any, cols: Dict[str, Any]) -> int:
    """Insert or update ``stocks`` by ``symbol``; returns ``stocks_id``."""
    sym = cols.get("symbol")
    if not sym:
        raise ValueError("upsert_stock_row: symbol required")
    now = datetime.now(timezone.utc)
    cols = dict(cols)
    cols["reference_updated_at"] = now
    fields = [
        "symbol",
        "name",
        "exchange",
        "instrument_type",
        "active",
        "list_date",
        "locale",
        "primary_exchange",
        "market",
        "currency_name",
        "cik",
        "composite_figi",
        "share_class_figi",
        "ticker_root",
        "sic_description",
        "market_cap",
        "total_employees",
        "address_line1",
        "address_city",
        "address_state",
        "postal_code",
        "phone",
        "description",
        "icon_url",
        "logo_url",
        "reference_updated_at",
    ]
    values = []
    for f in fields:
        values.append(cols.get(f))
    placeholders = ", ".join(["%s"] * len(fields))
    update_parts = [
        "name = COALESCE(EXCLUDED.name, stocks.name)",
        "exchange = COALESCE(EXCLUDED.exchange, stocks.exchange)",
        "instrument_type = COALESCE(EXCLUDED.instrument_type, stocks.instrument_type)",
        "active = COALESCE(EXCLUDED.active, stocks.active)",
        "list_date = COALESCE(EXCLUDED.list_date, stocks.list_date)",
        "locale = COALESCE(EXCLUDED.locale, stocks.locale)",
        "primary_exchange = COALESCE(EXCLUDED.primary_exchange, stocks.primary_exchange)",
        "market = COALESCE(EXCLUDED.market, stocks.market)",
        "currency_name = COALESCE(EXCLUDED.currency_name, stocks.currency_name)",
        "cik = COALESCE(EXCLUDED.cik, stocks.cik)",
        "composite_figi = COALESCE(EXCLUDED.composite_figi, stocks.composite_figi)",
        "share_class_figi = COALESCE(EXCLUDED.share_class_figi, stocks.share_class_figi)",
        "ticker_root = COALESCE(EXCLUDED.ticker_root, stocks.ticker_root)",
        "sic_description = COALESCE(EXCLUDED.sic_description, stocks.sic_description)",
        "market_cap = COALESCE(EXCLUDED.market_cap, stocks.market_cap)",
        "total_employees = COALESCE(EXCLUDED.total_employees, stocks.total_employees)",
        "address_line1 = COALESCE(EXCLUDED.address_line1, stocks.address_line1)",
        "address_city = COALESCE(EXCLUDED.address_city, stocks.address_city)",
        "address_state = COALESCE(EXCLUDED.address_state, stocks.address_state)",
        "postal_code = COALESCE(EXCLUDED.postal_code, stocks.postal_code)",
        "phone = COALESCE(EXCLUDED.phone, stocks.phone)",
        "description = COALESCE(EXCLUDED.description, stocks.description)",
        "icon_url = COALESCE(EXCLUDED.icon_url, stocks.icon_url)",
        "logo_url = COALESCE(EXCLUDED.logo_url, stocks.logo_url)",
        "reference_updated_at = EXCLUDED.reference_updated_at",
    ]
    sql = f"""
        INSERT INTO stocks ({", ".join(fields)})
        VALUES ({placeholders})
        ON CONFLICT (symbol) DO UPDATE SET
        {", ".join(update_parts)}
        RETURNING stocks_id
    """
    cur.execute(sql, values)
    r = cur.fetchone()
    return int(r[0])


def get_reference_state(cur: Any, sync_kind: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        """
        SELECT sync_kind, last_cursor, status, updated_at
        FROM job_stock_reference_state
        WHERE sync_kind = %s
        """,
        (sync_kind,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "sync_kind": row[0],
        "last_cursor": row[1],
        "status": row[2],
        "updated_at": row[3],
    }


def upsert_reference_state(cur: Any, sync_kind: str, last_cursor: Optional[str], status: Optional[str] = None) -> None:
    cur.execute(
        """
        INSERT INTO job_stock_reference_state (sync_kind, last_cursor, status, updated_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (sync_kind) DO UPDATE SET
          last_cursor = EXCLUDED.last_cursor,
          status = COALESCE(EXCLUDED.status, job_stock_reference_state.status),
          updated_at = now()
        """,
        (sync_kind, last_cursor, status),
    )


def replace_instrument_types(cur: Any, rows: List[Dict[str, Any]]) -> int:
    """Replace all rows in ``ticker_instrument_types`` with API results."""
    cur.execute("TRUNCATE ticker_instrument_types RESTART IDENTITY")
    if not rows:
        return 0
    batch: List[Tuple[Any, ...]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        code = (r.get("code") or r.get("type") or "").strip()
        if not code:
            continue
        desc = (r.get("description") or "").strip() or None
        ac = (r.get("asset_class") or "").strip() or ""
        loc = (r.get("locale") or "").strip() or ""
        batch.append((code, desc, ac, loc))
    if not batch:
        return 0
    execute_values(
        cur,
        "INSERT INTO ticker_instrument_types (code, description, asset_class, locale) VALUES %s",
        batch,
    )
    return len(batch)


def replace_related_for_stocks_id(
    cur: Any,
    from_stocks_id: int,
    related_items: List[Dict[str, Any]],
    fetched_at: datetime,
) -> int:
    cur.execute("DELETE FROM stock_related_tickers WHERE from_stocks_id = %s", (from_stocks_id,))
    n = 0
    for idx, item in enumerate(related_items):
        if not isinstance(item, dict):
            continue
        tsym = (item.get("ticker") or item.get("symbol") or "").strip().upper()
        if not tsym:
            continue
        cur.execute(
            """
            INSERT INTO stock_related_tickers (from_stocks_id, to_symbol, rank, fetched_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (from_stocks_id, to_symbol) DO UPDATE SET
              rank = EXCLUDED.rank,
              fetched_at = EXCLUDED.fetched_at
            """,
            (from_stocks_id, tsym, idx, fetched_at),
        )
        n += 1
    return n


def get_stocks_id_for_symbol(cur: Any, symbol: str) -> Optional[int]:
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    cur.execute("SELECT stocks_id FROM stocks WHERE symbol = %s", (sym,))
    row = cur.fetchone()
    return int(row[0]) if row else None


def search_stocks(cur: Any, q: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Prefix match on symbol preferred; also match name ILIKE. ``q`` trimmed."""
    raw = (q or "").strip()
    if not raw:
        return []
    lim = max(1, min(int(limit), 100))
    sym_prefix = raw.upper()
    cur.execute(
        """
        SELECT stocks_id, symbol, name, exchange, primary_exchange, instrument_type, active
        FROM stocks
        WHERE symbol ILIKE %s
           OR (name IS NOT NULL AND name ILIKE %s)
        ORDER BY
          CASE WHEN symbol ILIKE %s THEN 0 ELSE 1 END,
          symbol
        LIMIT %s
        """,
        (f"{sym_prefix}%", f"%{raw}%", f"{sym_prefix}%", lim),
    )
    out: List[Dict[str, Any]] = []
    for row in cur.fetchall():
        out.append(
            {
                "stocks_id": row[0],
                "symbol": row[1],
                "name": row[2],
                "exchange": row[3],
                "primary_exchange": row[4],
                "instrument_type": row[5],
                "active": row[6],
            }
        )
    return out


def fetch_stock_detail_dict(cur: Any, symbol: str) -> Optional[Dict[str, Any]]:
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    cur.execute("SELECT * FROM stocks WHERE symbol = %s", (sym,))
    desc = cur.description
    row = cur.fetchone()
    if not row or not desc:
        return None
    return {desc[i].name: row[i] for i in range(len(row))}


def fetch_related_with_names(cur: Any, symbol: str) -> Tuple[Optional[int], List[Dict[str, Any]]]:
    """Return ``(from_stocks_id | None, [{to_symbol, name?, rank}, ...])``."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return None, []
    cur.execute("SELECT stocks_id FROM stocks WHERE symbol = %s", (sym,))
    row = cur.fetchone()
    if not row:
        return None, []
    sid = int(row[0])
    cur.execute(
        """
        SELECT r.to_symbol, r.rank, r.fetched_at, s.name AS peer_name
        FROM stock_related_tickers r
        LEFT JOIN stocks s ON s.symbol = r.to_symbol
        WHERE r.from_stocks_id = %s
        ORDER BY r.rank ASC, r.to_symbol
        """,
        (sid,),
    )
    out: List[Dict[str, Any]] = []
    for rec in cur.fetchall():
        out.append(
            {
                "ticker": rec[0],
                "rank": rec[1],
                "fetched_at": rec[2],
                "name": rec[3],
            }
        )
    return sid, out


def list_instrument_types(cur: Any) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT ticker_instrument_types_id, code, description, asset_class, locale, created_at
        FROM ticker_instrument_types
        ORDER BY asset_class, code, locale
        """
    )
    desc = cur.description
    rows = cur.fetchall()
    if not desc:
        return []
    return [{desc[i].name: r[i] for i in range(len(r))} for r in rows]


def symbols_needing_overview(cur: Any, stale_hours: int = 720) -> List[str]:
    """Symbols with null reference_updated_at or older than ``stale_hours``."""
    h = max(1, int(stale_hours))
    cur.execute(
        """
        SELECT symbol FROM stocks
        WHERE reference_updated_at IS NULL
           OR reference_updated_at < (now() - (%s * interval '1 hour'))
        ORDER BY symbol
        """,
        (h,),
    )
    return [str(r[0]) for r in cur.fetchall() if r and r[0]]


def all_stock_symbols(cur: Any) -> List[str]:
    cur.execute("SELECT symbol FROM stocks ORDER BY symbol")
    return [str(r[0]) for r in cur.fetchall() if r and r[0]]
