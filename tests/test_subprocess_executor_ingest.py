"""SubprocessLocalExecutor market ingest start/stop (Mac-style) — mocked subprocess."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.ops.services.executor_local import SubprocessLocalExecutor, _ingest_script_log_for_unit


def test_ingest_script_log_for_unit() -> None:
    assert _ingest_script_log_for_unit("bifrost-massive-ws.service")[0] == "run_massive_ws.py"
    assert _ingest_script_log_for_unit("bifrost-ib-operator.service")[0] == "run_ib_operator.py"
    assert _ingest_script_log_for_unit("bifrost-ib-ingestor.service")[0] == "run_ib_ingestor.py"
    assert _ingest_script_log_for_unit("bifrost-ib-market-ingest.service")[0] == "run_ib_ingestor.py"
    assert _ingest_script_log_for_unit("bifrost-ib-account-agent.service")[0] == "run_ib_account_agent.py"
    assert _ingest_script_log_for_unit("unknown.service") is None


@pytest.mark.asyncio
async def test_start_ingest_massive_happy_path(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "run_massive_ws.py").write_text("#\n", encoding="utf-8")
    cfg = root / "config" / "c.yaml"
    cfg.parent.mkdir()
    cfg.write_text("redis:\n  enabled: false\n", encoding="utf-8")

    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=root,
        resolved_config_path=str(cfg),
    )

    with patch.object(ex, "_ingest_matching_pids", new_callable=AsyncMock, return_value=[]):
        mock_proc = MagicMock()
        mock_proc.pid = 4242
        mock_proc.wait = AsyncMock(side_effect=asyncio.TimeoutError())

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc) as cse:
            r = await ex._systemctl("start", "bifrost-massive-ws.service")

    assert r["method"] == "subprocess"
    assert r["pid"] == 4242
    cse.assert_called_once()
    call_kw = cse.call_args
    cmd = call_kw[0]
    assert "run_massive_ws.py" in cmd[1]
    assert "--config" in cmd
    assert str(cfg.resolve()) in cmd


@pytest.mark.asyncio
async def test_start_ingest_operator_positional_config(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "run_ib_operator.py").write_text("#\n", encoding="utf-8")
    cfg = root / "config" / "c.yaml"
    cfg.parent.mkdir()
    cfg.write_text("redis:\n  enabled: false\n", encoding="utf-8")

    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=root,
        resolved_config_path=str(cfg),
    )

    with patch.object(ex, "_ingest_matching_pids", new_callable=AsyncMock, return_value=[]):
        mock_proc = MagicMock()
        mock_proc.pid = 99
        mock_proc.wait = AsyncMock(side_effect=asyncio.TimeoutError())

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc) as cse:
            await ex._systemctl("start", "bifrost-ib-operator.service")

    cmd = cse.call_args[0]
    assert "run_ib_operator.py" in cmd[1]
    assert "--config" not in cmd
    assert str(cfg.resolve()) == cmd[-1]


@pytest.mark.asyncio
async def test_start_ingest_already_running_raises(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "run_massive_ws.py").write_text("#\n", encoding="utf-8")

    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=root,
    )

    with patch.object(ex, "_ingest_matching_pids", new_callable=AsyncMock, return_value=["111"]):
        with pytest.raises(RuntimeError, match="ingest_already_running"):
            await ex._systemctl("start", "bifrost-massive-ws.service")


@pytest.mark.asyncio
async def test_stop_ingest_sends_sigterm(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "run_massive_ws.py").write_text("#\n", encoding="utf-8")

    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=root,
    )

    with patch.object(
        ex,
        "_ingest_matching_pids",
        new_callable=AsyncMock,
        side_effect=[["1001", "1002"], []],
    ):
        with patch("os.getpgid", return_value=1001), patch(
            "os.killpg", side_effect=OSError("test force single-pid kill")
        ), patch("os.kill") as kill_mock:
            r = await ex._systemctl("stop", "bifrost-massive-ws.service")

    assert r["action"] == "stop"
    assert kill_mock.call_count == 2
    assert r.get("sigkill_pids") == []


@pytest.mark.asyncio
async def test_worker_unit_still_uses_run_celery(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "run_celery.py").write_text("#\n", encoding="utf-8")

    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=root,
    )

    mock_proc = MagicMock()
    mock_proc.pid = 7
    mock_proc.wait = AsyncMock(side_effect=asyncio.TimeoutError())

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc) as cse:
        r = await ex._systemctl("start", "bifrost-celery-worker@ib-1.service")

    assert r["pid"] == 7
    cmd = cse.call_args[0]
    assert "run_celery.py" in cmd[1]
    assert "--instance" in cmd
    assert "ib-1" in cmd


@pytest.mark.asyncio
async def test_unknown_unit_permission_error(tmp_path: Path) -> None:
    ex = SubprocessLocalExecutor(
        allowed_units=[],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
        project_root=tmp_path,
    )
    with pytest.raises(PermissionError):
        await ex._systemctl("start", "some-other.service")
