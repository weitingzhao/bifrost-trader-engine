"""PostgreSQL helpers for Massive reference tickers (All Tickers → tickers; Overview → ticker_overview)."""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from psycopg2.extras import execute_values

logger = logging.getLogger(__name__)

SYNC_KIND_UNIVERSE = "universe_tickers"

# Columns stored only on ``tickers`` (All Tickers + internal timestamps).
_TICKERS_UPSERT_FIELDS = [
    "ticker",
    "name",
    "market",
    "locale",
    "primary_exchange",
    "instrument_type",
    "active",
    "currency_name",
    "currency_symbol",
    "base_currency_name",
    "base_currency_symbol",
    "cik",
    "composite_figi",
    "share_class_figi",
    "last_updated_utc",
    "delisted_utc",
    "created_at",
    "updated_at",
]

# Overview-only columns on ``ticker_overview``.
_OVERVIEW_UPSERT_FIELDS = [
    "sector",
    "industry",
    "exchange",
    "list_date",
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
    "overview_updated_at",
]


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


def _parse_timestamptz(val: Any) -> Optional[datetime]:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    s = str(val).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
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


def _text_or_empty(val: Any) -> str:
    if val is None:
        return ""
    return str(val).strip()


def row_from_ticker_list_item(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map All Tickers ``results[]`` item → ``tickers`` column dict (no Overview-only fields)."""
    sym = (row.get("ticker") or row.get("symbol") or "").strip().upper()
    if not sym:
        return {}
    pe = (row.get("primary_exchange") or row.get("primary_exchange_mic") or "").strip() or None
    return {
        "ticker": sym,
        "name": (row.get("name") or "").strip() or None,
        "market": (row.get("market") or "").strip() or None,
        "locale": (row.get("locale") or "").strip() or None,
        "primary_exchange": pe,
        "instrument_type": (row.get("type") or "").strip() or None,
        "active": _parse_bool(row.get("active")),
        "currency_name": (row.get("currency_name") or "").strip() or None,
        "currency_symbol": (row.get("currency_symbol") or "").strip() or None,
        "base_currency_name": (row.get("base_currency_name") or "").strip() or None,
        "base_currency_symbol": (row.get("base_currency_symbol") or "").strip() or None,
        "cik": (row.get("cik") or "").strip() or None,
        "composite_figi": (row.get("composite_figi") or "").strip() or None,
        "share_class_figi": (row.get("share_class_figi") or "").strip() or None,
        "last_updated_utc": _parse_timestamptz(row.get("last_updated_utc")),
        "delisted_utc": _parse_timestamptz(row.get("delisted_utc")),
    }


def _detail_fields_from_overview_dict(d: Dict[str, Any]) -> Dict[str, Any]:
    """Overview-only columns from normalized ticker detail body."""
    addr = d.get("address") if isinstance(d.get("address"), dict) else {}
    brand = d.get("branding") if isinstance(d.get("branding"), dict) else {}
    out: Dict[str, Any] = {
        "sector": _text_or_empty(d.get("sector")),
        "industry": _text_or_empty(d.get("industry")),
        "exchange": (d.get("exchange") or "").strip() or None,
        "list_date": _parse_date(d.get("list_date")),
        "ticker_root": (d.get("ticker_root") or "").strip() or None,
        "sic_description": (d.get("sic_description") or "").strip() or None,
        "market_cap": _parse_float(d.get("market_cap")),
        "total_employees": _parse_int(d.get("total_employees")),
        "address_line1": None,
        "address_city": None,
        "address_state": None,
        "postal_code": None,
        "phone": (d.get("phone_number") or d.get("phone") or "").strip() or None,
        "description": None,
        "icon_url": None,
        "logo_url": None,
    }
    if isinstance(addr, dict):
        out["address_line1"] = (addr.get("address1") or addr.get("address_line_1") or "").strip() or None
        out["address_city"] = (addr.get("city") or "").strip() or None
        out["address_state"] = (addr.get("state") or "").strip() or None
        out["postal_code"] = (addr.get("postal_code") or "").strip() or None
    desc = d.get("description")
    if isinstance(desc, str) and desc.strip():
        out["description"] = desc.strip()[:16000]
    if isinstance(brand, dict):
        out["icon_url"] = (brand.get("icon_url") or "").strip() or None
        out["logo_url"] = (brand.get("logo_url") or "").strip() or None
    return out


def row_from_ticker_detail(body: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Map Ticker Overview response → (tickers columns, details columns)."""
    d = _normalize_ticker_detail_body(body)
    if not d:
        return {}, {}
    if not (d.get("ticker") or "").strip():
        return {}, {}
    tickers_part = row_from_ticker_list_item(d)
    if not tickers_part:
        return {}, {}
    det = _detail_fields_from_overview_dict(d)
    now = datetime.now(timezone.utc)
    det["overview_updated_at"] = now
    return tickers_part, det


def upsert_ticker_row(cur: Any, cols: Dict[str, Any]) -> int:
    """Insert or update ``tickers`` by ``ticker``; returns ``tickers_id``."""
    tk = cols.get("ticker")
    if not tk:
        raise ValueError("upsert_ticker_row: ticker required")
    now = datetime.now(timezone.utc)
    cols = dict(cols)
    cols["updated_at"] = now
    if "created_at" not in cols or cols.get("created_at") is None:
        cols["created_at"] = now
    values = []
    for f in _TICKERS_UPSERT_FIELDS:
        values.append(cols.get(f))
    placeholders = ", ".join(["%s"] * len(_TICKERS_UPSERT_FIELDS))
    update_parts = [
        "name = COALESCE(EXCLUDED.name, tickers.name)",
        "market = COALESCE(EXCLUDED.market, tickers.market)",
        "locale = COALESCE(EXCLUDED.locale, tickers.locale)",
        "primary_exchange = COALESCE(EXCLUDED.primary_exchange, tickers.primary_exchange)",
        "instrument_type = COALESCE(EXCLUDED.instrument_type, tickers.instrument_type)",
        "active = COALESCE(EXCLUDED.active, tickers.active)",
        "currency_name = COALESCE(EXCLUDED.currency_name, tickers.currency_name)",
        "currency_symbol = COALESCE(EXCLUDED.currency_symbol, tickers.currency_symbol)",
        "base_currency_name = COALESCE(EXCLUDED.base_currency_name, tickers.base_currency_name)",
        "base_currency_symbol = COALESCE(EXCLUDED.base_currency_symbol, tickers.base_currency_symbol)",
        "cik = COALESCE(EXCLUDED.cik, tickers.cik)",
        "composite_figi = COALESCE(EXCLUDED.composite_figi, tickers.composite_figi)",
        "share_class_figi = COALESCE(EXCLUDED.share_class_figi, tickers.share_class_figi)",
        "last_updated_utc = COALESCE(EXCLUDED.last_updated_utc, tickers.last_updated_utc)",
        "delisted_utc = COALESCE(EXCLUDED.delisted_utc, tickers.delisted_utc)",
        "updated_at = EXCLUDED.updated_at",
    ]
    sql = f"""
        INSERT INTO tickers ({", ".join(_TICKERS_UPSERT_FIELDS)})
        VALUES ({placeholders})
        ON CONFLICT (ticker) DO UPDATE SET
        {", ".join(update_parts)}
        RETURNING tickers_id
    """
    cur.execute(sql, values)
    r = cur.fetchone()
    return int(r[0])


def upsert_ticker_overview_row(cur: Any, tickers_id: int, cols: Dict[str, Any]) -> None:
    """Insert or update ``ticker_overview`` for ``tickers_id``."""
    cols = dict(cols)
    if cols.get("sector") is None:
        cols["sector"] = ""
    if cols.get("industry") is None:
        cols["industry"] = ""
    vals = [tickers_id] + [cols.get(f) for f in _OVERVIEW_UPSERT_FIELDS]
    ph = ", ".join(["%s"] * (1 + len(_OVERVIEW_UPSERT_FIELDS)))
    overview_cols_sql = ", ".join(["tickers_id"] + _OVERVIEW_UPSERT_FIELDS)
    upd = [
        "sector = COALESCE(NULLIF(EXCLUDED.sector, ''), ticker_overview.sector)",
        "industry = COALESCE(NULLIF(EXCLUDED.industry, ''), ticker_overview.industry)",
        "exchange = COALESCE(EXCLUDED.exchange, ticker_overview.exchange)",
        "list_date = COALESCE(EXCLUDED.list_date, ticker_overview.list_date)",
        "ticker_root = COALESCE(EXCLUDED.ticker_root, ticker_overview.ticker_root)",
        "sic_description = COALESCE(EXCLUDED.sic_description, ticker_overview.sic_description)",
        "market_cap = COALESCE(EXCLUDED.market_cap, ticker_overview.market_cap)",
        "total_employees = COALESCE(EXCLUDED.total_employees, ticker_overview.total_employees)",
        "address_line1 = COALESCE(EXCLUDED.address_line1, ticker_overview.address_line1)",
        "address_city = COALESCE(EXCLUDED.address_city, ticker_overview.address_city)",
        "address_state = COALESCE(EXCLUDED.address_state, ticker_overview.address_state)",
        "postal_code = COALESCE(EXCLUDED.postal_code, ticker_overview.postal_code)",
        "phone = COALESCE(EXCLUDED.phone, ticker_overview.phone)",
        "description = COALESCE(EXCLUDED.description, ticker_overview.description)",
        "icon_url = COALESCE(EXCLUDED.icon_url, ticker_overview.icon_url)",
        "logo_url = COALESCE(EXCLUDED.logo_url, ticker_overview.logo_url)",
        "overview_updated_at = COALESCE(EXCLUDED.overview_updated_at, ticker_overview.overview_updated_at)",
    ]
    sql = f"""
        INSERT INTO ticker_overview ({overview_cols_sql})
        VALUES ({ph})
        ON CONFLICT (tickers_id) DO UPDATE SET
        {", ".join(upd)}
    """
    cur.execute(sql, vals)


def get_reference_state(cur: Any, sync_kind: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        """
        SELECT sync_kind, last_cursor, status, updated_at
        FROM job_ticker_reference_state
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
        INSERT INTO job_ticker_reference_state (sync_kind, last_cursor, status, updated_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (sync_kind) DO UPDATE SET
          last_cursor = EXCLUDED.last_cursor,
          status = COALESCE(EXCLUDED.status, job_ticker_reference_state.status),
          updated_at = now()
        """,
        (sync_kind, last_cursor, status),
    )


def replace_ticker_types(cur: Any, rows: List[Dict[str, Any]]) -> int:
    """Replace all rows in ``ticker_types`` with API results."""
    cur.execute("TRUNCATE ticker_types RESTART IDENTITY")
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
        "INSERT INTO ticker_types (code, description, asset_class, locale) VALUES %s",
        batch,
    )
    return len(batch)


def replace_related_for_tickers_id(
    cur: Any,
    from_tickers_id: int,
    related_items: List[Dict[str, Any]],
    fetched_at: datetime,
) -> int:
    cur.execute("DELETE FROM ticker_related_tickers WHERE from_tickers_id = %s", (from_tickers_id,))
    n = 0
    for idx, item in enumerate(related_items):
        if not isinstance(item, dict):
            continue
        tsym = (item.get("ticker") or item.get("symbol") or "").strip().upper()
        if not tsym:
            continue
        cur.execute(
            """
            INSERT INTO ticker_related_tickers (from_tickers_id, to_symbol, rank, fetched_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (from_tickers_id, to_symbol) DO UPDATE SET
              rank = EXCLUDED.rank,
              fetched_at = EXCLUDED.fetched_at
            """,
            (from_tickers_id, tsym, idx, fetched_at),
        )
        n += 1
    return n


def get_tickers_id_for_ticker(cur: Any, ticker: str) -> Optional[int]:
    sym = (ticker or "").strip().upper()
    if not sym:
        return None
    cur.execute("SELECT tickers_id FROM tickers WHERE ticker = %s", (sym,))
    row = cur.fetchone()
    return int(row[0]) if row else None


def search_tickers(cur: Any, q: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Prefix match on ticker preferred; also match name ILIKE. ``q`` trimmed."""
    raw = (q or "").strip()
    if not raw:
        return []
    lim = max(1, min(int(limit), 100))
    sym_prefix = raw.upper()
    cur.execute(
        """
        SELECT t.tickers_id, t.ticker, t.name,
               COALESCE(t.primary_exchange, d.exchange) AS exchange,
               t.primary_exchange, t.instrument_type, t.active
        FROM tickers t
        LEFT JOIN ticker_overview d ON d.tickers_id = t.tickers_id
        WHERE t.ticker ILIKE %s
           OR (t.name IS NOT NULL AND t.name ILIKE %s)
        ORDER BY
          CASE WHEN t.ticker ILIKE %s THEN 0 ELSE 1 END,
          t.ticker
        LIMIT %s
        """,
        (f"{sym_prefix}%", f"%{raw}%", f"{sym_prefix}%", lim),
    )
    out: List[Dict[str, Any]] = []
    for row in cur.fetchall():
        tk = row[1]
        out.append(
            {
                "tickers_id": row[0],
                "ticker": tk,
                "symbol": tk,
                "name": row[2],
                "exchange": row[3],
                "primary_exchange": row[4],
                "instrument_type": row[5],
                "active": row[6],
            }
        )
    return out


def fetch_ticker_detail_merged(cur: Any, ticker: str) -> Optional[Dict[str, Any]]:
    """Single merged dict: ``tickers`` + ``ticker_overview`` (+ ``symbol`` alias)."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return None
    cur.execute(
        """
        SELECT t.*, d.sector, d.industry, d.exchange AS detail_exchange, d.list_date, d.ticker_root,
               d.sic_description, d.market_cap, d.total_employees,
               d.address_line1, d.address_city, d.address_state, d.postal_code,
               d.phone, d.description, d.icon_url, d.logo_url, d.overview_updated_at
        FROM tickers t
        LEFT JOIN ticker_overview d ON d.tickers_id = t.tickers_id
        WHERE t.ticker = %s
        """,
        (sym,),
    )
    row = cur.fetchone()
    desc = cur.description
    if not row or not desc:
        return None
    dct: Dict[str, Any] = {}
    colnames = [desc[i].name for i in range(len(desc))]
    for i, name in enumerate(colnames):
        dct[name] = row[i]
    # Prefer display exchange from detail if tickers.primary_exchange null
    if dct.get("detail_exchange"):
        dct["exchange"] = dct["detail_exchange"]
    elif dct.get("primary_exchange"):
        dct["exchange"] = dct["primary_exchange"]
    dct.pop("detail_exchange", None)
    dct["symbol"] = dct.get("ticker")
    return dct


def fetch_related_with_names(cur: Any, ticker: str) -> Tuple[Optional[int], List[Dict[str, Any]]]:
    """Return ``(from_tickers_id | None, [{ticker, name?, rank}, ...])``."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return None, []
    cur.execute("SELECT tickers_id FROM tickers WHERE ticker = %s", (sym,))
    row = cur.fetchone()
    if not row:
        return None, []
    tid = int(row[0])
    cur.execute(
        """
        SELECT r.to_symbol, r.rank, r.fetched_at, p.name AS peer_name
        FROM ticker_related_tickers r
        LEFT JOIN tickers p ON p.ticker = r.to_symbol
        WHERE r.from_tickers_id = %s
        ORDER BY r.rank ASC, r.to_symbol
        """,
        (tid,),
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
    return tid, out


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
    """Tickers with missing or stale ``ticker_reference_details``."""
    h = max(1, int(stale_hours))
    cur.execute(
        """
        SELECT t.ticker FROM tickers t
        LEFT JOIN ticker_overview d ON d.tickers_id = t.tickers_id
        WHERE d.tickers_id IS NULL
           OR d.overview_updated_at IS NULL
           OR d.overview_updated_at < (now() - (%s * interval '1 hour'))
        ORDER BY t.ticker
        """,
        (h,),
    )
    return [str(r[0]) for r in cur.fetchall() if r and r[0]]


def all_ticker_symbols(cur: Any) -> List[str]:
    cur.execute("SELECT ticker FROM tickers ORDER BY ticker")
    return [str(r[0]) for r in cur.fetchall() if r and r[0]]


def normalize_ticker_ref_kind(kind: str) -> str:
    """Accept legacy ``stock_reference_*`` Celery/API kinds."""
    k = (kind or "").strip().lower()
    legacy = {
        "stock_reference_universe": "ticker_reference_universe",
        "stock_reference_overview": "ticker_reference_overview",
        "stock_reference_related": "ticker_reference_related",
        "stock_reference_instrument_types": "ticker_reference_instrument_types",
    }
    return legacy.get(k, k)
