"""Ticker subscriptions and R-M6 instrument_prices (IB + Redis). Used by GsTrading."""

import logging
import math
from typing import Any

logger = logging.getLogger(__name__)


async def refresh_ticker_subscriptions(app: Any) -> None:
    """每次心跳同步 Real-time ticker：应与 Watchlist STK + 当前活跃标的 + Stream 主/副账户持仓 STK 一致；多退少补，无需重启守护进程。"""
    if not app.connector.is_connected:
        return
    desired: set = set()
    if app.symbol:
        desired.add(app.symbol.strip())
    if app._status_sink and hasattr(app._status_sink, "get_watchlist_stk_symbols"):
        for s in getattr(app._status_sink, "get_watchlist_stk_symbols")() or []:
            if s and str(s).strip():
                desired.add(str(s).strip())
    if app._status_sink and hasattr(app._status_sink, "get_stream_position_stk_symbols"):
        for s in getattr(app._status_sink, "get_stream_position_stk_symbols")() or []:
            if s and str(s).strip():
                desired.add(str(s).strip())
    current = set(app.connector.get_subscribed_ticker_symbols())
    to_remove = current - desired
    to_add = desired - current
    for sym in sorted(to_remove):
        app.connector.unsubscribe_ticker(sym)
        if getattr(app, "_redis_quotes", None) and app._redis_quotes.available:
            app._redis_quotes.delete_quote(sym)
        logger.info("[Daemon] Real-time ticker unsubscribed: %s", sym)
    if to_add:
        added = await app.connector.subscribe_tickers(
            sorted(to_add), app._on_ticker_for_symbol
        )
        if added:
            logger.info(
                "[Daemon] Real-time ticker subscribed: %s",
                sorted(added.keys()),
            )


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
