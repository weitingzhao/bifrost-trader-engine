from backend.research.routers.option_discovery import router as option_discovery_router
from backend.research.routers.max_pain import router as max_pain_router
from backend.research.routers.stream import router as research_stream_router
from backend.research.routers.routes import router as research_routes_router

__all__ = [
    "option_discovery_router",
    "max_pain_router",
    "research_stream_router",
    "research_routes_router",
]
