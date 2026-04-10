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

from src.massive.celery_queues import celery_queue_for_massive_job
from src.vendor.massive.client import _as_error_str

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


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/research/massive/status")
def get_massive_status(request: Request) -> Dict[str, Any]:
    """Massive/Polygon configuration summary (no API key returned)."""
    from src.vendor.massive.config import get_massive_settings, massive_delay_notice_english

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

    from src.vendor.massive.reader import get_massive_daily_checklist_data

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
    err = data.get("error") if isinstance(data, dict) else None
    syms_out = data.get("symbols") if isinstance(data, dict) else None
    fatal_err = (
        isinstance(err, str)
        and err.strip()
        and (not isinstance(syms_out, dict) or len(syms_out) == 0)
    )
    if fatal_err:
        return {"ok": False, "error": err.strip(), "trade_date": data.get("trade_date", td)}
    return {"ok": True, **data}


@router.post("/research/massive/api-coverage/sync")
def post_massive_api_coverage_sync() -> Dict[str, Any]:
    """Sync docs/plans/massive_api_coverage.html to frontend/public/plans for UI embed."""
    # routes.py is backend/massive/routers/ — repo root is parents[3], not parents[2] (backend/).
    root = Path(__file__).resolve().parents[3]
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


@router.post("/research/massive/stocks-api-coverage/sync")
def post_massive_stocks_api_coverage_sync() -> Dict[str, Any]:
    """Sync docs/plans/massive_stocks_api_coverage.html to frontend/public/plans for UI embed."""
    root = Path(__file__).resolve().parents[3]
    src = root / "docs" / "plans" / "massive_stocks_api_coverage.html"
    dst = root / "frontend" / "public" / "plans" / "massive_stocks_api_coverage.html"
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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
            from src.monitor.reader.market import get_market_holidays
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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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


# ── Tickers reference (Stocks REST, read-only) ───────────────────────────────

@router.get("/research/massive/tickers")
def get_massive_reference_tickers(
    request: Request,
    ticker: Optional[str] = Query(None),
    instrument_type: Optional[str] = Query(None, alias="type"),
    market: Optional[str] = Query(None),
    exchange: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    active: Optional[bool] = Query(None),
    date: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    sort: str = Query("ticker"),
    order: str = Query("asc"),
    cursor: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """GET /v3/reference/tickers — paginated ticker universe (proxy)."""
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_reference_tickers(
        ticker=ticker,
        instrument_type=instrument_type,
        market=market,
        exchange=exchange,
        search=search,
        active=active,
        date=date,
        limit=limit,
        sort=sort,
        order=order,
        cursor=cursor,
    )
    if data.get("error"):
        return {"ok": False, "error": _as_error_str(data["error"])}
    return {"ok": True, "data": data}


@router.get("/research/massive/tickers/types")
def get_massive_ticker_types(
    request: Request,
    asset_class: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """GET /v3/reference/tickers/types — registered before /tickers/{ticker} so *types* is not captured as a symbol."""
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_ticker_types(asset_class=asset_class, locale=locale)
    if data.get("error"):
        return {"ok": False, "error": _as_error_str(data["error"])}
    return {"ok": True, "data": data}


# ── Ticker reference (PostgreSQL + Redis cache) ─────────────────────────────
# Paths under ``/reference/tickers/`` avoid collision with ``GET .../tickers/{ticker:path}`` (upstream proxy).


def _pg_configured(request: Request) -> Optional[dict]:
    db = _db_config(request)
    if not db or (db.get("sink") != "postgres" and not db.get("postgres")):
        return None
    return db


def _ticker_ref_search_impl(
    request: Request,
    q: str,
    limit: int,
) -> Dict[str, Any]:
    import psycopg2

    from src.persistence.postgres.connection import _get_conn_params
    from src.persistence.postgres.ticker_reference import search_tickers
    from src.vendor.massive.reference_cache_keys import (
        CACHE_TTL_SEARCH_SEC,
        key_search,
        normalize_search_key,
        redis_client_from_status_config,
    )

    cfg = _pg_configured(request)
    if not cfg:
        return {"ok": False, "error": "PostgreSQL not configured"}
    nq = normalize_search_key(q)
    rds = redis_client_from_status_config(cfg)
    cache_key = key_search(nq) if nq else None
    if rds and cache_key and nq:
        try:
            raw = rds.get(cache_key)
            if raw:
                return {"ok": True, "cached": True, "results": json.loads(raw)}
        except (json.JSONDecodeError, TypeError):
            pass
    params = _get_conn_params(cfg)
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            rows = search_tickers(cur, q, limit)
    finally:
        conn.close()
    if rds and cache_key and nq:
        try:
            rds.setex(cache_key, CACHE_TTL_SEARCH_SEC, json.dumps(rows, default=str))
        except Exception:
            pass
    return {"ok": True, "cached": False, "results": rows}


@router.get("/research/massive/reference/tickers/search")
def get_ticker_reference_search(request: Request, q: str = Query("", max_length=128), limit: int = Query(20, ge=1, le=100)) -> Dict[str, Any]:
    """Autocomplete over ``tickers`` (ticker prefix + name ILIKE)."""
    return _ticker_ref_search_impl(request, q, limit)


@router.get("/research/massive/stocks/search")
def get_stock_reference_search_legacy(
    request: Request,
    q: str = Query("", max_length=128),
    limit: int = Query(20, ge=1, le=100),
) -> Dict[str, Any]:
    """Deprecated: use ``GET /research/massive/reference/tickers/search``."""
    return _ticker_ref_search_impl(request, q, limit)


def _ticker_ref_related_impl(request: Request, symbol: str) -> Dict[str, Any]:
    import psycopg2

    from src.persistence.postgres.connection import _get_conn_params
    from src.persistence.postgres.ticker_reference import fetch_related_with_names
    from src.vendor.massive.reference_cache_keys import (
        CACHE_TTL_PEERS_SEC,
        key_peers,
        normalize_symbol,
        redis_client_from_status_config,
    )

    cfg = _pg_configured(request)
    if not cfg:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = normalize_symbol(symbol)
    if not sym:
        return {"ok": False, "error": "Invalid symbol"}
    rds = redis_client_from_status_config(cfg)
    if rds:
        try:
            raw = rds.get(key_peers(sym))
            if raw:
                return {"ok": True, "cached": True, "data": json.loads(raw)}
        except (json.JSONDecodeError, TypeError):
            pass
    params = _get_conn_params(cfg)
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            tid, peers = fetch_related_with_names(cur, sym)
    finally:
        conn.close()
    payload = {"from_tickers_id": tid, "symbol": sym, "ticker": sym, "related": peers}
    if rds:
        try:
            rds.setex(key_peers(sym), CACHE_TTL_PEERS_SEC, json.dumps(payload, default=str))
        except Exception:
            pass
    return {"ok": True, "cached": False, "data": payload}


@router.get("/research/massive/reference/tickers/{ticker}/related")
def get_ticker_reference_related(request: Request, ticker: str) -> Dict[str, Any]:
    """Related tickers from ``ticker_related_tickers`` (+ peer names from ``tickers``)."""
    return _ticker_ref_related_impl(request, ticker)


@router.get("/research/massive/stocks/{symbol}/related")
def get_stock_reference_related_legacy(request: Request, symbol: str) -> Dict[str, Any]:
    """Deprecated: use ``GET /research/massive/reference/tickers/{ticker}/related``."""
    return _ticker_ref_related_impl(request, symbol)


def _ticker_ref_detail_impl(request: Request, symbol: str) -> Dict[str, Any]:
    import psycopg2

    from src.persistence.postgres.connection import _get_conn_params
    from src.persistence.postgres.ticker_reference import fetch_ticker_detail_merged
    from src.vendor.massive.reference_cache_keys import (
        CACHE_TTL_TICKER_SEC,
        key_ticker,
        normalize_symbol,
        redis_client_from_status_config,
    )

    cfg = _pg_configured(request)
    if not cfg:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = normalize_symbol(symbol)
    if not sym:
        return {"ok": False, "error": "Invalid symbol"}
    rds = redis_client_from_status_config(cfg)
    if rds:
        try:
            raw = rds.get(key_ticker(sym))
            if raw:
                return {"ok": True, "cached": True, "ticker": json.loads(raw)}
        except (json.JSONDecodeError, TypeError):
            pass
    params = _get_conn_params(cfg)
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            row = fetch_ticker_detail_merged(cur, sym)
    finally:
        conn.close()
    if not row:
        return {"ok": False, "error": "Not found", "symbol": sym}
    if rds:
        try:
            rds.setex(key_ticker(sym), CACHE_TTL_TICKER_SEC, json.dumps(row, default=str))
        except Exception:
            pass
    return {"ok": True, "cached": False, "ticker": row}


@router.get("/research/massive/reference/tickers/{ticker}")
def get_ticker_reference_detail(request: Request, ticker: str) -> Dict[str, Any]:
    """Single merged row from ``tickers`` + ``ticker_reference_details``."""
    return _ticker_ref_detail_impl(request, ticker)


@router.get("/research/massive/stocks/{symbol}")
def get_stock_reference_detail_legacy(request: Request, symbol: str) -> Dict[str, Any]:
    """Deprecated: use ``GET /research/massive/reference/tickers/{ticker}``."""
    out = _ticker_ref_detail_impl(request, symbol)
    if out.get("ok") and isinstance(out.get("ticker"), dict):
        out["stock"] = out["ticker"]
    return out


@router.get("/research/massive/instrument-types")
def get_instrument_types_db(
    request: Request,
    asset_class: str = Query("*"),
    locale: str = Query("*"),
) -> Dict[str, Any]:
    """Instrument type dictionary from ``ticker_instrument_types``."""
    import psycopg2

    from src.persistence.postgres.connection import _get_conn_params
    from src.persistence.postgres.ticker_reference import list_instrument_types
    from src.vendor.massive.reference_cache_keys import (
        CACHE_TTL_INSTRUMENT_TYPES_SEC,
        key_instrument_types,
        redis_client_from_status_config,
    )

    cfg = _pg_configured(request)
    if not cfg:
        return {"ok": False, "error": "PostgreSQL not configured"}
    loc = (locale or "*").strip() or "*"
    ac = (asset_class or "*").strip() or "*"
    rds = redis_client_from_status_config(cfg)
    k = key_instrument_types(loc, ac)
    if rds:
        try:
            raw = rds.get(k)
            if raw:
                return {"ok": True, "cached": True, "results": json.loads(raw)}
        except (json.JSONDecodeError, TypeError):
            pass
    params = _get_conn_params(cfg)
    conn = psycopg2.connect(**params)
    try:
        with conn.cursor() as cur:
            rows = list_instrument_types(cur)
    finally:
        conn.close()
    if rds:
        try:
            rds.setex(k, CACHE_TTL_INSTRUMENT_TYPES_SEC, json.dumps(rows, default=str))
        except Exception:
            pass
    return {"ok": True, "cached": False, "results": rows}


@router.post("/research/massive/jobs/ticker-reference")
@router.post("/research/massive/jobs/stock-reference")
def post_jobs_ticker_reference(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Enqueue ticker reference Celery job (``ticker_reference_*`` kinds; legacy ``stock_reference_*`` accepted)."""
    from src.vendor.massive.config import get_massive_settings
    from src.massive.tasks import run_massive_job
    from src.vendor.massive.reader import insert_job_massive_backfill, update_job_massive_backfill_celery_task_id
    from src.persistence.postgres.ticker_reference import normalize_ticker_ref_kind

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)

    kind_raw = (body.get("kind") or "").strip().lower()
    kind = normalize_ticker_ref_kind(kind_raw)
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    allowed = frozenset(
        {
            "ticker_reference_universe",
            "ticker_reference_overview",
            "ticker_reference_related",
            "ticker_reference_instrument_types",
        }
    )
    if kind not in allowed:
        return {"ok": False, "error": f"Invalid kind; allowed: {sorted(allowed)} (legacy stock_reference_* also accepted)"}

    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    jid, deduplicated = insert_job_massive_backfill(db, kind, payload)
    if jid is None:
        return {"ok": False, "error": "Failed to enqueue job"}

    if deduplicated:
        return {"ok": True, "job_id": str(jid), "deduplicated": True}

    try:
        priority_high = str(body.get("priority") or "").strip().lower() == "high"
        queue_name = celery_queue_for_massive_job(kind, priority_high=priority_high)
        async_result = run_massive_job.apply_async(
            args=[jid], task_id=str(jid), queue=queue_name
        )
        update_job_massive_backfill_celery_task_id(db, jid, async_result.id)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "job_id": str(jid)}


@router.get("/research/massive/tickers/{ticker:path}")
def get_massive_ticker_detail(
    request: Request,
    ticker: str,
    date: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """GET /v3/reference/tickers/{ticker} — single ticker (proxy). Path allows dots (e.g. BRK.A)."""
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_ticker_detail(ticker, date=date)
    if data.get("error"):
        return {"ok": False, "error": _as_error_str(data["error"])}
    return {"ok": True, "data": data}


@router.get("/research/massive/related-companies/{ticker}")
def get_massive_related_companies(request: Request, ticker: str) -> Dict[str, Any]:
    """GET /v1/related-companies/{ticker} (proxy)."""
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)
    if not ms["api_key"]:
        return {"ok": False, "error": "Massive API key not configured"}
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    data = client.fetch_related_companies(ticker)
    if data.get("error"):
        return {"ok": False, "error": _as_error_str(data["error"])}
    return {"ok": True, "data": data}


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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    from src.vendor.massive.config import get_massive_settings
    from src.vendor.massive.client import MassiveClient

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
    """Enqueue Celery job (queue depends on kind: options → massive/massive_high, ticker ref → massive_stocks*)."""
    from src.vendor.massive.config import get_massive_settings
    from src.massive.tasks import run_massive_job
    from src.vendor.massive.reader import insert_job_massive_backfill, update_job_massive_backfill_celery_task_id
    from src.persistence.postgres.ticker_reference import normalize_ticker_ref_kind

    reader = getattr(request.app.state, "reader", None)
    cfg = reader._config if reader else {}
    ms = get_massive_settings(cfg)

    kind_raw = (body.get("kind") or "").strip().lower()
    kind = normalize_ticker_ref_kind(kind_raw)
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
            "ticker_reference_universe",
            "ticker_reference_overview",
            "ticker_reference_related",
            "ticker_reference_instrument_types",
            "stock_reference_universe",
            "stock_reference_overview",
            "stock_reference_related",
            "stock_reference_instrument_types",
        }
    )
    if kind_raw not in allowed:
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
        priority_high = str(body.get("priority") or "").strip().lower() == "high"
        queue_name = celery_queue_for_massive_job(kind, priority_high=priority_high)
        async_result = run_massive_job.apply_async(
            args=[jid], task_id=str(jid), queue=queue_name
        )
        update_job_massive_backfill_celery_task_id(db, jid, async_result.id)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "job_id": str(jid)}


@router.get("/research/massive/jobs/{job_id}/events")
async def stream_massive_job_events(
    request: Request,
    job_id: str,
    timeout_sec: int = Query(180, ge=10, le=600),
) -> StreamingResponse:
    """SSE: poll job row until terminal status or timeout (1s interval)."""
    import time

    from src.vendor.massive.reader import get_job_massive_backfill

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


@router.get("/research/massive/corporate-actions")
def get_massive_corporate_actions(
    request: Request,
    symbol: str = Query(..., description="Stock ticker (e.g. AAPL)"),
    action_type: Optional[str] = Query(None, description="dividend | split"),
    limit: int = Query(50, ge=1, le=500),
) -> Dict[str, Any]:
    """Corporate actions persisted by Massive sync (dividends, splits)."""
    from src.vendor.massive.reader import get_corporate_actions

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
