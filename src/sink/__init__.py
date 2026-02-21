"""Status sink package: persist state snapshot and operations (Phase 1: PostgreSQL)."""

from src.sink.base import OPERATION_KEYS, SNAPSHOT_KEYS, StatusSink

# Lazy import so the package loads without psycopg2 (e.g. scripts/check/phase1.py --skip-db)
def __getattr__(name: str):
    if name == "PostgreSQLSink":
        from src.sink.postgres_sink import PostgreSQLSink
        return PostgreSQLSink
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "StatusSink",
    "PostgreSQLSink",
    "SNAPSHOT_KEYS",
    "OPERATION_KEYS",
]
