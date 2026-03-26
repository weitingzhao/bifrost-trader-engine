"""Massive / Polygon option research REST endpoints.

Extracted from research.py — all routes with prefix ``/research/massive/``.
No IB client dependencies.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["massive"])

MASSIVE_STOP_EXIT_DELAY_SEC = 2.5


# ── shared helpers (thin, no IB) ──────────────────────────────────────────────

def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


def _norm_expiry_key(expiration: str) -> str:
    e = (expiration or "").strip()
    if len(e) >= 10 and e[4] == "-":
        return e[:4] + e[5:7] + e[8:10]
    return e


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
    out: Dict[str, Any] = {
        "job_id": str(j.get("job_massive_backfill_id", "")),
        "type": "massive_backfill",
        "kind": j.get("kind"),
        "status": j.get("status"),
        "result": res,
        "celery_task_id": j.get("celery_task_id"),
        "created_ts": created_ts,
        "updated_ts": updated_ts,
    }
    ph = j.get("payload_hash")
    if ph:
        out["payload_hash"] = ph[:16]
    return out


def _purge_all_massive_jobs_response(request: Request, status: Optional[str]) -> Dict[str, Any]:
    from backend.massive.reader import delete_all_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_massive_backfill(db, status_filter=status)
    return {"ok": True, "deleted": deleted}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/research/massive/status")
def get_massive_status(request: Request) -> Dict[str, Any]:
    """Massive/Polygon configuration summary (no API key returned)."""
    from backend.massive.config import get_massive_settings, massive_delay_notice_english

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    return {
        "configured": bool(ms["api_key"]),
        "tier": ms["tier"],
        "delay_notice": massive_delay_notice_english(),
        "trades_enabled": ms["trades_enabled"],
    }


@router.post("/research/massive/shutdown")
def post_massive_shutdown() -> Dict[str, Any]:
    """Terminate the Massive API process (same pattern as POST /control/monitor_stop on the status server)."""

    def _exit_after_send() -> None:
        time.sleep(MASSIVE_STOP_EXIT_DELAY_SEC)
        logger.info("Massive shutdown: exiting process.")
        os._exit(0)

    threading.Thread(target=_exit_after_send, daemon=True).start()
    return {"ok": True}


@router.get("/research/massive/daily-checklist")
def get_massive_daily_checklist(
    request: Request,
    symbols: str = Query(..., description="Comma-separated underlying symbols (Watchlist STK)"),
    trade_date: Optional[str] = Query(
        None,
        description="Session calendar date YYYY-MM-DD (US). Default: today in America/New_York",
    ),
) -> Dict[str, Any]:
    """Per-symbol daily data readiness (snapshot, OI, Max Pain, corporate, WS ingest)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from backend.massive.reader import get_massive_daily_checklist_data

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym_list = [s.strip().upper() for s in (symbols or "").split(",") if s.strip()][:80]
    if not sym_list:
        return {"ok": False, "error": "symbols is required"}
    td = (trade_date or "").strip()
    if not td:
        td = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    data = get_massive_daily_checklist_data(db, sym_list, td)
    return {"ok": True, **data}


@router.post("/research/massive/api-coverage/sync")
def post_massive_api_coverage_sync() -> Dict[str, Any]:
    """Sync docs/plans/massive_api_coverage.html to frontend/public/plans for UI embed."""
    root = Path(__file__).resolve().parents[2]
    src = root / "docs" / "plans" / "massive_api_coverage.html"
    dst = root / "frontend" / "public" / "plans" / "massive_api_coverage.html"
    if not src.is_file():
        return {"ok": False, "error": f"Source file not found: {src}"}
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return {
            "ok": True,
            "source": str(src),
            "target": str(dst),
            "size_bytes": dst.stat().st_size,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/research/massive/greeks-coverage")
def get_massive_greeks_coverage(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query("", description="Expiration YYYYMMDD or YYYY-MM-DD (optional; omit for all)"),
    source: str = Query("massive", description="Snapshot source: massive | ib"),
) -> Dict[str, Any]:
    """Greeks/IV coverage and freshness stats from option_snapshots."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "symbol is required"}
    src = (source or "massive").strip().lower()
    if src not in ("massive", "ib"):
        src = "massive"
    exp = (expiration or "").strip()
    exp_norm = _norm_expiry_key(exp) if exp else None

    import psycopg2
    try:
        params = {}
        for k in ("host", "port", "dbname", "user", "password"):
            v = db.get(f"pg_{k}") or db.get(k)
            if v is not None:
                params[k] = int(v) if k == "port" else str(v)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                where = "source = %s AND contract_key LIKE %s"
                args: list = [src, f"{sym}%"]
                if exp_norm:
                    where += " AND contract_key LIKE %s"
                    args.append(f"%{exp_norm}%")
                cur.execute(
                    f"""
                    SELECT
                        count(*) AS total,
                        count(iv) AS with_iv,
                        count(delta) AS with_delta,
                        count(gamma) AS with_gamma,
                        count(theta) AS with_theta,
                        count(vega) AS with_vega,
                        count(CASE WHEN delta IS NOT NULL AND gamma IS NOT NULL
                                    AND theta IS NOT NULL AND vega IS NOT NULL THEN 1 END) AS with_full_greeks,
                        count(open_interest) AS with_oi,
                        min(snapshot_ts) AS oldest_ts,
                        max(snapshot_ts) AS newest_ts,
                        count(CASE WHEN snapshot_ts < now() - interval '24 hours' THEN 1 END) AS stale_rows
                    FROM (
                        SELECT DISTINCT ON (contract_key)
                            iv, delta, gamma, theta, vega, open_interest, snapshot_ts
                        FROM option_snapshots
                        WHERE {where}
                        ORDER BY contract_key, snapshot_ts DESC
                    ) latest
                    """,
                    args,
                )
                row = cur.fetchone()
                if not row or row[0] == 0:
                    return {
                        "ok": True,
                        "symbol": sym,
                        "expiration": exp_norm or "",
                        "source": src,
                        "total": 0,
                        "coverage": {},
                    }
                (total, w_iv, w_delta, w_gamma, w_theta, w_vega,
                 w_full, w_oi, oldest, newest, stale) = row
                pct = lambda n: round(n / total * 100, 1) if total else 0  # noqa: E731
                return {
                    "ok": True,
                    "symbol": sym,
                    "expiration": exp_norm or "",
                    "source": src,
                    "total": total,
                    "coverage": {
                        "with_iv": w_iv,
                        "iv_pct": pct(w_iv),
                        "with_delta": w_delta,
                        "with_gamma": w_gamma,
                        "with_theta": w_theta,
                        "with_vega": w_vega,
                        "with_full_greeks": w_full,
                        "full_greeks_pct": pct(w_full),
                        "with_oi": w_oi,
                    },
                    "freshness": {
                        "oldest_ts": oldest.isoformat() if oldest else None,
                        "newest_ts": newest.isoformat() if newest else None,
                        "stale_rows": stale,
                    },
                }
        finally:
            conn.close()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/research/massive/contracts-coverage")
def get_massive_contracts_coverage(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query("", description="Expiration YYYYMMDD or YYYY-MM-DD (optional)"),
) -> Dict[str, Any]:
    """Contract reference coverage and mapping consistency from option_contracts."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "symbol is required"}
    exp = (expiration or "").strip()
    exp_norm = _norm_expiry_key(exp) if exp else None

    import psycopg2
    try:
        params = {}
        for k in ("host", "port", "dbname", "user", "password"):
            v = db.get(f"pg_{k}") or db.get(k)
            if v is not None:
                params[k] = int(v) if k == "port" else str(v)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                where = "symbol = %s"
                args: list = [sym]
                if exp_norm:
                    where += " AND expiry = %s"
                    args.append(exp_norm)
                cur.execute(
                    f"""
                    SELECT
                        count(*) AS total,
                        count(massive_option_ticker) AS with_ticker,
                        count(CASE WHEN symbol != '' AND expiry != ''
                                    AND option_right != '' THEN 1 END) AS with_complete_identity,
                        count(CASE WHEN massive_option_ticker IS NOT NULL
                                    AND massive_option_ticker != ''
                                    AND contract_key NOT LIKE '%%' || symbol || '%%' THEN 1 END) AS mapping_mismatch,
                        min(created_at) AS oldest_ts,
                        max(created_at) AS newest_ts,
                        count(CASE WHEN created_at < now() - interval '7 days' THEN 1 END) AS stale_rows,
                        count(DISTINCT expiry) AS distinct_expirations,
                        count(DISTINCT strike) AS distinct_strikes
                    FROM option_contracts
                    WHERE {where}
                    """,
                    args,
                )
                row = cur.fetchone()
                if not row or row[0] == 0:
                    return {
                        "ok": True, "symbol": sym, "expiration": exp_norm or "",
                        "total": 0, "coverage": {}, "freshness": {},
                    }
                (total, w_ticker, w_identity, mismatch,
                 oldest, newest, stale, dist_exp, dist_strikes) = row
                pct = lambda n: round(n / total * 100, 1) if total else 0  # noqa: E731
                return {
                    "ok": True, "symbol": sym, "expiration": exp_norm or "",
                    "total": total,
                    "coverage": {
                        "with_massive_ticker": w_ticker,
                        "ticker_pct": pct(w_ticker),
                        "with_complete_identity": w_identity,
                        "identity_pct": pct(w_identity),
                        "mapping_mismatch": mismatch,
                        "distinct_expirations": dist_exp,
                        "distinct_strikes": dist_strikes,
                    },
                    "freshness": {
                        "oldest_ts": oldest.isoformat() if oldest else None,
                        "newest_ts": newest.isoformat() if newest else None,
                        "stale_rows": stale,
                    },
                }
        finally:
            conn.close()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── Market Ops (REST-only, read-only) ────────────────────────────────────────

@router.get("/research/massive/market-ops/conditions")
def get_massive_market_conditions(
    request: Request,
    asset_class: Optional[str] = Query(None, description="options | stocks | crypto | fx"),
    data_type: Optional[str] = Query(None, description="trade | bbo | nbbo"),
    limit: int = Query(1000, ge=1, le=1000),
) -> Dict[str, Any]:
    """Condition codes from Massive REST (read-only, no DB write)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured", "results": []}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_market_conditions(asset_class=asset_class, data_type=data_type, limit=limit)
    if data.get("error"):
        return {"ok": False, "error": data["error"], "results": []}
    return {"ok": True, "results": data.get("results") or [], "count": len(data.get("results") or [])}


@router.get("/research/massive/market-ops/exchanges")
def get_massive_market_exchanges(
    request: Request,
    asset_class: Optional[str] = Query(None, description="stocks | options | crypto | fx"),
    locale: Optional[str] = Query(None, description="us | global"),
) -> Dict[str, Any]:
    """Exchange list from Massive REST (read-only, no DB write)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured", "results": []}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_market_exchanges(asset_class=asset_class, locale=locale)
    if data.get("error"):
        return {"ok": False, "error": data["error"], "results": []}
    return {"ok": True, "results": data.get("results") or [], "count": len(data.get("results") or [])}


@router.get("/research/massive/market-ops/holidays")
def get_massive_market_holidays(request: Request) -> Dict[str, Any]:
    """Upcoming market holidays from Massive REST + local reference_us_holidays comparison."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured", "massive_holidays": [], "local_holidays": []}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_market_holidays()
    massive_holidays = data.get("results") or []
    if not isinstance(massive_holidays, list):
        massive_holidays = []
    if data.get("error"):
        return {"ok": False, "error": data["error"], "massive_holidays": [], "local_holidays": []}

    local_holidays: List[Dict[str, Any]] = []
    db = _db_config(request)
    if db:
        try:
            from servers.reader.market import get_market_holidays
            local_holidays = get_market_holidays(db, exchange="NYSE")
        except Exception:
            pass

    local_dates = {h.get("holiday_date") for h in local_holidays if h.get("holiday_date")}
    massive_dates = set()
    for h in massive_holidays:
        d = h.get("date")
        if d:
            massive_dates.add(d)

    return {
        "ok": True,
        "massive_holidays": massive_holidays,
        "massive_count": len(massive_holidays),
        "local_holidays": local_holidays,
        "local_count": len(local_holidays),
        "comparison": {
            "in_massive_only": sorted(massive_dates - local_dates),
            "in_local_only": sorted(local_dates - massive_dates),
            "in_both": sorted(massive_dates & local_dates),
        },
    }


@router.get("/research/massive/market-ops/status")
def get_massive_market_status(request: Request) -> Dict[str, Any]:
    """Current market trading status from Massive REST (read-only)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_market_status()
    if data.get("error"):
        return {"ok": False, "error": data["error"]}
    return {"ok": True, "status": data}


# ── Technical Indicators (cross-asset, read-only) ────────────────────────────

@router.get("/research/massive/technical-indicators/{indicator}/{ticker}")
def get_massive_technical_indicator(
    request: Request,
    indicator: str,
    ticker: str,
    timespan: str = Query("day"),
    window: int = Query(14, ge=1, le=500),
    series_type: str = Query("close"),
    adjusted: bool = Query(True),
    order: str = Query("desc"),
    limit: int = Query(50, ge=1, le=5000),
    short_window: Optional[int] = Query(None, ge=1, description="MACD only"),
    long_window: Optional[int] = Query(None, ge=1, description="MACD only"),
    signal_window: Optional[int] = Query(None, ge=1, description="MACD only"),
) -> Dict[str, Any]:
    """SMA / EMA / RSI / MACD from Massive REST (read-only, no DB write)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    allowed = {"sma", "ema", "rsi", "macd"}
    if indicator not in allowed:
        return {"ok": False, "error": f"Unknown indicator '{indicator}'. Allowed: {', '.join(sorted(allowed))}"}

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured", "results": {}}
    client = MassiveClient(ms["api_key"], ms["rest_base"])

    kwargs: Dict[str, Any] = dict(
        timespan=timespan, window=window, series_type=series_type,
        adjusted=adjusted, order=order, limit=limit,
    )
    if indicator == "macd":
        if short_window is not None:
            kwargs["short_window"] = short_window
        if long_window is not None:
            kwargs["long_window"] = long_window
        if signal_window is not None:
            kwargs["signal_window"] = signal_window
        data = client.fetch_indicator_macd(ticker, **kwargs)
    else:
        fetcher = getattr(client, f"fetch_indicator_{indicator}")
        data = fetcher(ticker, **kwargs)

    if data.get("error"):
        return {"ok": False, "error": data["error"], "results": {}}

    results = data.get("results") or {}
    values = results.get("values") or [] if isinstance(results, dict) else []
    return {
        "ok": True,
        "indicator": indicator,
        "ticker": ticker.strip().upper(),
        "count": len(values),
        "results": results,
    }


# ── Trades & Quotes (Options REST, read-only) ────────────────────────────────

@router.get("/research/massive/trades-quotes/last-trade/{options_ticker}")
def get_massive_last_trade(request: Request, options_ticker: str) -> Dict[str, Any]:
    """GET /v2/last/trade/{optionsTicker} — most recent trade for a contract (read-only, Starter)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_last_trade(options_ticker)
    if data.get("error"):
        return {"ok": False, "error": data["error"]}
    return {"ok": True, **data}


@router.get("/research/massive/trades-quotes/quotes/{options_ticker}")
def get_massive_hist_quotes(
    request: Request,
    options_ticker: str,
    timestamp_gte: Optional[str] = Query(None, description="Nanosecond timestamp lower bound"),
    timestamp_lte: Optional[str] = Query(None, description="Nanosecond timestamp upper bound"),
    limit: int = Query(100, ge=1, le=50000),
    sort: str = Query("timestamp"),
    order: str = Query("asc"),
) -> Dict[str, Any]:
    """GET /v3/quotes/{optionsTicker} — historical BBO quotes (read-only, Starter)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_option_quotes(
        options_ticker,
        timestamp_gte=timestamp_gte,
        timestamp_lte=timestamp_lte,
        limit=limit,
        sort=sort,
        order=order,
    )
    if data.get("error"):
        return {"ok": False, "error": data["error"]}
    results = data.get("results") or []
    return {"ok": True, "count": len(results) if isinstance(results, list) else 0, **data}


@router.get("/research/massive/trades-quotes/trades/{options_ticker}")
def get_massive_hist_trades(
    request: Request,
    options_ticker: str,
    timestamp_gte: Optional[str] = Query(None, description="Nanosecond timestamp lower bound"),
    timestamp_lte: Optional[str] = Query(None, description="Nanosecond timestamp upper bound"),
    limit: int = Query(100, ge=1, le=50000),
    sort: str = Query("timestamp"),
    order: str = Query("asc"),
) -> Any:
    """GET /v3/trades/{optionsTicker} — tick-level trades (read-only, Developer tier gate)."""
    from backend.massive.config import get_massive_settings
    from backend.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["trades_enabled"]:
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "error": "Historical trades API requires Developer tier and trades_enabled.",
            },
        )
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_option_trades(
        options_ticker,
        timestamp_gte=timestamp_gte,
        timestamp_lte=timestamp_lte,
        limit=limit,
        sort=sort,
        order=order,
    )
    if data.get("error"):
        return {"ok": False, "error": data["error"]}
    results = data.get("results") or []
    return {"ok": True, "count": len(results) if isinstance(results, list) else 0, **data}


# ── Sync / Jobs ───────────────────────────────────────────────────────────────

@router.post("/research/massive/sync")
def post_massive_sync(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Enqueue Celery job on queue `massive`. Body: kind + payload."""
    from backend.massive.config import get_massive_settings
    from backend.massive.tasks import run_massive_job
    from backend.massive.reader import insert_job_massive_backfill, update_job_massive_backfill_celery_task_id

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)

    kind = (body.get("kind") or "").strip().lower()
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    allowed = frozenset(
        {
            "aggregates",
            "snapshot",
            "oi",
            "reference",
            "corporate_action",
            "trades",
            "trades_quotes",
            "contracts",
            "eod_pipeline",
            "max_pain",
            "reconcile",
            "trim_jobs",
        }
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
    if kind == "trades_quotes":
        mode = (payload.get("mode") or "").strip().lower()
        if mode == "trades" and not ms["trades_enabled"]:
            return JSONResponse(
                status_code=403,
                content={
                    "ok": False,
                    "message": "Historical trades require Developer tier and trades_enabled.",
                },
            )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    jid, deduplicated = insert_job_massive_backfill(db, kind, payload)
    if jid is None:
        return {"ok": False, "error": "Failed to enqueue job"}

    if deduplicated:
        return {"ok": True, "job_id": str(jid), "deduplicated": True}

    try:
        queue_name = (
            "massive_high" if str(body.get("priority") or "").strip().lower() == "high" else "massive"
        )
        async_result = run_massive_job.apply_async(
            args=[jid], task_id=str(jid), queue=queue_name
        )
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
    from backend.massive.reader import list_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "jobs": []}
    rows = list_job_massive_backfill(
        db, limit=limit, offset=offset, status_filter=status, kind_filter=kind
    )
    jobs = [_massive_job_to_api(dict(r)) for r in rows]
    return {"ok": True, "jobs": jobs}


@router.post("/research/massive/jobs/trim")
def trim_massive_jobs(
    request: Request,
    keep: int = Query(200, ge=1, le=50000, description="Keep newest N jobs by id; delete older rows"),
) -> Dict[str, Any]:
    """Trim Massive job table to the newest `keep` rows (same idea as bars trim)."""
    from backend.massive.reader import trim_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = trim_job_massive_backfill(db, keep=keep)
    return {"ok": True, "deleted": deleted}


@router.delete("/research/massive/jobs")
def delete_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
) -> Dict[str, Any]:
    """Delete all Massive jobs, or only those matching status."""
    return _purge_all_massive_jobs_response(request, status)


@router.post("/research/massive/jobs/purge")
def purge_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
) -> Dict[str, Any]:
    """Same as DELETE /research/massive/jobs. POST for clients or proxies that block DELETE on collection URLs."""
    return _purge_all_massive_jobs_response(request, status)


@router.get("/research/massive/jobs/{job_id}/events")
async def stream_massive_job_events(
    request: Request,
    job_id: str,
    timeout_sec: int = Query(180, ge=10, le=600),
) -> StreamingResponse:
    """SSE: poll job row until terminal status or timeout (1s interval)."""
    import time

    from backend.massive.reader import get_job_massive_backfill

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
    from backend.massive.reader import get_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB"}
    job = get_job_massive_backfill(db, job_id)
    if job is None:
        return {"ok": False, "error": "Job not found"}
    return {"ok": True, "job": _massive_job_to_api(job)}


@router.delete("/research/massive/jobs/{job_id}")
def delete_massive_job(request: Request, job_id: str) -> Dict[str, Any]:
    """Delete one Massive sync job row."""
    from backend.massive.reader import delete_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB"}
    if delete_job_massive_backfill(db, job_id):
        return {"ok": True}
    return {"ok": False, "error": "Delete failed"}


@router.get("/research/massive/corporate-actions")
def get_massive_corporate_actions(
    request: Request,
    symbol: str = Query(..., description="Stock ticker (e.g. AAPL)"),
    action_type: Optional[str] = Query(None, description="dividend | split"),
    limit: int = Query(50, ge=1, le=500),
) -> Dict[str, Any]:
    """Corporate actions persisted by Massive sync (dividends, splits)."""
    from backend.massive.reader import get_corporate_actions

    db = _db_config(request)
    if not db:
        return {"ok": False, "rows": [], "error": "PostgreSQL not configured"}
    rows = get_corporate_actions(db, symbol, action_type=action_type, limit=limit)
    serialised = []
    for r in rows:
        row = dict(r)
        for k in ("ex_date", "record_date", "payment_date", "created_at"):
            v = row.get(k)
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
        serialised.append(row)
    return {"ok": True, "rows": serialised}
