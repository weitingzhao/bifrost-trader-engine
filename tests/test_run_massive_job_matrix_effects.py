"""Registry of matrix row side effects matches ``RUN_MASSIVE_JOB_MATRIX`` rows."""

from __future__ import annotations

from src.massive.run_massive_job_manifest import RUN_MASSIVE_JOB_MATRIX
from src.massive.run_massive_job_matrix_effects import _REGISTRY, effects_for_matrix_row


def test_effects_registry_covers_every_matrix_row() -> None:
    assert len(_REGISTRY) == len(RUN_MASSIVE_JOB_MATRIX)
    for r in RUN_MASSIVE_JOB_MATRIX:
        m = r.mode or ""
        assert (r.kind, m) in _REGISTRY
        e = effects_for_matrix_row(r.kind, r.mode)
        assert not e.feed_apis[0].startswith("(unmapped")


def test_to_api_dict_includes_effects() -> None:
    r0 = RUN_MASSIVE_JOB_MATRIX[0]
    d = r0.to_api_dict()
    assert "feed_apis" in d and isinstance(d["feed_apis"], list)
    assert "db_tables" in d and isinstance(d["db_tables"], list)
    assert "redis_nodes" in d and isinstance(d["redis_nodes"], list)
