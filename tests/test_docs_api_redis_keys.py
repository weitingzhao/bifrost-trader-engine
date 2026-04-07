"""Redis console stream key helpers for Docs / Trading / Portfolio API logs."""

from src.app.config import docs_api_console_stream_key
from src.config.yaml_config import portfolio_api_console_stream_key, trading_api_console_stream_key


def test_docs_api_console_stream_key() -> None:
    assert docs_api_console_stream_key("prod") == "bifrost:console:prod:api_docs"
    assert docs_api_console_stream_key("dev") == "bifrost:console:dev:api_docs"
    assert docs_api_console_stream_key(None) == "bifrost:console:dev:api_docs"


def test_trading_portfolio_console_stream_keys() -> None:
    assert trading_api_console_stream_key("prod") == "bifrost:console:prod:api_trading"
    assert trading_api_console_stream_key(None) == "bifrost:console:dev:api_trading"
    assert portfolio_api_console_stream_key("prod") == "bifrost:console:prod:api_portfolio"
    assert portfolio_api_console_stream_key(None) == "bifrost:console:dev:api_portfolio"
