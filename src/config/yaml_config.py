"""YAML config load, path resolution, and IB flattening. Shared by daemon, server, Celery, and monitor."""

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from src.core.dict_merge import deep_merge

IB_PORT_MAP = {"tws_live": 7496, "tws_paper": 7497, "gateway": 4002}

# IB block shape is the same in dev/prod templates; error messages reference both.
_IB_YAML_EXAMPLE_HINT = (
    "See config/config.dev.yaml.example or config/config.prod.yaml.example for the `ib:` shape."
)

_VALID_ENV_NAMES = frozenset(("dev", "prod"))


def resolve_startup_config_path(project_root: str, argv: List[str]) -> Tuple[str, List[str]]:
    """Resolve config file for ``run_engine`` / ``run_server`` / ``run_celery``.

    Precedence:

    1. ``BIFROST_CONFIG`` environment variable (if non-empty): path used as-is (relative to project root if not absolute).
    2. First positional argument: explicit path to a YAML file.
    3. ``--env dev|prod``, ``--dev``, ``--prod``, or ``-e dev|prod`` (stripped from returned argv).
    4. ``BIFROST_ENV`` environment variable (default ``dev``).
    5. ``config/config.{dev|prod}.yaml`` under project root.

    If that file is missing, falls back to ``config/config.yaml``, then ``config/config.yaml.example``.

    Returns ``(absolute_config_path, argv_without_consumed_env_flags_and_explicit_config_path)``.
    Unknown flags (e.g. ``--debug``) are preserved in the second return value.
    """
    root = Path(project_root)

    if os.environ.get("BIFROST_CONFIG", "").strip():
        raw = os.environ["BIFROST_CONFIG"].strip()
        p = Path(raw)
        if not p.is_absolute():
            p = root / raw
        return str(p.resolve()), list(argv)

    i = 0
    env_from_flag: Optional[str] = None
    stripped: List[str] = []
    while i < len(argv):
        a = argv[i]
        if a in ("--env", "-e") and i + 1 < len(argv):
            v = argv[i + 1].lower().strip()
            env_from_flag = v if v in _VALID_ENV_NAMES else "dev"
            i += 2
            continue
        if a.startswith("--env="):
            v = a.split("=", 1)[1].lower().strip()
            env_from_flag = v if v in _VALID_ENV_NAMES else "dev"
            i += 1
            continue
        if a == "--prod":
            env_from_flag = "prod"
            i += 1
            continue
        if a == "--dev":
            env_from_flag = "dev"
            i += 1
            continue
        stripped.append(a)
        i += 1

    explicit_path: Optional[str] = None
    rest: List[str] = []
    for a in stripped:
        if a.startswith("--"):
            rest.append(a)
            continue
        if explicit_path is None:
            explicit_path = a
        else:
            rest.append(a)

    if explicit_path:
        p = Path(explicit_path)
        if not p.is_absolute():
            p = root / explicit_path
        return str(p.resolve()), rest

    env_name = (env_from_flag or os.environ.get("BIFROST_ENV", "dev") or "dev").lower().strip()
    if env_name not in _VALID_ENV_NAMES:
        env_name = "dev"

    candidate = root / "config" / f"config.{env_name}.yaml"
    if candidate.exists():
        return str(candidate.resolve()), rest

    legacy = root / "config" / "config.yaml"
    if legacy.exists():
        return str(legacy.resolve()), rest

    return str((root / "config" / "config.yaml.example").resolve()), rest


def config_profile_from_resolved_path(resolved_path: str) -> Optional[str]:
    """Return ``dev`` or ``prod`` when the loaded file is ``config.dev.yaml`` / ``config.prod.yaml``.

    Used for UI (e.g. browser tab title). Custom paths or ``config.yaml`` alone return ``None``."""
    name = Path(resolved_path).name
    if name == "config.dev.yaml":
        return "dev"
    if name == "config.prod.yaml":
        return "prod"
    return None


def read_config(config_path: Optional[str] = None) -> tuple[dict, str]:
    """Load YAML. Returns (config, resolved_path).

    When the resolved file is ``config/config.dev.yaml`` or ``config/config.prod.yaml`` and
    ``config/config.yaml`` exists in the same directory, load ``config.yaml`` first and **deep-merge**
    the env-specific file on top (overlay wins). This matches a split where shared keys live in
    ``config.yaml`` and env overrides live in ``config.dev.yaml`` / ``config.prod.yaml``.
    """
    config_path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(config_path).exists():
        config_path = "config/config.yaml.example"
    config_path = str(Path(config_path).resolve())
    path_obj = Path(config_path)
    name = path_obj.name

    with open(config_path, "r", encoding="utf-8") as f:
        overlay: Dict[str, Any] = yaml.safe_load(f) or {}

    if name in ("config.dev.yaml", "config.prod.yaml"):
        base_path = path_obj.parent / "config.yaml"
        if base_path.is_file():
            with open(base_path, "r", encoding="utf-8") as f:
                base: Dict[str, Any] = yaml.safe_load(f) or {}
            return deep_merge(base, overlay), config_path

    return overlay, config_path


def _flatten_host_secondary_ib(ib: dict) -> Dict[str, Any]:
    """Map ``ib.host`` / ``ib.secondary`` to internal flat keys for port resolution and connectors.

    Primary TWS: ``ib.host.ip``, ``ib.host.port_type``, ``ib.host.client_id.*``
    Optional second TWS: ``ib.secondary`` (ip, port_type, client_id.listener/account).
    """
    h = ib.get("host")
    if not isinstance(h, dict):
        raise ValueError(
            "config['ib']['host'] is required (dict with ip, port_type, client_id). "
            + _IB_YAML_EXAMPLE_HINT
        )
    s = ib.get("secondary") if isinstance(ib.get("secondary"), dict) else {}
    hc = h.get("client_id") if isinstance(h.get("client_id"), dict) else {}
    sc = s.get("client_id") if isinstance(s.get("client_id"), dict) else {}

    host = str(h.get("ip") or "127.0.0.1").strip()
    ptp = str(h.get("port_type") or "tws_paper").strip().lower()
    ib2_h = str(s.get("ip") or "").strip()
    ib2_pt = str(s.get("port_type") or "tws_paper").strip().lower()

    return {
        "host": host,
        "port_type": ptp,
        "ib2_host": ib2_h or None,
        "ib2_port_type": ib2_pt,
        "connect_timeout": ib.get("connect_timeout"),
        "client_id_daemon": int(hc.get("daemon") or 1),
        "client_id_listener": int(hc.get("listener") or 2),
        "client_id_account": int(hc.get("account") or 100),
        "client_id_markets": int(hc.get("markets") or 101),
        "client_id_worker_market": int(hc.get("worker_market") or 500),
        "ib2_client_id_listener": int(sc.get("listener") or 3),
        "ib2_client_id_account": int(sc.get("account") or 102),
    }


def get_effective_ib_config(config: dict) -> Dict[str, Any]:
    """Build the canonical IB connection dict from config.yaml (single source of truth for client IDs).

    Required shape::

        ib:
          connect_timeout: 60
          host:
            ip: ...
            port_type: ...
            client_id: { daemon, listener, account, markets, worker_market }
          secondary:  # optional second TWS
            ip: ...
            port_type: ...
            client_id: { listener, account }

    See ``config/config.dev.yaml.example`` or ``config/config.prod.yaml.example`` (same ``ib`` shape).

    Returns a dict with normalised keys consumed by daemon, server, and celery:
      host, port_type, port, connect_timeout,
      client_id_daemon, client_id_listener, client_id_account, client_id_markets, client_id_worker_market,
      ib2_host, ib2_port_type, ib2_port, ib2_client_id_listener, ib2_client_id_account.
    Also includes the ``ib_*`` prefixed aliases expected by the API / frontend (``ib_client_id_daemon`` etc.).
    """
    ib_raw = config.get("ib")
    if not ib_raw or not isinstance(ib_raw, dict):
        raise ValueError("config['ib'] is required in YAML. " + _IB_YAML_EXAMPLE_HINT)
    ib = _flatten_host_secondary_ib(ib_raw)
    host = str(ib.get("host") or "127.0.0.1").strip()
    port_type = str(ib.get("port_type") or "tws_paper").strip().lower()
    if port_type not in IB_PORT_MAP:
        port_type = "tws_paper"
    port = IB_PORT_MAP[port_type]

    cid_d = int(ib.get("client_id_daemon") or 1)
    cid_l = int(ib.get("client_id_listener") or 2)
    cid_a = int(ib.get("client_id_account") or 100)
    cid_m = int(ib.get("client_id_markets") or 101)
    cid_w = int(ib.get("client_id_worker_market") or 500)

    out: Dict[str, Any] = {
        "host": host,
        "port_type": port_type,
        "port": port,
        "connect_timeout": float(ib.get("connect_timeout") or 60.0),
        "client_id_daemon": cid_d,
        "client_id_listener": cid_l,
        "client_id_account": cid_a,
        "client_id_markets": cid_m,
        "client_id_worker_market": cid_w,
        # API / frontend aliases (ib_* prefix)
        "ib_host": host,
        "ib_port_type": port_type,
        "ib_client_id_daemon": cid_d,
        "ib_client_id_listener": cid_l,
        "ib_client_id_account": cid_a,
        "ib_client_id_markets": cid_m,
        "ib_client_id_worker_market": cid_w,
    }

    # Second IB
    ib2_host = str(ib.get("ib2_host") or "").strip()
    if ib2_host:
        ib2_pt = str(ib.get("ib2_port_type") or "tws_paper").strip().lower()
        if ib2_pt not in IB_PORT_MAP:
            ib2_pt = "tws_paper"
        ib2_cid_l = int(ib.get("ib2_client_id_listener") or 3)
        ib2_cid_a = int(ib.get("ib2_client_id_account") or 102)
        out.update({
            "ib2_host": ib2_host,
            "ib2_port_type": ib2_pt,
            "ib2_port": IB_PORT_MAP[ib2_pt],
            "ib2_client_id_listener": ib2_cid_l,
            "ib2_client_id_account": ib2_cid_a,
        })
    else:
        out.update({
            "ib2_host": None,
            "ib2_port_type": None,
            "ib2_port": None,
            "ib2_client_id_listener": 3,
            "ib2_client_id_account": 102,
        })

    return out
