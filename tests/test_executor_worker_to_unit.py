"""Celery nodename → systemd unit for Ops console / journalctl."""

from backend.ops.services.executor_local import RestrictedExecutor


def test_worker_to_unit_run_celery_instance():
    assert (
        RestrictedExecutor.worker_to_unit("workerib-1@server-app-ubt")
        == "bifrost-celery-worker@ib-1.service"
    )
    assert (
        RestrictedExecutor.worker_to_unit("workerbars-2@myhost")
        == "bifrost-celery-worker@bars-2.service"
    )


def test_worker_to_unit_legacy_celery_at():
    assert (
        RestrictedExecutor.worker_to_unit("celery@worker1")
        == "bifrost-celery-worker@worker1.service"
    )


def test_worker_to_unit_no_at():
    assert RestrictedExecutor.worker_to_unit("ib-1") == "bifrost-celery-worker@ib-1.service"
