"""Compatibility re-exports for StatusSink; PostgreSQL implementation lives in src.persistence."""

from typing import TYPE_CHECKING

from src.persistence.status_sink import OPERATION_KEYS, SNAPSHOT_KEYS, StatusSink

if TYPE_CHECKING:
    from src.persistence.postgres.postgres_sink import PostgreSQLSink


def __getattr__(name: str):
    if name == "PostgreSQLSink":
        from src.persistence.postgres.postgres_sink import PostgreSQLSink

        return PostgreSQLSink
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "StatusSink",
    "PostgreSQLSink",
    "SNAPSHOT_KEYS",
    "OPERATION_KEYS",
]
