from types import SimpleNamespace

from backend.research.routers import sepa_phase4_jobs as router


def _fake_request() -> SimpleNamespace:
    app = SimpleNamespace(state=SimpleNamespace(control_via_db={"postgres": {}}, status_cfg_for_read=None))
    return SimpleNamespace(app=app)


def test_list_phase4_jobs_status_filter_passthrough(monkeypatch):
    captured = {}

    def fake_list(_db, **kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr(router, "list_phase4_jobs", fake_list)
    out = router.list_sepa_phase4_jobs(
        _fake_request(),
        limit=20,
        offset=5,
        status="running",
        created_from=None,
        created_to=None,
    )
    assert out["ok"] is True
    assert captured["status_filter"] == "running"
    assert captured["created_from"] is None
    assert captured["created_to"] is None


def test_list_phase4_jobs_time_window_passthrough(monkeypatch):
    captured = {}

    def fake_list(_db, **kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr(router, "list_phase4_jobs", fake_list)
    out = router.list_sepa_phase4_jobs(
        _fake_request(),
        status=None,
        created_from="2026-04-01T00:00:00Z",
        created_to="2026-04-30T23:59:59Z",
    )
    assert out["ok"] is True
    assert captured["status_filter"] is None
    assert captured["created_from"] == "2026-04-01T00:00:00Z"
    assert captured["created_to"] == "2026-04-30T23:59:59Z"


def test_list_phase4_jobs_combined_filters_passthrough(monkeypatch):
    captured = {}

    def fake_list(_db, **kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr(router, "list_phase4_jobs", fake_list)
    out = router.list_sepa_phase4_jobs(
        _fake_request(),
        status="failed",
        created_from="2026-04-28T00:00:00Z",
        created_to="2026-04-28T23:59:59Z",
    )
    assert out["ok"] is True
    assert captured["status_filter"] == "failed"
    assert captured["created_from"] == "2026-04-28T00:00:00Z"
    assert captured["created_to"] == "2026-04-28T23:59:59Z"

