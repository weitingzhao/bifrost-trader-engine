"""Process-agnostic IB integrations shared by daemon, monitor, and workers.

- TWS / Gateway: :class:`IBConnector` in :mod:`src.connector.ib` (default export below).
- Flex Web Service (HTTPS/XML): import explicitly from :mod:`src.connector.flex_client`
  (not re-exported here to avoid loading urllib/xml on ``from src.connector import IBConnector``).
"""

from .ib import IBConnector

__all__ = ["IBConnector"]
