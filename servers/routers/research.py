"""Research: Option Discovery and related endpoints (R-OD1)."""

import asyncio
import json
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter(tags=["research"])

MAX_OPTION_SNAPSHOT_CONTRACTS = 20
MAX_OPTION_SNAPSHOT_CONTRACTS_EXTENDED = 60  # when frontend sends many strikes (e.g. 30)
OPTION_SNAPSHOT_STRIKES_AROUND_ATM = 10  # number of strikes to each side of ATM (total 2*N+1 or capped)


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


def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


def _norm_expiry_key(expiration: str) -> str:
    e = (expiration or "").strip()
    if len(e) >= 10 and e[4] == "-":
        return e[:4] + e[5:7] + e[8:10]
    return e


def _parse_strikes_csv(strikes: Optional[str]) -> List[float]:
    if not strikes or not str(strikes).strip():
        return []
    out: List[float] = []
    for part in str(strikes).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except ValueError:
            pass
    return out


def _parse_contract_key(ck: str) -> Tuple[Optional[float], Optional[str]]:
    parts = (ck or "").split("|")
    if len(parts) >= 5:
        try:
            return float(parts[3]), parts[4]
        except (TypeError, ValueError):
            return None, None
    return None, None


def _massive_job_to_api(j: Dict[str, Any]) -> Dict[str, Any]:
    created_ts = j.get("created_at")
    if hasattr(created_ts, "timestamp"):
        created_ts = created_ts.timestamp()
    updated_ts = j.get("updated_at")
    if hasattr(updated_ts, "timestamp"):
        updated_ts = updated_ts.timestamp()
    res = j.get("result")
    if isinstance(res, str):
        try:
            res = json.loads(res)
        except json.JSONDecodeError:
            pass
    return {
        "job_id": str(j.get("job_massive_backfill_id", "")),
        "type": "massive_backfill",
        "kind": j.get("kind"),
        "status": j.get("status"),
        "result": res,
        "celery_task_id": j.get("celery_task_id"),
        "created_ts": created_ts,
        "updated_ts": updated_ts,
    }


def _filter_option_strikes(strikes_raw: List[float], last_price: Optional[float]) -> List[float]:
    if last_price is not None and last_price > 0:
        min_s = max(0.5, last_price * 0.01)
        max_s = last_price * 2.5
        strikes = [s for s in strikes_raw if min_s <= s <= max_s]
    else:
        strikes = [s for s in strikes_raw if s >= 5.0]
    return sorted(set(strikes))


async def _option_expirations_ib(request: Request, symbol: str) -> Dict[str, Any]:
    """IB reqSecDefOptParams; same shape as legacy /research/option-expirations."""
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

    last_price: Optional[float] = None
    reader = getattr(request.app.state, "reader", None)
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(symbol)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])

    result = await client.fetch_option_expirations(symbol)
    expirations: List[str] = result.get("expirations") or []
    strikes_raw: List[float] = result.get("strikes") or []
    strikes = _filter_option_strikes(strikes_raw, last_price)
    error = result.get("error")
    out: Dict[str, Any] = {"symbol": symbol, "expirations": expirations, "strikes": strikes}
    if last_price is not None:
        out["last_price"] = last_price
    if error:
        out["error"] = error
    return out


@router.get("/research/massive/status")
def get_massive_status(request: Request) -> Dict[str, Any]:
    """Massive/Polygon configuration summary (no API key returned)."""
    from servers.massive_config import get_massive_settings, massive_delay_notice_english

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    return {
        "configured": bool(ms["api_key"]),
        "tier": ms["tier"],
        "delay_notice": massive_delay_notice_english(),
        "trades_enabled": ms["trades_enabled"],
    }


@router.get("/research/option-expirations")
async def get_option_expirations(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol (e.g. NVDA)"),
    provider: str = Query(
        "auto",
        description="massive: REST only; ib: IB only; auto: Massive if key + data, else IB",
    ),
) -> Dict[str, Any]:
    """R-OD1: Expirations and strikes from IB and/or Massive REST."""
    symbol = (symbol or "").strip()
    if not symbol:
        return {"symbol": "", "expirations": [], "strikes": [], "error": "symbol is required"}

    prov = (provider or "auto").strip().lower()
    if prov not in ("auto", "ib", "massive"):
        prov = "auto"

    reader = getattr(request.app.state, "reader", None)
    config = reader._config if reader else {}
    last_price: Optional[float] = None
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(symbol)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])

    if prov == "ib":
        out = await _option_expirations_ib(request, symbol)
        out["provider"] = "ib"
        return out

    if prov == "massive":
        from servers.massive_config import get_massive_settings
        from servers.massive_client import MassiveClient

        ms = get_massive_settings(config)
        if not ms["api_key"]:
            return {
                "symbol": symbol,
                "expirations": [],
                "strikes": [],
                "error": "Massive API key not configured",
                "provider": "massive",
            }
        client = MassiveClient(ms["api_key"], ms["rest_base"])
        result = client.fetch_expirations_and_strikes(symbol)
        expirations = result.get("expirations") or []
        strikes_raw: List[float] = result.get("strikes") or []
        strikes = _filter_option_strikes(strikes_raw, last_price)
        out: Dict[str, Any] = {
            "symbol": symbol,
            "expirations": expirations,
            "strikes": strikes,
            "provider": "massive",
        }
        if last_price is not None:
            out["last_price"] = last_price
        err = result.get("error")
        if err:
            out["error"] = err
        return out

    # auto: Massive first when configured and successful
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

    ms = get_massive_settings(config)
    if ms["api_key"]:
        client = MassiveClient(ms["api_key"], ms["rest_base"])
        result = client.fetch_expirations_and_strikes(symbol)
        err = result.get("error")
        exps = result.get("expirations") or []
        strikes_raw = result.get("strikes") or []
        if not err and (exps or strikes_raw):
            strikes = _filter_option_strikes(strikes_raw, last_price)
            out: Dict[str, Any] = {
                "symbol": symbol,
                "expirations": exps,
                "strikes": strikes,
                "provider": "massive",
            }
            if last_price is not None:
                out["last_price"] = last_price
            return out

    ib_out = await _option_expirations_ib(request, symbol)
    ib_out["provider"] = "ib"
    return ib_out


@router.get("/research/option-snapshots")
def get_option_snapshots_pg(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query(..., description="Expiration YYYYMMDD or YYYY-MM-DD"),
    strikes: Optional[str] = Query(
        None,
        description="Comma-separated strikes; if omitted, uses ATM ladder from daily last when available",
    ),
    source: str = Query("massive", description="Snapshot source column: massive | ib"),
) -> Dict[str, Any]:
    """Latest option_snapshots rows from PostgreSQL (Massive sync or IB sink)."""
    from servers.massive_client import contract_key_from_parts
    from servers.reader.massive_jobs import get_option_snapshots_latest

    db = _db_config(request)
    if not db:
        return {"symbol": symbol, "expiration": expiration, "rows": [], "error": "PostgreSQL not configured"}

    sym = (symbol or "").strip().upper()
    exp = (expiration or "").strip()
    if not sym or not exp:
        return {"symbol": sym, "expiration": exp, "rows": [], "error": "symbol and expiration are required"}

    src = (source or "massive").strip().lower()
    if src not in ("massive", "ib"):
        src = "massive"

    reader = getattr(request.app.state, "reader", None)
    strikes_list = _parse_strikes_csv(strikes)
    last_price: Optional[float] = None
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(sym)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])
    if not strikes_list and last_price:
        strikes_list = _strikes_around_spot(last_price)
    if not strikes_list:
        return {
            "symbol": sym,
            "expiration": exp,
            "rows": [],
            "error": "No strikes to query; provide strikes= or ensure daily last price exists.",
            "source": src,
        }

    max_half = max(1, MAX_OPTION_SNAPSHOT_CONTRACTS_EXTENDED // 2)
    if len(strikes_list) > max_half:
        strikes_list = strikes_list[:max_half]

    exp_norm = _norm_expiry_key(exp)
    keys: List[str] = []
    for st in strikes_list:
        for r in ("C", "P"):
            keys.append(contract_key_from_parts(sym, exp_norm, float(st), r))

    rows = get_option_snapshots_latest(db, keys, source=src)
    out_rows: List[Dict[str, Any]] = []
    underlying_price: Optional[float] = None
    for row in rows:
        ck = row.get("contract_key") or ""
        strike, right = _parse_contract_key(ck)
        if strike is None or not right:
            continue
        up = row.get("underlying_price")
        if up is not None and underlying_price is None:
            try:
                underlying_price = float(up)
            except (TypeError, ValueError):
                pass
        out_rows.append(
            {
                "strike": strike,
                "right": right,
                "bid": row.get("bid"),
                "ask": row.get("ask"),
                "last": row.get("last"),
                "mid": row.get("mid"),
                "iv": row.get("iv"),
                "delta": row.get("delta"),
                "gamma": row.get("gamma"),
                "theta": row.get("theta"),
                "vega": row.get("vega"),
                "open_interest": row.get("open_interest"),
            }
        )
    out_rows.sort(key=lambda x: (x["strike"], 0 if x["right"] == "C" else 1))

    out: Dict[str, Any] = {
        "symbol": sym,
        "expiration": exp,
        "rows": out_rows,
        "source": src,
    }
    if underlying_price is not None:
        out["underlying_price"] = underlying_price
    elif last_price is not None:
        out["underlying_price"] = last_price
    return out


@router.post("/research/massive/sync")
def post_massive_sync(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Enqueue Celery job on queue `massive`. Body: kind + payload."""
    from servers.massive_config import get_massive_settings
    from servers.massive_tasks import run_massive_job
    from servers.reader.massive_jobs import insert_job_massive_backfill, update_job_massive_backfill_celery_task_id

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)

    kind = (body.get("kind") or "").strip().lower()
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    allowed = frozenset(
        {"aggregates", "snapshot", "oi", "reference", "corporate_action", "trades"}
    )
    if kind not in allowed:
        return {"ok": False, "error": f"Invalid kind; allowed: {sorted(allowed)}"}

    if kind == "trades" and not ms["trades_enabled"]:
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "message": "Option trades sync is disabled. Enable massive.features.trades_enabled or use Developer tier.",
            },
        )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    jid = insert_job_massive_backfill(db, kind, payload)
    if jid is None:
        return {"ok": False, "error": "Failed to enqueue job"}

    try:
        async_result = run_massive_job.apply_async(args=[jid], task_id=str(jid))
        update_job_massive_backfill_celery_task_id(db, jid, async_result.id)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "job_id": str(jid)}


@router.get("/research/massive/jobs")
def list_massive_jobs(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None, description="Filter by job status"),
    kind: Optional[str] = Query(None, description="Filter by job kind"),
) -> Dict[str, Any]:
    from servers.reader.massive_jobs import list_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "jobs": []}
    rows = list_job_massive_backfill(
        db, limit=limit, offset=offset, status_filter=status, kind_filter=kind
    )
    jobs = [_massive_job_to_api(dict(r)) for r in rows]
    return {"ok": True, "jobs": jobs}


@router.get("/research/massive/jobs/{job_id}/events")
async def stream_massive_job_events(
    request: Request,
    job_id: str,
    timeout_sec: int = Query(180, ge=10, le=600),
) -> StreamingResponse:
    """SSE: poll job row until terminal status or timeout (1s interval)."""
    import time

    from servers.reader.massive_jobs import get_job_massive_backfill

    db = _db_config(request)

    async def event_gen():
        if not db:
            yield f"data: {json.dumps({'ok': False, 'error': 'No DB'})}\n\n"
            return
        start = time.monotonic()
        while time.monotonic() - start < timeout_sec:
            job = await asyncio.to_thread(get_job_massive_backfill, db, job_id)
            if job is None:
                yield f"data: {json.dumps({'ok': False, 'error': 'Job not found'})}\n\n"
                return
            payload = _massive_job_to_api(dict(job))
            yield f"data: {json.dumps({'ok': True, 'job': payload})}\n\n"
            st = (job.get("status") or "").strip().lower()
            if st in ("done", "failed"):
                return
            await asyncio.sleep(1.0)
        yield f"data: {json.dumps({'ok': False, 'error': 'timeout'})}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/research/massive/jobs/{job_id}")
def get_massive_job(request: Request, job_id: str) -> Dict[str, Any]:
    """Poll Massive sync job status (same idea as GET /bars/jobs/{id})."""
    from servers.reader.massive_jobs import get_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB"}
    job = get_job_massive_backfill(db, job_id)
    if job is None:
        return {"ok": False, "error": "Job not found"}
    return {"ok": True, "job": _massive_job_to_api(job)}


@router.get("/research/option-oi")
def get_research_option_oi(
    request: Request,
    symbol: str = Query(...),
    expiry: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(100, ge=1, le=500),
) -> Dict[str, Any]:
    from servers.reader.massive_jobs import get_option_open_interest_daily

    db = _db_config(request)
    if not db:
        return {"rows": [], "error": "PostgreSQL not configured"}
    rows = get_option_open_interest_daily(
        db,
        symbol,
        expiry=expiry,
        limit=limit,
        date_from=date_from,
        date_to=date_to,
    )
    return {"rows": rows}


@router.get("/research/option-trades")
def get_research_option_trades(
    request: Request,
    symbol: str = Query(...),
    limit: int = Query(100, ge=1, le=500),
) -> Any:
    from servers.massive_config import get_massive_settings
    from servers.reader.massive_jobs import get_option_trades

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["trades_enabled"]:
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "message": "Option trades API is disabled for this configuration.",
                "trades": [],
            },
        )

    db = _db_config(request)
    if not db:
        return {"trades": [], "error": "PostgreSQL not configured"}
    rows = get_option_trades(db, symbol, limit=limit)
    return {"ok": True, "trades": rows}


@router.post("/research/option-snapshot")
async def post_option_snapshot(
    request: Request,
    body: Dict[str, Any] = Body(..., description="symbol, expiration, optional strikes"),
) -> Dict[str, Any]:
    """OD.3: Fetch option quotes (bid/ask/last/mid) for symbol+expiration with pacing; returns rows + optional underlying_price."""
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
    return out
