"""Research: Option Discovery and related endpoints (R-OD1)."""

import json
import traceback
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Query, Request

router = APIRouter(tags=["research"])

MAX_OPTION_SNAPSHOT_CONTRACTS = 20
MAX_OPTION_SNAPSHOT_CONTRACTS_EXTENDED = 60  # when frontend sends many strikes (e.g. 30)
OPTION_SNAPSHOT_STRIKES_AROUND_ATM = 10  # number of strikes to each side of ATM (total 2*N+1 or capped)

DEBUG_LOG_PATH = "/Users/vision-mac-trader/Desktop/stocks/bifrost-trader-engine/.cursor/debug-05a4d1.log"


def _strikes_around_spot(spot: float, count: int = OPTION_SNAPSHOT_STRIKES_AROUND_ATM) -> List[float]:
    """Compute strike list around spot for US equity options. Step $5 for spot < 200, else $10."""
    if not (spot and spot > 0):
        return []
    step = 5.0 if spot < 200 else 10.0
    center = round(spot / step) * step
    strikes_set: set = set()
    for i in range(-count, count + 1):
        s = center + i * step
        if s > 0:
            strikes_set.add(s)
    return sorted(strikes_set)


def _debug_log(session_id: str, hypothesis_id: str, location: str, message: str, data: Dict[str, Any]) -> None:
    # #region agent log
    try:
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "sessionId": session_id,
                        "hypothesisId": hypothesis_id,
                        "location": location,
                        "message": message,
                        "data": data,
                        "timestamp": __import__("time").time() * 1000,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    except Exception:
        pass
    # #endregion


@router.get("/research/option-expirations")
async def get_option_expirations(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol (e.g. NVDA)"),
) -> Dict[str, Any]:
    """R-OD1: Return option expirations and strikes for a symbol (IB reqSecDefOptParams)."""
    symbol = (symbol or "").strip()
    if not symbol:
        return {"symbol": "", "expirations": [], "strikes": [], "error": "symbol is required"}

    client = getattr(request.app.state, "market_ib_client", None)
    if client is None:
        return {
            "symbol": symbol,
            "expirations": [],
            "strikes": [],
            "error": "Market data client not available",
        }
    if not getattr(request.app.state, "monitor_enabled", True):
        return {
            "symbol": symbol,
            "expirations": [],
            "strikes": [],
            "error": "Monitor IB client disabled",
        }

    try:
        await client.ensure_connected()
    except Exception as e:
        return {
            "symbol": symbol,
            "expirations": [],
            "strikes": [],
            "error": f"IB connection failed: {e}",
        }

    # Last price from stock_day (latest daily bar close) for display and strike context
    last_price: Optional[float] = None
    reader = getattr(request.app.state, "reader", None)
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(symbol)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])

    result = await client.fetch_option_expirations(symbol)
    expirations: List[str] = result.get("expirations") or []
    strikes_raw: List[float] = result.get("strikes") or []
    # Filter to valid US equity strikes (avoid 0.5, 1.0 from other chains)
    if last_price is not None and last_price > 0:
        min_s = max(0.5, last_price * 0.01)
        max_s = last_price * 2.5
        strikes = [s for s in strikes_raw if min_s <= s <= max_s]
    else:
        strikes = [s for s in strikes_raw if s >= 5.0]
    strikes = sorted(set(strikes))
    error = result.get("error")
    out: Dict[str, Any] = {"symbol": symbol, "expirations": expirations, "strikes": strikes}
    if last_price is not None:
        out["last_price"] = last_price
    if error:
        out["error"] = error
    return out


@router.post("/research/option-snapshot")
async def post_option_snapshot(
    request: Request,
    body: Dict[str, Any] = Body(..., description="symbol, expiration, optional strikes"),
) -> Dict[str, Any]:
    """OD.3: Fetch option quotes (bid/ask/last/mid) for symbol+expiration with pacing; returns rows + optional underlying_price."""
    # #region agent log
    _debug_log(
        "05a4d1",
        "H1",
        "research.py:post_option_snapshot:entry",
        "option-snapshot request body",
        {"body_keys": list(body.keys()), "symbol": body.get("symbol"), "expiration": body.get("expiration"), "has_strikes": "strikes" in body},
    )
    # #endregion
    symbol = (body.get("symbol") or "").strip()
    expiration = (body.get("expiration") or "").strip()
    if not symbol or not expiration:
        return {
            "symbol": symbol,
            "expiration": expiration,
            "rows": [],
            "error": "symbol and expiration are required",
        }

    client = getattr(request.app.state, "market_ib_client", None)
    if client is None:
        return {
            "symbol": symbol,
            "expiration": expiration,
            "rows": [],
            "error": "Market data client not available",
        }
    if not getattr(request.app.state, "monitor_enabled", True):
        return {
            "symbol": symbol,
            "expiration": expiration,
            "rows": [],
            "error": "Monitor IB client disabled",
        }

    try:
        await client.ensure_connected()
    except Exception as e:
        return {
            "symbol": symbol,
            "expiration": expiration,
            "rows": [],
            "error": f"IB connection failed: {e}",
        }

    strikes_raw = body.get("strikes")
    if isinstance(strikes_raw, list):
        strikes = [float(s) for s in strikes_raw if isinstance(s, (int, float)) and (isinstance(s, bool) is False)]
    else:
        strikes = []
    spot_from_stock_day: Optional[float] = None  # used for strike list and response underlying_price when from stock_day
    if not strikes:
        reader = getattr(request.app.state, "reader", None)
        if reader and hasattr(reader, "get_stock_day_fallback_price"):
            fallback = reader.get_stock_day_fallback_price(symbol)
            if fallback and fallback[0] is not None and fallback[0] > 0:
                spot_from_stock_day = float(fallback[0])
                strikes = _strikes_around_spot(spot_from_stock_day)
        if not strikes:
            result = await client.fetch_option_expirations(symbol)
            strikes = result.get("strikes") or []
    # When frontend sends strikes, allow up to 30 strikes (60 contracts); else cap at 10
    if strikes:
        max_contracts = min(MAX_OPTION_SNAPSHOT_CONTRACTS_EXTENDED, max(MAX_OPTION_SNAPSHOT_CONTRACTS, len(strikes) * 2))
        strikes = strikes[: max_contracts // 2]
    else:
        max_contracts = MAX_OPTION_SNAPSHOT_CONTRACTS

    # #region agent log
    _debug_log(
        "05a4d1",
        "H2",
        "research.py:post_option_snapshot:before_fetch",
        "before fetch_option_snapshot",
        {"symbol": symbol, "expiration": expiration, "strikes_len": len(strikes), "strikes_sample": strikes[:3] if strikes else []},
    )
    # #endregion

    out: Dict[str, Any] = {"symbol": symbol, "expiration": expiration, "rows": []}
    if spot_from_stock_day is not None:
        out["underlying_price"] = spot_from_stock_day
    err: Optional[str] = None
    try:
        rows, underlying_price = await client.fetch_option_snapshot(
            symbol, expiration, strikes, max_contracts=max_contracts, pacing_sec=0.35
        )
        out["rows"] = rows
        if underlying_price is not None:
            out["underlying_price"] = underlying_price
    except Exception as e:
        err = str(e)
        out["error"] = err
        # #region agent log
        _debug_log(
            "05a4d1",
            "H3",
            "research.py:post_option_snapshot:exception",
            "fetch_option_snapshot exception",
            {"error": str(e), "type": type(e).__name__, "traceback": traceback.format_exc()},
        )
        # #endregion

    # #region agent log
    _debug_log(
        "05a4d1",
        "H4",
        "research.py:post_option_snapshot:return",
        "response summary",
        {"out_error": out.get("error"), "rows_count": len(out.get("rows", []))},
    )
    # #endregion
    return out
