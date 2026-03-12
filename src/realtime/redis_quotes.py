"""Redis-backed quote cache and Pub/Sub linkage for real-time market data (R-RM*).

Daemon is the only writer; monitor subscribes and reads. Key naming: quote:{symbol}.
TTL on quote keys to avoid stale data. Channel: daemon:quotes (minimal payload: symbol + ts).
Subscribed ticker set: ticker:subscribed (Redis SET), updated on subscribe/unsubscribe.
"""

import json
import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

QUOTE_KEY_PREFIX = "quote:"
TICKER_SUBSCRIBED_KEY = "ticker:subscribed"
QUOTE_TTL_SEC = 300
PUB_CHANNEL = "daemon:quotes"


class RedisQuotesClient:
    """Thread-safe Redis client for writing quotes and publishing update notifications."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 6379,
        db: int = 0,
        password: Optional[str] = None,
        socket_connect_timeout: float = 5.0,
        quote_ttl_sec: int = QUOTE_TTL_SEC,
        channel: str = PUB_CHANNEL,
    ):
        self._host = host
        self._port = port
        self._db = db
        self._password = password or ""
        self._socket_connect_timeout = socket_connect_timeout
        self._quote_ttl_sec = quote_ttl_sec
        self._channel = channel
        self._client: Any = None
        self._available = False

    def connect(self) -> bool:
        """Establish connection. Returns True if connected."""
        if self._client is not None:
            try:
                self._client.ping()
                self._available = True
                return True
            except Exception:
                self._client = None
                self._available = False
        try:
            import redis
            self._client = redis.Redis(
                host=self._host,
                port=self._port,
                db=self._db,
                password=self._password if self._password else None,
                socket_connect_timeout=self._socket_connect_timeout,
                decode_responses=True,
            )
            self._client.ping()
            self._available = True
            logger.info(
                "Redis quotes client connected: host=%s port=%s db=%s channel=%s",
                self._host,
                self._port,
                self._db,
                self._channel,
            )
            return True
        except ImportError:
            logger.warning("redis package not installed; realtime quotes disabled")
            self._available = False
            return False
        except Exception as e:
            logger.warning("Redis connect failed: %s", e)
            self._client = None
            self._available = False
            return False

    @property
    def available(self) -> bool:
        return self._available and self._client is not None

    def set_quote(self, symbol: str, payload: Dict[str, Any]) -> bool:
        """Write quote to Redis (key quote:{symbol}), set TTL. Returns True on success."""
        if not self._client:
            return False
        key = f"{QUOTE_KEY_PREFIX}{symbol}"
        try:
            val = json.dumps(payload)
            pipe = self._client.pipeline()
            pipe.set(key, val, ex=self._quote_ttl_sec)
            pipe.execute()
            return True
        except Exception as e:
            logger.warning("Redis set_quote failed symbol=%s: %s", symbol, e)
            return False

    def publish_update(self, symbol: str, payload: Optional[Dict[str, Any]] = None) -> bool:
        """Publish minimal update to channel (default daemon:quotes). payload can be symbol+ts only."""
        if not self._client:
            return False
        msg = (payload or {}).copy()
        msg.setdefault("symbol", symbol)
        msg.setdefault("ts", time.time())
        try:
            self._client.publish(self._channel, json.dumps(msg))
            return True
        except Exception as e:
            logger.warning("Redis publish_update failed symbol=%s: %s", symbol, e)
            return False

    def delete_quote(self, symbol: str) -> bool:
        """Remove quote key from Redis (e.g. when unsubscribing ticker). Returns True on success or key already missing."""
        if not self._client:
            return False
        key = f"{QUOTE_KEY_PREFIX}{symbol}"
        try:
            self._client.delete(key)
            return True
        except Exception as e:
            logger.warning("Redis delete_quote failed symbol=%s: %s", symbol, e)
            return False

    def get_quote(self, symbol: str) -> Optional[Dict[str, Any]]:
        """Read one quote from Redis (for monitor). Returns None if key missing or error."""
        if not self._client:
            return None
        key = f"{QUOTE_KEY_PREFIX}{symbol}"
        try:
            val = self._client.get(key)
            if val is None:
                return None
            return json.loads(val)
        except Exception as e:
            logger.debug("Redis get_quote failed symbol=%s: %s", symbol, e)
            return None

    def get_quotes(self, symbols: List[str]) -> List[Dict[str, Any]]:
        """Read multiple quotes; returns list of dicts (only present symbols)."""
        out: List[Dict[str, Any]] = []
        for s in symbols:
            if not s or not s.strip():
                continue
            q = self.get_quote(s.strip())
            if q is not None:
                out.append(q)
        return out

    def add_symbol_subscribed(self, symbol: str) -> bool:
        """Add symbol to Redis SET ticker:subscribed. Returns True on success."""
        if not self._client:
            return False
        s = (symbol or "").strip()
        if not s:
            return False
        try:
            self._client.sadd(TICKER_SUBSCRIBED_KEY, s)
            return True
        except Exception as e:
            logger.warning("Redis add_symbol_subscribed failed symbol=%s: %s", symbol, e)
            return False

    def remove_symbol_subscribed(self, symbol: str) -> bool:
        """Remove symbol from Redis SET ticker:subscribed. Returns True on success."""
        if not self._client:
            return False
        s = (symbol or "").strip()
        if not s:
            return False
        try:
            self._client.srem(TICKER_SUBSCRIBED_KEY, s)
            return True
        except Exception as e:
            logger.warning("Redis remove_symbol_subscribed failed symbol=%s: %s", symbol, e)
            return False

    def get_subscribed_symbols(self) -> Set[str]:
        """Return set of symbols in Redis SET ticker:subscribed (daemon subscription list)."""
        if not self._client:
            return set()
        try:
            members = self._client.smembers(TICKER_SUBSCRIBED_KEY)
            return {str(m).strip() for m in (members or []) if m and str(m).strip()}
        except Exception as e:
            logger.debug("Redis get_subscribed_symbols failed: %s", e)
            return set()

    def get_subscribed_symbols_with_ages_sec(self) -> Tuple[Set[str], Dict[str, Optional[float]]]:
        """Return (subscribed_symbols, symbol -> seconds_since_last_update).
        For each symbol in ticker:subscribed, read quote and compute age from payload 'ts'.
        If no quote or no 'ts', age is None (treated as stale)."""
        subscribed = self.get_subscribed_symbols()
        now = time.time()
        ages: Dict[str, Optional[float]] = {}
        for sym in subscribed:
            q = self.get_quote(sym)
            if q is None:
                ages[sym] = None
                continue
            ts = q.get("ts")
            if ts is None:
                ages[sym] = None
                continue
            try:
                t = float(ts)
                if t > 0:
                    ages[sym] = now - t
                else:
                    ages[sym] = None
            except (TypeError, ValueError):
                ages[sym] = None
        return subscribed, ages

    def clear_subscribed_set(self) -> bool:
        """Remove all members from ticker:subscribed (e.g. on Release). Returns True on success."""
        if not self._client:
            return False
        try:
            self._client.delete(TICKER_SUBSCRIBED_KEY)
            return True
        except Exception as e:
            logger.warning("Redis clear_subscribed_set failed: %s", e)
            return False

    def close(self) -> None:
        if self._client:
            try:
                self._client.close()
            except Exception as e:
                logger.debug("Redis close: %s", e)
            self._client = None
        self._available = False


def get_quote_key(symbol: str) -> str:
    return f"{QUOTE_KEY_PREFIX}{symbol}"


def create_from_config(config: Dict[str, Any]) -> Optional[RedisQuotesClient]:
    """Build RedisQuotesClient from config if redis.enabled (or realtime.enabled)."""
    redis_cfg = config.get("redis") or {}
    realtime_cfg = config.get("realtime") or {}
    enabled = redis_cfg.get("enabled", False) or realtime_cfg.get("enabled", False)
    if not enabled:
        logger.info(
            "Redis quotes disabled: redis.enabled (or realtime.enabled) not true in config"
        )
        return None
    host = redis_cfg.get("host", "127.0.0.1")
    port = int(redis_cfg.get("port", 6379))
    db = int(redis_cfg.get("db", 0))
    password = redis_cfg.get("password")
    timeout = float(redis_cfg.get("socket_connect_timeout", 5.0))
    ttl = int(redis_cfg.get("quote_ttl_sec", QUOTE_TTL_SEC))
    channel = redis_cfg.get("channel", PUB_CHANNEL)
    client = RedisQuotesClient(
        host=host,
        port=port,
        db=db,
        password=password,
        socket_connect_timeout=timeout,
        quote_ttl_sec=ttl,
        channel=channel,
    )
    if client.connect():
        return client
    logger.warning(
        "Redis quotes unavailable: connect failed to %s:%s (check Redis is running and redis.host/port in config)",
        host,
        port,
    )
    return None


def run_subscribe_loop(
    rq: RedisQuotesClient,
    on_quote: Callable[[Dict[str, Any]], None],
    stop_event: threading.Event,
    poll_timeout: float = 0.5,
) -> None:
    """Run Redis SUBSCRIBE loop in a thread; for each daemon:quotes message, read quote from rq and call on_quote(quote_dict).
    Uses a separate Redis connection so the main rq connection can still do GET. Call from a daemon thread; stops when stop_event is set."""
    try:
        import redis
    except ImportError:
        logger.warning("redis package not installed; SSE quote stream disabled")
        return
    sub_client = redis.Redis(
        host=rq._host,
        port=rq._port,
        db=rq._db,
        password=rq._password if rq._password else None,
        socket_connect_timeout=rq._socket_connect_timeout,
        decode_responses=True,
    )
    try:
        pubsub = sub_client.pubsub()
        pubsub.subscribe(rq._channel)
        logger.info("Redis quotes subscribe loop started on channel=%s", rq._channel)
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
                quote = rq.get_quote(symbol)
                if quote:
                    on_quote(quote)
            except (json.JSONDecodeError, TypeError) as e:
                logger.debug("Redis subscribe message parse skip: %s", e)
    finally:
        try:
            pubsub.close()
        except Exception:
            pass
        try:
            sub_client.close()
        except Exception:
            pass
        logger.info("Redis quotes subscribe loop stopped")
