"""Derive self_check and status_lamp from status_current row. Phase 2 (R-M2, R-M3)."""

from typing import Any, Dict, List, Optional

# Default data lag threshold (ms) when not in config
_DEFAULT_DATA_LAG_THRESHOLD_MS = 5000.0


def derive_self_check(
    row: Optional[Dict[str, Any]],
    data_lag_threshold_ms: Optional[float] = None,
    trading_suspended: Optional[bool] = None,
) -> Dict[str, Any]:
    """Compute self_check (ok/degraded/blocked), block_reasons, and status_lamp (green/yellow/red).

    Args:
        row: Single status_current row (dict) or None if no row.
        data_lag_threshold_ms: From config gates.state.system.data_lag_threshold_ms, or default.
        trading_suspended: From daemon_run_status.suspended; when True, daemon is not placing new hedges (reflect in self_check).

    Returns:
        {"self_check": "ok"|"degraded"|"blocked", "block_reasons": [...], "status_lamp": "green"|"yellow"|"red"}
    """
    threshold = data_lag_threshold_ms if data_lag_threshold_ms is not None else _DEFAULT_DATA_LAG_THRESHOLD_MS
    block_reasons: List[str] = []

    if row is None:
        block_reasons.append("no_status")
        return {
            "self_check": "blocked",
            "block_reasons": block_reasons,
            "status_lamp": "red",
        }

    daemon_state = (row.get("daemon_state") or "").strip().upper()
    # RUNNING_SUSPENDED = daemon running but hedging paused (FSM state from daemon_run_status)
    if daemon_state not in ("RUNNING", "RUNNING_SUSPENDED"):
        block_reasons.append("daemon_not_running")
        return {
            "self_check": "blocked",
            "block_reasons": block_reasons,
            "status_lamp": "red",
        }

    # Trading suspended: from DB (trading_suspended) or from daemon-reported state (RUNNING_SUSPENDED)
    is_suspended = trading_suspended or (daemon_state == "RUNNING_SUSPENDED")
    if is_suspended:
        block_reasons.append("trading_suspended")
        return {
            "self_check": "degraded",
            "block_reasons": block_reasons,
            "status_lamp": "yellow",
        }

    # Degraded: data lag or trading_state suggests issue
    data_lag_ms = row.get("data_lag_ms")
    if data_lag_ms is not None and float(data_lag_ms) > threshold:
        block_reasons.append("data_stale")
        return {
            "self_check": "degraded",
            "block_reasons": block_reasons,
            "status_lamp": "yellow",
        }

    trading_state = (row.get("trading_state") or "").strip().upper()
    if trading_state in ("PAUSE_COST", "RISK_HALT", "STALE", "FORCE_HEDGE"):
        block_reasons.append(f"trading_state_{trading_state.lower()}")
        return {
            "self_check": "degraded",
            "block_reasons": block_reasons,
            "status_lamp": "yellow",
        }

    return {
        "self_check": "ok",
        "block_reasons": [],
        "status_lamp": "green",
    }


def derive_daemon_self_check(daemon_heartbeat: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute daemon self_check, status_lamp and block_reasons from daemon_heartbeat (RE-6/RE-7).

    Used for the 守护程序 status lamp on the monitoring UI. Heartbeat is written by the stable
    daemon (run_daemon.py); when absent or stale, daemon is considered not running.

    Args:
        daemon_heartbeat: Dict with daemon_alive (bool), ib_connected (bool); or None if no heartbeat.

    Returns:
        {"daemon_self_check": "ok"|"degraded"|"blocked", "daemon_lamp": "green"|"yellow"|"red"|"none", "daemon_block_reasons": [...]}
    """
    if not daemon_heartbeat:
        return {
            "daemon_self_check": "blocked",
            "daemon_lamp": "red",
            "daemon_block_reasons": ["no_heartbeat"],
        }
    daemon_alive = daemon_heartbeat.get("daemon_alive", False)
    ib_connected = daemon_heartbeat.get("ib_connected", False)

    if not daemon_alive:
        return {
            "daemon_self_check": "blocked",
            "daemon_lamp": "red",
            "daemon_block_reasons": ["daemon_not_running"],
        }
    if not ib_connected:
        return {
            "daemon_self_check": "degraded",
            "daemon_lamp": "yellow",
            "daemon_block_reasons": ["ib_not_connected"],
        }
    return {
        "daemon_self_check": "ok",
        "daemon_lamp": "green",
        "daemon_block_reasons": [],
    }
