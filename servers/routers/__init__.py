"""Domain-based API routers. Each module exposes a single `router` (APIRouter)."""

from servers.routers.core import router as core_router
from servers.routers.quotes import router as quotes_router
from servers.routers.logs import router as logs_router
from servers.routers.status import router as status_router
from servers.routers.executions import router as executions_router
from servers.routers.market import router as market_router
from servers.routers.watchlist import router as watchlist_router
from servers.routers.daemon import router as daemon_router
from servers.routers.config import router as config_router

__all__ = [
    "core_router",
    "quotes_router",
    "logs_router",
    "status_router",
    "executions_router",
    "market_router",
    "watchlist_router",
    "daemon_router",
    "config_router",
]
