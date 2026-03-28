"""Fetch US index daily bars from TradingView (tvDatafeed) and write to stock_day.

Used by POST /indices/refresh. Rate limit: >=2s between symbols; gap-fill from DB
max(bar_time) then fetch last N bars; UPSERT so head bar is always final value.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Delay between each symbol request to avoid TradingView rate limit / connection drop
DELAY_BETWEEN_SYMBOLS_SEC = 2.0
# Default number of bars to request when no gap (head update only)
DEFAULT_HEAD_BARS = 10
# Max bars per request (tvDatafeed limit)
MAX_BARS = 5000


def _get_expected_latest_date() -> date:
    """Return expected latest trading day (today in UTC; caller may refine to US session)."""
    return date.today()


def _fetch_one_index(
    tv_symbol: str,
    tv_exchange: str,
    n_bars: int,
    retries: int = 2,
) -> List[Dict[str, Any]]:
    """Fetch daily bars for one index from tvDatafeed. Returns list of dicts with bar_time, open, high, low, close, volume."""
    try:
        from tvDatafeed import TvDatafeed, Interval
    except ImportError:
        logger.error("tvDatafeed not installed. Run: pip install --upgrade --no-cache-dir git+https://github.com/rongardF/tvdatafeed.git")
        return []

    tv = TvDatafeed()
    for attempt in range(1, retries + 1):
        try:
            df = tv.get_hist(
                symbol=tv_symbol,
                exchange=tv_exchange,
                interval=Interval.in_daily,
                n_bars=min(n_bars, MAX_BARS),
            )
            if df is None or df.empty:
                return []
            rows: List[Dict[str, Any]] = []
            for i in range(len(df)):
                row = df.iloc[i]
                idx = df.index[i]
                if hasattr(idx, "timestamp"):
                    ts = idx.timestamp()
                elif hasattr(idx, "to_pydatetime"):
                    dt = idx.to_pydatetime()
                    ts = dt.timestamp() if hasattr(dt, "timestamp") else None
                else:
                    ts = None
                if ts is None:
                    continue
                open_ = row.get("open", row.get("Open"))
                high = row.get("high", row.get("High"))
                low = row.get("low", row.get("Low"))
                close = row.get("close", row.get("Close"))
                vol = row.get("volume", row.get("Volume"))
                rows.append({
                    "bar_time": ts,
                    "open": float(open_) if open_ is not None and str(open_) != "nan" else None,
                    "high": float(high) if high is not None and str(high) != "nan" else None,
                    "low": float(low) if low is not None and str(low) != "nan" else None,
                    "close": float(close) if close is not None and str(close) != "nan" else None,
                    "volume": float(vol) if vol is not None and str(vol) != "nan" else None,
                })
            return rows
        except Exception as e:
            logger.warning("tvDatafeed get_hist %s/%s attempt %s/%s: %s", tv_symbol, tv_exchange, attempt, retries, e)
            if attempt < retries:
                time.sleep(DELAY_BETWEEN_SYMBOLS_SEC)
            else:
                return []
    return []


def _bars_to_rows(symbol: str, bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert raw bar dicts to rows for write_ohlc_bars_to_db (symbol, period, bar_time, open, high, low, close, volume)."""
    out: List[Dict[str, Any]] = []
    for b in bars:
        out.append({
            "symbol": symbol,
            "period": "1 D",
            "bar_time": b.get("bar_time"),
            "open": b.get("open"),
            "high": b.get("high"),
            "low": b.get("low"),
            "close": b.get("close"),
            "volume": b.get("volume"),
        })
    return out


def refresh_reference_indices(
    config: Dict[str, Any],
    *,
    reader: Optional[Any] = None,
    delay_sec: float = DELAY_BETWEEN_SYMBOLS_SEC,
) -> Dict[str, Any]:
    """Fetch all reference indices from TradingView and write to stock_day.

    config must contain reference_indices (list of { symbol, label, tv_symbol, tv_exchange }) and postgres.
    Optionally pass a StatusReader(config) to avoid creating one per symbol; otherwise one is created for gap query.
    Returns { "ok": bool, "updated": [symbol, ...], "errors": [str, ...] }.
    """
    indices = config.get("reference_indices") or []
    if not indices:
        return {"ok": True, "updated": [], "errors": []}

    if not config.get("postgres") and not __import__("os").environ.get("PGHOST"):
        return {"ok": False, "updated": [], "errors": ["postgres config required to write index bars"]}

    from src.monitor.reader import StatusReader, write_ohlc_bars_to_db

    if reader is None:
        reader = StatusReader(config)

    updated: List[str] = []
    errors: List[str] = []

    for i, item in enumerate(indices):
        if i > 0:
            time.sleep(delay_sec)

        symbol = (item.get("symbol") or "").strip()
        tv_symbol = (item.get("tv_symbol") or "").strip()
        tv_exchange = (item.get("tv_exchange") or "").strip()
        label = (item.get("label") or symbol) or ""

        if not symbol or not tv_symbol or not tv_exchange:
            errors.append(f"reference_indices entry missing symbol/tv_symbol/tv_exchange: {item}")
            continue

        # Gap-fill: how many bars we might be missing
        last_ts = reader.get_bars_latest(symbol, "1 D")
        expected = _get_expected_latest_date()
        if last_ts is not None:
            last_date = datetime.fromtimestamp(last_ts, tz=timezone.utc).date()
            gap_days = max(0, (expected - last_date).days)
            n_bars = min(MAX_BARS, max(DEFAULT_HEAD_BARS, gap_days + 5))
        else:
            n_bars = min(MAX_BARS, 30)

        bars = _fetch_one_index(tv_symbol, tv_exchange, n_bars)
        if not bars:
            errors.append(f"{label} ({symbol}): no data from TradingView")
            continue

        rows = _bars_to_rows(symbol, bars)
        try:
            write_ohlc_bars_to_db(config, rows)
            updated.append(symbol)
            logger.info("reference_indices: wrote %s bars for %s (%s)", len(rows), symbol, label)
        except Exception as e:
            logger.warning("reference_indices: write failed for %s: %s", symbol, e)
            errors.append(f"{symbol}: {e}")

    return {"ok": len(errors) == 0, "updated": updated, "errors": errors}


def refresh_one_index(
    config: Dict[str, Any],
    symbol: str,
    *,
    days: Optional[int] = None,
    reader: Optional[Any] = None,
) -> Dict[str, Any]:
    """Refresh one reference index by symbol (e.g. ^GSPC). Optional days to override bar count; otherwise gap-based.
    Returns { "ok": bool, "updated": [symbol] or [], "errors": [str] }."""
    indices = config.get("reference_indices") or []
    sym = (symbol or "").strip()
    if not sym:
        return {"ok": False, "updated": [], "errors": ["symbol required"]}
    item = next((i for i in indices if (i.get("symbol") or "").strip() == sym), None)
    if not item:
        return {"ok": False, "updated": [], "errors": [f"symbol {sym} not in reference_indices"]}
    if not config.get("postgres") and not __import__("os").environ.get("PGHOST"):
        return {"ok": False, "updated": [], "errors": ["postgres config required"]}
    from src.monitor.reader import StatusReader, write_ohlc_bars_to_db
    if reader is None:
        reader = StatusReader(config)
    tv_symbol = (item.get("tv_symbol") or "").strip()
    tv_exchange = (item.get("tv_exchange") or "").strip()
    label = (item.get("label") or sym) or ""
    if not tv_symbol or not tv_exchange:
        return {"ok": False, "updated": [], "errors": [f"reference_indices entry for {sym} missing tv_symbol/tv_exchange"]}
    if days is not None and days > 0:
        n_bars = min(MAX_BARS, max(1, int(days)))
    else:
        last_ts = reader.get_bars_latest(sym, "1 D")
        expected = _get_expected_latest_date()
        if last_ts is not None:
            last_date = datetime.fromtimestamp(last_ts, tz=timezone.utc).date()
            gap_days = max(0, (expected - last_date).days)
            n_bars = min(MAX_BARS, max(DEFAULT_HEAD_BARS, gap_days + 5))
        else:
            n_bars = min(MAX_BARS, 30)
    bars = _fetch_one_index(tv_symbol, tv_exchange, n_bars)
    if not bars:
        return {"ok": False, "updated": [], "errors": [f"{label} ({sym}): no data from TradingView"]}
    rows = _bars_to_rows(sym, bars)
    try:
        write_ohlc_bars_to_db(config, rows)
        logger.info("reference_indices: wrote %s bars for %s (%s)", len(rows), sym, label)
        return {"ok": True, "updated": [sym], "errors": []}
    except Exception as e:
        logger.warning("reference_indices: write failed for %s: %s", sym, e)
        return {"ok": False, "updated": [], "errors": [f"{sym}: {e}"]}
