"""Process-agnostic IB API wrapper shared by daemon, monitor, and workers."""

from .ib import IBConnector

__all__ = ["IBConnector"]
