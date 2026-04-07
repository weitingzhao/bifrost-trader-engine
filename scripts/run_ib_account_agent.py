#!/usr/bin/env python3
"""IB Account Agent — account-domain IB events → Redis only (no PostgreSQL).

Uses ``client_id_account_agent`` / ``ib2_client_id_account_agent`` from ``get_effective_ib_config``.
Writes ``ib:account:snapshot:v1`` and health ``bifrost:health:ws_ib_account_agent``.

Usage::
  python scripts/run_ib_account_agent.py
  python scripts/run_ib_account_agent.py --config config/config.prod.yaml
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(str(_PROJECT_ROOT))

from backend.monitor.routers.deps import IB_ACCOUNT_AGENT_LOG_STREAM_KEY
from src.core.logging_redis_stream import RedisStreamLogHandler

_LOG_STREAM_MAXLEN = 2000

logger = logging.getLogger("ib_account_agent")


def _console_log_redis_url(config_path: str | None) -> str:
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config(config_path)
    except Exception:
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def _setup_logging(level: int, config_path: str | None) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s  %(message)s"))
    redis_handler = RedisStreamLogHandler(
        _console_log_redis_url(config_path),
        IB_ACCOUNT_AGENT_LOG_STREAM_KEY,
        maxlen=_LOG_STREAM_MAXLEN,
    )
    redis_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(h)
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


SNAPSHOT_POLL_SEC = 2.0
RECONNECT_BASE = 2.0
RECONNECT_MAX = 60.0


def _merged_open_orders(hc: Any, sc: Any) -> List[Dict[str, Any]]:
    orders: List[Dict[str, Any]] = []
    seen: set = set()
    if hc and getattr(hc, "is_connected", False):
        try:
            orders = list(hc.get_open_orders_snapshot() or [])
            seen = {(o.get("order_id"), o.get("account_id")) for o in orders}
        except Exception as e:
            logger.warning("Host open orders snapshot: %s", e)
    if sc and getattr(sc, "is_connected", False):
        try:
            for o in sc.get_open_orders_snapshot() or []:
                key = (o.get("order_id"), o.get("account_id"))
                if key not in seen:
                    seen.add(key)
                    orders.append(o)
        except Exception as e:
            logger.warning("Secondary open orders snapshot: %s", e)
    return orders


async def _accounts_snapshot(hc: Any, sc: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if hc and getattr(hc, "is_connected", False):
        account_ids = hc.get_managed_accounts()
        if account_ids:
            all_p = await hc.get_positions(account=None)
            for aid in account_ids:
                values = await hc.get_account_summary(account=aid)
                summary: Dict[str, Any] = {}
                for v in values:
                    if getattr(v, "tag", None) and getattr(v, "value", None) is not None:
                        summary[v.tag] = v.value
                if aid:
                    summary["account"] = aid
                acct_p = [p for p in all_p if getattr(p, "account", None) == aid]
                pos_dicts = [hc.position_to_dict(p) for p in acct_p]
                out.append({
                    "account_id": aid,
                    "summary": summary,
                    "positions": pos_dicts,
                })
    if sc and getattr(sc, "is_connected", False):
        ids2 = sc.get_managed_accounts()
        if ids2:
            all_p2 = await sc.get_positions(account=None)
            for aid in ids2:
                if any(a.get("account_id") == aid for a in out):
                    continue
                values = await sc.get_account_summary(account=aid)
                summary = {}
                for v in values:
                    if getattr(v, "tag", None) and getattr(v, "value", None) is not None:
                        summary[v.tag] = v.value
                if aid:
                    summary["account"] = aid
                acct_p = [p for p in all_p2 if getattr(p, "account", None) == aid]
                pos_dicts = [sc.position_to_dict(p) for p in acct_p]
                out.append({
                    "account_id": aid,
                    "summary": summary,
                    "positions": pos_dicts,
                })
    return out


class IbAccountAgentApp:
    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg
        self._rds = _redis_client(cfg)
        from src.vendor.ib_account_agent.writer import IbAccountAgentRedisWriter

        self._writer = IbAccountAgentRedisWriter(self._rds)
        self._stop = asyncio.Event()
        self._reconnects = 0
        self._msg_count = 0
        self._last_msg_ts = 0.0
        self._host_cid = 0
        self._sec_cid: Optional[int] = None
        self._fill_rows: List[Dict[str, Any]] = []

    def _bump(self) -> None:
        self._msg_count += 1
        self._last_msg_ts = time.time()

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
        self._host_cid = int(ib_eff["client_id_account_agent"])
        host = str(ib_eff["host"])
        port = int(ib_eff["port"])
        timeout = float(ib_eff.get("connect_timeout") or 60.0)

        logger.info(
            "IB Account Agent starting host=%s port=%s client_id=%s",
            host,
            port,
            self._host_cid,
        )

        primary = MarketIbClient(
            host, port, self._host_cid, name="IbAccountAgentHost"
        )

        secondary: Any = None
        ib2 = ib_eff.get("ib2_host") or ""
        if ib2:
            self._sec_cid = int(ib_eff.get("ib2_client_id_account_agent") or 152)
            secondary = MarketIbClient(
                ib2,
                int(ib_eff["ib2_port"]),
                self._sec_cid,
                name="IbAccountAgentSecondary",
            )

        while not self._stop.is_set():
            try:
                await self._run_session(primary, secondary, timeout)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Account agent session error: %s", e, exc_info=True)

            if self._stop.is_set():
                break
            self._reconnects += 1
            delay = min(
                RECONNECT_BASE * (2 ** min(self._reconnects - 1, 6)),
                RECONNECT_MAX,
            )
            self._writer.update_health(
                self._host_cid,
                False,
                time.time(),
                self._reconnects,
                self._msg_count,
                secondary_connected=False,
                secondary_client_id=self._sec_cid,
            )
            logger.info("Reconnecting in %.1fs (attempt %d)…", delay, self._reconnects)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        self._writer.update_health(
            self._host_cid,
            False,
            time.time(),
            self._reconnects,
            self._msg_count,
            secondary_connected=False,
            secondary_client_id=self._sec_cid,
        )
        logger.info("IB Account Agent stopped")

    async def _run_session(
        self,
        primary: Any,
        secondary: Any,
        timeout: float,
    ) -> None:
        await primary.ensure_connected()
        self._reconnects = 0
        if secondary is not None:
            try:
                await secondary.ensure_connected()
            except Exception as e:
                logger.warning("Secondary connect failed: %s", e)

        hc = primary.connector
        sc = secondary.connector if secondary else None

        def on_orders_update() -> None:
            self._bump()

        if hc and getattr(hc, "is_connected", False):
            hc.subscribe_positions(lambda: self._bump())
            hc.subscribe_order_status(lambda _: on_orders_update())
            hc.subscribe_open_order(lambda _: on_orders_update())
            try:
                hc.subscribe_fills(lambda _t, _f: self._bump())
            except Exception as e:
                logger.warning("subscribe_fills host: %s", e)
            try:
                await hc.get_open_orders_async(include_all_from_tws=True)
            except Exception as e:
                logger.warning("reqAllOpenOrders host: %s", e)

        if sc and getattr(sc, "is_connected", False):
            try:
                sc.subscribe_positions(lambda: self._bump())
                sc.subscribe_order_status(lambda _: on_orders_update())
                sc.subscribe_open_order(lambda _: on_orders_update())

                def on_sec_fill(_trade: Any, fill: Any) -> None:
                    self._bump()
                    row = sc.fill_to_execution_row(fill, source="tws_event")
                    if row:
                        self._fill_rows.append(row)

                sc.subscribe_fills(on_sec_fill)
                sc.set_commission_report_callback(
                    lambda _eid, _c, _pnl, _cur, _y, _yrd: self._bump()
                )
                await sc.get_open_orders_async(include_all_from_tws=True)
            except Exception as e:
                logger.warning("Secondary subscriptions: %s", e)

        sec_ok = bool(sc and getattr(sc, "is_connected", False))
        self._writer.update_health(
            self._host_cid,
            True,
            time.time(),
            self._reconnects,
            self._msg_count,
            secondary_connected=sec_ok,
            secondary_client_id=self._sec_cid,
        )

        while not self._stop.is_set():
            try:
                oo = _merged_open_orders(hc, sc)
                acct = await _accounts_snapshot(hc, sc)
                fills = list(self._fill_rows)
                self._fill_rows.clear()
                payload = {
                    "open_orders": oo,
                    "accounts_snapshot": acct,
                    "last_execution_rows": fills,
                    "host_connected": bool(hc and getattr(hc, "is_connected", False)),
                    "secondary_connected": sec_ok,
                }
                self._writer.write_snapshot(payload)
                self._writer.update_health(
                    self._host_cid,
                    True,
                    self._last_msg_ts or time.time(),
                    self._reconnects,
                    self._msg_count,
                    secondary_connected=sec_ok,
                    secondary_client_id=self._sec_cid,
                )
            except Exception as e:
                logger.warning("snapshot iteration: %s", e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=SNAPSHOT_POLL_SEC)
            except asyncio.TimeoutError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="IB Account Agent (Redis ib:account:snapshot:v1)")
    parser.add_argument("--config", type=str, default=None)
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
            print(f"ERROR: --config file not found: {args.config}", file=sys.stderr)
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
    try:
        _redis_client(cfg).ping()
    except Exception as e:
        logger.error("Redis ping failed: %s", e)
        sys.exit(1)

    app = IbAccountAgentApp(cfg)
    asyncio.run(app.run())


if __name__ == "__main__":
    main()
