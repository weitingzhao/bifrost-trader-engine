"""IB Operator main loop: Redis Stream consumer + IB executor."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Dict, Optional

import redis

from src.app.config import get_effective_ib_config
from src.bifrost.message_center import IbConnectionStatusTracker
from src.bifrost.ops_lease import maintain_health_host, ops_profile_from_config
from src.bifrost.redis_health_keys import HEALTH_HASH_TTL_SEC
from src.ib.connection_policy import operator_effective_health_refresh_sec
from src.ib_operator.config import effective_ib_operator_settings
from src.ib_operator.executor import IbOperatorExecutor
from src.ib_operator.health_redis import (
    operator_health_dict_to_redis_hash,
    prune_legacy_operator_health_hash_fields,
)
from src.ib_operator.protocol import (
    CommandMessage,
    dumps_result,
    parse_stream_fields,
    result_key,
)
from src.ib_operator.redis_io import (
    OperatorRedisRunner,
    ack_message,
    consumer_name,
    ensure_stream_and_group,
    parse_xreadgroup_reply,
    write_result,
    xreadgroup_recover_nogroup,
)
from src.monitor.integrations.ib_clients import (
    AccountIbClient,
    OperatorIbClient,
    SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
)

logger = logging.getLogger(__name__)


def _build_clients(config: Dict[str, Any]) -> IbOperatorExecutor:
    ib_cfg = get_effective_ib_config(config)
    host = ib_cfg["host"]
    port = int(ib_cfg["port"])
    primary = OperatorIbClient(
        host=host,
        port=port,
        client_id=ib_cfg["client_id_operator"],
        name="IbOperator",
    )
    ib2_host = ib_cfg.get("ib2_host") or ""
    acc2: Optional[AccountIbClient] = None
    if ib2_host:
        acc2 = AccountIbClient(
            host=ib2_host,
            port=ib_cfg["ib2_port"],
            client_id=ib_cfg["ib2_client_id_operator"],
            name="IbOperatorAccount2",
        )
    return IbOperatorExecutor(primary=primary, account_secondary=acc2)


def _write_health_sync(
    r: redis.Redis,
    executor: IbOperatorExecutor,
    key: str,
    probe_interval_sec: float,
    tracker: Optional[IbConnectionStatusTracker] = None,
    *,
    service_heartbeat_interval_sec: Optional[float] = None,
    last_service_heartbeat_at: Optional[float] = None,
    service_heartbeat_reconnect_in_progress: Optional[str] = None,
) -> None:
    try:
        asyncio.run(executor.record_ib_probe(probe_interval_sec))
    except Exception as e:
        logger.debug("IB Operator record_ib_probe: %s", e)
    h = executor.health_dict()
    now = time.time()
    h["updated_at"] = now
    if service_heartbeat_reconnect_in_progress is not None:
        h["service_heartbeat_reconnect_in_progress"] = service_heartbeat_reconnect_in_progress
    if service_heartbeat_interval_sec is not None and last_service_heartbeat_at is not None:
        iv = float(service_heartbeat_interval_sec)
        lh = float(last_service_heartbeat_at)
        h["service_heartbeat_interval_sec"] = iv
        h["last_service_heartbeat_at"] = lh
        h["next_service_heartbeat_in_s"] = max(0.0, lh + iv - now) if lh > 0 else iv
    mapping = operator_health_dict_to_redis_hash(h)
    try:
        # Do not DELETE the hash: prune_legacy_operator_health_hash_fields uses HDEL for old fields.
        # Ops control fields (bifrost_ops_control_env/host) live on this health hash.
        # HSET merges fields, so heartbeat refresh preserves HOST while updating liveness.
        r.hset(key, mapping=mapping)
        prune_legacy_operator_health_hash_fields(r, key)
        r.expire(key, HEALTH_HASH_TTL_SEC)
    except Exception as e:
        logger.warning("write health key failed: %s", e)
    _publish_operator_status_messages(tracker, h)


def _publish_operator_status_messages(
    tracker: Optional[IbConnectionStatusTracker],
    health_dict: Dict[str, Any],
) -> None:
    if tracker is None:
        return
    host = health_dict.get("host") if isinstance(health_dict.get("host"), dict) else {}
    tracker.update(
        slot="host",
        status="connected" if bool(host.get("connected")) else "disconnected",
        client_id=int(host.get("client_id") or 0) or None,
        occurred_at=float(health_dict.get("updated_at") or time.time()),
        reason=(str(host.get("last_error")).strip() or None) if host.get("last_error") is not None else None,
    )
    secondary = health_dict.get("secondary")
    if isinstance(secondary, dict):
        tracker.update(
            slot="secondary",
            status="connected" if bool(secondary.get("connected")) else "disconnected",
            client_id=int(secondary.get("client_id") or 0) or None,
            occurred_at=float(health_dict.get("updated_at") or time.time()),
            reason=(str(secondary.get("last_error")).strip() or None)
            if secondary.get("last_error") is not None
            else None,
        )


def _write_shutdown_health_sync(
    r: redis.Redis,
    executor: IbOperatorExecutor,
    key: str,
    tracker: Optional[IbConnectionStatusTracker] = None,
) -> None:
    """Publish final Redis health before process exit so /status and Socket Services update immediately."""
    h = executor.health_dict()
    for slot in ("host", "secondary"):
        sub = h.get(slot)
        if isinstance(sub, dict):
            h[slot] = {**sub, "connected": False}
    h["service_alive"] = False
    h["updated_at"] = time.time()
    mapping = operator_health_dict_to_redis_hash(h)
    try:
        r.hset(key, mapping=mapping)
        prune_legacy_operator_health_hash_fields(r, key)
    except Exception as e:
        logger.warning("write shutdown health failed: %s", e)
    _publish_operator_status_messages(tracker, h)


async def _handle_message(
    executor: IbOperatorExecutor,
    msg: CommandMessage,
) -> Dict[str, Any]:
    try:
        return await executor.execute(msg.op, msg.payload)
    except Exception as e:
        logger.warning(
            "execute op=%s req_id=%s caller=%s: %s",
            msg.op,
            msg.req_id,
            msg.caller,
            e,
            exc_info=True,
        )
        return {"ok": False, "error": str(e)}


def run_ib_operator_loop(
    config: Dict[str, Any],
    *,
    stop_event: Optional[threading.Event] = None,
    redis_client: Optional[redis.Redis] = None,
) -> None:
    """Block until ``stop_event`` is set (if provided). Creates IB clients and consumes Redis."""
    ops_profile = ops_profile_from_config(config)
    settings = effective_ib_operator_settings(config)
    if not settings["enabled"]:
        logger.error("IB Operator disabled in config (ib_operator.enabled=false or no Redis URL)")
        return
    rurl = settings["redis_url"]
    if not rurl:
        logger.error("IB Operator requires Redis (redis.enabled or realtime)")
        return

    stream = settings["stream"]
    group = settings["consumer_group"]
    cons = consumer_name()
    block_ms = settings["block_ms"]
    result_ttl = settings["result_ttl_sec"]
    result_prefix = settings["result_prefix"]
    max_bytes = settings["max_result_bytes"]
    health_key = settings["health_key"]
    ib_eff = get_effective_ib_config(config)
    probe_iv = float(ib_eff["ib_probe_interval_sec"])
    ib_op_yaml = config.get("ib_operator")
    ib_op_yaml = ib_op_yaml if isinstance(ib_op_yaml, dict) else {}
    health_refresh = operator_effective_health_refresh_sec(ib_op_yaml, probe_iv)

    r = redis_client or redis.from_url(rurl, decode_responses=True)
    ensure_stream_and_group(r, stream, group)
    executor = _build_clients(config)
    tracker = IbConnectionStatusTracker(r, service="ib_operator")
    runner = OperatorRedisRunner(r, stream, group, cons, block_ms)

    logger.info(
        "IB Operator started stream=%s group=%s consumer=%s",
        stream,
        group,
        cons,
    )

    # Publish Redis health before blocking on IB connect. Otherwise Ops may HSET only
    # bifrost_ops_control_env on this key after systemd start while connect_all() retries
    # TWS for a long time — leaving a hash with no host_* fields until connect returns.
    last_service_heartbeat_at = time.time()
    _write_health_sync(
        r,
        executor,
        health_key,
        probe_iv,
        tracker,
        service_heartbeat_interval_sec=health_refresh,
        last_service_heartbeat_at=last_service_heartbeat_at,
    )

    try:
        asyncio.run(executor.connect_all())
    except Exception as e:
        logger.warning("IB Operator initial connect failed (will retry on demand): %s", e)

    _write_health_sync(
        r,
        executor,
        health_key,
        probe_iv,
        tracker,
        service_heartbeat_interval_sec=health_refresh,
        last_service_heartbeat_at=last_service_heartbeat_at,
    )
    stop = stop_event or threading.Event()

    def should_stop() -> bool:
        return stop.is_set()

    while not should_stop():
        now = time.time()
        if now - last_service_heartbeat_at >= health_refresh:
            # Service heartbeat: one reconnect attempt per tick (no inner retry storm); failures wait for next tick.
            hd_try = executor.health_dict()
            host_ok = bool((hd_try.get("host") or {}).get("connected"))
            if not host_ok:
                # One attempt per slot; failures are isolated (Secondary is still attempted afterward).
                # No Message Center "reconnecting" events here — connected/disconnected come from Redis health after _write_health_sync.
                _hid = int((hd_try.get("host") or {}).get("client_id") or 0)
                _write_health_sync(
                    r,
                    executor,
                    health_key,
                    probe_iv,
                    tracker,
                    service_heartbeat_interval_sec=health_refresh,
                    last_service_heartbeat_at=last_service_heartbeat_at,
                    service_heartbeat_reconnect_in_progress=f"Host (client {_hid})",
                )
                async def _hb_host() -> None:
                    await asyncio.wait_for(
                        executor.connect_primary_only(max_connect_attempts=1),
                        timeout=SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                    )

                try:
                    asyncio.run(_hb_host())
                except asyncio.TimeoutError:
                    logger.debug(
                        "IB Operator service heartbeat Host connect timed out after %.0fs",
                        SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                    )
                except Exception as e:
                    logger.debug("IB Operator service heartbeat Host connect: %s", e)
                finally:
                    _write_health_sync(
                        r,
                        executor,
                        health_key,
                        probe_iv,
                        tracker,
                        service_heartbeat_interval_sec=health_refresh,
                        last_service_heartbeat_at=last_service_heartbeat_at,
                        service_heartbeat_reconnect_in_progress="",
                    )
            hd_sec = executor.health_dict()
            sec_block = hd_sec.get("secondary")
            if isinstance(sec_block, dict) and not bool(sec_block.get("connected")):
                _sid = int(sec_block.get("client_id") or 0)
                _write_health_sync(
                    r,
                    executor,
                    health_key,
                    probe_iv,
                    tracker,
                    service_heartbeat_interval_sec=health_refresh,
                    last_service_heartbeat_at=last_service_heartbeat_at,
                    service_heartbeat_reconnect_in_progress=f"Secondary (client {_sid})",
                )
                async def _hb_secondary() -> None:
                    await asyncio.wait_for(
                        executor.connect_secondary_only(max_connect_attempts=1),
                        timeout=SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                    )

                try:
                    asyncio.run(_hb_secondary())
                except asyncio.TimeoutError:
                    logger.debug(
                        "IB Operator service heartbeat Secondary connect timed out after %.0fs",
                        SERVICE_HEARTBEAT_CONNECT_TIMEOUT_SEC,
                    )
                except Exception as e:
                    logger.debug("IB Operator service heartbeat Secondary connect: %s", e)
                finally:
                    _write_health_sync(
                        r,
                        executor,
                        health_key,
                        probe_iv,
                        tracker,
                        service_heartbeat_interval_sec=health_refresh,
                        last_service_heartbeat_at=last_service_heartbeat_at,
                        service_heartbeat_reconnect_in_progress="",
                    )
            last_service_heartbeat_at = now
            _write_health_sync(
                r,
                executor,
                health_key,
                probe_iv,
                tracker,
                service_heartbeat_interval_sec=health_refresh,
                last_service_heartbeat_at=last_service_heartbeat_at,
                service_heartbeat_reconnect_in_progress="",
            )
            maintain_health_host(r, health_key, ops_profile)

        entries = []
        try:
            reply = xreadgroup_recover_nogroup(
                r,
                group,
                cons,
                {stream: "0"},
                count=1,
                block=0,
                stream_name=stream,
                group_name=group,
            )
            entries = parse_xreadgroup_reply(reply)
        except Exception as e:
            logger.warning("xreadgroup pending (stream=%s): %s", stream, e)

        if not entries and not should_stop():
            entries = runner.read_new()

        if not entries:
            continue

        for entry_id, fields in entries:
            if should_stop():
                break
            msg, perr = parse_stream_fields(fields, stream_id=entry_id)
            rk = result_key(result_prefix, msg.req_id if msg else "invalid")

            if perr or msg is None:
                logger.warning("Bad operator message id=%s: %s", entry_id, perr)
                err_body, _ = dumps_result({"ok": False, "error": perr or "parse"}, max_bytes=max_bytes)
                if msg and msg.req_id:
                    write_result(r, rk, err_body or "{}", ttl_sec=result_ttl)
                ack_message(r, stream, group, entry_id)
                continue

            if msg.is_expired():
                err_body, enc_err = dumps_result(
                    {"ok": False, "error": "deadline_expired"},
                    max_bytes=max_bytes,
                )
                if enc_err:
                    err_body = '{"ok":false,"error":"deadline_expired"}'
                write_result(r, rk, err_body or "{}", ttl_sec=result_ttl)
                ack_message(r, stream, group, entry_id)
                continue

            outcome = asyncio.run(_handle_message(executor, msg))
            body, enc_err = dumps_result(outcome, max_bytes=max_bytes)
            if enc_err:
                body, _ = dumps_result(
                    {"ok": False, "error": enc_err},
                    max_bytes=max_bytes,
                )
            write_result(r, rk, body or '{"ok":false,"error":"encode"}', ttl_sec=result_ttl)
            ack_message(r, stream, group, entry_id)
            executor.note_cmd_processed()
            _write_health_sync(
                r,
                executor,
                health_key,
                probe_iv,
                tracker,
                service_heartbeat_interval_sec=health_refresh,
                last_service_heartbeat_at=last_service_heartbeat_at,
            )

    logger.info("IB Operator stopping: disconnecting IB clients")
    try:
        asyncio.run(executor.disconnect_all())
    except Exception as e:
        logger.warning("disconnect on shutdown: %s", e)
    _write_shutdown_health_sync(r, executor, health_key, tracker)
