#!/usr/bin/env python3
"""IB market data ingestor — standalone process (separate client_id from gateway/daemon).

Uses ``get_effective_ib_config`` → ``client_id_ib_ingestor`` from YAML ``ib.host.client_id.ingestor``
(legacy YAML key ``ib_market_ingest`` under ``client_id`` still accepted). Default 150 if omitted.

Subscribes to Watchlist STK/OPT contracts via ib_insync, writes latest quotes to Redis ``ib:ingester:tick:*``,
health hash ``ib:ingester:meta:health`` (incl. client_id), subscriptions set, and pub channel ``ib:ingester:channel``.
Does not write ``quote:{symbol}`` (daemon-owned).

Usage
-----
  python scripts/run_ib_ingestor.py
  python scripts/run_ib_ingestor.py --config config/config.prod.yaml --log-level DEBUG

Phase 2 optional PostgreSQL sampling is not implemented; see plan (DATABASE.md review).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(str(_PROJECT_ROOT))

from backend.monitor.routers.deps import IB_INGESTOR_LOG_STREAM_KEY
from src.core.logging_redis_stream import RedisStreamLogHandler

_IB_INGESTOR_LOG_STREAM_MAXLEN = 2000

logger = logging.getLogger("ib_ingestor")

_RESET = "\033[0m"
_BOLD = "\033[1m"
_GRAY = "\033[90m"
_CYAN = "\033[36m"
_YELLOW = "\033[33m"
_RED = "\033[31m"

_LEVEL_COLORS = {
    logging.DEBUG: _GRAY,
    logging.INFO: _CYAN,
    logging.WARNING: _YELLOW,
    logging.ERROR: _RED + _BOLD,
    logging.CRITICAL: _RED + _BOLD,
}


class ColoredFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        color = _LEVEL_COLORS.get(record.levelno, _RESET)
        original_levelname = record.levelname
        try:
            record.levelname = f"{color}[{record.levelname}]{_RESET}"
            return super().format(record)
        finally:
            record.levelname = original_levelname


def _console_log_redis_url(config_path: str | None) -> str:
    """Use the same merged YAML as ``_load_config`` so Redis console stream matches Monitor (Prod systemd)."""
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config(config_path)
    except (ImportError, OSError, ValueError, TypeError):
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def _setup_logging(level: int, config_path: str | None) -> None:
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(name)s %(levelname)s  %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    redis_handler = RedisStreamLogHandler(
        _console_log_redis_url(config_path),
        IB_INGESTOR_LOG_STREAM_KEY,
        maxlen=_IB_INGESTOR_LOG_STREAM_MAXLEN,
    )
    redis_handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(console_handler)
    root.addHandler(redis_handler)
    root.setLevel(level)


def _load_config(config_path: str | None) -> dict:
    from src.app.config import read_config

    cfg, _ = read_config(config_path)
    return cfg


def _redis_client(cfg: dict):
    import redis

    rc = cfg.get("redis") or {}
    return redis.Redis(
        host=rc.get("host", "127.0.0.1"),
        port=int(rc.get("port", 6379)),
        db=int(rc.get("db", 0)),
        password=rc.get("password") or None,
        socket_connect_timeout=5,
        decode_responses=True,
    )


def _ingest_settings(cfg: dict) -> Dict[str, Any]:
    raw = cfg.get("ib_ingestor")
    if isinstance(raw, dict):
        return raw
    raw = cfg.get("ib_market_ingest")
    if isinstance(raw, dict):
        return raw
    return {}


def _watchlist_targets(
    cfg: dict,
    max_subscriptions: int,
    include_stk: bool,
    include_opt: bool,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Return (opt_contract_dicts, stk_symbols) capped by max_subscriptions (OPT rows first)."""
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        from src.persistence.postgres.connection import _get_conn_params

        status_cfg = cfg.get("status") or cfg
        params = _get_conn_params(status_cfg)
        conn = psycopg2.connect(**params)
        try:
            opt_rows: List[Dict[str, Any]] = []
            stk_syms: List[str] = []
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if include_opt:
                    cur.execute(
                        """
                        SELECT contract_key, symbol, expiry, strike, option_right
                        FROM watchlist
                        WHERE sec_type = 'OPT'
                          AND symbol IS NOT NULL AND TRIM(symbol) <> ''
                          AND expiry IS NOT NULL AND TRIM(expiry) <> ''
                          AND strike IS NOT NULL
                        ORDER BY created_at DESC
                        """
                    )
                    for r in cur.fetchall():
                        ck = (r.get("contract_key") or "").strip()
                        if not ck:
                            continue
                        opt_rows.append(
                            {
                                "contract_key": ck,
                                "symbol": (r.get("symbol") or "").strip(),
                                "expiry": (r.get("expiry") or "").strip(),
                                "strike": float(r["strike"]),
                                "option_right": (r.get("option_right") or "C").strip().upper() or "C",
                            }
                        )
                if include_stk:
                    cur.execute(
                        """
                        SELECT DISTINCT TRIM(symbol) AS sym
                        FROM watchlist
                        WHERE sec_type = 'STK' AND symbol IS NOT NULL AND TRIM(symbol) <> ''
                        ORDER BY sym
                        """
                    )
                    stk_syms = [row["sym"] for row in cur.fetchall() if row.get("sym")]
        finally:
            conn.close()

        budget = max(0, int(max_subscriptions))
        opt_take = min(len(opt_rows), budget)
        opt_sel = opt_rows[:opt_take]
        remaining = budget - opt_take
        stk_sel = stk_syms[: max(0, remaining)]
        return opt_sel, stk_sel
    except Exception as e:
        logger.warning("Watchlist load failed: %s", e)
        return [], []


def _float_or_none(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        v = float(x)
        if math.isnan(v):
            return None
        return v
    except (TypeError, ValueError):
        return None


def _quote_payload(contract_key: str, sec_type: str, t: Any) -> Dict[str, Any]:
    bid = _float_or_none(getattr(t, "bid", None))
    ask = _float_or_none(getattr(t, "ask", None))
    last = _float_or_none(getattr(t, "last", None))
    mid: Optional[float] = None
    if bid is not None and ask is not None:
        mid = (bid + ask) / 2.0
    elif last is not None:
        mid = last
    ts = time.time()
    sym = contract_key.split("|", 1)[0] if "|" in contract_key else contract_key
    return {
        "bid": bid,
        "ask": ask,
        "last": last,
        "mid": mid,
        "ts": ts,
        "contract_key": contract_key,
        "symbol": sym,
        "sec_type": sec_type,
    }


WATCHLIST_POLL_SEC = 60
RECONNECT_BASE = 2.0
RECONNECT_MAX = 60.0


class IbIngestorApp:
    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._st = _ingest_settings(cfg)
        self._rds = _redis_client(cfg)
        from src.vendor.ib_ingestor.writer import IbIngestorRedisWriter

        self._writer = IbIngestorRedisWriter(self._rds)
        self._stop = asyncio.Event()
        self._reconnects = 0
        self._msg_count = 0
        self._last_msg_ts = 0.0
        self._client_id = 0

    def _max_subscriptions(self) -> int:
        try:
            return max(1, min(5000, int(self._st.get("max_subscriptions", 200))))
        except (TypeError, ValueError):
            return 200

    def _include_stk(self) -> bool:
        return bool(self._st.get("include_stk", True))

    def _include_opt(self) -> bool:
        return bool(self._st.get("include_opt", True))

    async def run(self) -> None:
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass

        from src.app.config import get_effective_ib_config
        from src.monitor.integrations.ib_clients import MarketIbClient

        ib_eff = get_effective_ib_config(self._cfg)
        self._client_id = int(ib_eff["client_id_ib_ingestor"])
        host = str(ib_eff["host"])
        port = int(ib_eff.get("port_market_data", ib_eff["port"]))
        cid = self._client_id

        logger.info(
            "IB ingestor starting host=%s port=%s (market data) client_id=%s max_subs=%s",
            host,
            port,
            cid,
            self._max_subscriptions(),
        )

        while not self._stop.is_set():
            client = MarketIbClient(host, port, cid, name="IbIngestor")
            try:
                await self._run_connected_session(client)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Ingest session error: %s", e, exc_info=True)

            if self._stop.is_set():
                break

            self._reconnects += 1
            delay = min(
                RECONNECT_BASE * (2 ** min(self._reconnects - 1, 6)),
                RECONNECT_MAX,
            )
            self._writer.update_health(
                self._client_id,
                False,
                time.time(),
                self._reconnects,
                self._msg_count,
            )
            logger.info("Reconnecting in %.1fs (attempt %d)…", delay, self._reconnects)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        self._writer.update_health(
            self._client_id,
            False,
            time.time(),
            self._reconnects,
            self._msg_count,
        )
        logger.info(
            "IB ingestor stopped (messages=%d reconnects=%d)",
            self._msg_count,
            self._reconnects,
        )

    async def _run_connected_session(self, client: Any) -> None:
        await client.ensure_connected()
        self._reconnects = 0
        hb_task = asyncio.create_task(self._heartbeat_loop())
        try:
            while not self._stop.is_set():
                opt_rows, stk_syms = _watchlist_targets(
                    self._cfg,
                    self._max_subscriptions(),
                    self._include_stk(),
                    self._include_opt(),
                )
                if not opt_rows and not stk_syms:
                    logger.warning(
                        "No STK/OPT rows in watchlist; retry in %ds",
                        WATCHLIST_POLL_SEC,
                    )
                    self._writer.update_health(
                        self._client_id,
                        True,
                        time.time(),
                        self._reconnects,
                        self._msg_count,
                    )
                    self._writer.set_subscriptions(set())
                    try:
                        await asyncio.wait_for(
                            self._stop.wait(),
                            timeout=WATCHLIST_POLL_SEC,
                        )
                        return
                    except asyncio.TimeoutError:
                        continue

                keys: Set[str] = {r["contract_key"] for r in opt_rows}
                for s in stk_syms:
                    keys.add(f"{s}|STK|||")

                def on_opt(ck: str, ticker: Any) -> None:
                    self._on_tick(ck, "OPT", ticker)

                def on_stk(sym: str, ticker: Any) -> None:
                    ck = f"{sym}|STK|||"
                    self._on_tick(ck, "STK", ticker)

                async def _apply() -> None:
                    c = client.connector
                    if c is None:
                        raise RuntimeError("connector missing after ensure_connected")
                    for sym in list(c.get_subscribed_ticker_symbols()):
                        c.unsubscribe_ticker(sym)
                    for ck in list(c.get_subscribed_option_contract_keys()):
                        c.unsubscribe_option_ticker(ck)
                    if opt_rows:
                        await c.subscribe_option_tickers(opt_rows, on_opt)
                    if stk_syms:
                        await c.subscribe_tickers(stk_syms, on_stk)

                await client._run_on_client_loop(_apply())
                self._writer.set_subscriptions(keys)
                self._writer.update_health(
                    self._client_id,
                    True,
                    time.time(),
                    self._reconnects,
                    self._msg_count,
                )
                logger.info(
                    "Subscribed OPT=%d STK=%d (cap=%d)",
                    len(opt_rows),
                    len(stk_syms),
                    self._max_subscriptions(),
                )

                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=WATCHLIST_POLL_SEC)
                    return
                except asyncio.TimeoutError:
                    pass
        finally:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass
            try:
                await client.disconnect()
            except Exception as e:
                logger.debug("disconnect: %s", e)

    def _on_tick(self, contract_key: str, sec_type: str, ticker: Any) -> None:
        payload = _quote_payload(contract_key, sec_type, ticker)
        self._last_msg_ts = float(payload["ts"])
        self._msg_count += 1
        self._writer.write_quote(contract_key, payload)

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            ts = self._last_msg_ts or time.time()
            try:
                self._writer.update_health(
                    self._client_id,
                    True,
                    ts,
                    self._reconnects,
                    self._msg_count,
                )
            except Exception as e:
                logger.debug("heartbeat meta: %s", e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass


def _redis_ping_or_exit(cfg: dict) -> None:
    try:
        _redis_client(cfg).ping()
    except Exception as e:
        logger.error("Redis ping failed — IB ingestor cannot write ticks/meta: %s", e)
        print(
            "Hint: Use merged config/config.prod.yaml on the server; deploy with --sync-prod-config if needed.",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="IB ingestor (Redis ib:ingester:tick:*, ib:ingester:meta:health, …)",
    )
    parser.add_argument("--config", type=str, default=None, help="Path to YAML config")
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()

    cfg_path: str | None = args.config
    if cfg_path:
        p = Path(cfg_path)
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        if not p.is_file():
            print(
                f"ERROR: --config file not found: {args.config}\n"
                "  Deploy with: ./scripts/bifrost_ssh.sh --deploy --sync-prod-config\n"
                "  Or copy config/config.prod.yaml to the server.",
                file=sys.stderr,
            )
            sys.exit(2)
        cfg_path = str(p.resolve())
    else:
        for candidate in ("config/config.dev.yaml", "config/config.prod.yaml"):
            cp = _PROJECT_ROOT / candidate
            if cp.is_file():
                cfg_path = str(cp.resolve())
                break

    _setup_logging(getattr(logging, args.log_level), cfg_path)

    cfg = _load_config(cfg_path)
    _redis_ping_or_exit(cfg)
    app = IbIngestorApp(cfg)
    asyncio.run(app.run())


if __name__ == "__main__":
    main()
