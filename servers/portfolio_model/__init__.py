"""Compatibility shim: ``servers.portfolio_model`` resolves submodules from ``src/portfolio/model``."""

from pathlib import Path

_pkg_dir = Path(__file__).resolve().parent
_impl = _pkg_dir.parent.parent / "src" / "portfolio" / "model"
__path__.clear()
__path__.append(str(_pkg_dir))
__path__.append(str(_impl))

from src.portfolio.model import *  # noqa: F403
from src.portfolio.model import __all__ as __all__
