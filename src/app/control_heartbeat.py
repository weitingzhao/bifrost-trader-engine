"""Control poll, run_status, and heartbeat loop. Used by GsTrading."""

import asyncio
import logging
import time
from typing import Any, Optional

from src.app.accounts import _connector_for_read, refresh_secondary_accounts_and_sync
from src.fsm.daemon_fsm import DaemonState

logger = logging.getLogger(__name__)


def poll_control(app: Any) -> Optional[str]:
    """Poll control command from sink (PostgreSQL daemon_control table when sink is postgres). Return stop/flatten or None."""
    if app._status_sink is None:
        return None
    if hasattr(app._status_sink, "poll_and_consume_control"):
        return app._status_sink.poll_and_consume_control()
    return None


def poll_run_status(app: Any) -> tuple[bool, Optional[float]]:
    """Poll daemon_run_status from sink (suspended, heartbeat_interval_sec). interval None => use config default.
    Default suspended=True when no sink so Daemon does not connect Trading Client."""
    if app._status_sink is None:
        logger.debug("[Daemon] poll_run_status: no _status_sink → suspended=True, interval=None (default)")
        return True, None
    if hasattr(app._status_sink, "poll_run_status"):
        out = app._status_sink.poll_run_status()
        logger.debug("[Daemon] poll_run_status (from sink) → suspended=%s, interval=%s", out[0], out[1])
        return out
    logger.debug("[Daemon] poll_run_status: sink has no poll_run_status → suspended=True, interval=None")
    return True, None


def effective_heartbeat_interval(app: Any) -> float:
    """Heartbeat interval in seconds (from DB if set via monitoring, else config); clamped to [5, 120]."""
    raw = (
        app._heartbeat_interval_from_db
        if app._heartbeat_interval_from_db is not None
        else app._heartbeat_interval
    )
    return max(5.0, min(120.0, float(raw)))


def redis_quotes_connected(app: Any) -> bool:
    """Whether daemon is connected to Redis and writing real-time quotes (for status/monitoring)."""
    return bool(
        getattr(app, "_redis_quotes", None)
        and getattr(app._redis_quotes, "available", False)
    )


def _host_listener(app: Any) -> Any:
    """Host Listener is used for all Host-side event subscriptions (ticker, positions, open orders, fills)."""
    return getattr(app, "listener_connector", None)


def _read_connector_connected(app: Any) -> bool:
    """True when Listener or Trading connector is available for read (account/position/execution); avoids depending on Trading Client alone."""
    conn = _connector_for_read(app)
    return bool(conn and getattr(conn, "is_connected", False))


def event_subscribe_flags(app: Any) -> dict:
    """IB event subscription status for System page: ticker, positions, fills, commission; plus Secondary (ib2) flags."""
    listener = _host_listener(app)
    connected = bool(listener and listener.is_connected)
    running = app._fsm_daemon.is_running()
    fills_subscribed = getattr(app, "_event_subscribe_fills_registered", False)
    out = {
        "event_subscribe_ticker": running and connected,
        "event_subscribe_positions": running and connected,
        "event_subscribe_fills": running and connected and fills_subscribed,
        "event_subscribe_commission": connected,
    }
    listener_2 = getattr(app, "listener_connector_2", None)
    if listener_2 is not None:
        out["event_subscribe_positions_ib2"] = bool(
            getattr(listener_2, "is_connected", False)
            and getattr(app, "_event_subscribe_positions_ib2_registered", False)
        )
        out["event_subscribe_fills_ib2"] = bool(
            getattr(listener_2, "is_connected", False)
            and getattr(app, "_event_subscribe_fills_ib2_registered", False)
        )
        out["event_subscribe_commission_ib2"] = bool(
            getattr(listener_2, "is_connected", False)
            and getattr(app, "_event_subscribe_commission_ib2_registered", False)
        )
    else:
        out["event_subscribe_positions_ib2"] = False
        out["event_subscribe_fills_ib2"] = False
        out["event_subscribe_commission_ib2"] = False
    return out


def listener_heartbeat_kwargs(app: Any) -> dict:
    """Listener connection status for daemon_heartbeat: Host + optional Secondary (ib2_host). Does not include ib2 event_subscribe flags; those come from event_subscribe_flags()."""
    listener = getattr(app, "listener_connector", None)
    listener_2 = getattr(app, "listener_connector_2", None)
    out = {
        "listener_connected": bool(listener and listener.is_connected),
        "listener_client_id": getattr(listener, "client_id", None) if listener else None,
    }
    if listener_2 is not None:
        out["listener_2_connected"] = bool(listener_2.is_connected)
        out["listener_2_client_id"] = getattr(listener_2, "client_id", None)
    else:
        out["listener_2_connected"] = False
        out["listener_2_client_id"] = None
    return out


def apply_run_status_transition(app: Any) -> bool:
    """Sync Daemon FSM with daemon_run_status: RUNNING <-> RUNNING_SUSPENDED. Returns True if suspended (skip hedge).
    When transitioning to RUNNING_SUSPENDED, request IB Trading Client release so daemon goes to WAITING_IB (Trading Strategy not running → no Trading Client)."""
    suspended, interval = poll_run_status(app)
    app._heartbeat_interval_from_db = interval
    cur = app._fsm_daemon.current
    logger.debug(
        "[Daemon] heartbeat | poll_run_status → suspended=%s, interval=%s, current=%s",
        suspended,
        interval,
        cur.value if cur else None,
    )
    if suspended and cur == DaemonState.RUNNING:
        app._fsm_daemon.transition(DaemonState.RUNNING_SUSPENDED)
        logger.info(
            "[Daemon] state=RUNNING → RUNNING_SUSPENDED (daemon_run_status.suspended=true); will release IB Trading Client"
        )
        app._ib_disconnected_during_run = True
    elif not suspended and cur == DaemonState.RUNNING_SUSPENDED:
        app._fsm_daemon.transition(DaemonState.RUNNING)
        logger.info(
            "[Daemon] state=RUNNING_SUSPENDED → RUNNING (daemon_run_status.suspended=false)"
        )
    return suspended


async def heartbeat(app: Any) -> None:
    """Periodic heartbeat to run maybe_hedge even without tick updates; write status snapshot if sink configured. FSM RUNNING <-> RUNNING_SUSPENDED per daemon_run_status."""
    while app._fsm_daemon.is_running():
        cmd = poll_control(app)
        if cmd == "stop":
            logger.info("[Daemon] control (db): stop → requesting stop")
            app._fsm_daemon.request_stop()
            return
        if cmd == "flatten":
            logger.warning("[Daemon] control (db): flatten (not implemented yet)")
        if cmd == "release_ib" and (
            app.connector.is_connected or (_host_listener(app) and _host_listener(app).is_connected)
        ):
            now_t = time.time()
            interval = effective_heartbeat_interval(app)
            next_retry_ts = now_t + interval
            sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
            if app._status_sink and hasattr(
                app._status_sink, "write_daemon_heartbeat"
            ):
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=False,
                    ib_client_id=None,
                    next_retry_ts=next_retry_ts,
                    seconds_until_retry=sec_until,
                    redis_quotes_connected=redis_quotes_connected(app),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **event_subscribe_flags(app),
                    **listener_heartbeat_kwargs(app),
                )
            logger.info(
                "[Daemon] state=%s | control release_ib → releasing IB on next heartbeat",
                app._fsm_daemon.current.value,
            )
            app._ib_disconnected_during_run = True
        if (
            cmd == "refresh_accounts"
            and _read_connector_connected(app)
            and app._status_sink
        ):
            logger.info(
                "[Daemon] control (db): refresh_accounts → fetching from IB and syncing to DB"
            )
            await app._refresh_accounts_data()
            app._last_accounts_refresh_ts = time.time()
            minimal = app._build_heartbeat_minimal_dict()
            app._status_sink.write_snapshot(minimal, append_history=False)
            if not getattr(app, "mock_hedging", True):
                await app._refresh_position_prices()
                app._contract_quote_live_initialized = True
        if (
            cmd == "refresh_replay"
            and _read_connector_connected(app)
            and app._status_sink
        ):
            logger.info(
                "[Daemon] control (db): refresh_replay → syncing executions from IB for 复盘"
            )
            await app._refresh_executions_only()
        if (
            cmd == "refresh_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): refresh_ticker_subscriptions → Release then Init"
            )
            await app._refresh_ticker_subscriptions()
        if (
            cmd == "release_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): release_ticker_subscriptions → unsubscribe all"
            )
            await app._release_ticker_subscriptions()
            if app._status_sink and hasattr(app._status_sink, "write_daemon_subscribed_tickers"):
                app._status_sink.write_daemon_subscribed_tickers([])
        if (
            cmd == "init_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): init_ticker_subscriptions → subscribe if empty"
            )
            await app._init_ticker_subscriptions()
        suspended = apply_run_status_transition(app)
        interval_sec = effective_heartbeat_interval(app)
        state_label = app._fsm_daemon.current.value
        if suspended:
            logger.info(
                "[Daemon] state=%s | heartbeat: sleep %.0fs, skip maybe_hedge (suspended)",
                state_label,
                interval_sec,
            )
        else:
            logger.info(
                "[Daemon] state=%s | heartbeat: sleep %.0fs, then maybe_hedge",
                state_label,
                interval_sec,
            )
        await asyncio.sleep(interval_sec)
        if not app._fsm_daemon.is_running():
            return
        cmd = poll_control(app)
        if cmd == "stop":
            logger.info("[Daemon] control (db): stop → requesting stop")
            app._fsm_daemon.request_stop()
            return
        if cmd == "flatten":
            logger.warning("[Daemon] control (db): flatten (not implemented yet)")
        if cmd == "release_ib" and (
            app.connector.is_connected or (_host_listener(app) and _host_listener(app).is_connected)
        ):
            now_t = time.time()
            interval = effective_heartbeat_interval(app)
            next_retry_ts = now_t + interval
            sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
            if app._status_sink and hasattr(
                app._status_sink, "write_daemon_heartbeat"
            ):
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=False,
                    ib_client_id=None,
                    next_retry_ts=next_retry_ts,
                    seconds_until_retry=sec_until,
                    redis_quotes_connected=redis_quotes_connected(app),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **event_subscribe_flags(app),
                    **listener_heartbeat_kwargs(app),
                )
            logger.info(
                "[Daemon] state=%s | control release_ib → releasing IB on next heartbeat",
                app._fsm_daemon.current.value,
            )
            app._ib_disconnected_during_run = True
        if (
            cmd == "refresh_accounts"
            and _read_connector_connected(app)
            and app._status_sink
        ):
            logger.info(
                "[Daemon] control (db): refresh_accounts → fetching from IB and syncing to DB"
            )
            await app._refresh_accounts_data()
            app._last_accounts_refresh_ts = time.time()
            minimal = app._build_heartbeat_minimal_dict()
            app._status_sink.write_snapshot(minimal, append_history=False)
            if not getattr(app, "mock_hedging", True):
                await app._refresh_position_prices()
                app._contract_quote_live_initialized = True
        if (
            cmd == "refresh_replay"
            and _read_connector_connected(app)
            and app._status_sink
        ):
            logger.info(
                "[Daemon] control (db): refresh_replay → syncing executions from IB for 复盘"
            )
            await app._refresh_executions_only()
        if (
            cmd == "refresh_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): refresh_ticker_subscriptions → Release then Init"
            )
            await app._refresh_ticker_subscriptions()
        if (
            cmd == "release_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): release_ticker_subscriptions → unsubscribe all"
            )
            await app._release_ticker_subscriptions()
            if app._status_sink and hasattr(app._status_sink, "write_daemon_subscribed_tickers"):
                app._status_sink.write_daemon_subscribed_tickers([])
        if (
            cmd == "init_ticker_subscriptions"
            and _host_listener(app)
            and _host_listener(app).is_connected
        ):
            logger.info(
                "[Daemon] control (db): init_ticker_subscriptions → subscribe if empty"
            )
            await app._init_ticker_subscriptions()
        suspended = apply_run_status_transition(app)
        listener = _host_listener(app)
        if not (listener and listener.is_connected):
            now_t = time.time()
            interval = effective_heartbeat_interval(app)
            next_retry_ts = now_t + interval
            sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
            if app._status_sink and hasattr(
                app._status_sink, "write_daemon_heartbeat"
            ):
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=False,
                    ib_client_id=None,
                    next_retry_ts=next_retry_ts,
                    seconds_until_retry=sec_until,
                    redis_quotes_connected=redis_quotes_connected(app),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **event_subscribe_flags(app),
                    **listener_heartbeat_kwargs(app),
                )
            logger.warning(
                "[Daemon] state=%s | IB disconnected → WAITING_IB (DB updated, will retry)",
                app._fsm_daemon.current.value,
            )
            app._ib_disconnected_during_run = True
            return
        now_ts = time.time()
        if (
            now_ts - app._last_accounts_refresh_ts
            >= app._accounts_refresh_interval_sec
        ):
            await app._refresh_accounts_data()
            app._last_accounts_refresh_ts = now_ts
            # Sync Secondary accounts/positions at same cadence (no per-event callback to avoid task flood)
            listener_2 = getattr(app, "listener_connector_2", None)
            if listener_2 is not None and getattr(listener_2, "is_connected", False):
                try:
                    await refresh_secondary_accounts_and_sync(app)
                except Exception as e:
                    logger.debug("[Daemon] heartbeat refresh_secondary_accounts_and_sync: %s", e)
        if app.symbol:
            conn_read = _connector_for_read(app)
            if conn_read:
                spot_fresh = await conn_read.get_underlying_price(app.symbol)
                if spot_fresh is not None and spot_fresh > 0:
                    app.store.set_underlying_price(spot_fresh)
        if app._status_sink:
            result = await app._refresh_and_build_snapshot()
            if result is not None:
                snapshot, spot, cs, data_lag_ms = result
                snap_dict = app._build_snapshot_dict(
                    snapshot, spot, cs, data_lag_ms
                )
                app._status_sink.write_snapshot(snap_dict, append_history=False)
                if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
                    try:
                        payload = app._quote_payload()
                        if payload:
                            app._redis_quotes.set_quote(app.symbol, payload)
                            app._redis_quotes.publish_update(
                                app.symbol,
                                {"symbol": app.symbol, "ts": payload.get("ts")},
                            )
                    except Exception as e:
                        logger.warning("Redis quote write in heartbeat: %s", e)
            else:
                logger.debug(
                    "Heartbeat: no full snapshot (spot unavailable), writing minimal status"
                )
                minimal = app._build_heartbeat_minimal_dict()
                app._status_sink.write_snapshot(minimal, append_history=False)
                if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
                    try:
                        payload = app._quote_payload()
                        if payload:
                            app._redis_quotes.set_quote(app.symbol, payload)
                            app._redis_quotes.publish_update(
                                app.symbol,
                                {"symbol": app.symbol, "ts": payload.get("ts")},
                            )
                    except Exception as e:
                        logger.warning(
                            "Redis quote write in heartbeat (minimal): %s", e
                        )
            if not getattr(app, "mock_hedging", True):
                if not getattr(app, "_contract_quote_live_initialized", False):
                    try:
                        await app._refresh_position_prices()
                        app._contract_quote_live_initialized = True
                    except Exception as e:
                        logger.debug(
                            "R-M6 initial refresh_position_prices: %s", e
                        )
                try:
                    if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
                        app._sync_contract_quote_live_from_redis()
                    else:
                        await app._refresh_position_prices()
                except Exception as e:
                    logger.debug("R-M6 contract_quote_live sync failed: %s", e)
            if hasattr(app._status_sink, "write_daemon_heartbeat"):
                listener = _host_listener(app)
                # ib_connected/ib_client_id = Trading connector only; Listener has its own listener_connected/listener_client_id
                connector = getattr(app, "connector", None)
                _ib_conn = bool(connector and connector.is_connected)
                _ib_cid = getattr(connector, "client_id", None) if connector else None
                logger.debug(
                    "[Daemon] heartbeat | write_daemon_heartbeat Trading: ib_connected=%s, ib_client_id=%s",
                    _ib_conn,
                    _ib_cid,
                )
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=_ib_conn,
                    ib_client_id=_ib_cid,
                    heartbeat_interval_sec=effective_heartbeat_interval(app),
                    redis_quotes_connected=redis_quotes_connected(app),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **event_subscribe_flags(app),
                    **listener_heartbeat_kwargs(app),
                )
        # Ticker subscriptions: every heartbeat run Redis-based sync (a/b/c); after Release, next heartbeat restores subscriptions.
        listener = _host_listener(app)
        if listener and listener.is_connected:
            await app._refresh_ticker_subscriptions()
            # Write actual subscribed list to DB so status API / UI show current state (e.g. 0 tickers right after Release).
            if app._status_sink and hasattr(app._status_sink, "write_daemon_subscribed_tickers"):
                if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
                    current = sorted(app._redis_quotes.get_subscribed_symbols())
                else:
                    current = sorted(listener.get_subscribed_ticker_symbols())
                app._status_sink.write_daemon_subscribed_tickers(current)
        if not suspended:
            if getattr(app, "mock_hedging", True):
                logger.info(
                    "[Daemon] state=RUNNING | Mock: skip maybe_hedge (mock_hedging=true)"
                )
            else:
                logger.info(
                    "[Daemon] state=RUNNING | heartbeat: tick, running maybe_hedge"
                )
                await app._eval_hedge_sync()
