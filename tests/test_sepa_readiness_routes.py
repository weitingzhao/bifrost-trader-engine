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


def test_post_sync_holidays(monkeypatch):
    fake_result = {"ok": True, "fetched": 3, "inserted": 2, "updated": 1, "skipped": 0}

    def _fake_sync(db, *, cfg=None):
        assert db == {"postgres": {}}
        return fake_result

    monkeypatch.setattr(
        "src.vendor.massive.holidays_sync.sync_market_holidays_from_massive",
        _fake_sync,
    )
    out = router.post_sepa_sync_holidays(_fake_request())
    assert out == fake_result


def test_post_sync_holidays_no_db():
    req = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(control_via_db=None, status_cfg_for_read=None))
    )
    out = router.post_sepa_sync_holidays(req)
    assert out["ok"] is False
    assert "PostgreSQL" in out["error"]


def test_post_stock_unified_snapshot_no_db():
    req = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(control_via_db=None, status_cfg_for_read=None))
    )
    out = router.post_sepa_stock_unified_snapshot(req)
    assert out["ok"] is False
    assert "PostgreSQL" in out["error"]


def test_post_stock_unified_snapshot(monkeypatch):
    def _fake_refresh(db, cfg):
        assert db == {"postgres": {}}
        assert cfg == {}
        return {"ok": True, "symbols_total": 500, "chunks": 2, "rows_upserted": 500, "errors": [], "elapsed_ms": 12}

    monkeypatch.setattr(
        "backend.research.routers.sepa_readiness.run_refresh_cache_stock_unified_snapshots",
        _fake_refresh,
    )
    out = router.post_sepa_stock_unified_snapshot(_fake_request())
    assert out["ok"] is True
    assert out["rows_upserted"] == 500
