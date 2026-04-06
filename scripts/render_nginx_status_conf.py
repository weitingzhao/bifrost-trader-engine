#!/usr/bin/env python3
"""Fill deploy/nginx/*.conf from YAML ``server.*`` listen ports (merged config, normalized).

Nginx cannot read YAML; after changing ``config/config.yaml`` (or env overlay), run::

  python scripts/render_nginx_status_conf.py

Production host (merge base + prod)::

  BIFROST_CONFIG=config/config.prod.yaml python scripts/render_nginx_status_conf.py

Optional second file for HTTPS example::

  python scripts/render_nginx_status_conf.py --ssl-output deploy/nginx/bifrost-status-ssl.conf.example
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)

from src.app.config import read_config  # noqa: E402

_PLACEHOLDER_MAP = (
    ("@@BIFROST_MONITOR_PORT@@", "monitor_port", 8765),
    ("@@BIFROST_MASSIVE_PORT@@", "massive_port", 8766),
    ("@@BIFROST_DOCS_PORT@@", "docs_port", 8767),
    ("@@BIFROST_OPS_PORT@@", "ops_port", 8768),
    ("@@BIFROST_TRADING_PORT@@", "trading_port", 8769),
    ("@@BIFROST_STRATEGY_PORT@@", "strategy_port", 8770),
    ("@@BIFROST_PORTFOLIO_PORT@@", "portfolio_port", 8771),
    ("@@BIFROST_MARKET_PORT@@", "market_port", 8772),
    ("@@BIFROST_RESEARCH_PORT@@", "research_port", 8773),
)


def _ports_from_config(config: dict) -> dict[str, int]:
    srv = config.get("server") if isinstance(config.get("server"), dict) else {}
    out: dict[str, int] = {}
    for _ph, key, default in _PLACEHOLDER_MAP:
        try:
            v = int(srv.get(key) or default)
        except (TypeError, ValueError):
            v = default
        out[key] = v
    return out


def render_template(text: str, ports: dict[str, int]) -> str:
    out = text
    for ph, key, _default in _PLACEHOLDER_MAP:
        out = out.replace(ph, str(ports[key]))
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Render nginx status proxy conf from YAML server ports.")
    p.add_argument(
        "--config",
        metavar="PATH",
        help="YAML path passed to read_config (default: env BIFROST_CONFIG or config/config.yaml).",
    )
    p.add_argument(
        "--http-template",
        default="deploy/nginx/bifrost-status.conf.template",
        help="HTTP server template with @@BIFROST_*_PORT@@ placeholders.",
    )
    p.add_argument(
        "-o",
        "--output",
        default="deploy/nginx/bifrost-status.conf",
        help="Written HTTP nginx conf (default: deploy/nginx/bifrost-status.conf).",
    )
    p.add_argument(
        "--ssl-template",
        default="deploy/nginx/bifrost-status-ssl.conf.template",
        help="HTTPS server template (same placeholders).",
    )
    p.add_argument(
        "--ssl-output",
        metavar="PATH",
        default=None,
        help="If set, also render SSL template to this path (e.g. deploy/nginx/bifrost-status-ssl.conf.example).",
    )
    args = p.parse_args()

    cfg, resolved = read_config(args.config)
    ports = _ports_from_config(cfg)
    print(
        f"render_nginx_status_conf: YAML {resolved} → "
        f"monitor={ports['monitor_port']} massive={ports['massive_port']} "
        f"docs={ports['docs_port']} ops={ports['ops_port']} "
        f"trading={ports['trading_port']} strategy={ports['strategy_port']} "
        f"portfolio={ports['portfolio_port']} market={ports['market_port']} "
        f"research={ports['research_port']}",
        file=sys.stderr,
    )

    http_tpl = (_PROJECT_ROOT / args.http_template).resolve()
    if not http_tpl.is_file():
        print(f"Missing template: {http_tpl}", file=sys.stderr)
        return 1
    http_body = render_template(http_tpl.read_text(encoding="utf-8"), ports)
    out_path = (_PROJECT_ROOT / args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    prev = out_path.read_text(encoding="utf-8") if out_path.is_file() else None
    if prev == http_body:
        print(
            f"No change to {out_path} (merged YAML ports match file contents — this is normal).",
            file=sys.stderr,
        )
    else:
        out_path.write_text(http_body, encoding="utf-8")
        print(f"Wrote {out_path}", file=sys.stderr)

    if args.ssl_output:
        ssl_tpl = (_PROJECT_ROOT / args.ssl_template).resolve()
        if not ssl_tpl.is_file():
            print(f"Missing SSL template: {ssl_tpl}", file=sys.stderr)
            return 1
        ssl_body = render_template(ssl_tpl.read_text(encoding="utf-8"), ports)
        ssl_path = (_PROJECT_ROOT / args.ssl_output).resolve()
        ssl_path.parent.mkdir(parents=True, exist_ok=True)
        prev_s = ssl_path.read_text(encoding="utf-8") if ssl_path.is_file() else None
        if prev_s == ssl_body:
            print(
                f"No change to {ssl_path} (merged YAML ports match file contents).",
                file=sys.stderr,
            )
        else:
            ssl_path.write_text(ssl_body, encoding="utf-8")
            print(f"Wrote {ssl_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
