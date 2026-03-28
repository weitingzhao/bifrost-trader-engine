"""Domain-based API routers for the monitor FastAPI app."""

from backend.monitor.routers.core import router as core_router
from backend.monitor.routers.quotes import router as quotes_router
from backend.monitor.routers.logs import router as logs_router
from backend.monitor.routers.status import router as status_router
from backend.monitor.routers.executions import router as executions_router
from backend.monitor.routers.market import router as market_router
from backend.monitor.routers.watchlist import router as watchlist_router
from backend.monitor.routers.research import router as research_router
from backend.monitor.routers.reports import router as reports_router
from backend.monitor.routers.daemon import router as daemon_router
from backend.monitor.routers.config import router as config_router
from backend.monitor.routers.strategies import router as strategies_router
from backend.monitor.routers.portfolio_model import router as portfolio_model_router

__all__ = [
    "core_router",
    "quotes_router",
    "logs_router",
    "status_router",
    "executions_router",
    "market_router",
    "watchlist_router",
    "research_router",
    "reports_router",
    "daemon_router",
    "config_router",
    "strategies_router",
    "portfolio_model_router",
]
