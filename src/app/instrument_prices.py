"""Ticker subscriptions and R-M6 instrument_prices (IB + Redis). Used by GsTrading."""

import logging
import math
from typing import Any, Set

logger = logging.getLogger(__name__)

STALE_TICKER_SEC = 30.0


def _clear_control_message(app: Any) -> None:
    if app._status_sink and hasattr(app._status_sink, "write_daemon_control_message"):
        app._status_sink.write_daemon_control_message(None)


def _redis_add_subscribed(app: Any, symbols: Set[str]) -> None:
    """Add symbols to Redis ticker:subscribed set after subscribing."""
    if not getattr(app, "_redis_quotes", None) or not app._redis_quotes.available:
        return
    for sym in symbols:
        app._redis_quotes.add_symbol_subscribed(sym)


def _redis_remove_subscribed_and_quote(app: Any, symbol: str) -> None:
    """Remove symbol from Redis set and delete quote (on unsubscribe)."""
    if not getattr(app, "_redis_quotes", None) or not app._redis_quotes.available:
        return
    app._redis_quotes.remove_symbol_subscribed(symbol)
    app._redis_quotes.delete_quote(symbol)


async def release_ticker_subscriptions(app: Any) -> None:
    """Unsubscribe all Real-time ticker subscriptions; clear Redis quotes and ticker:subscribed set. Clears last_control_message."""
    if not app.connector.is_connected:
        return
    current = set(app.connector.get_subscribed_ticker_symbols())
    for sym in sorted(current):
        app.connector.unsubscribe_ticker(sym)
        _redis_remove_subscribed_and_quote(app, sym)
        logger.info("[Daemon] Real-time ticker unsubscribed: %s", sym)
    if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
        app._redis_quotes.clear_subscribed_set()
    _clear_control_message(app)


def _build_init_desired_symbols(app: Any) -> set:
    """Ideal set for Init: Watchlist STK + strategy symbol + all position STK symbols (deduplicated)."""
    desired: set = set()
    if app.symbol:
        desired.add(app.symbol.strip())
    if app._status_sink and hasattr(app._status_sink, "get_watchlist_stk_symbols"):
        for s in getattr(app._status_sink, "get_watchlist_stk_symbols")() or []:
            if s and str(s).strip():
                desired.add(str(s).strip())
    instruments = get_position_stk_instruments(app)
    for meta in instruments.values():
        sym = (meta.get("symbol") or "").strip()
        if sym:
            desired.add(sym)
    return desired


async def init_ticker_subscriptions(app: Any) -> None:
    """If no subscriptions (per Redis set): build desired set (watchlist + all positions) and subscribe. If Redis set non-empty, write error and return."""
    if not app.connector.is_connected:
        return
    subscribed: Set[str] = set()
    if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
        subscribed = app._redis_quotes.get_subscribed_symbols()
    if subscribed:
        msg = "请清空订阅"
        if app._status_sink and hasattr(app._status_sink, "write_daemon_control_message"):
            app._status_sink.write_daemon_control_message(msg)
        logger.warning("[Daemon] init_ticker_subscriptions: Redis subscribed set non-empty (%s), %s", len(subscribed), msg)
        return
    _clear_control_message(app)
    desired = _build_init_desired_symbols(app)
    if desired:
        added = await app.connector.subscribe_tickers(
            sorted(desired), app._on_ticker_for_symbol
        )
        if added:
            _redis_add_subscribed(app, set(added.keys()))
            logger.info(
                "[Daemon] Real-time ticker (init) subscribed: %s",
                sorted(added.keys()),
            )


async def sync_ticker_subscriptions_from_redis(
    app: Any, stale_sec: float = STALE_TICKER_SEC
) -> None:
    """Sync ticker subscriptions using Redis as source of truth.
    Get subscribed set and per-symbol last-update age from Redis; target set = watchlist + all positions.
    a) In target and subscribed: refresh (unsub+sub) if last update > stale_sec or missing.
    b) In target but not subscribed: subscribe.
    c) Subscribed but not in target: unsubscribe.
    """
    if not app.connector.is_connected:
        return
    rq = getattr(app, "_redis_quotes", None)
    if not rq or not rq.available:
        logger.debug("[Daemon] sync_ticker_subscriptions_from_redis: Redis unavailable, skip")
        return
    desired = _build_init_desired_symbols(app)
    subscribed, ages = rq.get_subscribed_symbols_with_ages_sec()
    a = desired & subscribed
    b = desired - subscribed
    c = subscribed - desired
    to_refresh: Set[str] = set()
    for sym in a:
        age = ages.get(sym)
        if age is None or age > stale_sec:
            to_refresh.add(sym)
    # (c) Unsubscribe and remove from Redis
    for sym in sorted(c):
        app.connector.unsubscribe_ticker(sym)
        _redis_remove_subscribed_and_quote(app, sym)
        logger.info("[Daemon] Real-time ticker unsubscribed (not in target): %s", sym)
    # (a) Refresh: unsub then sub (do not change Redis set)
    for sym in sorted(to_refresh):
        app.connector.unsubscribe_ticker(sym)
    if to_refresh:
        added = await app.connector.subscribe_tickers(
            sorted(to_refresh), app._on_ticker_for_symbol
        )
        if added:
            logger.info("[Daemon] Real-time ticker refreshed (stale >%ss): %s", stale_sec, sorted(added.keys()))
    # (b) Subscribe and add to Redis set
    if b:
        added = await app.connector.subscribe_tickers(
            sorted(b), app._on_ticker_for_symbol
        )
        if added:
            _redis_add_subscribed(app, set(added.keys()))
            logger.info("[Daemon] Real-time ticker subscribed (new): %s", sorted(added.keys()))


async def refresh_ticker_subscriptions(app: Any) -> None:
    """Sync: use Redis subscription state and per-symbol age; refresh stale (>30s), subscribe new, unsubscribe removed. If Redis unavailable, fallback to Release then Init."""
    if not app.connector.is_connected:
        return
    rq = getattr(app, "_redis_quotes", None)
    if rq and rq.available:
        await sync_ticker_subscriptions_from_redis(app, stale_sec=STALE_TICKER_SEC)
    else:
        await release_ticker_subscriptions(app)
        await init_ticker_subscriptions(app)


def get_position_stk_instruments(app: Any) -> dict:
    """从 accounts_data 聚合持仓中的 STK 标的，返回 contract_key -> meta（symbol, sec_type, expiry, strike, option_right, exchange, currency）。"""
    instruments: dict = {}
    accounts = app.store.get_accounts_data()
    if not accounts:
        return instruments
    for acc in accounts:
        positions = acc.get("positions") or []
        if not isinstance(positions, list):
            continue
        for p in positions:
            if not isinstance(p, dict):
                continue
            sym = (p.get("symbol") or "").strip()
            if not sym:
                continue
            sec = (p.get("secType") or p.get("sec_type") or "").strip()
            sec_u = sec.upper()
            if sec_u != "STK":
                continue
            ex = (p.get("exchange") or "").strip() or "SMART"
            curr = (p.get("currency") or "").strip() or "USD"
            contract_key = f"{sym}|{sec_u}|||"
            if contract_key in instruments:
                continue
            instruments[contract_key] = {
                "symbol": sym,
                "sec_type": sec_u,
                "expiry": None,
                "strike": None,
                "option_right": None,
                "exchange": ex,
                "currency": curr,
            }
    return instruments


async def refresh_position_prices(app: Any) -> None:
    """R-M6：根据当前 accounts_data 按 contract_key 聚合标的，逐标的向 IB 拉价并写入 instrument_prices。"""
    if not app._status_sink or not hasattr(
        app._status_sink, "write_instrument_prices"
    ):
        return
    if not app.connector.is_connected:
        return
    instruments = get_position_stk_instruments(app)
    if not instruments:
        return
    rows = []
    for ck, meta in instruments.items():
        price = await app.connector.get_instrument_price(
            symbol=meta["symbol"],
            sec_type=meta["sec_type"],
            expiry=meta["expiry"],
            strike=meta["strike"],
            right=meta["option_right"],
            exchange=meta["exchange"],
            currency=meta["currency"],
        )
        if not price:
            logger.debug(
                "[R-M6] get_instrument_price returned no data for %s (%s)",
                ck,
                meta["symbol"],
            )
            continue
        rows.append(
            {
                "contract_key": ck,
                "symbol": meta["symbol"],
                "sec_type": meta["sec_type"],
                "expiry": meta["expiry"],
                "strike": meta["strike"],
                "option_right": meta["option_right"],
                "last": price.get("last"),
                "bid": price.get("bid"),
                "ask": price.get("ask"),
                "mid": price.get("mid"),
            }
        )
    logger.info(
        "[R-M6] refresh_position_prices: %s stock instruments, %s rows to write",
        len(instruments),
        len(rows),
    )
    if rows:
        app._status_sink.write_instrument_prices(rows)


def sync_instrument_prices_from_redis(app: Any) -> None:
    """R-M6：用 Redis 中 Event 已写入的行情更新 instrument_prices，仅更新有 Redis 数据的持仓标的。"""
    if not app._status_sink or not hasattr(
        app._status_sink, "write_instrument_prices"
    ):
        return
    if not getattr(app, "_redis_quotes", None) or not app._redis_quotes.available:
        return
    instruments = get_position_stk_instruments(app)
    if not instruments:
        return
    symbols = [m["symbol"] for m in instruments.values()]
    quotes = app._redis_quotes.get_quotes(symbols)
    if not quotes:
        return
    symbol_to_ck = {m["symbol"]: ck for ck, m in instruments.items()}
    rows = []
    for q in quotes:
        sym = q.get("symbol")
        ck = symbol_to_ck.get(sym) if sym else None
        if not ck:
            continue
        meta = instruments[ck]
        bid = q.get("bid")
        ask = q.get("ask")
        last = q.get("last")
        try:
            bid_f = float(bid) if bid is not None else None
            ask_f = float(ask) if ask is not None else None
            last_f = float(last) if last is not None else None
        except (TypeError, ValueError):
            continue
        if bid_f is not None and not math.isfinite(bid_f):
            bid_f = None
        if ask_f is not None and not math.isfinite(ask_f):
            ask_f = None
        if last_f is not None and not math.isfinite(last_f):
            last_f = None
        if last_f is None and (bid_f is None or ask_f is None):
            continue
        mid = (
            (bid_f + ask_f) / 2.0
            if bid_f is not None and ask_f is not None
            else last_f
        )
        if mid is None:
            mid = last_f
        if mid is not None and not math.isfinite(mid):
            continue
        rows.append(
            {
                "contract_key": ck,
                "symbol": meta["symbol"],
                "sec_type": meta["sec_type"],
                "expiry": meta["expiry"],
                "strike": meta["strike"],
                "option_right": meta["option_right"],
                "last": last_f,
                "bid": bid_f,
                "ask": ask_f,
                "mid": mid,
            }
        )
    if rows:
        app._status_sink.write_instrument_prices(rows)
        logger.debug(
            "[R-M6] sync_instrument_prices_from_redis: %s rows from Redis",
            len(rows),
        )
