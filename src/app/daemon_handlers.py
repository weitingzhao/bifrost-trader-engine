"""Daemon FSM state handlers, run() loop, and stop(). Used by GsTrading."""

import asyncio
import logging
import time
from typing import Any

from src.fsm.daemon_fsm import DaemonState
from src.fsm.events import TradingEvent

logger = logging.getLogger(__name__)


async def handle_idle(app: Any) -> DaemonState:
    """IDLE: ready to start. Transition to CONNECTING."""
    logger.info("[Daemon] state=IDLE → CONNECTING (connecting to IB)")
    return DaemonState.CONNECTING


async def handle_connecting(app: Any) -> DaemonState:
    """CONNECTING: try IB with client_id, client_id+1, ... (up to 10 attempts); if all fail → WAITING_IB (RE-7)."""
    logger.info(
        "[Daemon] state=CONNECTING | connecting to IB (clientId=%s; will try +1, +2, ... if already in use)",
        getattr(app.connector, "client_id", None),
    )
    ok = await app.connector.connect(max_attempts=10)
    if not ok:
        logger.warning(
            "[Daemon] state=CONNECTING | IB connect failed after 10 attempts → WAITING_IB (daemon stays up, will retry)"
        )
        return DaemonState.WAITING_IB
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
            logger.info(
                "[Daemon] state=WAITING_IB | %s → connecting to IB (clientId=%s; will try +1, +2, ... if in use)",
                "retry_ib" if cmd == "retry_ib" else "retry timer",
                getattr(app.connector, "client_id", None),
            )
            ok = await app.connector.connect(max_attempts=10)
            if ok:
                if app._status_sink and hasattr(
                    app._status_sink, "write_daemon_heartbeat"
                ):
                    app._status_sink.write_daemon_heartbeat(
                        hedge_running=False,
                        ib_connected=True,
                        ib_client_id=getattr(app.connector, "client_id", None),
                        heartbeat_interval_sec=app._effective_heartbeat_interval(),
                        redis_quotes_connected=app._redis_quotes_connected(),
                        **app._event_subscribe_flags(),
                        **app._listener_heartbeat_kwargs(),
                    )
                logger.info("[Daemon] state=WAITING_IB → CONNECTED (IB connected)")
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
    if app._status_sink and hasattr(app._status_sink, "write_daemon_heartbeat"):
        app._status_sink.write_daemon_heartbeat(
            hedge_running=False,
            ib_connected=app.connector.is_connected,
            ib_client_id=getattr(app.connector, "client_id", None),
            heartbeat_interval_sec=app._effective_heartbeat_interval(),
            redis_quotes_connected=app._redis_quotes_connected(),
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
    """RUNNING: subscribe to Watchlist STK + active symbol, start background tasks, loop until stop requested."""
    logger.info(
        "[Daemon] state=RUNNING | subscribing to tickers (Watchlist STK + active symbol) and positions..."
    )
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
        await app.connector.subscribe_tickers(
            symbols_list, app._on_ticker_for_symbol
        )
        logger.info(
            "[Daemon] subscribed to %s symbol(s): %s",
            len(symbols_list),
            symbols_list,
        )
    else:
        logger.info(
            "[Daemon] no watchlist or active symbol available; skip ticker subscribe"
        )
    app.connector.subscribe_positions(app._eval_hedge_threadsafe)
    listener_just_connected = False
    try:
        ok = await app.listener_connector.connect(max_attempts=3)
        if ok:
            listener_just_connected = True
            logger.info(
                "[Daemon] Listener IB connected (client_id=%s)",
                app.listener_connector.client_id,
            )
        else:
            logger.warning(
                "[Daemon] Listener IB connect failed (TWS may not show listener client_id)"
            )
    except Exception as e:
        logger.warning("[Daemon] Listener IB connect error: %s", e)
    app._apply_run_status_transition()
    if app._status_sink:
        app._status_sink.write_snapshot(
            app._build_heartbeat_minimal_dict(), append_history=False
        )
        if hasattr(app._status_sink, "write_daemon_heartbeat"):
            listener_kw = (
                {
                    "listener_connected": True,
                    "listener_client_id": app.listener_connector.client_id,
                }
                if listener_just_connected
                else app._listener_heartbeat_kwargs()
            )
            app._status_sink.write_daemon_heartbeat(
                hedge_running=True,
                ib_connected=app.connector.is_connected,
                ib_client_id=getattr(app.connector, "client_id", None),
                heartbeat_interval_sec=app._effective_heartbeat_interval(),
                redis_quotes_connected=app._redis_quotes_connected(),
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
                if app.connector.is_connected:
                    try:
                        await app.connector.disconnect()
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
            symbols = (
                app.connector.get_subscribed_ticker_symbols()
                if getattr(app.connector, "get_subscribed_ticker_symbols", None)
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
    await app.connector.disconnect()
    listener = getattr(app, "listener_connector", None)
    if listener:
        try:
            await listener.disconnect()
        except Exception as e:
            logger.debug("Listener disconnect on stop: %s", e)
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
