from datetime import date, timedelta

from src.research.sepa.phase1_engine import Phase1Config, evaluate_symbol_phase1


def _build_rows(days: int = 260):
    base = date(2025, 1, 1)
    rows = []
    price = 100.0
    for i in range(days):
        d = base + timedelta(days=i)
        price += 0.3
        rows.append(
            {
                "bar_time": d,
                "open": price - 0.5,
                "high": price + 1.0,
                "low": price - 1.0,
                "close": price,
                "volume": 220_000.0,
            }
        )
    return rows


def test_evaluate_symbol_phase1_happy_path():
    rows = _build_rows(270)
    out = evaluate_symbol_phase1("NVDA", rows)
    assert out["symbol"] == "NVDA"
    assert out["insufficient_data"] is False
    assert isinstance(out["conditions"], list)
    assert len(out["conditions"]) == 10
    assert out["pass_count"] >= 8


def test_evaluate_symbol_phase1_insufficient_data():
    rows = _build_rows(80)
    out = evaluate_symbol_phase1("AAPL", rows)
    assert out["technical_pass"] is False
    assert out["insufficient_data"] is True
    assert "insufficient" in (out.get("error") or "")


def test_evaluate_symbol_phase1_strict_sma200_rising():
    rows = _build_rows(280)
    cfg = Phase1Config(strict_sma200_rising=True)
    out = evaluate_symbol_phase1("MSFT", rows, cfg=cfg)
    cond = {c["id"]: c for c in out["conditions"]}
    assert "sma200_rising_1m" in cond
    assert isinstance(cond["sma200_rising_1m"]["pass"], bool)

