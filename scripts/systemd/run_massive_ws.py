#!/usr/bin/env python3
"""Massive (Polygon) Options WebSocket ingest — long-running standalone service.

Connects to the Massive Options WS, dynamically subscribes to channels for
Watchlist symbols, writes latest quotes to Redis, samples 1-minute bars to
PostgreSQL (option_snapshots), and publishes update notifications.

Architecture reference: docs/ARCHITECTURE.md (WebSocket ingest); health hash ``bifrost:health:ws_massive_option``;
console log stream ``bifrost:console:ws_massive_option`` (Monitor ``/api/massive-ws/logs*``).

Usage
─────
  python scripts/systemd/run_massive_ws.py
  python scripts/systemd/run_massive_ws.py --config config/config.prod.yaml
  python scripts/systemd/run_massive_ws.py --config config/config.dev.yaml --log-level DEBUG
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Set

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(str(_PROJECT_ROOT))

from src.bifrost.redis_health_keys import BIFROST_HEALTH_MASSIVE_WS, HEALTH_HASH_TTL_SEC

from backend.monitor.routers.deps import MASSIVE_WS_LOG_STREAM_KEY
from src.core.logging_redis_stream import RedisStreamLogHandler

_MASSIVE_WS_LOG_STREAM_MAXLEN = 2000

logger = logging.getLogger("massive_ws")

# Console log colors (aligned with scripts/run_server_massive.py, scripts/systemd/run_engine.py)
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
    """Must use the same merged YAML as the ingest (e.g. ``--config config/config.prod.yaml``).

    Calling ``read_config()`` with no path uses ``config/config.yaml`` only, so Redis for the
    dashboard stream can differ from ``_load_config`` → empty Socket Services logs on Prod Linux.
    """
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
        MASSIVE_WS_LOG_STREAM_KEY,
        maxlen=_MASSIVE_WS_LOG_STREAM_MAXLEN,
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


# ─── Constants ────────────────────────────────────────────────────────────────

REDIS_KEY_PREFIX = "massive:"
REDIS_META_STATUS = BIFROST_HEALTH_MASSIVE_WS
REDIS_META_SUBS = "massive:meta:subscriptions"
REDIS_PUB_CHANNEL = "massive:channel"
REDIS_KEY_TTL = 300

QUEUE_MAX = 10_000
HEARTBEAT_TIMEOUT = 30
RECONNECT_BASE = 1.0
RECONNECT_MAX = 60.0
WATCHLIST_POLL_SEC = 60
PG_SAMPLE_INTERVAL_SEC = 60


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _load_config(config_path: str | None) -> dict:
    from src.app.config import read_config
    cfg, _ = read_config(config_path)
    return cfg


def _get_massive(cfg: dict) -> dict:
    from src.vendor.massive.config import get_massive_settings
    return get_massive_settings(cfg)


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


def _pg_conn(cfg: dict):
    import psycopg2
    from src.persistence.postgres.connection import _get_conn_params
    status_cfg = cfg.get("status") or cfg
    params = _get_conn_params(status_cfg)
    return psycopg2.connect(**params)


def _watchlist_option_symbols(cfg: dict) -> Set[str]:
    """Read Watchlist STK symbols that are optionable."""
    try:
        import psycopg2
        from src.persistence.postgres.connection import _get_conn_params
        status_cfg = cfg.get("status") or cfg
        params = _get_conn_params(status_cfg)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT symbol FROM watchlist WHERE sec_type = 'STK' AND optionable = true"
                )
                return {row[0] for row in cur.fetchall()}
        finally:
            conn.close()
    except Exception as e:
        logger.warning("Failed to read watchlist symbols: %s", e)
        return set()


def _channels_for_symbols(symbols: Set[str], _tier: str, trades_enabled: bool) -> str:
    """Build Polygon subscribe params string for given symbols."""
    if not symbols:
        return ""
    prefixes = ["Q.O:", "AM.O:"]
    if trades_enabled:
        prefixes.append("T.O:")
    parts = []
    for sym in sorted(symbols):
        for p in prefixes:
            parts.append(f"{p}{sym}*")
    return ",".join(parts)


def _contract_key_from_ticker(ticker: str) -> Optional[str]:
    """Parse Polygon option ticker (O:NVDA250620C00120000) to contract_key."""
    t = ticker.strip()
    if t.startswith("O:"):
        t = t[2:]
    if len(t) < 16:
        return None
    try:
        sym_end = len(t) - 15
        sym = t[:sym_end]
        date_str = t[sym_end:sym_end + 6]
        right_char = t[sym_end + 6]
        strike_raw = t[sym_end + 7:]
        yy = date_str[:2]
        mm = date_str[2:4]
        dd = date_str[4:6]
        expiry = f"20{yy}{mm}{dd}"
        right = "C" if right_char == "C" else "P"
        strike = float(strike_raw) / 1000.0
        strike_str = f"{strike:g}"
        return f"{sym}|OPT|{expiry}|{strike_str}|{right}"
    except Exception:
        return None


# ─── Redis writer ─────────────────────────────────────────────────────────────

class RedisWriter:
    def __init__(self, rds):
        self._rds = rds

    def write_quote(self, contract_key: str, data: dict) -> None:
        key = REDIS_KEY_PREFIX + contract_key
        self._rds.set(key, json.dumps(data, default=str), ex=REDIS_KEY_TTL)
        self._rds.publish(REDIS_PUB_CHANNEL, contract_key)

    def update_status(self, connected: bool, last_msg_ts: float, reconnects: int, msg_count: int) -> None:
        self._rds.hset(REDIS_META_STATUS, mapping={
            "connected": "1" if connected else "0",
            "last_msg_ts": str(last_msg_ts),
            "reconnects": str(reconnects),
            "msg_count": str(msg_count),
            "updated_at": str(time.time()),
        })
        self._rds.expire(REDIS_META_STATUS, HEALTH_HASH_TTL_SEC)

    def set_subscriptions(self, channels: Set[str]) -> None:
        pipe = self._rds.pipeline()
        pipe.delete(REDIS_META_SUBS)
        if channels:
            pipe.sadd(REDIS_META_SUBS, *channels)
        pipe.execute()


# ─── PG sampler (1-min) ──────────────────────────────────────────────────────

class PgSampler:
    """Writes at most one snapshot row per contract_key per minute to PG."""

    def __init__(self, cfg: dict):
        self._cfg = cfg
        self._last_write: Dict[str, float] = {}

    def maybe_write(self, contract_key: str, data: dict) -> bool:
        now = time.time()
        last = self._last_write.get(contract_key, 0)
        if now - last < PG_SAMPLE_INTERVAL_SEC:
            return False
        try:
            conn = _pg_conn(self._cfg)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO option_snapshots (
                            contract_key, snapshot_ts,
                            iv, delta, gamma, theta, vega, open_interest,
                            source, created_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'massive_ws', now())
                        ON CONFLICT (contract_key, snapshot_ts) DO UPDATE SET
                          iv = COALESCE(EXCLUDED.iv, option_snapshots.iv),
                          delta = COALESCE(EXCLUDED.delta, option_snapshots.delta),
                          gamma = COALESCE(EXCLUDED.gamma, option_snapshots.gamma),
                          theta = COALESCE(EXCLUDED.theta, option_snapshots.theta),
                          vega = COALESCE(EXCLUDED.vega, option_snapshots.vega),
                          open_interest = COALESCE(EXCLUDED.open_interest, option_snapshots.open_interest)
                        """,
                        (
                            contract_key,
                            datetime.fromtimestamp(data.get("t", now) / 1000 if data.get("t", 0) > 1e12 else data.get("t", now), tz=timezone.utc),
                            data.get("iv"),
                            data.get("delta"),
                            data.get("gamma"),
                            data.get("theta"),
                            data.get("vega"),
                            data.get("oi"),
                        ),
                    )
                conn.commit()
                self._last_write[contract_key] = now
                return True
            finally:
                conn.close()
        except Exception as e:
            logger.debug("PG sample write failed for %s: %s", contract_key, e)
            return False


# ─── Main ingest loop ────────────────────────────────────────────────────────

class MassiveWsIngest:
    def __init__(self, cfg: dict):
        self._cfg = cfg
        self._massive = _get_massive(cfg)
        self._rds = _redis_client(cfg)
        self._redis_writer = RedisWriter(self._rds)
        self._pg_sampler = PgSampler(cfg)
        self._stop = asyncio.Event()
        self._reconnects = 0
        self._msg_count = 0
        self._current_symbols: Set[str] = set()
        self._current_channels: str = ""
        from src.bifrost.ops_lease import ops_profile_from_config
        self._ops_profile = ops_profile_from_config(cfg)

    def _heartbeat_ops_lease(self) -> None:
        """Restore/refresh bifrost_ops_control_env on the health hash each heartbeat.

        Writes to REDIS_META_STATUS (the health hash) — the key that GET /services actually reads.
        Also refreshes bifrost_ops_control_updated_at so the orphan-detection grace period
        (120 s) never expires while the service is running (heartbeat fires every 60 s).
        """
        if not self._ops_profile:
            return
        try:
            from backend.ops.market_ingest_control_env import (
                BIFROST_OPS_CONTROL_ENV_FIELD,
                BIFROST_OPS_CONTROL_HOST_FIELD,
                BIFROST_OPS_CONTROL_UPDATED_AT_FIELD,
                control_hostname,
            )
            existing = self._rds.hget(REDIS_META_STATUS, BIFROST_OPS_CONTROL_ENV_FIELD)
            now = time.time()
            if not existing:
                hostname = control_hostname()
                self._rds.hset(REDIS_META_STATUS, mapping={
                    BIFROST_OPS_CONTROL_ENV_FIELD: self._ops_profile,
                    BIFROST_OPS_CONTROL_HOST_FIELD: hostname,
                    BIFROST_OPS_CONTROL_UPDATED_AT_FIELD: str(now),
                })
                logger.info(
                    "ops_lease: restored bifrost_ops_control_env on %s → %s @ %s",
                    REDIS_META_STATUS, self._ops_profile, hostname,
                )
            else:
                # Refresh updated_at to keep the orphan-detection grace period alive.
                self._rds.hset(REDIS_META_STATUS, BIFROST_OPS_CONTROL_UPDATED_AT_FIELD, str(now))
        except Exception as e:
            logger.debug("_heartbeat_ops_lease: %s", e)

    async def run(self) -> None:
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._stop.set)

        logger.info("Massive WS ingest starting (tier=%s, trades=%s)",
                     self._massive["tier"], self._massive["trades_enabled"])

        while not self._stop.is_set():
            try:
                await self._connect_and_consume()
            except Exception as e:
                logger.error("WS connection error: %s", e)

            if self._stop.is_set():
                break

            self._reconnects += 1
            delay = min(RECONNECT_BASE * (2 ** min(self._reconnects - 1, 6)), RECONNECT_MAX)
            logger.info("Reconnecting in %.1fs (attempt %d)…", delay, self._reconnects)
            self._redis_writer.update_status(False, time.time(), self._reconnects, self._msg_count)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        self._redis_writer.update_status(False, time.time(), self._reconnects, self._msg_count)
        logger.info("Massive WS ingest stopped (total messages: %d, reconnects: %d)",
                     self._msg_count, self._reconnects)

    async def _connect_and_consume(self) -> None:
        import websockets

        api_key = self._massive["api_key"]
        ws_url = self._massive["ws_url"]

        # Dynamic subscription from Watchlist
        symbols = _watchlist_option_symbols(self._cfg)
        if not symbols:
            logger.warning("No optionable STK symbols in Watchlist; waiting %ds…", WATCHLIST_POLL_SEC)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=WATCHLIST_POLL_SEC)
            except asyncio.TimeoutError:
                pass
            return

        channels = _channels_for_symbols(symbols, self._massive["tier"], self._massive["trades_enabled"])
        self._current_symbols = symbols
        self._current_channels = channels

        logger.info("Connecting to %s (symbols: %s)", ws_url, ", ".join(sorted(symbols)))

        try:
            async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                # Welcome
                welcome = await asyncio.wait_for(ws.recv(), timeout=10)
                logger.debug("← welcome: %s", str(welcome)[:200])

                # Auth
                await ws.send(json.dumps({"action": "auth", "params": api_key}))
                auth_resp = await asyncio.wait_for(ws.recv(), timeout=10)
                auth_data = json.loads(auth_resp)
                if isinstance(auth_data, list):
                    statuses = [m.get("status") for m in auth_data if isinstance(m, dict)]
                    if "auth_failed" in statuses:
                        logger.error("Auth failed — check API key and tier.")
                        return
                    if "auth_success" not in statuses:
                        # Starter may redirect to delayed endpoint
                        msgs = [str(m.get("message", "")).lower() for m in auth_data if isinstance(m, dict)]
                        if any("delayed" in msg for msg in msgs):
                            logger.info("Redirecting to delayed endpoint…")
                            ws_url_delayed = ws_url.replace("://socket.polygon.io", "://delayed.polygon.io")
                            if ws_url_delayed == ws_url:
                                ws_url_delayed = "wss://delayed.polygon.io/options"
                            self._massive["ws_url"] = ws_url_delayed
                            return

                logger.info("Auth success")

                # Subscribe
                await ws.send(json.dumps({"action": "subscribe", "params": channels}))
                logger.info("Subscribed: %s", channels[:200])
                self._redis_writer.set_subscriptions(set(channels.split(",")))
                self._redis_writer.update_status(True, time.time(), self._reconnects, self._msg_count)
                self._heartbeat_ops_lease()
                self._reconnects = 0

                # Consume with watchlist refresh
                queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
                recv_task = asyncio.create_task(self._recv_loop(ws, queue))
                process_task = asyncio.create_task(self._process_loop(queue))
                watchlist_task = asyncio.create_task(self._watchlist_refresh_loop(ws))

                _done, pending = await asyncio.wait(
                    [recv_task, process_task, watchlist_task, asyncio.create_task(self._stop.wait())],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):
                        pass

        except Exception as e:
            logger.warning("WS session ended: %s", e)

    async def _recv_loop(self, ws, queue: asyncio.Queue) -> None:
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=HEARTBEAT_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning("No message for %ds, treating as stale", HEARTBEAT_TIMEOUT)
                return
            except Exception as e:
                logger.debug("recv error: %s", e)
                return
            try:
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    logger.debug("Queue full, dropped oldest")
                queue.put_nowait(raw)
            except Exception:
                pass

    async def _process_loop(self, queue: asyncio.Queue) -> None:
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                msgs = json.loads(raw)
                if not isinstance(msgs, list):
                    msgs = [msgs]
                for msg in msgs:
                    if not isinstance(msg, dict):
                        continue
                    ev = msg.get("ev")
                    if not ev:
                        continue
                    self._msg_count += 1
                    self._handle_message(msg)
                    if self._msg_count % 500 == 0:
                        self._redis_writer.update_status(True, time.time(), self._reconnects, self._msg_count)
            except json.JSONDecodeError:
                logger.debug("Bad JSON: %s", raw[:100])
            except Exception as e:
                logger.debug("Process error: %s", e)

    def _handle_message(self, msg: dict) -> None:
        ev = msg.get("ev", "")
        sym = msg.get("sym") or msg.get("T") or ""
        ck = _contract_key_from_ticker(sym)
        if not ck:
            return

        data: Dict[str, Any] = {"ev": ev, "sym": sym}

        if ev == "Q":
            data.update({"bid": msg.get("bp"), "ask": msg.get("ap"), "t": msg.get("t")})
        elif ev in ("AM", "A"):
            data.update({
                "c": msg.get("c"), "o": msg.get("o"), "h": msg.get("h"), "l": msg.get("l"),
                "v": msg.get("v"), "t": msg.get("s") or msg.get("t"),
            })
        elif ev == "T":
            data.update({"last": msg.get("p"), "size": msg.get("s"), "t": msg.get("t")})
        else:
            data.update(msg)

        self._redis_writer.write_quote(ck, data)

        # 1-min PG sampling for AM (minute agg) events
        if ev == "AM":
            self._pg_sampler.maybe_write(ck, data)

    async def _watchlist_refresh_loop(self, ws) -> None:
        """Periodically check Watchlist and update subscriptions."""
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=WATCHLIST_POLL_SEC)
                return
            except asyncio.TimeoutError:
                pass

            self._heartbeat_ops_lease()
            new_symbols = _watchlist_option_symbols(self._cfg)
            if not new_symbols or new_symbols == self._current_symbols:
                continue

            added = new_symbols - self._current_symbols
            removed = self._current_symbols - new_symbols

            if removed:
                unsub_channels = _channels_for_symbols(removed, self._massive["tier"], self._massive["trades_enabled"])
                try:
                    await ws.send(json.dumps({"action": "unsubscribe", "params": unsub_channels}))
                    logger.info("Unsubscribed removed symbols: %s", ", ".join(sorted(removed)))
                except Exception as e:
                    logger.warning("Unsubscribe failed: %s", e)

            if added:
                sub_channels = _channels_for_symbols(added, self._massive["tier"], self._massive["trades_enabled"])
                try:
                    await ws.send(json.dumps({"action": "subscribe", "params": sub_channels}))
                    logger.info("Subscribed new symbols: %s", ", ".join(sorted(added)))
                except Exception as e:
                    logger.warning("Subscribe failed: %s", e)

            self._current_symbols = new_symbols
            self._current_channels = _channels_for_symbols(new_symbols, self._massive["tier"], self._massive["trades_enabled"])
            self._redis_writer.set_subscriptions(set(self._current_channels.split(",")))


# ─── Entry point ──────────────────────────────────────────────────────────────

def _redis_ping_or_exit(cfg: dict) -> None:
    """Fail fast when Redis is unreachable (otherwise quotes/meta silently never persist)."""
    try:
        _redis_client(cfg).ping()
    except Exception as e:
        logger.error(
            "Redis ping failed — cannot write quotes or console stream: %s",
            e,
        )
        print(
            "Hint: On Prod, use merged config/config.prod.yaml (see BIFROST_CONFIG / --config). "
            "If you rsync without --sync-prod-config, the server may lack config.prod.yaml.",
            file=sys.stderr,
        )
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Massive Options WebSocket ingest service")
    parser.add_argument("--config", type=str, default=None, help="Path to YAML config")
    parser.add_argument("--log-level", type=str, default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()

    cfg_path: str | None = args.config
    if cfg_path:
        p = Path(cfg_path)
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        if not p.is_file():
            print(
                f"ERROR: --config file not found: {args.config}\n"
                "  rsync deploy excludes config/config.prod.yaml unless you use:\n"
                "    ./scripts/bifrost_ssh.sh --deploy --sync-prod-config\n"
                "  Or copy config/config.prod.yaml to the server (same tree as config/config.yaml).",
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
    ms = _get_massive(cfg)

    if not ms["api_key"]:
        logger.error("No Massive API key. Set massive.api_key in config or MASSIVE_API_KEY env var.")
        sys.exit(1)

    ingest = MassiveWsIngest(cfg)
    asyncio.run(ingest.run())


if __name__ == "__main__":
    main()
