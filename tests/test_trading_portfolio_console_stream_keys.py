"""Trading / Portfolio API Redis console stream keys (bifrost:console:{dev|prod}:api_*)."""

from src.app.config import portfolio_api_console_stream_key, trading_api_console_stream_key


def test_trading_api_console_stream_key() -> None:
    assert trading_api_console_stream_key("prod") == "bifrost:console:prod:api_trading"
    assert trading_api_console_stream_key("dev") == "bifrost:console:dev:api_trading"
    assert trading_api_console_stream_key(None) == "bifrost:console:dev:api_trading"


def test_portfolio_api_console_stream_key() -> None:
    assert portfolio_api_console_stream_key("prod") == "bifrost:console:prod:api_portfolio"
    assert portfolio_api_console_stream_key("dev") == "bifrost:console:dev:api_portfolio"
    assert portfolio_api_console_stream_key(None) == "bifrost:console:dev:api_portfolio"
