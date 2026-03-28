"""Compatibility shim: ``servers.reader`` resolves submodules from ``src/portfolio/reader`` then ``src/monitor/reader``."""

from pathlib import Path

_pkg_dir = Path(__file__).resolve().parent
_root = _pkg_dir.parent.parent
_impl_pf = _root / "src" / "portfolio" / "reader"
_impl = _root / "src" / "monitor" / "reader"
__path__.clear()
__path__.append(str(_pkg_dir))
__path__.append(str(_impl_pf))
__path__.append(str(_impl))

from src.monitor.reader import *  # noqa: F403
from src.monitor.reader import __all__ as __all__
