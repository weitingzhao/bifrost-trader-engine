"""Research: Option Discovery and related endpoints (R-OD1)."""

import asyncio
import hashlib
import json
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from servers.redis_url import redis_url_from_config

router = APIRouter(tags=["research"])

# FASTAPI_PLAN FA-2: snapshot Redis cache TTL (seconds)
SNAPSHOT_CACHE_TTL_SEC = 120


def _option_expirations_cache_response(body: Dict[str, Any]) -> JSONResponse:
    """Slow-changing expirations list: allow browser / SWR to cache 5 minutes."""
    return JSONResponse(
        content=body,
        headers={"Cache-Control": "max-age=300"},
    )

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


def _purge_all_massive_jobs_response(request: Request, status: Optional[str]) -> Dict[str, Any]:
    """Delete all Massive job rows (optional status filter). Shared by DELETE and POST purge."""
    from servers.reader.massive_jobs import delete_all_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_massive_backfill(db, status_filter=status)
    return {"ok": True, "deleted": deleted}


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

    from servers.reader.massive_jobs import get_massive_daily_checklist_data

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


@router.get("/research/option-expirations")
async def get_option_expirations(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol (e.g. NVDA)"),
    provider: str = Query(
        "auto",
        description="massive: REST only; ib: IB only; auto: Massive if key + data, else IB",
    ),
    debug: bool = Query(
        False,
        description="If true and provider uses Massive REST, include redacted request URLs, "
        "per-page JSON responses, and a sample of contract objects (no DB writes).",
    ),
    expiration: Optional[str] = Query(
        None,
        description="When set with Massive provider, restrict contracts to this single expiration "
        "(YYYY-MM-DD or YYYYMMDD). Reduces pagination and returns strikes for that expiry only. "
        "Ignored when provider=ib.",
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
        return _option_expirations_cache_response(out)

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
        result = client.fetch_expirations_and_strikes(
            symbol, include_debug=debug, expiration_date=expiration,
        )
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
        md = result.get("massive_debug")
        if debug and isinstance(md, dict):
            out["massive_debug"] = md
        return _option_expirations_cache_response(out)

    # auto: Massive first when configured and successful
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

    ms = get_massive_settings(config)
    if ms["api_key"]:
        client = MassiveClient(ms["api_key"], ms["rest_base"])
        result = client.fetch_expirations_and_strikes(
            symbol, include_debug=debug, expiration_date=expiration,
        )
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
            md = result.get("massive_debug")
            if debug and isinstance(md, dict):
                out["massive_debug"] = md
            return _option_expirations_cache_response(out)

    ib_out = await _option_expirations_ib(request, symbol)
    ib_out["provider"] = "ib"
    return _option_expirations_cache_response(ib_out)


@router.get("/research/option-snapshots", response_model=None)
def get_option_snapshots_pg(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query(..., description="Expiration YYYYMMDD or YYYY-MM-DD"),
    strikes: Optional[str] = Query(
        None,
        description="Comma-separated strikes; if omitted, uses ATM ladder from daily last when available",
    ),
    source: str = Query("massive", description="Snapshot source column: massive | ib"),
) -> Any:
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

    cache_fingerprint = hashlib.sha256(
        json.dumps(keys, sort_keys=True).encode()
    ).hexdigest()[:24]
    cache_key = f"massive:snapshot_cache:{sym}:{exp_norm}:{src}:{cache_fingerprint}"
    try:
        import redis

        rurl = redis_url_from_config(reader._config if reader else {})
        if rurl:
            rc = redis.from_url(rurl, decode_responses=True)
            cached = rc.get(cache_key)
            if cached:
                return JSONResponse(
                    content=json.loads(cached),
                    headers={
                        "X-Cache": "HIT",
                        "Cache-Control": f"private, max-age={SNAPSHOT_CACHE_TTL_SEC}",
                    },
                )
    except Exception:
        pass

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
    if not out_rows and keys:
        out["warning"] = (
            "No rows in option_snapshots for the requested contract keys. "
            "Run Load quotes again after a successful Massive chain snapshot, or verify expiry/strikes match the chain."
        )
    try:
        import redis

        rurl = redis_url_from_config(reader._config if reader else {})
        if rurl:
            rc = redis.from_url(rurl, decode_responses=True)
            rc.setex(cache_key, SNAPSHOT_CACHE_TTL_SEC, json.dumps(out, default=str))
    except Exception:
        pass
    return JSONResponse(
        content=out,
        headers={
            "X-Cache": "MISS",
            "Cache-Control": f"private, max-age={SNAPSHOT_CACHE_TTL_SEC}",
        },
    )


@router.get("/research/option-contract/liquidity-summary")
def get_option_contract_liquidity_summary(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query(..., description="Expiration YYYYMMDD or YYYY-MM-DD"),
    strike: float = Query(..., description="Strike price"),
    right: str = Query(..., description="C or P"),
    source: str = Query("massive", description="massive | ib"),
) -> Dict[str, Any]:
    """P1: Aggregate liquidity stats for a single contract — spread percentile, OI rank, snapshot freshness."""
    from servers.massive_client import contract_key_from_parts
    from servers.reader.massive_jobs import get_option_snapshots_latest

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = (symbol or "").strip().upper()
    exp_norm = _norm_expiry_key((expiration or "").strip())
    r = (right or "").strip().upper()
    if not sym or not exp_norm or r not in ("C", "P"):
        return {"ok": False, "error": "symbol, expiration, strike, and right (C/P) are required"}
    src = (source or "massive").strip().lower()
    if src not in ("massive", "ib"):
        src = "massive"

    reader = getattr(request.app.state, "reader", None)
    last_price: Optional[float] = None
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(sym)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])
    strikes_list = _strikes_around_spot(last_price) if last_price else [strike]

    all_keys: List[str] = []
    for st in strikes_list:
        for rt in ("C", "P"):
            all_keys.append(contract_key_from_parts(sym, exp_norm, float(st), rt))
    target_key = contract_key_from_parts(sym, exp_norm, float(strike), r)
    if target_key not in all_keys:
        all_keys.append(target_key)

    rows = get_option_snapshots_latest(db, all_keys, source=src)
    spreads_same_right: List[float] = []
    oi_same_right: List[int] = []
    target_row: Optional[dict] = None
    for row in rows:
        ck = row.get("contract_key") or ""
        bid = row.get("bid")
        ask = row.get("ask")
        mid_val = row.get("mid")
        oi_val = row.get("open_interest")
        r_part = ck.rsplit("|", 1)[-1] if "|" in ck else ""
        if r_part == r:
            if bid is not None and ask is not None and mid_val is not None:
                try:
                    mid_f = float(mid_val)
                    if mid_f > 0:
                        spreads_same_right.append((float(ask) - float(bid)) / mid_f * 100)
                except (TypeError, ValueError):
                    pass
            if oi_val is not None:
                try:
                    oi_same_right.append(int(oi_val))
                except (TypeError, ValueError):
                    pass
        if ck == target_key:
            target_row = row

    spread_pct: Optional[float] = None
    spread_percentile: Optional[float] = None
    if target_row:
        bid = target_row.get("bid")
        ask = target_row.get("ask")
        mid_v = target_row.get("mid")
        if bid is not None and ask is not None and mid_v is not None:
            try:
                mid_f = float(mid_v)
                if mid_f > 0:
                    spread_pct = (float(ask) - float(bid)) / mid_f * 100
            except (TypeError, ValueError):
                pass
    if spread_pct is not None and len(spreads_same_right) > 1:
        rank = sum(1 for s in spreads_same_right if s <= spread_pct)
        spread_percentile = (rank / len(spreads_same_right)) * 100

    oi_percentile: Optional[float] = None
    target_oi = target_row.get("open_interest") if target_row else None
    if target_oi is not None and len(oi_same_right) > 1:
        try:
            toi = int(target_oi)
            rank = sum(1 for o in oi_same_right if o <= toi)
            oi_percentile = (rank / len(oi_same_right)) * 100
        except (TypeError, ValueError):
            pass

    snapshot_ts: Optional[str] = None
    if target_row and target_row.get("snapshot_ts"):
        ts = target_row["snapshot_ts"]
        snapshot_ts = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)

    return {
        "ok": True,
        "symbol": sym,
        "expiration": exp_norm,
        "strike": strike,
        "right": r,
        "source": src,
        "spread_pct": round(spread_pct, 2) if spread_pct is not None else None,
        "spread_percentile": round(spread_percentile, 1) if spread_percentile is not None else None,
        "oi": int(target_oi) if target_oi is not None else None,
        "oi_percentile": round(oi_percentile, 1) if oi_percentile is not None else None,
        "contracts_compared": len(spreads_same_right),
        "snapshot_ts": snapshot_ts,
    }


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


@router.get("/research/option-contract/relative-value")
def get_option_contract_relative_value(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expiration: str = Query(..., description="Expiration YYYYMMDD or YYYY-MM-DD"),
    strike: float = Query(..., description="Strike price"),
    right: str = Query(..., description="C or P"),
    source: str = Query("massive", description="massive | ib"),
) -> Dict[str, Any]:
    """P2: IV relative value — z-score vs same-right contracts in same expiry."""
    from servers.massive_client import contract_key_from_parts
    from servers.reader.massive_jobs import get_option_snapshots_latest
    import math

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    sym = (symbol or "").strip().upper()
    exp_norm = _norm_expiry_key((expiration or "").strip())
    r = (right or "").strip().upper()
    if not sym or not exp_norm or r not in ("C", "P"):
        return {"ok": False, "error": "symbol, expiration, strike, and right (C/P) are required"}
    src = (source or "massive").strip().lower()
    if src not in ("massive", "ib"):
        src = "massive"

    reader = getattr(request.app.state, "reader", None)
    last_price: Optional[float] = None
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(sym)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])
    wide_strikes = _strikes_around_spot(last_price, count=30) if last_price else [strike]

    keys: List[str] = []
    for st in wide_strikes:
        keys.append(contract_key_from_parts(sym, exp_norm, float(st), r))
    target_key = contract_key_from_parts(sym, exp_norm, float(strike), r)
    if target_key not in keys:
        keys.append(target_key)

    rows = get_option_snapshots_latest(db, keys, source=src)
    ivs: List[float] = []
    target_iv: Optional[float] = None
    iv_curve: List[Dict[str, Any]] = []
    for row in rows:
        iv = row.get("iv")
        if iv is None:
            continue
        try:
            iv_f = float(iv)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(iv_f):
            continue
        ck = row.get("contract_key") or ""
        parts = ck.split("|")
        row_strike = float(parts[3]) if len(parts) > 3 else 0
        ivs.append(iv_f)
        iv_curve.append({"strike": row_strike, "iv": round(iv_f, 6)})
        if ck == target_key:
            target_iv = iv_f

    if target_iv is None or len(ivs) < 3:
        return {
            "ok": True,
            "label": None,
            "iv_zscore": None,
            "this_iv": target_iv,
            "avg_iv": None,
            "contracts_compared": len(ivs),
            "iv_curve": sorted(iv_curve, key=lambda x: x["strike"]),
        }

    mean = sum(ivs) / len(ivs)
    std = math.sqrt(sum((v - mean) ** 2 for v in ivs) / len(ivs))
    if std < 1e-8:
        z = 0.0
    else:
        z = (target_iv - mean) / std
    label = "Rich" if z > 1 else ("Cheap" if z < -1 else "Neutral")

    return {
        "ok": True,
        "label": label,
        "iv_zscore": round(z, 3),
        "this_iv": round(target_iv, 6),
        "avg_iv": round(mean, 6),
        "std_iv": round(std, 6),
        "contracts_compared": len(ivs),
        "iv_curve": sorted(iv_curve, key=lambda x: x["strike"]),
    }


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


@router.get("/research/massive/market-ops/conditions")
def get_massive_market_conditions(
    request: Request,
    asset_class: Optional[str] = Query(None, description="options | stocks | crypto | fx"),
    data_type: Optional[str] = Query(None, description="trade | bbo | nbbo"),
    limit: int = Query(1000, ge=1, le=1000),
) -> Dict[str, Any]:
    """Condition codes from Massive REST (read-only, no DB write)."""
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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


# ── Technical Indicators (cross-asset, read-only) ──

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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


# ── Trades & Quotes (Options REST, read-only) ──

@router.get("/research/massive/trades-quotes/last-trade/{options_ticker}")
def get_massive_last_trade(request: Request, options_ticker: str) -> Dict[str, Any]:
    """GET /v2/last/trade/{optionsTicker} — most recent trade for a contract (read-only, Starter)."""
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.massive_config import get_massive_settings
    from servers.massive_client import MassiveClient

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
    from servers.reader.massive_jobs import list_job_massive_backfill

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
    from servers.reader.massive_jobs import trim_job_massive_backfill

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


@router.delete("/research/massive/jobs/{job_id}")
def delete_massive_job(request: Request, job_id: str) -> Dict[str, Any]:
    """Delete one Massive sync job row."""
    from servers.reader.massive_jobs import delete_job_massive_backfill

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
    from servers.reader.massive_jobs import get_corporate_actions

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


@router.get("/research/iv-term-structure", response_model=None)
def get_iv_term_structure(
    request: Request,
    symbol: str = Query(..., description="Underlying symbol"),
    expirations: str = Query(
        ...,
        description="Comma-separated expiration dates (YYYYMMDD or YYYY-MM-DD), max 12",
    ),
    source: str = Query("massive", description="Snapshot source: massive | ib"),
) -> Dict[str, Any]:
    """ATM IV for multiple expirations — powers the IV term structure chart."""
    from datetime import date, datetime

    from servers.massive_client import contract_key_from_parts
    from servers.reader.massive_jobs import get_option_snapshots_latest

    db = _db_config(request)
    if not db:
        return {"ok": False, "symbol": symbol, "points": [], "error": "PostgreSQL not configured"}

    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "symbol": sym, "points": [], "error": "symbol is required"}

    src = (source or "massive").strip().lower()
    if src not in ("massive", "ib"):
        src = "massive"

    exp_list: List[str] = []
    for raw in (expirations or "").split(","):
        e = _norm_expiry_key(raw)
        if len(e) == 8 and e.isdigit():
            exp_list.append(e)
    exp_list = exp_list[:12]
    if len(exp_list) < 2:
        return {"ok": False, "symbol": sym, "points": [], "error": "Need at least 2 valid expirations"}

    reader = getattr(request.app.state, "reader", None)
    last_price: Optional[float] = None
    if reader and hasattr(reader, "get_stock_day_fallback_price"):
        fallback = reader.get_stock_day_fallback_price(sym)
        if fallback and fallback[0] is not None and fallback[0] > 0:
            last_price = float(fallback[0])
    if not last_price:
        return {"ok": False, "symbol": sym, "points": [], "error": "No underlying price available for ATM strike selection"}

    atm_strikes = _strikes_around_spot(last_price, count=2)
    if not atm_strikes:
        return {"ok": False, "symbol": sym, "points": [], "error": "Cannot compute ATM strikes"}

    all_keys: List[str] = []
    key_exp_map: Dict[str, str] = {}
    for exp in exp_list:
        for st in atm_strikes:
            for r in ("C", "P"):
                k = contract_key_from_parts(sym, exp, float(st), r)
                all_keys.append(k)
                key_exp_map[k] = exp

    rows = get_option_snapshots_latest(db, all_keys, source=src)

    exp_iv: Dict[str, List[Tuple[float, Optional[float], Optional[float], float]]] = {}
    for row in rows:
        ck = row.get("contract_key") or ""
        exp = key_exp_map.get(ck)
        if not exp:
            continue
        strike, right = _parse_contract_key(ck)
        if strike is None:
            continue
        iv_val = row.get("iv")
        if iv_val is None:
            continue
        try:
            iv_f = float(iv_val)
        except (TypeError, ValueError):
            continue
        if not (0 < iv_f < 10):
            continue
        entry = exp_iv.setdefault(exp, [])
        dist = abs(strike - last_price)
        if right == "C":
            entry.append((dist, iv_f, None, strike))
        else:
            entry.append((dist, None, iv_f, strike))

    today = date.today()
    points: List[Dict[str, Any]] = []
    for exp in exp_list:
        items = exp_iv.get(exp, [])
        if not items:
            continue
        items.sort(key=lambda x: x[0])
        best_call: Optional[float] = None
        best_put: Optional[float] = None
        best_strike: Optional[float] = None
        for dist, iv_c, iv_p, st in items:
            if iv_c is not None and best_call is None:
                best_call = iv_c
                if best_strike is None:
                    best_strike = st
            if iv_p is not None and best_put is None:
                best_put = iv_p
                if best_strike is None:
                    best_strike = st
            if best_call is not None and best_put is not None:
                break

        atm_iv: Optional[float] = None
        if best_call is not None and best_put is not None:
            atm_iv = (best_call + best_put) / 2
        elif best_call is not None:
            atm_iv = best_call
        elif best_put is not None:
            atm_iv = best_put
        if atm_iv is None:
            continue

        try:
            exp_date = datetime.strptime(exp, "%Y%m%d").date()
        except ValueError:
            continue
        dte = (exp_date - today).days
        if dte < 0:
            continue

        points.append({
            "expiration": exp,
            "dte_days": dte,
            "strike": best_strike,
            "iv_call": best_call,
            "iv_put": best_put,
            "atm_iv": atm_iv,
        })

    points.sort(key=lambda p: p["dte_days"])
    return {"ok": True, "symbol": sym, "underlying_price": last_price, "points": points}
