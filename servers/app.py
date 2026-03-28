"""Shim: status FastAPI app lives in ``backend.monitor.app``."""

from backend.monitor.app import create_app, run_server

__all__ = ["create_app", "run_server"]
