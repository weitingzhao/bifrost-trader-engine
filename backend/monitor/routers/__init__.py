"""Domain-based API routers for the monitor FastAPI app (core 5)."""

from backend.monitor.routers.core import router as core_router
from backend.monitor.routers.logs import router as logs_router
from backend.monitor.routers.messages import router as messages_router
from backend.monitor.routers.status import router as status_router
from backend.monitor.routers.daemon import router as daemon_router
from backend.monitor.routers.config import router as config_router

__all__ = [
    "core_router",
    "logs_router",
    "messages_router",
    "status_router",
    "daemon_router",
    "config_router",
]
