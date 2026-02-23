#!/usr/bin/env python3
"""Stable daemon on the trading machine: holds IB Client ID, polls PostgreSQL, starts/stops hedge app subprocess on resume/suspend.

Does not assume IB is running at startup (RE-7): uses timed connect and retry loop; writes ib_connected and
ib_client_id to daemon_heartbeat for monitoring; consumes retry_ib from daemon_control for immediate retry.
See docs/ARCHITECTURE.md §5.1 and docs/RUN_ENVIRONMENT_AND_REQUIREMENTS.md §3.1, §3.3.
"""

import asyncio
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

# Project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)

logger = logging.getLogger(__name__)

# Default heartbeat interval (seconds) for polling DB
_DEFAULT_HEARTBEAT_INTERVAL = 10.0
# Default interval (seconds) between IB connect retries when not connected (RE-7)
_DEFAULT_IB_RETRY_INTERVAL = 30.0
# Wait up to this many seconds for hedge subprocess to exit on suspend/stop
_SUBPROCESS_TERM_TIMEOUT = 15.0


def _load_config(config_path: Optional[str] = None) -> dict:
    from src.app.gs_trading import read_config
    path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(path).exists():
        path = str(_PROJECT_ROOT / "config" / "config.yaml.example")
    config, _ = read_config(path)
    return config


def _run_stable_daemon_async(config_path: Optional[str]) -> None:
    """RE-7: Do not assume IB is running. Loop: try connect (with retry); when connected, poll DB and manage hedge subprocess; when disconnected, retry after interval or on retry_ib."""
    config = _load_config(config_path)
    status_cfg = config.get("status") or {}
    use_db = status_cfg.get("sink") == "postgres" and (
        status_cfg.get("postgres") or os.environ.get("PGHOST")
    )
    if not use_db:
        logger.error("Stable daemon requires status.sink=postgres and status.postgres (or PGHOST)")
        sys.exit(1)

    from src.sink.postgres_sink import PostgreSQLSink
    from src.connector.ib import IBConnector

    sink = PostgreSQLSink(status_cfg)
    ib_cfg = config.get("ib", {})
    connector = IBConnector(
        host=ib_cfg.get("host", "127.0.0.1"),
        port=int(ib_cfg.get("port", 4001)),
        client_id=int(ib_cfg.get("client_id", 1)),
        connect_timeout=float(ib_cfg.get("connect_timeout", 60)),
    )

    daemon_cfg = config.get("daemon") or {}
    hedge_cmd = (daemon_cfg.get("hedge_command") or f"{sys.executable} scripts/run_hedge_app.py").strip()
    heartbeat_interval = float(daemon_cfg.get("heartbeat_interval", _DEFAULT_HEARTBEAT_INTERVAL))
    ib_retry_interval = float(daemon_cfg.get("ib_retry_interval_sec", _DEFAULT_IB_RETRY_INTERVAL))
    hedge_client_id = ib_cfg.get("hedge_client_id") or (int(ib_cfg.get("client_id", 1)) + 1)

    child_process: Optional[subprocess.Popen] = None

    def _is_child_running() -> bool:
        return child_process is not None and child_process.poll() is None

    def _terminate_child() -> None:
        nonlocal child_process
        if child_process is None:
            return
        p = child_process
        child_process = None
        try:
            p.terminate()
            try:
                p.wait(timeout=_SUBPROCESS_TERM_TIMEOUT)
            except subprocess.TimeoutExpired:
                logger.warning("Hedge subprocess did not exit in %ss, sending SIGKILL", _SUBPROCESS_TERM_TIMEOUT)
                p.kill()
                p.wait(timeout=5)
        except Exception as e:
            logger.debug("Terminate child: %s", e)

    def _start_child() -> bool:
        nonlocal child_process
        if child_process is not None and child_process.poll() is None:
            return True
        parts = hedge_cmd.split()
        if not parts:
            return False
        if config_path:
            parts.append(config_path)
        env = os.environ.copy()
        env["BIFROST_HEDGE_CLIENT_ID"] = str(hedge_client_id)
        env["BIFROST_UNDER_DAEMON"] = "1"
        try:
            child_process = subprocess.Popen(
                parts,
                cwd=str(_PROJECT_ROOT),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            logger.info("Started hedge app subprocess (pid=%s, hedge_client_id=%s)", child_process.pid, hedge_client_id)
            return True
        except Exception as e:
            logger.error("Failed to start hedge app: %s", e)
            return False

    def _write_heartbeat(
        hedge: bool,
        ib_ok: bool,
        cid: Optional[int],
        next_retry_ts: Optional[float] = None,
        seconds_until_retry: Optional[int] = None,
    ) -> None:
        if hasattr(sink, "write_daemon_heartbeat"):
            sink.write_daemon_heartbeat(
                hedge, ib_connected=ib_ok, ib_client_id=cid,
                next_retry_ts=next_retry_ts, seconds_until_retry=seconds_until_retry,
            )

    async def main_loop() -> None:
        nonlocal child_process
        stop_requested = False
        try:
            while not stop_requested:
                now_t = time.time()
                next_retry_ts = now_t + ib_retry_interval
                sec_until = max(0, min(ib_retry_interval + 5, int(round(next_retry_ts - now_t))))
                _write_heartbeat(False, False, None, next_retry_ts=next_retry_ts, seconds_until_retry=sec_until)

                cmd = sink.poll_and_consume_control(consume_only=("stop", "retry_ib"))
                if cmd == "stop":
                    logger.info("Stable daemon: stop consumed; exiting")
                    stop_requested = True
                    break
                immediate_retry = cmd == "retry_ib"

                if not connector.is_connected:
                    logger.info("Stable daemon: connecting to IB (one attempt; next retry in %.0fs if failed)...", ib_retry_interval)
                    ok = await connector.connect(max_attempts=1)
                    if ok:
                        _write_heartbeat(False, True, connector.client_id)
                        logger.info("Stable daemon: IB connected (client_id=%s); polling DB every %.0fs", connector.client_id, heartbeat_interval)
                        try:
                            while True:
                                cmd = sink.poll_and_consume_control(consume_only=("stop", "retry_ib"))
                                if cmd == "stop":
                                    stop_requested = True
                                    break
                                if not connector.is_connected:
                                    logger.warning("Stable daemon: IB connection lost; will retry")
                                    break
                                suspended = sink.poll_run_status()
                                if suspended and _is_child_running():
                                    logger.info("Stable daemon: suspended=true; terminating hedge subprocess")
                                    _terminate_child()
                                elif not suspended and not _is_child_running():
                                    if not _start_child():
                                        logger.warning("Stable daemon: resume requested but failed to start hedge app")
                                if child_process is not None and child_process.poll() is not None:
                                    code = child_process.poll()
                                    child_process = None
                                    logger.info("Stable daemon: hedge subprocess exited (code=%s)", code)
                                _write_heartbeat(_is_child_running(), True, connector.client_id)
                                await asyncio.sleep(heartbeat_interval)
                        finally:
                            _terminate_child()
                            await connector.disconnect()
                            _write_heartbeat(False, False, None)
                    else:
                        now_t = time.time()
                        next_retry_ts = now_t + ib_retry_interval
                        sec_until = max(0, min(ib_retry_interval + 5, int(round(next_retry_ts - now_t))))
                        _write_heartbeat(False, False, None, next_retry_ts=next_retry_ts, seconds_until_retry=sec_until)
                        logger.warning("Stable daemon: IB connect failed; next retry in %ss (or use Retry IB in monitoring)", sec_until)
                    if stop_requested:
                        break
                    if not immediate_retry:
                        await asyncio.sleep(ib_retry_interval)
        finally:
            _write_heartbeat(False, False, None)
            _terminate_child()
            if connector.is_connected:
                await connector.disconnect()
            if hasattr(sink, "write_daemon_graceful_shutdown"):
                sink.write_daemon_graceful_shutdown()
            sink.close()
            logger.info("Stable daemon: stopped")

    asyncio.run(main_loop())


def main() -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        level=logging.INFO,
    )
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    elif config_path is None:
        config_path = str(_PROJECT_ROOT / "config" / "config.yaml")
    _run_stable_daemon_async(config_path)


if __name__ == "__main__":
    main()
