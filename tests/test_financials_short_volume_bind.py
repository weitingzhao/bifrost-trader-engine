"""Short volume upsert bind order matches Massive ``GET /stocks/v1/short-volume`` ``results[]`` keys."""

from datetime import date
from unittest.mock import MagicMock

from psycopg2.extras import Json

from src.research.sepa.financials_data import (
    _STOCK_SHORT_VOLUME_UPSERT_BIND_COLUMNS,
    _short_volume_bind_tuple,
    upsert_short_volume_rows,
)


def test_short_volume_sql_placeholder_matches_bind_columns():
    cur = MagicMock()
    row = {
        "ticker": "A",
        "date": "2025-03-25",
        "adf_short_volume": 0,
        "adf_short_volume_exempt": 0,
        "exempt_volume": 1,
        "nasdaq_carteret_short_volume": 179943,
        "nasdaq_carteret_short_volume_exempt": 1,
        "nasdaq_chicago_short_volume": 1,
        "nasdaq_chicago_short_volume_exempt": 0,
        "non_exempt_volume": 181218,
        "nyse_short_volume": 1275,
        "nyse_short_volume_exempt": 0,
        "short_volume": 181219,
        "short_volume_ratio": 31.57,
        "total_volume": 574084,
    }
    upsert_short_volume_rows(cur, [row])
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params)
    assert len(params) == len(_STOCK_SHORT_VOLUME_UPSERT_BIND_COLUMNS)


def test_short_volume_named_slots_align_results_keys():
    row = {
        "ticker": "A",
        "date": "2025-03-25",
        "adf_short_volume": 0,
        "adf_short_volume_exempt": 0,
        "exempt_volume": 1.5,
        "nasdaq_carteret_short_volume": 179943,
        "nasdaq_carteret_short_volume_exempt": 1,
        "nasdaq_chicago_short_volume": 1,
        "nasdaq_chicago_short_volume_exempt": 0,
        "non_exempt_volume": 181218.25,
        "nyse_short_volume": 1275,
        "nyse_short_volume_exempt": 0,
        "short_volume": 181219,
        "short_volume_ratio": 31.57,
        "total_volume": 574084,
    }
    td = date(2025, 3, 25)
    bind = _short_volume_bind_tuple(
        row,
        sym="A",
        td=td,
        ex_js=None,
        cik_v="0001090872",
        source="massive",
    )
    cols = _STOCK_SHORT_VOLUME_UPSERT_BIND_COLUMNS
    assert bind[cols.index("symbol")] == "A"
    assert bind[cols.index("trade_date")] == td
    assert bind[cols.index("adf_short_volume")] == 0
    assert bind[cols.index("exempt_volume")] == 1.5
    assert bind[cols.index("nasdaq_carteret_short_volume")] == 179943
    assert bind[cols.index("non_exempt_volume")] == 181218.25
    assert bind[cols.index("short_volume")] == 181219
    assert bind[cols.index("short_volume_ratio")] == 31.57
    assert bind[cols.index("total_volume")] == 574084
    assert bind[cols.index("cik")] == "0001090872"
    assert bind[cols.index("exchanges")] is None


def test_short_volume_exchanges_json_when_present():
    row = {"ticker": "X", "date": "2025-01-01", "short_volume": 1, "total_volume": 10}
    td = date(2025, 1, 1)
    ex = {"nyse": 1}
    bind = _short_volume_bind_tuple(
        row,
        sym="X",
        td=td,
        ex_js=Json(ex),
        cik_v=None,
        source="massive",
    )
    cols = _STOCK_SHORT_VOLUME_UPSERT_BIND_COLUMNS
    assert isinstance(bind[cols.index("exchanges")], Json)
