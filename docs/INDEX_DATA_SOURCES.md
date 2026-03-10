# US Index Data for Watchlist Comparison

For comparing watchlist stocks with US indices (S&P 500 ^GSPC, Dow 30 ^DJI, Nasdaq ^IXIC), the project uses **TradingView (tvDatafeed)** and stores daily bars in **stock_day** with UPSERT so the latest bar is always the final value.

## Requirements (R-A3 extension)

- **Config**: `reference_indices` in config: list of `{ symbol, label, tv_symbol, tv_exchange }`. `symbol` is used in API/DB (e.g. ^GSPC); `tv_symbol`/`tv_exchange` are for tvDatafeed.
- **Storage**: Reuse **stock_day**; same `(symbol, bar_time)` UPSERT (ON CONFLICT DO UPDATE) so each update overwrites the head bar.
- **Update job**: Single script or Celery task; **rate limit**: ≥2s between each symbol request; frequency: daily or every 2–4 hours.
- **Gap-fill after reconnect**: On each run, for each index query DB for `MAX(bar_time)`; if behind expected latest trading day, request enough bars to fill the gap, then always request last 5–10 bars and write (UPSERT).
- **API**: GET /status returns `reference_indices` (symbol + label) so frontend can show a "market" row; GET /bars/benchmark accepts these symbols and returns latest daily close from stock_day.

## TradingView (tvDatafeed) — implemented

- **Status**: Tested and working without login; all three indices return daily bars.
- **Install**: `pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git`
- **Test**: `python scripts/test_tradingview_indices.py`

| Common name | symbol (API/DB) | tv_symbol | tv_exchange |
|-------------|-----------------|-----------|-------------|
| S&P 500     | ^GSPC           | SPX       | CBOE        |
| Dow 30      | ^DJI            | DJI       | TVC         |
| Nasdaq      | ^IXIC           | IXIC      | INDEX       |

- **Rate limit**: ≥2s delay between symbols; run job daily or every 2–4h; retry once on timeout.

## Yahoo Finance (yfinance)

- **Status**: Often 429 Rate Limited; not used. Test: `python scripts/test_yahoo_indices.py`.

## IB (TWS/Gateway)

- **Status**: Not implemented for indices. Would require Index contract (sec_type=IND); same bars pipeline can be extended later.

## Implementation

- **Config**: `config/config.yaml` → `reference_indices` (see example below).
- **Fetch + write**: `servers/index_data_client.py` — fetch from tvDatafeed, gap-fill from DB max(bar_time), convert to rows with `symbol`, `period: "1 D"`, write via `write_ohlc_bars_to_db` (reader) or sink `write_ohlc_bars`.
- **Refresh**: Use **POST /indices/refresh** (Server API). Omit `symbol` to refresh all reference indices from DB config; optional `symbol` to refresh one. Run via cron (e.g. `curl -X POST http://localhost:8765/indices/refresh`) or from frontend/Settings.
- **API**: Server includes `reference_indices` in GET /status from config; frontend merges these symbols into the benchmark request so `/bars/benchmark` returns index closes; Live/Overview can show a "market" row.

## Config example

```yaml
reference_indices:
  - symbol: "^GSPC"
    label: "S&P 500"
    tv_symbol: "SPX"
    tv_exchange: "CBOE"
  - symbol: "^DJI"
    label: "Dow 30"
    tv_symbol: "DJI"
    tv_exchange: "TVC"
  - symbol: "^IXIC"
    label: "Nasdaq"
    tv_symbol: "IXIC"
    tv_exchange: "INDEX"
```

## Cron example (optional)

To refresh indices daily without using the UI, call the API (Server must be running):

```cron
# Daily after US market close (e.g. 22:00 local)
0 22 * * * curl -s -X POST http://localhost:8765/indices/refresh
```

## US market holidays (for "need Pull" display)

The Data page shows "(end)" in yellow only on **US trading days** (exclude weekends and NYSE holidays). Holiday data is stored in the database:

- **Table**: `us_market_holidays` (see docs/DATABASE.md §2.22). Columns: exchange, holiday_date, label.
- **Source**: [NYSE Hours & Holidays](https://www.nyse.com/markets/hours-and-holidays), or [ICE/NYSE press](https://ir.theice.com/press) (e.g. "Holiday and Early Closings Calendar").
- **Management**: Add or delete holidays in **Settings → US market holidays (NYSE)** (or via API: GET/POST/DELETE /market/holidays). When NYSE publishes a new year’s calendar, add those dates in Settings.
- **API**: GET /market/trading-day?date=YYYY-MM-DD returns `{ date, is_trading_day }`; backend uses weekend check + `us_market_holidays` table.
- **Backend option**: For gap/coverage logic that respects trading days, use Python `exchange_calendars` or `pandas_market_calendars` (NYSE calendar) so "gap_end" only triggers after the next trading day.
