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
from src.bifrost.message_center import IbConnectionStatusTracker
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
HOST_FAIL_ITERATIONS_BEFORE_SESSION_RESET = 15
# After ensure_connected, ib_insync may lag before isConnected() is true on the client loop.
_POST_CONNECT_SNAPSHOT_ATTEMPTS = 20
_POST_CONNECT_SNAPSHOT_DELAY_SEC = 0.25


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
        self._status_tracker = IbConnectionStatusTracker(self._rds, service="ib_account_agent")
        self._stop = asyncio.Event()
        self._reconnects = 0
        self._msg_count = 0
        self._last_msg_ts = 0.0
        self._host_cid = 0
        self._sec_cid: Optional[int] = None
        self._fill_rows: List[Dict[str, Any]] = []
        self._ib_probe_interval_sec = 5.0
        self._reconnect_base_sec = 2.0
        self._reconnect_max_sec = 60.0
        self._reconnect_max_exp = 6
        self._host_probe_at = 0.0
        self._host_probe_ok = False
        self._sec_probe_at = 0.0
        self._sec_probe_ok = False
        self._session_disconnected = asyncio.Event()

    def _bump(self) -> None:
        self._msg_count += 1
        self._last_msg_ts = time.time()

    def _set_probe_state(
        self,
        *,
        host_probe_at: float,
        host_probe_ok: bool,
        sec_probe_at: float,
        sec_probe_ok: bool,
    ) -> None:
        self._host_probe_at = float(host_probe_at or 0.0)
        self._host_probe_ok = bool(host_probe_ok)
        self._sec_probe_at = float(sec_probe_at or 0.0)
        self._sec_probe_ok = bool(sec_probe_ok)

    def _write_agent_health_latest_probe(
        self,
        *,
        host_ok: bool,
        sec_ok: bool,
        last_msg_ts: float,
        secondary: Any,
        host_alive: bool = True,
    ) -> None:
        self._write_agent_health(
            host_ok=host_ok,
            sec_ok=sec_ok,
            last_msg_ts=last_msg_ts,
            host_probe_at=self._host_probe_at,
            host_probe_ok=self._host_probe_ok,
            sec_probe_at=self._sec_probe_at,
            sec_probe_ok=self._sec_probe_ok,
            secondary=secondary,
            host_alive=host_alive,
        )

    def _write_agent_health(
        self,
        *,
        host_ok: bool,
        sec_ok: bool,
        last_msg_ts: float,
        host_probe_at: float,
        host_probe_ok: bool,
        sec_probe_at: float,
        sec_probe_ok: bool,
        secondary: Any,
        host_alive: bool = True,
    ) -> None:
        self._writer.update_health(
            self._host_cid,
            host_ok,
            last_msg_ts,
            self._reconnects,
            self._msg_count,
            secondary_connected=sec_ok if secondary is not None else None,
            secondary_client_id=self._sec_cid,
            host_alive=host_alive,
            host_ib_probe_at=host_probe_at,
            host_ib_probe_ok=host_probe_ok,
            host_ib_probe_interval_sec=self._ib_probe_interval_sec,
            secondary_ib_probe_at=sec_probe_at,
            secondary_ib_probe_ok=sec_probe_ok,
            secondary_ib_probe_interval_sec=self._ib_probe_interval_sec,
        )
        self._status_tracker.update(
            slot="host",
            status="connected" if host_ok else "disconnected",
            client_id=self._host_cid or None,
            occurred_at=last_msg_ts,
        )
        if secondary is not None:
            self._status_tracker.update(
                slot="secondary",
                status="connected" if sec_ok else "disconnected",
                client_id=self._sec_cid,
                occurred_at=last_msg_ts,
            )

    async def run(self) -> None:
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stop.set)
            except NotImplementedError:
                pass

        from src.app.config import get_effective_ib_config
        from src.ib.connection_policy import reconnect_delay_s
        from src.monitor.integrations.ib_clients import MarketIbClient

        ib_eff = get_effective_ib_config(self._cfg)
        self._ib_probe_interval_sec = float(ib_eff["ib_probe_interval_sec"])
        self._reconnect_base_sec = float(ib_eff["ib_reconnect_base_sec"])
        self._reconnect_max_sec = float(ib_eff["ib_reconnect_max_sec"])
        self._reconnect_max_exp = int(ib_eff["ib_reconnect_max_exp"])
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

        # Seed Redis health after client_ids are known (Host + optional Secondary).
        self._writer.update_health(
            self._host_cid,
            False,
            time.time(),
            self._reconnects,
            self._msg_count,
            secondary_connected=False if secondary is not None else None,
            secondary_client_id=self._sec_cid,
            host_ib_probe_at=0.0,
            host_ib_probe_ok=False,
            host_ib_probe_interval_sec=self._ib_probe_interval_sec,
            secondary_ib_probe_at=0.0,
            secondary_ib_probe_ok=False,
            secondary_ib_probe_interval_sec=self._ib_probe_interval_sec,
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
            delay = reconnect_delay_s(
                self._reconnects,
                base=self._reconnect_base_sec,
                max_s=self._reconnect_max_sec,
                max_exp=self._reconnect_max_exp,
            )
            self._writer.update_health(
                self._host_cid,
                False,
                time.time(),
                self._reconnects,
                self._msg_count,
                secondary_connected=False if secondary is not None else None,
                secondary_client_id=self._sec_cid,
                host_ib_probe_at=0.0,
                host_ib_probe_ok=False,
                host_ib_probe_interval_sec=self._ib_probe_interval_sec,
                secondary_ib_probe_at=0.0,
                secondary_ib_probe_ok=False,
                secondary_ib_probe_interval_sec=self._ib_probe_interval_sec,
            )
            self._status_tracker.update(
                slot="host",
                status="disconnected",
                client_id=self._host_cid or None,
                occurred_at=time.time(),
                reason="Session ended",
            )
            self._status_tracker.update(
                slot="host",
                status="reconnecting",
                client_id=self._host_cid or None,
                occurred_at=time.time(),
                reason="Waiting for reconnect backoff",
            )
            if secondary is not None:
                self._status_tracker.update(
                    slot="secondary",
                    status="disconnected",
                    client_id=self._sec_cid,
                    occurred_at=time.time(),
                    reason="Session ended",
                )
                self._status_tracker.update(
                    slot="secondary",
                    status="reconnecting",
                    client_id=self._sec_cid,
                    occurred_at=time.time(),
                    reason="Waiting for reconnect backoff",
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
            secondary_connected=False if secondary is not None else None,
            secondary_client_id=self._sec_cid,
            host_alive=False,
            host_ib_probe_at=0.0,
            host_ib_probe_ok=False,
            host_ib_probe_interval_sec=self._ib_probe_interval_sec,
            secondary_ib_probe_at=0.0,
            secondary_ib_probe_ok=False,
            secondary_ib_probe_interval_sec=self._ib_probe_interval_sec,
        )
        self._status_tracker.update(
            slot="host",
            status="disconnected",
            client_id=self._host_cid or None,
            occurred_at=time.time(),
            reason="Service stopped",
        )
        if secondary is not None:
            self._status_tracker.update(
                slot="secondary",
                status="disconnected",
                client_id=self._sec_cid,
                occurred_at=time.time(),
                reason="Service stopped",
            )
        logger.info("IB Account Agent stopped")

    async def _ib_probe_loop(self, primary: Any, secondary: Any) -> None:
        """Periodic IB liveness probe — keeps host_ib_probe_at fresh independently of the snapshot loop.

        Account snapshot RPCs (get_positions / get_account_summary) occupy the
        IB client's private event-loop thread for 10-30 s.  If we called
        ``connected_snapshot()`` here, it dispatches via
        ``run_coroutine_threadsafe`` to that same busy loop and blocks the
        main asyncio loop on ``fut.result(timeout=5)`` until the RPC finishes
        — effectively starving this probe task.

        Instead we read ``_connected_state`` directly (a simple bool set by
        the connect/disconnect lifecycle, safe to read under CPython's GIL).
        This lets the probe advance ``host_ib_probe_at`` every interval
        regardless of how long account-snapshot RPCs take.
        """
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(
                    self._stop.wait(),
                    timeout=max(1.0, self._ib_probe_interval_sec),
                )
                break
            except asyncio.TimeoutError:
                pass
            now = time.time()
            host_ok = bool(getattr(primary, "_connected_state", False))
            sec_ok = (
                bool(getattr(secondary, "_connected_state", False))
                if secondary is not None
                else False
            )
            if not host_ok:
                self._session_disconnected.set()
            self._host_probe_at = now
            self._host_probe_ok = host_ok
            if secondary is not None:
                self._sec_probe_at = now
                self._sec_probe_ok = sec_ok
            try:
                self._writer.update_health(
                    self._host_cid,
                    host_ok,
                    self._last_msg_ts or now,
                    self._reconnects,
                    self._msg_count,
                    secondary_connected=sec_ok if secondary is not None else None,
                    secondary_client_id=self._sec_cid,
                    host_ib_probe_at=now,
                    host_ib_probe_ok=host_ok,
                    host_ib_probe_interval_sec=self._ib_probe_interval_sec,
                    secondary_ib_probe_at=now if secondary is not None else 0.0,
                    secondary_ib_probe_ok=sec_ok,
                    secondary_ib_probe_interval_sec=self._ib_probe_interval_sec,
                )
            except Exception as e:
                logger.debug("ib probe health: %s", e)

    async def _run_session(
        self,
        primary: Any,
        secondary: Any,
        timeout: float,
    ) -> None:
        await primary.ensure_connected()
        self._reconnects = 0
        self._session_disconnected.clear()
        for _ in range(_POST_CONNECT_SNAPSHOT_ATTEMPTS):
            if primary.connected_snapshot():
                break
            await asyncio.sleep(_POST_CONNECT_SNAPSHOT_DELAY_SEC)
        if secondary is not None:
            try:
                await secondary.ensure_connected()
                for _ in range(_POST_CONNECT_SNAPSHOT_ATTEMPTS):
                    if secondary.connected_snapshot():
                        break
                    await asyncio.sleep(_POST_CONNECT_SNAPSHOT_DELAY_SEC)
            except Exception as e:
                logger.warning("Secondary connect failed: %s", e)

        hc = primary.connector
        sc = secondary.connector if secondary else None
        host_ok = bool(primary.connected_snapshot())
        sec_ok = bool(secondary.connected_snapshot()) if secondary is not None else False

        now0 = time.time()
        self._set_probe_state(
            host_probe_at=now0,
            host_probe_ok=host_ok,
            sec_probe_at=now0 if secondary is not None else 0.0,
            sec_probe_ok=sec_ok if secondary is not None else False,
        )
        self._write_agent_health_latest_probe(
            host_ok=host_ok,
            sec_ok=sec_ok,
            last_msg_ts=now0,
            secondary=secondary,
        )

        # Start probe task BEFORE subscriptions / reqAllOpenOrders — those IB
        # RPCs can block the event loop for 30+ seconds (or hang entirely when
        # TWS is busy), and probe_at must keep advancing during that time.
        probe_task = asyncio.ensure_future(self._ib_probe_loop(primary, secondary))

        def on_orders_update() -> None:
            self._bump()

        if hc and host_ok:
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

        if sc and sec_ok:
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
        host_fail_streak = 0

        try:
            while not self._stop.is_set():
                if self._session_disconnected.is_set():
                    raise ConnectionError(
                        "IB Account Agent disconnect detected by probe — resetting session for reconnect"
                    )
                try:
                    host_ok = bool(primary.connected_snapshot())
                    if secondary is not None:
                        sec_ok = bool(secondary.connected_snapshot())
                    else:
                        sec_ok = False

                    if not host_ok:
                        host_fail_streak += 1
                        if host_fail_streak >= HOST_FAIL_ITERATIONS_BEFORE_SESSION_RESET:
                            raise ConnectionError(
                                "IB Account Agent host API disconnected; resetting session for backoff reconnect"
                            )
                    else:
                        host_fail_streak = 0

                    now = time.time()
                    self._set_probe_state(
                        host_probe_at=now,
                        host_probe_ok=host_ok,
                        sec_probe_at=now if secondary is not None else 0.0,
                        sec_probe_ok=sec_ok,
                    )

                    oo = _merged_open_orders(hc, sc)
                    acct = await _accounts_snapshot(hc, sc)
                    fills = list(self._fill_rows)
                    self._fill_rows.clear()
                    payload = {
                        "open_orders": oo,
                        "accounts_snapshot": acct,
                        "last_execution_rows": fills,
                        "host_connected": host_ok,
                        "secondary_connected": sec_ok,
                    }
                    self._writer.write_snapshot(payload)
                    self._write_agent_health_latest_probe(
                        host_ok=host_ok,
                        sec_ok=sec_ok,
                        last_msg_ts=self._last_msg_ts or now,
                        secondary=secondary,
                    )
                except ConnectionError:
                    raise
                except Exception as e:
                    logger.warning("snapshot iteration: %s", e)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=SNAPSHOT_POLL_SEC)
                except asyncio.TimeoutError:
                    pass
        finally:
            probe_task.cancel()
            try:
                await probe_task
            except asyncio.CancelledError:
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
