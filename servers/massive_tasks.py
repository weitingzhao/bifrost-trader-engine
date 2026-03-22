"""Celery tasks for Massive / Polygon options sync (queue: massive)."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_here = Path(__file__).resolve().parent
_project_root = _here.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from servers.celery_app import app  # noqa: E402

logger = logging.getLogger(__name__)


def _config_path_for_task() -> Optional[str]:
    for a in sys.argv[1:]:
        if a.startswith("-"):
            continue
        candidate = Path(a) if os.path.isabs(a) else _project_root / a
        if candidate.is_file() and candidate.suffix.lower() in (".yaml", ".yml"):
            return str(candidate.resolve())
    return None


def _norm_expiry(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 10 and s[4] == "-":
        return s[:4] + s[5:7] + s[8:10]
    return s


def _right_from_contract_type(ct: str) -> str:
    u = (ct or "").upper()
    if u in ("CALL", "C"):
        return "C"
    if u in ("PUT", "P"):
        return "P"
    return "C"


def _parse_snapshot_ts(item: Dict[str, Any]) -> datetime:
    lt = item.get("last_trade") or {}
    lq = item.get("last_quote") or {}
    for ns in (
        lt.get("sip_timestamp"),
        lt.get("participant_timestamp"),
        lq.get("last_updated"),
    ):
        if ns is not None:
            try:
                n = int(ns)
                if n > 1_000_000_000_000_000_000:
                    return datetime.fromtimestamp(n / 1e9, tz=timezone.utc)
                if n > 1_000_000_000_000:
                    return datetime.fromtimestamp(n / 1000.0, tz=timezone.utc)
                return datetime.fromtimestamp(float(n), tz=timezone.utc)
            except (TypeError, ValueError, OSError):
                pass
    return datetime.now(timezone.utc)


def _apply_snapshot(
    conn: Any,
    underlying: str,
    snap: Dict[str, Any],
) -> int:
    """Insert option_contracts + option_snapshots rows. Returns count inserted."""
    from servers.massive_client import contract_key_from_parts

    results = snap.get("results")
    if not isinstance(results, list):
        return 0
    underlying = (underlying or "").strip().upper()
    n = 0
    with conn.cursor() as cur:
        for item in results:
            if not isinstance(item, dict):
                continue
            det = item.get("details") or {}
            ticker = (det.get("ticker") or item.get("ticker") or "").strip()
            if not ticker:
                continue
            exp_raw = det.get("expiration_date") or det.get("expiration")
            if not exp_raw:
                continue
            exp = _norm_expiry(str(exp_raw)[:10])
            try:
                strike = float(det.get("strike_price"))
            except (TypeError, ValueError):
                continue
            ort = _right_from_contract_type(det.get("contract_type", "call"))
            ck = contract_key_from_parts(underlying, exp, strike, ort)
            g = item.get("greeks") if isinstance(item.get("greeks"), dict) else {}
            iv = g.get("iv")
            if iv is None:
                iv = item.get("implied_volatility")
            lq = item.get("last_quote") if isinstance(item.get("last_quote"), dict) else {}
            lt = item.get("last_trade") if isinstance(item.get("last_trade"), dict) else {}
            bid = lq.get("bid") or lq.get("p")
            ask = lq.get("ask") or lq.get("P")
            last = lt.get("price")
            if last is None and isinstance(lt.get("last"), (int, float)):
                last = lt.get("last")
            mid = None
            if bid is not None and ask is not None:
                try:
                    mid = (float(bid) + float(ask)) / 2.0
                except (TypeError, ValueError):
                    mid = last
            else:
                mid = last
            oi = item.get("open_interest")
            if oi is not None:
                try:
                    oi = int(oi)
                except (TypeError, ValueError):
                    oi = None
            ua = item.get("underlying_asset") or {}
            if isinstance(ua, dict):
                up = ua.get("price")
            else:
                up = None
            ts = _parse_snapshot_ts(item)
            cur.execute(
                """
                INSERT INTO option_contracts (contract_key, symbol, expiry, strike, option_right, massive_option_ticker, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (contract_key) DO UPDATE SET
                  massive_option_ticker = COALESCE(EXCLUDED.massive_option_ticker, option_contracts.massive_option_ticker)
                """,
                (ck, underlying, exp, strike, ort, ticker),
            )
            cur.execute(
                """
                INSERT INTO option_snapshots (
                  contract_key, snapshot_ts, last, bid, ask, mid,
                  iv, delta, gamma, theta, vega, open_interest, underlying_price, source, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'massive', now())
                """,
                (
                    ck,
                    ts,
                    float(last) if last is not None else None,
                    float(bid) if bid is not None else None,
                    float(ask) if ask is not None else None,
                    float(mid) if mid is not None else None,
                    float(iv) if iv is not None else None,
                    float(g.get("delta")) if g.get("delta") is not None else None,
                    float(g.get("gamma")) if g.get("gamma") is not None else None,
                    float(g.get("theta")) if g.get("theta") is not None else None,
                    float(g.get("vega")) if g.get("vega") is not None else None,
                    oi,
                    float(up) if up is not None else None,
                ),
            )
            n += 1
    return n


def _apply_aggs(
    conn: Any,
    symbol: str,
    expiry: str,
    strike: float,
    option_right: str,
    period: str,
    aggs: Dict[str, Any],
) -> int:
    """Upsert option_min bars from /v2/aggs response."""
    exp = _norm_expiry(expiry)
    r = option_right.strip().upper()
    if r in ("CALL",):
        r = "C"
    if r in ("PUT",):
        r = "P"
    bars = aggs.get("results") or []
    if not isinstance(bars, list):
        return 0
    n = 0
    with conn.cursor() as cur:
        for bar in bars:
            if not isinstance(bar, dict):
                continue
            t = bar.get("t")
            if t is None:
                continue
            try:
                ts_ms = int(t)
                bt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
            except (TypeError, ValueError, OSError):
                continue
            o = bar.get("o")
            h = bar.get("h")
            l = bar.get("l")
            c = bar.get("c")
            v = bar.get("v")
            cur.execute(
                """
                INSERT INTO option_min (
                  symbol, expiry, strike, option_right, period, bar_time,
                  open, high, low, close, volume, source, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'massive', now())
                ON CONFLICT (symbol, expiry, strike, option_right, period, bar_time, source)
                DO UPDATE SET
                  open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                  close = EXCLUDED.close, volume = EXCLUDED.volume
                """,
                (
                    symbol.upper(),
                    exp,
                    float(strike),
                    r,
                    period,
                    bt,
                    float(o) if o is not None else None,
                    float(h) if h is not None else None,
                    float(l) if l is not None else None,
                    float(c) if c is not None else None,
                    float(v) if v is not None else None,
                ),
            )
            n += 1
    return n


def _apply_corporate_actions(
    conn: Any,
    client: Any,
    symbol: str,
) -> int:
    """Fetch dividends + splits from Massive/Polygon and upsert into massive_corporate_action."""
    total = 0
    with conn.cursor() as cur:
        divs = client.fetch_dividends(symbol)
        for d in divs.get("results") or []:
            if not isinstance(d, dict):
                continue
            ex = d.get("ex_dividend_date") or ""
            if not ex:
                continue
            cur.execute(
                """
                INSERT INTO massive_corporate_action
                  (symbol, action_type, ex_date, record_date, payment_date,
                   amount, description, source, created_at)
                VALUES (%s, 'dividend', %s, %s, %s, %s, %s, 'massive', now())
                ON CONFLICT (symbol, action_type, ex_date, source)
                DO UPDATE SET
                  record_date   = EXCLUDED.record_date,
                  payment_date  = EXCLUDED.payment_date,
                  amount        = EXCLUDED.amount,
                  description   = EXCLUDED.description
                """,
                (
                    symbol,
                    ex,
                    d.get("record_date"),
                    d.get("pay_date"),
                    float(d["cash_amount"]) if d.get("cash_amount") is not None else None,
                    d.get("description") or d.get("dividend_type") or None,
                ),
            )
            total += 1

        splits = client.fetch_splits(symbol)
        for s in splits.get("results") or []:
            if not isinstance(s, dict):
                continue
            ex = s.get("execution_date") or ""
            if not ex:
                continue
            cur.execute(
                """
                INSERT INTO massive_corporate_action
                  (symbol, action_type, ex_date, ratio_from, ratio_to,
                   description, source, created_at)
                VALUES (%s, 'split', %s, %s, %s, %s, 'massive', now())
                ON CONFLICT (symbol, action_type, ex_date, source)
                DO UPDATE SET
                  ratio_from  = EXCLUDED.ratio_from,
                  ratio_to    = EXCLUDED.ratio_to,
                  description = EXCLUDED.description
                """,
                (
                    symbol,
                    ex,
                    float(s["split_from"]) if s.get("split_from") is not None else None,
                    float(s["split_to"]) if s.get("split_to") is not None else None,
                    f'{s.get("split_from")}:{s.get("split_to")}',
                ),
            )
            total += 1
    return total


@app.task(bind=True, name="servers.massive_tasks.run_massive_job")
def run_massive_job(self, job_id: int) -> Dict[str, Any]:
    """Execute one job_massive_backfill row."""
    from src.app.config import read_config
    from servers.massive_client import MassiveClient
    from servers.massive_config import get_massive_settings
    from servers.reader.massive_jobs import get_job_massive_backfill, update_job_massive_backfill_result
    import psycopg2
    from src.sink.pg_connection import _get_conn_params

    cfg_path = _config_path_for_task()
    config, _ = read_config(cfg_path)
    status_cfg = config
    if not status_cfg.get("postgres") and status_cfg.get("sink") != "postgres":
        return {"ok": False, "error": "postgres not configured"}

    ms = get_massive_settings(config)
    client = MassiveClient(ms["api_key"], ms["rest_base"])
    if not client.configured:
        update_job_massive_backfill_result(status_cfg, job_id, "failed", {"ok": False, "error": "Massive API key not configured"})
        return {"ok": False, "error": "no api key"}

    job = get_job_massive_backfill(status_cfg, job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    kind = (job.get("kind") or "").strip().lower()
    payload = job.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}

    update_job_massive_backfill_result(status_cfg, job_id, "running", None)

    try:
        params = _get_conn_params(status_cfg)
        conn = psycopg2.connect(**params)
        try:
            if kind == "snapshot":
                u = (payload.get("underlying") or payload.get("symbol") or "").strip().upper()
                if not u:
                    raise ValueError("payload.underlying required")
                snap = client.fetch_options_snapshot(u)
                if snap.get("error"):
                    raise RuntimeError(str(snap.get("error")))
                count = _apply_snapshot(conn, u, snap)
                conn.commit()
                result = {"ok": True, "kind": kind, "rows_written": count}
                update_job_massive_backfill_result(status_cfg, job_id, "done", result)
                return result

            if kind == "aggregates":
                ot = (payload.get("options_ticker") or "").strip()
                if not ot:
                    raise ValueError("payload.options_ticker required")
                mult = int(payload.get("multiplier") or 1)
                ts = (payload.get("timespan") or "minute").strip()
                start_ms = int(payload.get("start_ms") or 0)
                end_ms = int(payload.get("end_ms") or 0)
                sym = (payload.get("symbol") or "").strip().upper()
                exp = (payload.get("expiry") or "").strip()
                strike = float(payload.get("strike") or 0)
                opt_right = (payload.get("option_right") or "C").strip()
                period_map = {"minute": "1 min", "second": "1 sec", "hour": "1 hour"}
                period = period_map.get(ts, "1 min")
                if not start_ms or not end_ms:
                    raise ValueError("start_ms and end_ms required")
                aggs = client.fetch_option_aggs(ot, mult, ts, start_ms, end_ms)
                if aggs.get("error"):
                    raise RuntimeError(str(aggs.get("error")))
                count = _apply_aggs(conn, sym, exp, strike, opt_right, period, aggs)
                conn.commit()
                result = {"ok": True, "kind": kind, "bars_upserted": count}
                update_job_massive_backfill_result(status_cfg, job_id, "done", result)
                return result

            if kind == "oi":
                result = {"ok": True, "kind": kind, "message": "Use snapshot job to populate OI from chain data"}
                update_job_massive_backfill_result(status_cfg, job_id, "done", result)
                return result

            if kind == "corporate_action":
                sym = (payload.get("symbol") or "").strip().upper()
                if not sym:
                    raise ValueError("payload.symbol required")
                count = _apply_corporate_actions(conn, client, sym)
                conn.commit()
                result = {"ok": True, "kind": kind, "rows_upserted": count}
                update_job_massive_backfill_result(status_cfg, job_id, "done", result)
                return result

            raise ValueError(f"unknown kind: {kind}")
        except Exception as e:
            conn.rollback()
            logger.exception("run_massive_job failed: %s", e)
            err = {"ok": False, "error": str(e)}
            update_job_massive_backfill_result(status_cfg, job_id, "failed", err)
            return err
        finally:
            conn.close()
    except Exception as e:
        logger.exception("run_massive_job outer: %s", e)
        err = {"ok": False, "error": str(e)}
        update_job_massive_backfill_result(status_cfg, job_id, "failed", err)
        return err
