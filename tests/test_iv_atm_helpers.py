"""Unit tests for backend.research.iv_atm helpers (IV cone / rollup)."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

from backend.research.app import create_research_app
from backend.research.iv_atm import (
    assemble_volatility_cone_points,
    build_exp_iv_map,
    rollup_daily_ivs_by_expiration,
)

_FULL_SERVER = {
    "monitor_port": 8765,
    "massive_port": 8766,
    "docs_port": 8767,
    "ops_port": 8768,
    "trading_port": 8769,
    "strategy_port": 8770,
    "portfolio_port": 8771,
    "market_port": 8772,
    "research_port": 8773,
    "skip_monitor_ib": True,
}


def test_rollup_daily_ivs_by_expiration_sorts_by_date():
    rows = [
        {"expiry": "20991220", "trade_date": date(2099, 6, 3), "atm_iv": 0.5},
        {"expiry": "20991220", "trade_date": date(2099, 6, 1), "atm_iv": 0.3},
        {"expiry": "20991220", "trade_date": date(2099, 6, 2), "atm_iv": 0.4},
    ]
    out = rollup_daily_ivs_by_expiration(rows, ["20991220"], min_trade_date=date(2099, 6, 1))
    assert out["20991220"] == [0.3, 0.4, 0.5]


def test_assemble_volatility_cone_points_band_warns_when_few_samples():
    exp_list = ["20991220", "20991227"]
    last_price = 100.0
    exp_iv_cur_all = build_exp_iv_map([], {}, last_price)
    per_exp = {"20991220": [0.2] * 3, "20991227": [0.2] * 3}
    points, warns = assemble_volatility_cone_points(
        exp_list,
        last_price,
        exp_iv_cur_all,
        per_exp,
        min_samples_for_bands=5,
    )
    assert len(points) == 2
    assert len(warns) == 2


def test_iv_volatility_cone_rollupy_response():
    reader = MagicMock()
    reader._config = {"server": dict(_FULL_SERVER)}
    reader.get_stock_day_fallback_price.return_value = (100.0, 0.0, None)

    exp1, exp2 = "20991220", "20991227"

    def _report_rows():
        out = []
        for exp in (exp1, exp2):
            for i in range(6):
                out.append({
                    "expiry": exp,
                    "trade_date": date(2099, 1, i + 1),
                    "atm_iv": 0.25 + i * 0.01,
                    "iv_call": 0.24,
                    "iv_put": 0.26,
                    "strike": 100.0,
                    "underlying_price": 100.0,
                    "source": "massive",
                })
        return out

    with patch(
        "src.vendor.massive.reader.get_report_option_atm_iv_daily",
        return_value=_report_rows(),
    ), patch(
        "src.vendor.massive.reader.get_option_snapshots_eod_per_day",
        return_value=[],
    ), patch(
        "src.vendor.massive.reader.get_option_snapshots_latest",
        return_value=[],
    ):
        app = create_research_app(
            reader,
            control_via_db={"sink": "postgres", "postgres": {}},
            status_cfg_for_read={"sink": "postgres", "postgres": {}},
            merged_config={"server": dict(_FULL_SERVER), "postgres": {}, "sink": "postgres"},
        )
        client = TestClient(app, raise_server_exceptions=True)
        r = client.get(
            f"/research/iv-volatility-cone?symbol=TEST&expirations={exp1},{exp2}&source=massive&lookback_days=90",
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        assert body.get("rollup_used") is True
        assert len(body.get("points") or []) >= 1
