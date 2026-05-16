"""Put/Call Ratio report endpoints — Research API."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, Request

from backend.research.routers.option_discovery import _db_config

router = APIRouter(prefix="/research", tags=["reports"])


@router.get("/put-call-ratio")
def get_putcall_ratio_report(
    request: Request,
    symbol: Optional[str] = Query(None, description="Underlying symbol filter"),
    trade_date_gte: Optional[str] = Query(None, description="Min trade_date YYYY-MM-DD"),
    trade_date_lte: Optional[str] = Query(None, description="Max trade_date YYYY-MM-DD"),
    limit: int = Query(100, ge=1, le=500),
) -> Dict[str, Any]:
    """Query report_option_put_call_ratio_daily (Massive EOD batch)."""
    from src.vendor.massive.reader import get_report_putcall_ratio_rows

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured", "rows": []}
    rows = get_report_putcall_ratio_rows(
        db,
        symbol=symbol,
        trade_date_gte=trade_date_gte,
        trade_date_lte=trade_date_lte,
        limit=limit,
    )
    return {"ok": True, "count": len(rows), "rows": rows}


@router.get("/put-call-ratio/history")
def get_putcall_ratio_history(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol (e.g. NVDA)"),
    lookback_days: int = Query(90, ge=1, le=730, description="Number of calendar days to look back"),
) -> Dict[str, Any]:
    """Time series for PCR chart: ascending by trade_date for charting."""
    from src.vendor.massive.reader import get_report_putcall_ratio_history

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured", "symbol": symbol, "series": []}
    series = get_report_putcall_ratio_history(db, symbol=symbol, lookback_days=lookback_days)
    return {"ok": True, "symbol": symbol.strip().upper(), "count": len(series), "series": series}
