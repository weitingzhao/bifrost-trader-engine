"""Redis SUBSCRIBE loop for quote pub/sub (monitor SSE). Uses a separate connection from the reader GET client."""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable, Dict

from .redis_quotes import RedisQuotesReader

logger = logging.getLogger(__name__)


def run_subscribe_loop(
    reader: RedisQuotesReader,
    on_quote: Callable[[Dict[str, Any]], None],
    stop_event: threading.Event,
    poll_timeout: float = 0.5,
) -> None:
    """Run Redis SUBSCRIBE in a thread; on each channel message, load quote via reader and call on_quote.

    Uses reader.realtime_params for host/port/db/channel so the reader's primary connection can keep doing GET.
    """
    try:
        import redis
    except ImportError:
        logger.warning("redis package not installed; SSE quote stream disabled")
        return

    p = reader.realtime_params
    sub_client = redis.Redis(
        host=p.host,
        port=p.port,
        db=p.db,
        password=p.password if p.password else None,
        socket_connect_timeout=p.socket_connect_timeout,
        decode_responses=True,
    )
    pubsub = None
    try:
        pubsub = sub_client.pubsub()
        pubsub.subscribe(p.channel)
        logger.info("Redis quotes subscribe loop started on channel=%s", p.channel)
        while not stop_event.is_set():
            msg = pubsub.get_message(timeout=poll_timeout)
            if msg is None:
                continue
            if msg.get("type") != "message":
                continue
            try:
                data = json.loads(msg["data"])
                symbol = (data.get("symbol") or "").strip()
                if not symbol:
                    continue
                quote = reader.get_quote(symbol)
                if quote:
                    on_quote(quote)
            except (json.JSONDecodeError, TypeError) as e:
                logger.debug("Redis subscribe message parse skip: %s", e)
    finally:
        if pubsub is not None:
            try:
                pubsub.close()
            except Exception:
                pass
        try:
            sub_client.close()
        except Exception:
            pass
        logger.info("Redis quotes subscribe loop stopped")
