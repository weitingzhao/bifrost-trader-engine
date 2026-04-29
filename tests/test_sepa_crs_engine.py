from datetime import date, timedelta

from src.research.sepa.crs_engine import CRS_VERSION, compute_crs_scores


def _series(start_close: float, step: float, days: int = 270):
    base = date(2025, 1, 1)
    rows = []
    p = start_close
    for i in range(days):
        p += step
        rows.append({"bar_time": base + timedelta(days=i), "close": p})
    return rows


def test_crs_scores_sorted_and_percentile():
    rows = {
        "AAA": _series(100, 0.40),  # strongest
        "BBB": _series(100, 0.20),
        "CCC": _series(100, -0.05),  # weakest
    }
    out = compute_crs_scores(rows)
    assert out["crs_version"] == CRS_VERSION
    by_sym = {r["symbol"]: r for r in out["results"]}
    assert by_sym["AAA"]["crs_score"] > by_sym["BBB"]["crs_score"] > by_sym["CCC"]["crs_score"]
    assert out["summary"]["universe_size"] == 3


def test_crs_scores_tie_handling():
    rows = {
        "AAA": _series(100, 0.20),
        "BBB": _series(100, 0.20),
        "CCC": _series(100, -0.10),
    }
    out = compute_crs_scores(rows)
    by_sym = {r["symbol"]: r for r in out["results"]}
    assert by_sym["AAA"]["crs_score"] == by_sym["BBB"]["crs_score"]
    assert by_sym["CCC"]["crs_score"] < by_sym["AAA"]["crs_score"]


def test_crs_insufficient_data_and_min_filter():
    rows = {
        "AAA": _series(100, 0.25, 300),
        "BBB": _series(100, 0.05, 200),  # insufficient
    }
    out = compute_crs_scores(rows, min_crs=70)
    by_sym = {r["symbol"]: r for r in out["results"]}
    assert by_sym["BBB"]["insufficient_data"] is True
    assert by_sym["BBB"]["pass"] is False
    assert by_sym["AAA"]["insufficient_data"] is False
    assert isinstance(by_sym["AAA"]["pass"], bool)

