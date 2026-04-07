"""Daemon FSM state handlers, run() loop, and stop(). Used by GsTrading."""

import asyncio
import logging
import time
from typing import Any

from src.daemon.fsm.daemon_fsm import DaemonState
from src.daemon.fsm.events import TradingEvent

logger = logging.getLogger(__name__)


async def handle_idle(app: Any) -> DaemonState:
    """IDLE: ready to start. If daemon_run_status.suspended=true (default), go to WAITING_IB without connecting IB Trading Client; else CONNECTING."""
    suspended, interval = app._poll_run_status()
    logger.debug(
        "[Daemon] state=IDLE | poll_run_status → suspended=%s, interval=%s; next state=%s",
        suspended,
        interval,
        "WAITING_IB" if suspended else "CONNECTING",
    )
    if suspended:
        logger.info(
            "[Daemon] state=IDLE → WAITING_IB (daemon_run_status.suspended=true; Trading Strategy and Trading Client off until Resume)"
        )
        return DaemonState.WAITING_IB
    logger.info("[Daemon] state=IDLE → CONNECTING (connecting to IB)")
    return DaemonState.CONNECTING


async def handle_connecting(app: Any) -> DaemonState:
    """CONNECTING: try IB with client_id, client_id+1, ... (up to 10 attempts); if all fail → WAITING_IB (RE-7)."""
    if getattr(app, "_use_ib_edge", False):
        logger.info(
            "[Daemon] state=CONNECTING → CONNECTED (IB edge mode; no Trading Client socket)"
        )
        return DaemonState.CONNECTED
    cid = getattr(app.connector, "client_id", None)
    logger.debug("[Daemon] state=CONNECTING | Trading Client connecting client_id=%s", cid)
    logger.info(
        "[Daemon] state=CONNECTING | connecting to IB (clientId=%s; will try +1, +2, ... if already in use)",
        cid,
    )
    ok = await app.connector.connect(max_attempts=10)
    if not ok:
        logger.warning(
            "[Daemon] state=CONNECTING | IB connect failed after 10 attempts → WAITING_IB (daemon stays up, will retry)"
        )
        return DaemonState.WAITING_IB
    logger.debug("[Daemon] state=CONNECTING | Trading Client connected client_id=%s", getattr(app.connector, "client_id", None))
    logger.info("[Daemon] state=CONNECTING → CONNECTED (IB connected)")
    return DaemonState.CONNECTED


async def handle_waiting_ib(app: Any) -> DaemonState:
    """WAITING_IB (RE-7): daemon running, IB not connected. Write heartbeat; poll stop/retry_ib; auto-retry at next heartbeat."""
    now_t = time.time()
    interval = app._effective_heartbeat_interval()
    next_retry_ts = now_t + interval
    sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
    if app._status_sink and hasattr(app._status_sink, "write_daemon_heartbeat"):
        app._status_sink.write_daemon_heartbeat(
            hedge_running=False,
            ib_connected=False,
            ib_client_id=None,
            next_retry_ts=next_retry_ts,
            seconds_until_retry=sec_until,
            heartbeat_interval_sec=app._effective_heartbeat_interval(),
            redis_quotes_connected=app._redis_quotes_connected(),
            mock_hedging=getattr(app, "mock_hedging", True),
            **app._event_subscribe_flags(),
            **app._listener_heartbeat_kwargs(),
        )
    logger.info(
        "[Daemon] state=WAITING_IB | IB not connected; next retry in %ss (heartbeat interval=%.0fs)",
        sec_until,
        interval,
    )
    while True:
        cmd = app._poll_control()
        if cmd == "stop":
            logger.info("[Daemon] state=WAITING_IB | control stop → STOPPING")
            return DaemonState.STOPPING
        if cmd == "retry_ib" or time.time() >= next_retry_ts:
            if getattr(app, "_use_ib_edge", False):
                from src.daemon.ib_edge import ib_edge_snapshot_ready

                if ib_edge_snapshot_ready(app.config):
                    logger.info(
                        "[Daemon] state=WAITING_IB → CONNECTED (IB edge: account snapshot in Redis)"
                    )
                    return DaemonState.CONNECTED
                now_t = time.time()
                interval = app._effective_heartbeat_interval()
                next_retry_ts = now_t + interval
                await asyncio.sleep(1.0)
                continue
            # WAITING_IB: connect Listener (Host) for read-only; do not connect Trading until user Resume
            listener = getattr(app, "listener_connector", None)
            if listener is None:
                logger.warning("[Daemon] state=WAITING_IB | no listener_connector; skip connect")
                await asyncio.sleep(1.0)
                continue
            cid = getattr(listener, "client_id", None)
            logger.debug(
                "[Daemon] state=WAITING_IB | Listener (Host) connecting (%s) client_id=%s",
                "retry_ib" if cmd == "retry_ib" else "retry timer",
                cid,
            )
            logger.info(
                "[Daemon] state=WAITING_IB | %s → connecting Listener (Host) to IB (clientId=%s; will try +1, +2, ... if in use)",
                "retry_ib" if cmd == "retry_ib" else "retry timer",
                cid,
            )
            ok = await listener.connect(max_attempts=10)
            if ok:
                logger.debug("[Daemon] state=WAITING_IB | Listener (Host) connected client_id=%s", getattr(listener, "client_id", None))
                if app._status_sink and hasattr(
                    app._status_sink, "write_daemon_heartbeat"
                ):
                    app._status_sink.write_daemon_heartbeat(
                        hedge_running=False,
                        ib_connected=False,
                        ib_client_id=None,
                        heartbeat_interval_sec=app._effective_heartbeat_interval(),
                        redis_quotes_connected=app._redis_quotes_connected(),
                        mock_hedging=getattr(app, "mock_hedging", True),
                        **app._event_subscribe_flags(),
                        **app._listener_heartbeat_kwargs(),
                    )
                logger.info("[Daemon] state=WAITING_IB → CONNECTED (Listener connected)")
                return DaemonState.CONNECTED
            now_t = time.time()
            interval = app._effective_heartbeat_interval()
            next_retry_ts = now_t + interval
            sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
            if app._status_sink and hasattr(
                app._status_sink, "write_daemon_heartbeat"
            ):
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=False,
                    ib_connected=False,
                    ib_client_id=None,
                    next_retry_ts=next_retry_ts,
                    seconds_until_retry=sec_until,
                    heartbeat_interval_sec=app._effective_heartbeat_interval(),
                    redis_quotes_connected=app._redis_quotes_connected(),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **app._event_subscribe_flags(),
                    **app._listener_heartbeat_kwargs(),
                )
            logger.debug(
                "[Daemon] state=WAITING_IB | connect failed; next retry in %ss",
                sec_until,
            )
        await asyncio.sleep(1.0)


async def handle_connected(app: Any) -> DaemonState:
    """CONNECTED: fetch positions + spot, bootstrap TradingFSM (START/SYNCED). Transition to RUNNING."""
    _conn = getattr(app, "connector", None)
    _ib_c = bool(_conn and getattr(_conn, "is_connected", False))
    _ib_id = getattr(_conn, "client_id", None) if _conn else None
    if app._status_sink and hasattr(app._status_sink, "write_daemon_heartbeat"):
        app._status_sink.write_daemon_heartbeat(
            hedge_running=False,
            ib_connected=_ib_c,
            ib_client_id=_ib_id,
            heartbeat_interval_sec=app._effective_heartbeat_interval(),
            redis_quotes_connected=app._redis_quotes_connected(),
            mock_hedging=getattr(app, "mock_hedging", True),
            **app._event_subscribe_flags(),
            **app._listener_heartbeat_kwargs(),
        )
    logger.info(
        "[Daemon] state=CONNECTED | fetching account summary and positions, building snapshot..."
    )
    await app._refresh_accounts_data()
    app._last_accounts_refresh_ts = time.time()
    result = await app._refresh_and_build_snapshot()
    if result is not None:
        snapshot, spot, cs, data_lag_ms = result
        app._fsm_trading.apply_transition(TradingEvent.START, snapshot)
        app._fsm_trading.apply_transition(TradingEvent.SYNCED, snapshot)
        if app._status_sink:
            snap_dict = app._build_snapshot_dict(
                snapshot, spot, cs, data_lag_ms
            )
            app._status_sink.write_snapshot(snap_dict, append_history=False)
    else:
        if app._status_sink:
            app._status_sink.write_snapshot(
                app._build_heartbeat_minimal_dict(), append_history=False
            )
    logger.info("[Daemon] state=CONNECTED → RUNNING (bootstrap done)")
    return DaemonState.RUNNING


async def handle_running(app: Any) -> DaemonState:
    """RUNNING: Host Listener = all Host events (ticker, positions, open orders, fills).
    Secondary Listener = Secondary open orders, positions, fills, commission. Host Trading = no logic/subscriptions."""
    if getattr(app, "_use_ib_edge", False):
        logger.info(
            "[Daemon] state=RUNNING | IB edge mode — no Listener; accounts from Redis (IB Account Agent)"
        )
        app._event_subscribe_fills_registered = False
        app._event_subscribe_positions_ib2_registered = False
        app._event_subscribe_fills_ib2_registered = False
        app._event_subscribe_commission_ib2_registered = False
        try:
            from src.daemon.ib_edge import refresh_accounts_from_redis_edge

            await refresh_accounts_from_redis_edge(app)
        except Exception as e:
            logger.warning("[Daemon] ib_edge initial refresh: %s", e)
        app._apply_run_status_transition()
        if app._status_sink:
            app._status_sink.write_snapshot(
                app._build_heartbeat_minimal_dict(), append_history=False
            )
            if hasattr(app._status_sink, "write_daemon_heartbeat"):
                listener_kw = app._listener_heartbeat_kwargs()
                connector = getattr(app, "connector", None)
                _ib_conn = bool(connector and getattr(connector, "is_connected", False))
                _ib_cid = getattr(connector, "client_id", None) if connector else None
                app._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=_ib_conn,
                    ib_client_id=_ib_cid,
                    heartbeat_interval_sec=app._effective_heartbeat_interval(),
                    redis_quotes_connected=app._redis_quotes_connected(),
                    mock_hedging=getattr(app, "mock_hedging", True),
                    **app._event_subscribe_flags(),
                    **listener_kw,
                )
        app._heartbeat_task = asyncio.create_task(app._heartbeat())
        app._config_reload_task = asyncio.create_task(app._reload_config_loop())
        app._ib_disconnected_during_run = False
        try:
            while app._fsm_daemon.is_running():
                await asyncio.sleep(1.0)
                if getattr(app, "_ib_disconnected_during_run", False):
                    app._ib_disconnected_during_run = False
                    return DaemonState.WAITING_IB
        except asyncio.CancelledError:
            pass
        return DaemonState.STOPPING

    logger.info(
        "[Daemon] state=RUNNING | connecting Host Listener, then subscribing tickers and positions..."
    )
    # Connect Host Listener first (all Host-side event subscriptions use it; Host Trading is not used here)
    try:
        host_cid = getattr(app.listener_connector, "client_id", None)
        logger.debug("[Daemon] state=RUNNING | Listener (Host) connecting client_id=%s", host_cid)
        ok = await app.listener_connector.connect(max_attempts=3)
        if ok:
            listener_just_connected = True
            logger.debug("[Daemon] state=RUNNING | Listener (Host) connected client_id=%s", app.listener_connector.client_id)
            logger.info(
                "[Daemon] Listener (Host) IB connected (client_id=%s)",
                app.listener_connector.client_id,
            )
        else:
            logger.warning(
                "[Daemon] Listener (Host) IB connect failed (TWS may not show listener client_id)"
            )
    except Exception as e:
        logger.warning("[Daemon] Listener (Host) IB connect error: %s", e)
    listener = getattr(app, "listener_connector", None)
    if listener is not None and getattr(listener, "is_connected", False):
        symbols_to_subscribe: list = []
        if app._status_sink and hasattr(app._status_sink, "get_watchlist_stk_symbols"):
            symbols_to_subscribe = (
                getattr(app._status_sink, "get_watchlist_stk_symbols")() or []
            )
        logger.info("[Daemon] Watchlist STK symbols from DB: %s", symbols_to_subscribe)
        symbols_set = set(
            s.strip() for s in symbols_to_subscribe if s and str(s).strip()
        )
        if app.symbol:
            symbols_set.add(app.symbol)
        symbols_set = {s for s in symbols_set if s and str(s).strip()}
        symbols_list = sorted(symbols_set)
        if symbols_list:
            await listener.subscribe_tickers(symbols_list, app._on_ticker_for_symbol)
            logger.info(
                "[Daemon] subscribed to %s symbol(s) (Host Listener): %s",
                len(symbols_list),
                symbols_list,
            )
        else:
            logger.info(
                "[Daemon] no watchlist or active symbol available; skip ticker subscribe"
            )
        # Hedge evaluation is driven only by heartbeat; do not trigger on every position update.
        listener.subscribe_positions(lambda: None)

    # R-A5: open orders — merge only Host Listener + Secondary Listener (no Host Trading)
    def _merged_open_orders() -> list:
        orders: list = []
        seen: set = set()
        host_listener_count = 0
        if listener is not None and getattr(listener, "is_connected", False):
            try:
                orders = list(listener.get_open_orders_snapshot() or [])
                host_listener_count = len(orders)
                seen = {(o.get("order_id"), o.get("account_id")) for o in orders}
            except Exception as e:
                logger.warning("[Daemon] Host listener open orders snapshot: %s", e)
        listener_2 = getattr(app, "listener_connector_2", None)
        has_listener_2 = listener_2 is not None
        listener_2_connected = getattr(listener_2, "is_connected", False) if listener_2 else False
        secondary_count = 0
        if listener_2 is not None and getattr(listener_2, "is_connected", False):
            try:
                orders_2 = list(listener_2.get_open_orders_snapshot() or [])
                secondary_count = len(orders_2)
                for o in orders_2:
                    key = (o.get("order_id"), o.get("account_id"))
                    if key not in seen:
                        seen.add(key)
                        orders.append(o)
            except Exception as e:
                logger.warning("[Daemon] Secondary open orders snapshot: %s", e)
        return orders

    def _on_open_orders_update() -> None:
        try:
            merged = _merged_open_orders()
            if app._status_sink and hasattr(app._status_sink, "write_open_orders"):
                app._status_sink.write_open_orders(merged)
        except Exception as e:
            logger.warning("[Daemon] open orders callback error: %s", e)

    if listener is not None and getattr(listener, "is_connected", False):
        listener.subscribe_order_status(lambda _: _on_open_orders_update())
        listener.subscribe_open_order(lambda _: _on_open_orders_update())
        try:
            listener.subscribe_fills(lambda _t, _f: None)
            app._event_subscribe_fills_registered = True
        except Exception as e:
            logger.warning("[Daemon] Host listener subscribe_fills failed: %s", e)

    # Optional: include TWS manual orders in initial snapshot (Host Listener + Secondary merged after listener_2 connect below)
    def _write_initial_open_orders() -> None:
        try:
            merged = _merged_open_orders()
            if app._status_sink and hasattr(app._status_sink, "write_open_orders"):
                app._status_sink.write_open_orders(merged)
        except Exception as e:
            logger.warning("[Daemon] initial open orders snapshot failed: %s", e)

    listener_2_just_connected = False
    listener_2 = getattr(app, "listener_connector_2", None)
    if listener_2 is not None:
        try:
            sec_cid = getattr(listener_2, "client_id", None)
            logger.debug("[Daemon] state=RUNNING | Listener (Secondary) connecting client_id=%s", sec_cid)
            ok2 = await listener_2.connect(max_attempts=3)
            if ok2:
                listener_2_just_connected = True
                logger.debug("[Daemon] state=RUNNING | Listener (Secondary) connected client_id=%s", getattr(listener_2, "client_id", None))
                logger.info(
                    "[Daemon] Listener (Secondary) IB connected (client_id=%s)",
                    listener_2.client_id,
                )
                # Secondary: one-time merge so store and DB have Secondary accounts
                try:
                    from src.portfolio import accounts as _accounts
                    await _accounts.refresh_secondary_accounts_and_sync(app)
                except Exception as e:
                    logger.warning("[Daemon] Secondary initial accounts sync: %s", e)
                # Secondary: subscribe positions (no per-event sync to avoid flood of tasks; heartbeat syncs Secondary)
                try:
                    listener_2.subscribe_positions(lambda: None)
                    app._event_subscribe_positions_ib2_registered = True
                except Exception as e:
                    logger.warning("[Daemon] Secondary subscribe_positions: %s", e)
                    app._event_subscribe_positions_ib2_registered = False
                # Secondary: open order / order status → same merged write
                try:
                    listener_2.subscribe_order_status(lambda _: _on_open_orders_update())
                    listener_2.subscribe_open_order(lambda _: _on_open_orders_update())
                except Exception as e:
                    logger.warning("[Daemon] Secondary subscribe_order_status/open_order: %s", e)
                # Secondary: fills → one row per fill, write to account_executions
                try:
                    def _on_secondary_fill(_trade: Any, fill: Any) -> None:
                        row = listener_2.fill_to_execution_row(fill, source="tws_event")
                        if not row:
                            return
                        loop = getattr(app, "_loop", None)
                        sink = getattr(app, "_status_sink", None)
                        if loop is not None and sink is not None and hasattr(sink, "write_account_executions"):

                            def _write() -> None:
                                try:
                                    sink.write_account_executions([row])
                                except Exception as e:
                                    logger.warning("[Daemon] Secondary fill write: %s", e)

                            loop.call_soon_threadsafe(_write)

                    listener_2.subscribe_fills(_on_secondary_fill)
                    app._event_subscribe_fills_ib2_registered = True
                except Exception as e:
                    logger.warning("[Daemon] Secondary subscribe_fills: %s", e)
                    app._event_subscribe_fills_ib2_registered = False
                # Secondary: commission report → same sink
                try:
                    if app._status_sink and hasattr(app._status_sink, "update_execution_commission"):
                        listener_2.set_commission_report_callback(
                            lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                                eid, c, pnl, cur, y_, yrd
                            )
                        )
                    app._event_subscribe_commission_ib2_registered = True
                except Exception as e:
                    logger.warning("[Daemon] Secondary set_commission_report_callback: %s", e)
                    app._event_subscribe_commission_ib2_registered = False
            else:
                logger.warning(
                    "[Daemon] Listener (Secondary) IB connect failed"
                )
                app._event_subscribe_positions_ib2_registered = False
                app._event_subscribe_fills_ib2_registered = False
                app._event_subscribe_commission_ib2_registered = False
        except Exception as e:
            logger.warning("[Daemon] Listener (Secondary) IB connect error: %s", e)
            app._event_subscribe_positions_ib2_registered = False
            app._event_subscribe_fills_ib2_registered = False
            app._event_subscribe_commission_ib2_registered = False
    else:
        app._event_subscribe_positions_ib2_registered = False
        app._event_subscribe_fills_ib2_registered = False
        app._event_subscribe_commission_ib2_registered = False
    # Request all open orders from TWS so existing/manual orders appear in openTrades() (R-A5). Only Listeners (no Host Trading).
    if listener is not None and getattr(listener, "is_connected", False):
        try:
            await listener.get_open_orders_async(include_all_from_tws=True)
        except Exception as e:
            logger.warning("[Daemon] reqAllOpenOrders (Host Listener) failed: %s", e)
    listener_2 = getattr(app, "listener_connector_2", None)
    if listener_2 is not None and getattr(listener_2, "is_connected", False):
        try:
            await listener_2.get_open_orders_async(include_all_from_tws=True)
        except Exception as e:
            logger.warning("[Daemon] reqAllOpenOrders (Secondary) failed: %s", e)
    # Initial open orders (Host + Secondary merged)
    _write_initial_open_orders()
    app._apply_run_status_transition()
    if app._status_sink:
        app._status_sink.write_snapshot(
            app._build_heartbeat_minimal_dict(), append_history=False
        )
        if hasattr(app._status_sink, "write_daemon_heartbeat"):
            listener_kw = app._listener_heartbeat_kwargs()
            host_listener = getattr(app, "listener_connector", None)
            # ib_connected/ib_client_id = Trading connector only; Listener in listener_kw
            connector = getattr(app, "connector", None)
            _ib_conn = bool(connector and connector.is_connected)
            _ib_cid = getattr(connector, "client_id", None) if connector else None
            app._status_sink.write_daemon_heartbeat(
                hedge_running=True,
                ib_connected=_ib_conn,
                ib_client_id=_ib_cid,
                heartbeat_interval_sec=app._effective_heartbeat_interval(),
                redis_quotes_connected=app._redis_quotes_connected(),
                mock_hedging=getattr(app, "mock_hedging", True),
                **app._event_subscribe_flags(),
                **listener_kw,
            )
    app._heartbeat_task = asyncio.create_task(app._heartbeat())
    app._config_reload_task = asyncio.create_task(app._reload_config_loop())
    control_available = app._status_sink is not None and hasattr(
        app._status_sink, "poll_and_consume_control"
    )
    logger.info(
        "[Daemon] state=%s | Daemon running (symbol=%s, paper_trade=%s, config=%s); control via daemon_control=%s",
        app._fsm_daemon.current.value,
        app.symbol,
        app.paper_trade,
        app._config_path or "default",
        "enabled" if control_available else "disabled (no postgres sink)",
    )
    app._ib_disconnected_during_run = False
    try:
        while app._fsm_daemon.is_running():
            await asyncio.sleep(1.0)
            if getattr(app, "_ib_disconnected_during_run", False):
                app._ib_disconnected_during_run = False
                _co = getattr(app, "connector", None)
                if _co and getattr(_co, "is_connected", False):
                    try:
                        await _co.disconnect()
                    except Exception as e:
                        logger.warning(
                            "[Daemon] release_ib: disconnect failed (continuing to WAITING_IB): %s",
                            e,
                        )
                listener = getattr(app, "listener_connector", None)
                if listener and listener.is_connected:
                    try:
                        await listener.disconnect()
                    except Exception as e:
                        logger.warning(
                            "[Daemon] release_ib: listener disconnect failed: %s", e
                        )
                listener_2 = getattr(app, "listener_connector_2", None)
                if listener_2 and listener_2.is_connected:
                    try:
                        await listener_2.disconnect()
                    except Exception as e:
                        logger.warning(
                            "[Daemon] release_ib: listener_2 disconnect failed: %s", e
                        )
                return DaemonState.WAITING_IB
    except asyncio.CancelledError:
        pass
    return DaemonState.STOPPING


async def handle_stopping(app: Any) -> DaemonState:
    """STOPPING: cancel tasks, disconnect. Transition to STOPPED."""
    logger.info(
        "[Daemon] state=STOPPING | cancelling tasks, disconnecting IB..."
    )
    heartbeat_task = getattr(app, "_heartbeat_task", None)
    config_reload_task = getattr(app, "_config_reload_task", None)
    if heartbeat_task is not None:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug("Heartbeat task raised before cancel: %s", e)
    if config_reload_task is not None:
        config_reload_task.cancel()
        try:
            await config_reload_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug("Config reload task raised before cancel: %s", e)
    if getattr(app._status_sink, "close", None):
        try:
            app._status_sink.close()
        except Exception as e:
            logger.debug("Status sink close: %s", e)
    if getattr(app, "_redis_quotes", None):
        try:
            host_listener = getattr(app, "listener_connector", None)
            symbols = (
                host_listener.get_subscribed_ticker_symbols()
                if host_listener and getattr(host_listener, "get_subscribed_ticker_symbols", None)
                else []
            )
            for sym in symbols:
                if sym and str(sym).strip():
                    app._redis_quotes.delete_quote(sym.strip())
            if symbols:
                logger.info(
                    "[Daemon] STOPPING: cleared Redis ticker keys for %s symbol(s): %s",
                    len(symbols),
                    symbols,
                )
            app._redis_quotes.close()
        except Exception as e:
            logger.debug("Redis quotes close: %s", e)
    if getattr(app, "_redis_quotes_reader", None):
        try:
            app._redis_quotes_reader.close()
        except Exception as e:
            logger.debug("Redis quotes reader close: %s", e)
    _co = getattr(app, "connector", None)
    if _co:
        await _co.disconnect()
    listener = getattr(app, "listener_connector", None)
    if listener:
        try:
            await listener.disconnect()
        except Exception as e:
            logger.debug("Listener disconnect on stop: %s", e)
    listener_2 = getattr(app, "listener_connector_2", None)
    if listener_2:
        try:
            await listener_2.disconnect()
        except Exception as e:
            logger.debug("Listener (Secondary) disconnect on stop: %s", e)
    logger.info("[Daemon] state=STOPPING → STOPPED (exit)")
    return DaemonState.STOPPED


def get_state_handlers(app: Any) -> dict:
    """Map state -> async handler that returns next state."""
    return {
        DaemonState.IDLE: lambda: handle_idle(app),
        DaemonState.CONNECTING: lambda: handle_connecting(app),
        DaemonState.WAITING_IB: lambda: handle_waiting_ib(app),
        DaemonState.CONNECTED: lambda: handle_connected(app),
        DaemonState.RUNNING: lambda: handle_running(app),
        DaemonState.STOPPING: lambda: handle_stopping(app),
    }


async def run(app: Any) -> None:
    """State-driven loop: run handler for current state, transition to returned state."""
    app._loop = asyncio.get_running_loop()
    handlers = get_state_handlers(app)
    logger.info(
        "[Daemon] started (state loop: IDLE → CONNECTING → CONNECTED → RUNNING → STOPPING → STOPPED)"
    )
    try:
        while app._fsm_daemon.current != DaemonState.STOPPED:
            current = app._fsm_daemon.current
            handler = handlers.get(current)
            if handler is None:
                logger.warning(
                    "[Daemon] state=%s | no handler; stopping", current.value
                )
                break
            try:
                next_state = await handler()
                if not app._fsm_daemon.transition(next_state):
                    logger.error(
                        "[Daemon] invalid transition %s → %s; stopping",
                        current.value,
                        next_state.value,
                    )
                    if app._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                        app._fsm_daemon.transition(DaemonState.STOPPING)
                    break
            except Exception as e:
                logger.exception(
                    "[Daemon] state=%s handler raised: %s", current.value, e
                )
                if app._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                    app._fsm_daemon.transition(DaemonState.STOPPING)
                else:
                    app._fsm_daemon.transition(DaemonState.STOPPED)
    finally:
        if app._fsm_daemon.current != DaemonState.STOPPED:
            if app._fsm_daemon.current != DaemonState.STOPPING:
                app._fsm_daemon.transition(DaemonState.STOPPING)
            try:
                await handle_stopping(app)
            except Exception as e:
                logger.exception("Cleanup (_handle_stopping) failed: %s", e)
            app._fsm_daemon.transition(DaemonState.STOPPED)


def stop(app: Any) -> None:
    app._fsm_daemon.request_stop()
