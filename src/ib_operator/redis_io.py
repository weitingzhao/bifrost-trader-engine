"""Redis Stream helpers for IB Operator (sync API)."""

from __future__ import annotations

import logging
import socket
from typing import Any, Dict, List, Tuple

from redis.exceptions import ResponseError

logger = logging.getLogger(__name__)


def is_nogroup_error(exc: BaseException) -> bool:
    """True if Redis replied NOGROUP (stream missing or consumer group missing)."""
    return "nogroup" in str(exc).lower()


def xreadgroup_recover_nogroup(
    r: Any,
    group: str,
    consumer: str,
    streams: Dict[str, str],
    *,
    count: int,
    block: int,
    stream_name: str,
    group_name: str,
) -> Any:
    """XREADGROUP; on NOGROUP recreate group via ensure_stream_and_group and retry once."""
    try:
        return r.xreadgroup(group, consumer, streams, count=count, block=block)
    except ResponseError as e:
        if not is_nogroup_error(e):
            raise
        logger.warning(
            "Redis NOGROUP on stream=%s group=%s (%s); recreating consumer group.",
            stream_name,
            group_name,
            e,
        )
        ensure_stream_and_group(r, stream_name, group_name)
        return r.xreadgroup(group, consumer, streams, count=count, block=block)


def ensure_stream_and_group(
    r: Any,
    stream: str,
    group: str,
    *,
    mkstream: bool = True,
) -> None:
    """Create consumer group if missing."""
    try:
        r.xgroup_create(stream, group, id="0", mkstream=mkstream)
        logger.info("Created Redis stream group %s on %s", group, stream)
    except Exception as e:
        err = str(e).lower()
        if "busygroup" in err or "already exists" in err:
            return
        logger.warning("xgroup_create %s: %s", stream, e)
        raise


def parse_xreadgroup_reply(
    reply: Any,
) -> List[Tuple[str, Dict[str, str]]]:
    """Normalize xreadgroup reply to [(stream_id, {field: str}), ...]."""
    out: List[Tuple[str, Dict[str, str]]] = []
    if not reply:
        return out
    for _stream_name, entries in reply:
        if not entries:
            continue
        for entry_id, fields in entries:
            fd: Dict[str, str] = {}
            if isinstance(fields, dict):
                for k, v in fields.items():
                    fd[str(k)] = v if isinstance(v, str) else str(v)
            elif isinstance(fields, (list, tuple)):
                it = iter(fields)
                for k in it:
                    v = next(it, None)
                    fd[str(k)] = v if isinstance(v, str) else str(v)
            out.append((str(entry_id), fd))
    return out


def consumer_name() -> str:
    return f"{socket.gethostname()}-{os_getpid()}"


def os_getpid() -> int:
    import os

    return os.getpid()


def write_result(
    r: Any,
    key: str,
    value: str,
    *,
    ttl_sec: int,
) -> None:
    if ttl_sec > 0:
        r.set(key, value, ex=ttl_sec)
    else:
        r.set(key, value)


def ack_message(r: Any, stream: str, group: str, stream_id: str) -> None:
    try:
        r.xack(stream, group, stream_id)
    except Exception as e:
        logger.warning("xack failed id=%s: %s", stream_id, e)


class OperatorRedisRunner:
    """Blocking XREADGROUP loop with PEL reclaim for stale deadlines."""

    def __init__(
        self,
        r: Any,
        stream: str,
        group: str,
        consumer: str,
        block_ms: int,
    ) -> None:
        self.r = r
        self.stream = stream
        self.group = group
        self.consumer = consumer
        self.block_ms = block_ms

    def read_pending_batch(self, count: int = 10) -> List[Tuple[str, Dict[str, str]]]:
        try:
            pend = self.r.xpending_range(
                self.stream,
                self.group,
                min="-",
                max="+",
                count=count,
                consumer=self.consumer,
            )
        except Exception as e:
            logger.debug("xpending_range: %s", e)
            return []
        out: List[Tuple[str, Dict[str, str]]] = []
        for p in pend or []:
            eid = p.get("message_id") or p.get(b"message_id")
            if eid is None:
                continue
            sid = eid.decode() if isinstance(eid, bytes) else str(eid)
            try:
                rows = self.r.xrange(self.stream, min=sid, max=sid, count=1)
            except Exception:
                continue
            if not rows:
                continue
            _eid, fields = rows[0]
            fd: Dict[str, str] = {}
            if isinstance(fields, dict):
                for k, v in fields.items():
                    fd[str(k)] = v if isinstance(v, str) else str(v)
            elif isinstance(fields, (list, tuple)):
                it = iter(fields)
                for k in it:
                    v = next(it, None)
                    fd[str(k)] = v if isinstance(v, str) else str(v)
            out.append((str(_eid), fd))
        return out

    def read_new(
        self,
    ) -> List[Tuple[str, Dict[str, str]]]:
        reply = xreadgroup_recover_nogroup(
            self.r,
            self.group,
            self.consumer,
            {self.stream: ">"},
            count=1,
            block=self.block_ms,
            stream_name=self.stream,
            group_name=self.group,
        )
        return parse_xreadgroup_reply(reply)
