from src.research.sepa.fundamentals_engine import evaluate_fundamentals


def _q(fy: int, fp: str, eps: float, rev: float):
    return {
        "fiscal_year": fy,
        "fiscal_period": fp,
        "basic_earnings_per_share": eps,
        "revenues": rev,
    }


def _a(fy: int, eps: float, rev: float):
    return {
        "fiscal_year": fy,
        "basic_earnings_per_share": eps,
        "revenues": rev,
    }


def test_fundamentals_all_pass():
    qrows = [
        _q(2023, "Q1", 1.00, 100.0),
        _q(2023, "Q2", 1.10, 105.0),
        _q(2023, "Q3", 1.20, 110.0),
        _q(2024, "Q1", 1.30, 130.0),  # +30%
        _q(2024, "Q2", 1.50, 138.0),  # +36%
        _q(2024, "Q3", 1.70, 150.0),  # +36.4%
    ]
    arows = [
        _a(2021, 1.00, 100.0),
        _a(2022, 1.20, 120.0),
        _a(2023, 1.50, 145.0),
        _a(2024, 2.00, 180.0),
    ]
    out = evaluate_fundamentals(qrows, arows)
    assert out["fundamental_pass"] is True
    assert out["pass_count"] == 8
    assert out["fail_count"] == 0


def test_fundamentals_insufficient_data():
    qrows = [_q(2024, "Q1", 1.0, 100.0), _q(2025, "Q1", 1.1, 110.0)]
    arows = [_a(2024, 1.0, 100.0), _a(2025, 1.1, 110.0)]
    out = evaluate_fundamentals(qrows, arows)
    assert out["insufficient_data"] is True
    assert out["fundamental_pass"] is False
    assert out["fail_count"] >= 1


def test_fundamentals_negative_eps_base_not_comparable():
    qrows = [
        _q(2023, "Q1", -0.5, 100.0),
        _q(2024, "Q1", 0.5, 130.0),
        _q(2023, "Q2", -0.4, 105.0),
        _q(2024, "Q2", 0.8, 140.0),
    ]
    arows = [
        _a(2021, -1.0, 100.0),
        _a(2022, 0.5, 120.0),
        _a(2023, 0.8, 140.0),
        _a(2024, 1.2, 170.0),
    ]
    out = evaluate_fundamentals(qrows, arows)
    assert out["not_comparable"] is True
    assert "not_comparable_negative_base" in out["issues"]

