#!/usr/bin/env python3
"""IB market data ingestor — standalone process (separate client_id from gateway/daemon).

Uses ``get_effective_ib_config`` → ``client_id_ib_ingestor`` from YAML ``ib.host.client_id.ingestor``
(legacy YAML key ``ib_market_ingest`` under ``client_id`` still accepted). Default 150 if omitted.

Subscribes to Watchlist STK/OPT contracts via ib_insync, writes latest quotes to Redis ``ib:ingester:tick:*``,
health hash ``bifrost:health:ws_ib_ingestor`` (incl. client_id), subscriptions set, and pub channel ``ib:ingester:channel``.
Console log stream ``bifrost:console:ws_ib_ingestor`` (Monitor ingestor log APIs). Does not write ``quote:{symbol}`` (daemon-owned).

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
from src.bifrost.message_center import IbConnectionStatusTracker
from src.core.logging_redis_stream import RedisStreamLogHandler
from src.monitor.integrations.ib_clients import SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC

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


def _on_demand_stk_symbols(rds: Any) -> List[str]:
    """Extra STK symbols from Redis SET ``ib:ingester:control:on_demand_stk`` (merged with watchlist)."""
    try:
        from src.vendor.ib_ingestor.redis_keys import IB_INGESTER_ON_DEMAND_STK

        raw = rds.smembers(IB_INGESTER_ON_DEMAND_STK)
    except Exception:
        return []
    out: List[str] = []
    for x in raw or []:
        s = str(x).strip().upper()
        if s:
            out.append(s)
    return out


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


class IbIngestorApp:
    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._st = _ingest_settings(cfg)
        self._rds = _redis_client(cfg)
        from src.vendor.ib_ingestor.writer import IbIngestorRedisWriter

        self._writer = IbIngestorRedisWriter(self._rds)
        self._status_tracker = IbConnectionStatusTracker(self._rds, service="ib_ingestor")
        self._stop = asyncio.Event()
        self._reconnects = 0
        self._msg_count = 0
        self._last_msg_ts = 0.0
        self._client_id = 0
        self._session_ib_client: Any = None
        self._last_ib_probe_at = 0.0
        self._last_ib_probe_ok = False
        self._ib_probe_interval_sec = 5.0
        self._session_disconnected = asyncio.Event()
        self._service_heartbeat_interval_sec = 30.0
        self._last_service_heartbeat_at = 0.0
        #: Set by service heartbeat after ensure_connected(); main loop re-runs subscriptions ASAP.
        self._pending_resubscribe = False

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
        self._ib_probe_interval_sec = float(ib_eff["ib_probe_interval_sec"])
        self._service_heartbeat_interval_sec = max(
            self._ib_probe_interval_sec,
            float(self._st.get("health_refresh_sec") or 30),
        )
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

        self._last_service_heartbeat_at = time.time()

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
            delay = self._service_heartbeat_interval_sec
            now = time.time()
            sh = self._ingest_heartbeat_meta(now)
            self._writer.update_health(
                self._client_id,
                False,
                now,
                self._reconnects,
                self._msg_count,
                ib_probe_at=0.0,
                ib_probe_ok=False,
                ib_probe_interval_sec=self._ib_probe_interval_sec,
                **sh,
            )
            self._status_tracker.update(
                slot="host",
                status="disconnected",
                client_id=self._client_id or None,
                occurred_at=now,
                reason="Session ended",
            )
            logger.info(
                "Next session reconnect in %.1fs (service heartbeat, attempt %d)…",
                delay,
                self._reconnects,
            )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        _now = time.time()
        self._writer.update_health(
            self._client_id,
            False,
            _now,
            self._reconnects,
            self._msg_count,
            ib_probe_at=0.0,
            ib_probe_ok=False,
            ib_probe_interval_sec=self._ib_probe_interval_sec,
            **self._ingest_heartbeat_meta(_now),
        )
        self._status_tracker.update(
            slot="host",
            status="disconnected",
            client_id=self._client_id or None,
            occurred_at=time.time(),
            reason="Service stopped",
        )
        logger.info(
            "IB ingestor stopped (messages=%d reconnects=%d)",
            self._msg_count,
            self._reconnects,
        )

    def _ingest_heartbeat_meta(self, now: float) -> Dict[str, float]:
        iv = float(self._service_heartbeat_interval_sec)
        lh = float(self._last_service_heartbeat_at)
        nx = max(0.0, lh + iv - now) if lh > 0 else iv
        return {
            "service_heartbeat_interval_sec": iv,
            "last_service_heartbeat_at": lh,
            "next_service_heartbeat_in_s": nx,
        }

    def _push_health(
        self,
        *,
        connected: bool,
        last_msg_ts: float,
        service_heartbeat_reconnect_in_progress: str = "",
    ) -> None:
        _now = time.time()
        self._writer.update_health(
            self._client_id,
            connected,
            last_msg_ts,
            self._reconnects,
            self._msg_count,
            ib_probe_at=self._last_ib_probe_at,
            ib_probe_ok=self._last_ib_probe_ok,
            ib_probe_interval_sec=self._ib_probe_interval_sec,
            service_heartbeat_reconnect_in_progress=service_heartbeat_reconnect_in_progress,
            **self._ingest_heartbeat_meta(_now),
        )
        self._status_tracker.update(
            slot="host",
            status="connected" if connected else "disconnected",
            client_id=self._client_id or None,
            occurred_at=last_msg_ts,
        )

    async def _wait_session_or_stop(self, timeout: float) -> bool:
        """Wait up to *timeout* seconds; return True if the session should exit
        (either stop requested or IB disconnect detected by heartbeat/probe)."""
        if self._stop.is_set() or self._session_disconnected.is_set():
            return True
        stop_f = asyncio.ensure_future(self._stop.wait())
        disc_f = asyncio.ensure_future(self._session_disconnected.wait())
        done, pending = await asyncio.wait(
            [stop_f, disc_f],
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        return self._stop.is_set() or self._session_disconnected.is_set()

    async def _wait_watchlist_interval_or_interrupt(self) -> bool:
        """Wait up to ``WATCHLIST_POLL_SEC`` for stop/disconnect.

        Returns True if the session should end. Returns False early when
        ``_pending_resubscribe`` is set (IB reconnected via service heartbeat but market
        subscriptions must be re-applied — TWS does not restore tick streams automatically).
        """
        deadline = time.monotonic() + float(WATCHLIST_POLL_SEC)
        while time.monotonic() < deadline:
            if self._stop.is_set() or self._session_disconnected.is_set():
                return True
            if self._pending_resubscribe:
                self._pending_resubscribe = False
                logger.info("Resyncing market subscriptions after IB reconnect (service heartbeat)")
                return False
            slice_rem = min(1.0, deadline - time.monotonic())
            if slice_rem <= 0:
                break
            if await self._wait_session_or_stop(slice_rem):
                return True
        return False

    async def _run_connected_session(self, client: Any) -> None:
        await client.ensure_connected()
        self._reconnects = 0
        self._session_ib_client = client
        self._session_disconnected.clear()
        self._pending_resubscribe = False
        self._status_tracker.update(
            slot="host",
            status="connected",
            client_id=self._client_id or None,
            occurred_at=time.time(),
        )
        hb_task = asyncio.create_task(self._heartbeat_loop())
        probe_task = asyncio.create_task(self._ib_probe_loop())
        try:
            while not self._stop.is_set():
                opt_rows, stk_syms = _watchlist_targets(
                    self._cfg,
                    self._max_subscriptions(),
                    self._include_stk(),
                    self._include_opt(),
                )
                extra_stk = _on_demand_stk_symbols(self._rds)
                if extra_stk:
                    seen_syms = set(stk_syms)
                    for s in extra_stk:
                        if s not in seen_syms:
                            seen_syms.add(s)
                            stk_syms.append(s)
                if not opt_rows and not stk_syms:
                    logger.warning(
                        "No STK/OPT rows in watchlist; retry in %ds",
                        WATCHLIST_POLL_SEC,
                    )
                    wire = client.connected_snapshot()
                    self._push_health(connected=wire, last_msg_ts=time.time())
                    self._writer.set_subscriptions(set())
                    if await self._wait_watchlist_interval_or_interrupt():
                        if self._session_disconnected.is_set():
                            logger.warning("IB disconnected during empty-watchlist wait — ending session for reconnect")
                        return
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
                wire = client.connected_snapshot()
                self._push_health(connected=wire, last_msg_ts=self._last_msg_ts or time.time())
                logger.info(
                    "Subscribed OPT=%d STK=%d (cap=%d)",
                    len(opt_rows),
                    len(stk_syms),
                    self._max_subscriptions(),
                )

                if await self._wait_watchlist_interval_or_interrupt():
                    if self._session_disconnected.is_set():
                        logger.warning("IB disconnected — ending session for reconnect")
                    return
        finally:
            self._session_ib_client = None
            hb_task.cancel()
            probe_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass
            try:
                await probe_task
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

    async def _ib_probe_loop(self) -> None:
        """Periodic IB API liveness (connected_snapshot); updates ib_probe_* independently of tick heartbeat."""
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=max(1.0, self._ib_probe_interval_sec),
                )
                break
            except asyncio.TimeoutError:
                pass
            cl = self._session_ib_client
            if cl is None:
                continue
            ok = cl.connected_snapshot()
            if not ok:
                self._session_disconnected.set()
            now = time.time()
            self._last_ib_probe_at = now
            self._last_ib_probe_ok = ok
            try:
                self._push_health(
                    connected=ok,
                    last_msg_ts=self._last_msg_ts or now,
                )
            except Exception as e:
                logger.debug("ib probe health: %s", e)

    async def _heartbeat_loop(self) -> None:
        """Freshen last_msg_ts / wire connected in Redis without treating meta-only writes as IB probe success."""
        while not self._stop.is_set():
            ts = self._last_msg_ts or time.time()
            now = time.time()
            cl = self._session_ib_client
            if self._last_service_heartbeat_at <= 0:
                self._last_service_heartbeat_at = now
            if now - self._last_service_heartbeat_at >= self._service_heartbeat_interval_sec:
                self._last_service_heartbeat_at = now
                if cl is not None and not cl.connected_snapshot():
                    self._push_health(
                        connected=False,
                        last_msg_ts=ts,
                        service_heartbeat_reconnect_in_progress=f"Host (client {self._client_id})",
                    )
                    try:
                        await asyncio.wait_for(
                            cl.ensure_connected(max_connect_attempts=1),
                            timeout=SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                        )
                        # API may show connected again but reqMktData subscriptions are lost; re-apply soon.
                        self._pending_resubscribe = True
                    except asyncio.TimeoutError:
                        logger.debug(
                            "IB ingestor service heartbeat reconnect timed out after %.0fs",
                            SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                        )
                    except Exception as e:
                        logger.debug("IB ingestor service heartbeat reconnect: %s", e)
            wire = cl.connected_snapshot() if cl is not None else False
            if not wire and cl is not None:
                self._session_disconnected.set()
            try:
                self._push_health(
                    connected=wire,
                    last_msg_ts=ts,
                    service_heartbeat_reconnect_in_progress="",
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
        description="IB ingestor (Redis ib:ingester:tick:*, bifrost:health:ws_ib_ingestor, …)",
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
