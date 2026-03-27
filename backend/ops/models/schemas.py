"""Pydantic models for the Ops control plane API (worker state, scaling, audit)."""

from __future__ import annotations

import enum
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── Enums ─────────────────────────────────────────────────────────────────────


class WorkerStatus(str, enum.Enum):
    RUNNING_HEALTHY = "running_healthy"
    RUNNING_DEGRADED = "running_degraded"
    STARTING = "starting"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"
    UNKNOWN = "unknown"


class ScaleAction(str, enum.Enum):
    ADD = "add"
    REMOVE = "remove"


class BrokerAction(str, enum.Enum):
    START = "start"
    STOP = "stop"
    RESTART = "restart"



# ── Worker models ─────────────────────────────────────────────────────────────


class WorkerSummary(BaseModel):
    worker_id: str
    status: WorkerStatus
    queues: List[str] = []
    concurrency: int = 0
    active_tasks: int = 0
    reserved_tasks: int = 0
    last_heartbeat: Optional[float] = None


class WorkerDetail(WorkerSummary):
    pool_type: Optional[str] = None
    prefetch_count: Optional[int] = None
    active_task_list: List[Dict[str, Any]] = []
    reserved_task_list: List[Dict[str, Any]] = []
    stats: Dict[str, Any] = {}



# ── Queue / Scale / Broker request models ────────────────────────────────────


class ScaleRequest(BaseModel):
    action: ScaleAction
    instance_id: Optional[str] = None
    worker_type: Optional[str] = None
    queues: List[str] = Field(default_factory=list)


class BrokerControlRequest(BaseModel):
    action: BrokerAction


# ── Audit ─────────────────────────────────────────────────────────────────────


class AuditEntry(BaseModel):
    timestamp: float = Field(default_factory=time.time)
    operator: str = "unknown"
    source_ip: Optional[str] = None
    action: str
    target: str
    command_id: Optional[str] = None
    outcome: str
    detail: Optional[str] = None
