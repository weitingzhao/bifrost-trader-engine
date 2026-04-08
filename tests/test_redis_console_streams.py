"""Redis console stream key constants."""

from src.bifrost.redis_console_streams import BIFROST_CONSOLE_DAEMON_TRADING


def test_daemon_trading_console_stream_under_bifrost_console() -> None:
    assert BIFROST_CONSOLE_DAEMON_TRADING == "bifrost:console:daemon_trading"
