"""Redis key names for IB ingestor (isolated from quote: / massive:)."""

from src.bifrost.redis_health_keys import BIFROST_HEALTH_IB_INGESTOR

IB_INGESTER_PREFIX = "ib:ingester"
IB_INGESTER_META_HEALTH = BIFROST_HEALTH_IB_INGESTOR
IB_INGESTER_META_SUBSCRIPTIONS = "ib:ingester:meta:subscriptions"
IB_INGESTER_CHANNEL = "ib:ingester:channel"
IB_INGESTER_TICK_PREFIX = "ib:ingester:tick:"
IB_INGESTER_TICK_TTL_SEC = 300
