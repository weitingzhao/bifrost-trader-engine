"""Worker profile registry and instance-ID allocator.

Profiles live in YAML under ``ops.worker_profiles``.  Each key maps to a label
and a list of Celery queues the worker consumes.

Instance IDs follow ``{profile_key}-{seq}`` (e.g. ``stocks_ib-1``, ``options_massive-3``).
Sequence numbers are allocated atomically via Redis INCR; when Redis is
unavailable the allocator falls back to max(existing) + 1.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

_PROFILE_KEY_RE = re.compile(r"^[a-zA-Z0-9_]+$")
INSTANCE_ID_RE = re.compile(r"^(?P<profile>[a-zA-Z0-9_]+)-(?P<seq>\d+)$")
_REDIS_SEQ_PREFIX = "bifrost:ops:worker_instance_seq:"


@dataclass
class WorkerProfile:
    key: str
    label: str
    queues: List[str]


@dataclass
class WorkerProfileRegistry:
    profiles: Dict[str, WorkerProfile] = field(default_factory=dict)

    @classmethod
    def from_config(cls, config: dict) -> "WorkerProfileRegistry":
        ops = config.get("ops") or {}
        raw = ops.get("worker_profiles") or {}
        profiles: Dict[str, WorkerProfile] = {}
        for key, entry in raw.items():
            if not _PROFILE_KEY_RE.match(key):
                logger.warning("Ignoring worker_profile with invalid key %r", key)
                continue
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("label", key))
            queues = entry.get("queues") or []
            if isinstance(queues, str):
                queues = [queues]
            queues = [str(q).strip() for q in queues if str(q).strip()]
            if not queues:
                logger.warning("worker_profile %r has no queues; skipping", key)
                continue
            profiles[key] = WorkerProfile(key=key, label=label, queues=queues)
        return cls(profiles=profiles)

    def get(self, key: str) -> Optional[WorkerProfile]:
        return self.profiles.get(key)

    def list_profiles(self) -> List[Dict[str, object]]:
        return [
            {"key": p.key, "label": p.label, "queues": list(p.queues)}
            for p in self.profiles.values()
        ]


def allocate_instance_id(
    profile_key: str,
    broker_url: str,
    existing_units: Optional[List[str]] = None,
) -> str:
    """Return the next ``{profile_key}-{seq}`` ID.

    Primary: Redis INCR on ``bifrost:ops:worker_instance_seq:{profile_key}``.
    Fallback: parse *existing_units* for the highest seq with the same prefix.
    """
    seq = _allocate_via_redis(profile_key, broker_url)
    if seq is not None:
        return f"{profile_key}-{seq}"

    return _allocate_via_scan(profile_key, existing_units or [])


def _allocate_via_redis(profile_key: str, broker_url: str) -> Optional[int]:
    try:
        import redis as _redis

        r = _redis.from_url(broker_url, socket_connect_timeout=3, socket_timeout=3)
        seq = r.incr(f"{_REDIS_SEQ_PREFIX}{profile_key}")
        return int(seq)
    except Exception as exc:
        logger.warning("Redis INCR for worker seq failed (%s); falling back to scan", exc)
        return None


def _allocate_via_scan(profile_key: str, existing_units: List[str]) -> str:
    prefix = f"{profile_key}-"
    max_seq = 0
    for u in existing_units:
        # unit string may be "bifrost-celery-worker@bars-2.service"
        at = u.find("@")
        dot = u.rfind(".service")
        if at >= 0:
            iid = u[at + 1 : dot if dot > at else len(u)]
        else:
            iid = u
        if iid.startswith(prefix):
            try:
                seq = int(iid[len(prefix) :])
                max_seq = max(max_seq, seq)
            except ValueError:
                pass
    return f"{profile_key}-{max_seq + 1}"
