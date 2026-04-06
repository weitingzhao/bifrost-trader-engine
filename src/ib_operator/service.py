"""IB Operator main loop: Redis Stream consumer + IB executor."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Dict, Optional

import redis

from src.app.config import get_effective_ib_config
from src.ib_operator.config import effective_ib_operator_settings
from src.ib_operator.executor import IbOperatorExecutor
from src.ib_operator.health_redis import operator_health_dict_to_redis_hash
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
from src.monitor.integrations.ib_clients import AccountIbClient, OperatorIbClient

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


def _write_health_sync(r: redis.Redis, executor: IbOperatorExecutor, key: str, ex_sec: int) -> None:
    h = executor.health_dict()
    h["updated_at"] = time.time()
    mapping = operator_health_dict_to_redis_hash(h)
    try:
        # Do not DELETE the hash: Ops stores bifrost_ops_control_env on the same key
        # (Socket Services Host column). Replacing the key would drop the lease after
        # the first health refresh.
        pipe = r.pipeline()
        pipe.hset(key, mapping=mapping)
        if ex_sec > 0:
            pipe.expire(key, ex_sec)
        pipe.execute()
    except Exception as e:
        logger.warning("write health key failed: %s", e)


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
    health_refresh = settings["health_refresh_sec"]
    health_ex = max(int(health_refresh * 4), 60)

    r = redis_client or redis.from_url(rurl, decode_responses=True)
    ensure_stream_and_group(r, stream, group)
    executor = _build_clients(config)
    runner = OperatorRedisRunner(r, stream, group, cons, block_ms)

    logger.info(
        "IB Operator started stream=%s group=%s consumer=%s",
        stream,
        group,
        cons,
    )

    try:
        asyncio.run(executor.connect_all())
    except Exception as e:
        logger.warning("IB Operator initial connect failed (will retry on demand): %s", e)

    _write_health_sync(r, executor, health_key, health_ex)
    last_health = time.time()
    stop = stop_event or threading.Event()

    def should_stop() -> bool:
        return stop.is_set()

    while not should_stop():
        now = time.time()
        if now - last_health >= health_refresh:
            _write_health_sync(r, executor, health_key, health_ex)
            last_health = now

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
            _write_health_sync(r, executor, health_key, health_ex)
            last_health = time.time()

    logger.info("IB Operator stopping: disconnecting IB clients")
    try:
        asyncio.run(executor.disconnect_all())
    except Exception as e:
        logger.warning("disconnect on shutdown: %s", e)
