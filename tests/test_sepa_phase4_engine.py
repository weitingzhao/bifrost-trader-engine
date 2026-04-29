from src.research.sepa import phase4_engine as p4


def test_phase4_job_create_and_get_result_not_ready():
    store = {}

    def fake_insert(_cfg, job_id, request_payload, **_kwargs):
        store[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": {"current": 0, "total": 2, "stage": "queued", "pct": 0.0},
            "request": request_payload,
            "summary": {},
            "errors": [],
            "version": "sepa_phase4_v1",
        }
        return 1

    def fake_get(_cfg, job_id):
        return store.get(job_id)

    def fake_get_result(_cfg, job_id, **_kwargs):
        row = store.get(job_id)
        if not row:
            return None
        return {
            "job_id": job_id,
            "status": row["status"],
            "summary": row["summary"],
            "rows": [],
            "total_rows": 0,
            "offset": 0,
            "limit": 10,
            "version": "sepa_phase4_v1",
        }

    p4.insert_job_sepa_phase4 = fake_insert
    p4.get_job_sepa_phase4 = fake_get
    p4.get_job_sepa_phase4_result = fake_get_result

    job_id = p4.create_phase4_job({"postgres": {}}, ["aapl", "msft"], payload={"source": "massive"})
    row = p4.get_phase4_job({"postgres": {}}, job_id)
    assert row is not None
    assert row["status"] == "queued"
    assert row["request"]["symbols"] == ["AAPL", "MSFT"]
    res = p4.get_phase4_job_result({"postgres": {}}, job_id, offset=0, limit=10)
    assert res is not None
    assert res["rows"] == []


def test_phase4_run_job_happy_path(monkeypatch):
    store = {}

    def fake_insert(_cfg, job_id, request_payload, **_kwargs):
        store[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": {"current": 0, "total": len(request_payload.get("symbols", [])), "stage": "queued", "pct": 0.0},
            "request": request_payload,
            "summary": {},
            "result": None,
            "errors": [],
            "version": "sepa_phase4_v1",
        }
        return 1

    def fake_get(_cfg, job_id):
        return store.get(job_id)

    def fake_update(_cfg, job_id, **fields):
        row = store.get(job_id)
        if not row:
            return False
        row.update(fields)
        return True

    monkeypatch.setattr(p4, "insert_job_sepa_phase4", fake_insert)
    monkeypatch.setattr(p4, "get_job_sepa_phase4", fake_get)
    monkeypatch.setattr(p4, "update_job_sepa_phase4", fake_update)
    monkeypatch.setattr(
        p4,
        "get_stock_day_series_for_sepa",
        lambda *_args, **_kwargs: {"AAA": [{"close": 1}], "BBB": [{"close": 1}]},
    )
    monkeypatch.setattr(
        p4,
        "evaluate_phase1_batch",
        lambda *_args, **_kwargs: {
            "results": [
                {"symbol": "AAA", "technical_pass": True, "conditions": []},
                {"symbol": "BBB", "technical_pass": True, "conditions": []},
            ]
        },
    )
    monkeypatch.setattr(
        p4,
        "get_stock_day_close_series_for_crs",
        lambda *_args, **_kwargs: {"AAA": [{"close": 1}], "BBB": [{"close": 1}]},
    )
    monkeypatch.setattr(
        p4,
        "compute_crs_scores",
        lambda *_args, **_kwargs: {
            "results": [
                {"symbol": "AAA", "pass": True, "crs_score": 95.0},
                {"symbol": "BBB", "pass": False, "crs_score": 20.0},
            ]
        },
    )
    monkeypatch.setattr(
        p4,
        "_fetch_eval_one",
        lambda sym, *_args, **_kwargs: {
            "symbol": sym,
            "fundamental_pass": True,
            "insufficient_data": False,
            "not_comparable": False,
            "conditions": [],
            "pass_count": 8,
            "fail_count": 0,
            "metrics": {},
            "issues": [],
            "cache_hit": "redis",
        },
    )
    monkeypatch.setattr(p4, "redis_client_from_status_config", lambda *_args, **_kwargs: None)

    class DummyClient:
        pass

    job_id = p4.create_phase4_job({"postgres": {}}, ["AAA", "BBB"])
    p4.run_sepa_phase4_job(
        job_id,
        symbols=["AAA", "BBB"],
        status_config={"postgres": {"host": "x"}},
        merged_config={},
        massive_client=DummyClient(),
        cfg=p4.Phase4JobConfig(use_parallel=False),
    )
    row = p4.get_phase4_job({"postgres": {}}, job_id)
    assert row is not None
    assert row["status"] == "succeeded"
    assert row["summary"]["phase1_passed"] == 2
    assert row["summary"]["crs_passed"] == 1
    assert row["summary"]["final_passed"] == 1

