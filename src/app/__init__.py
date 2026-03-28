"""Shim: daemon implementation is under ``src.daemon.app``; YAML config via ``src.app.config``."""

from __future__ import annotations

from typing import Any

__all__ = ["GsTrading", "run_daemon"]


def __getattr__(name: str) -> Any:
    if name == "GsTrading":
        from src.daemon.app.gs_trading import GsTrading

        return GsTrading
    if name == "run_daemon":
        from src.daemon.app.entry import run_daemon

        return run_daemon
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
