"""Shared helpers for routers (e.g. Redis URL for log streams)."""

import logging
import os

logger = logging.getLogger(__name__)

DAEMON_LOG_STREAM_KEY = "bifrost:daemon_console"
SERVER_LOG_STREAM_KEY = "bifrost:server_console"
MASSIVE_LOG_STREAM_KEY = "bifrost:massive_console"
DOCS_LOG_STREAM_KEY = "bifrost:docs_console"


def daemon_log_redis_url() -> str:
    """Build Redis URL for daemon/server console stream from config/env. Falls back to local Redis."""
    try:
        from src.app.config import read_config

        config, _ = read_config()
        r = config.get("redis") or {}
    except Exception as e:
        logger.warning("read_config for daemon console failed: %s; using default Redis URL", e)
        r = {}
    host = (r.get("host") or os.environ.get("REDIS_HOST") or "127.0.0.1").strip()
    port = int(r.get("port") or os.environ.get("REDIS_PORT") or 6379)
    db = int(r.get("db") or os.environ.get("REDIS_DB") or 0)
    password = (r.get("password") or os.environ.get("REDIS_PASSWORD") or "").strip()
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"
