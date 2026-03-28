"""Forward ``/research/docs`` and ``/research/massive`` to localhost sidecar processes.

The Docs and Massive APIs run as separate Uvicorn processes (``docs_port`` / ``massive_port``).
Nginx can route those paths directly; when the browser talks only to the main Status server
(e.g. ``http://host:8765``), ``GET /research/docs/health`` would otherwise 404. This router
proxies to ``127.0.0.1`` so Settings → API health works without relying on nginx for those paths.
"""

from __future__ import annotations

import asyncio
import logging
import urllib.error
import urllib.request
from typing import Any, Dict

from fastapi import APIRouter, Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

router = APIRouter(tags=["research-sidecars"], include_in_schema=False)

_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)


def _ports(request: Request) -> tuple[int, int]:
    reader = getattr(request.app.state, "reader", None)
    cfg_dict = reader._config if reader is not None else {}
    srv = cfg_dict.get("server") or {}
    docs = int(srv.get("docs_port") or 8767)
    massive = int(srv.get("massive_port") or 8766)
    return docs, massive


def _forward_request_headers(request: Request) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for name, value in request.headers.items():
        ln = name.lower()
        if ln in _HOP_BY_HOP or ln == "host":
            continue
        out[name] = value
    return out


def _response_headers_from_urllib(h: Any) -> Dict[str, str]:
    """Normalize urllib response / HTTPError headers to a plain dict for Starlette."""
    if hasattr(h, "items"):
        return {k: v for k, v in h.items()}
    return dict(h)


def _strip_hop_response_headers(h: Dict[str, str]) -> Dict[str, str]:
    drop = frozenset({"transfer-encoding", "connection", "content-encoding"})
    return {k: v for k, v in h.items() if k.lower() not in drop}


async def _proxy_to_sidecar(
    upstream_root: str,
    path_suffix: str,
    request: Request,
    *,
    timeout_sec: float = 120.0,
) -> Response:
    """*upstream_root* is e.g. ``http://127.0.0.1:8767/research/docs`` (no trailing slash)."""
    query = request.url.query
    url = f"{upstream_root}/{path_suffix}" if path_suffix else upstream_root
    if query:
        url = f"{url}?{query}"
    method = request.method.upper()
    body = await request.body() if method not in ("GET", "HEAD", "OPTIONS") else None
    req_headers = _forward_request_headers(request)

    def _sync() -> tuple[bytes, int, Dict[str, str]]:
        req = urllib.request.Request(url, data=body, method=method)
        for k, v in req_headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                raw = resp.read()
                hdrs = _response_headers_from_urllib(resp.headers)
                return raw, resp.status, hdrs
        except urllib.error.HTTPError as e:
            raw = e.read()
            hdrs = _response_headers_from_urllib(e.headers)
            return raw, e.code, hdrs
        except urllib.error.URLError as e:
            logger.warning("research sidecar proxy URLError %s: %s", url, e)
            raise

    try:
        content, status, hdrs = await asyncio.to_thread(_sync)
    except urllib.error.URLError:
        return Response(
            content=b'{"detail":"Sidecar unreachable (is the process running on this host?)"}',
            status_code=502,
            media_type="application/json",
        )

    out_h = _strip_hop_response_headers(hdrs)
    return Response(content=content, status_code=status, headers=out_h)


@router.api_route(
    "/research/docs/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def proxy_research_docs(full_path: str, request: Request) -> Response:
    port, _ = _ports(request)
    root = f"http://127.0.0.1:{port}/research/docs"
    return await _proxy_to_sidecar(root, full_path, request)


@router.api_route(
    "/research/massive/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def proxy_research_massive(full_path: str, request: Request) -> Response:
    _, port = _ports(request)
    root = f"http://127.0.0.1:{port}/research/massive"
    return await _proxy_to_sidecar(root, full_path, request)
