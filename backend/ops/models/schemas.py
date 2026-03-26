"""Pydantic models for the Ops control plane API (commands, worker state, audit)."""

from __future__ import annotations

import enum
import time
import uuid
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


class CommandAction(str, enum.Enum):
    START = "start"
    STOP = "stop"
    RESTART = "restart"


class ScaleAction(str, enum.Enum):
    ADD = "add"
    REMOVE = "remove"


class BrokerAction(str, enum.Enum):
    START = "start"
    STOP = "stop"
    RESTART = "restart"


class CommandStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMEOUT = "timeout"


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


# ── Command models ────────────────────────────────────────────────────────────


class CommandRequest(BaseModel):
    action: CommandAction
    target_type: str = "worker"
    target_id: str
    reason: Optional[str] = None
    idempotency_key: Optional[str] = None


class CommandRecord(BaseModel):
    command_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    action: CommandAction
    target_type: str = "worker"
    target_id: str
    status: CommandStatus = CommandStatus.QUEUED
    reason: Optional[str] = None
    idempotency_key: Optional[str] = None
    operator: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


# ── Queue / Scale / Broker request models ────────────────────────────────────


class QueueControlRequest(BaseModel):
    add: List[str] = Field(default_factory=list)
    remove: List[str] = Field(default_factory=list)


class ScaleRequest(BaseModel):
    action: ScaleAction
    instance_id: str
    queues: List[str] = Field(default_factory=lambda: ["celery"])


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
