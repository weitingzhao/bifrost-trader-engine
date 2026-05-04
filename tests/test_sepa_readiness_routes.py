from types import SimpleNamespace

from backend.research.routers import sepa_readiness as router


def _fake_request() -> SimpleNamespace:
    app = SimpleNamespace(state=SimpleNamespace(control_via_db={"postgres": {}}, status_cfg_for_read=None))
    return SimpleNamespace(app=app)


def test_get_summary_no_db(monkeypatch):
    monkeypatch.setattr(router, "fetch_sepa_readiness_summary", lambda _db: {"ok": True, "universe_count": 3})
    out = router.get_sepa_readiness_summary(_fake_request())
    assert out["ok"] is True
    assert out["universe_count"] == 3


def test_get_summary_missing_config():
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(control_via_db=None, status_cfg_for_read=None)))
    out = router.get_sepa_readiness_summary(req)
    assert out["ok"] is False


def test_post_snapshot(monkeypatch):
    monkeypatch.setattr(
        router,
        "run_sepa_universe_readiness_snapshot",
        lambda _db: {"ok": True, "rows_affected": 10, "elapsed_ms": 5},
    )
    out = router.post_sepa_readiness_snapshot(_fake_request())
    assert out["ok"] is True
    assert out["rows_affected"] == 10
