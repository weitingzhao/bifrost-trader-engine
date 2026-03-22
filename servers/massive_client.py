"""HTTP client for Massive / Polygon options REST API (urllib, no extra deps)."""

from __future__ import annotations

import json
import logging
import ssl
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_REST_BASE = "https://api.polygon.io"


def _norm_expiry(s: str) -> str:
    """Normalize expiration to YYYYMMDD or YYYYMM as stored elsewhere."""
    s = (s or "").strip()
    if len(s) >= 10 and s[4] == "-":
        return s[:4] + s[5:7] + s[8:10]
    return s


def _right_from_contract_type(ct: str) -> str:
    u = (ct or "").upper()
    if u in ("CALL", "C"):
        return "C"
    if u in ("PUT", "P"):
        return "P"
    return "C"


def contract_key_from_parts(
    symbol: str, expiry: str, strike: float, option_right: str
) -> str:
    """Match account_positions / DATABASE.md: symbol|OPT|expiry|strike|right."""
    sym = (symbol or "").strip().upper()
    exp = _norm_expiry(expiry)
    r = (option_right or "").strip().upper()
    if r in ("CALL",):
        r = "C"
    if r in ("PUT",):
        r = "P"
    return f"{sym}|OPT|{exp}|{strike}|{r}"


class MassiveClient:
    """Minimal Polygon v3 options REST wrapper."""

    def __init__(self, api_key: str, rest_base: str = DEFAULT_REST_BASE) -> None:
        self._api_key = (api_key or "").strip()
        self._base = (rest_base or DEFAULT_REST_BASE).rstrip("/")
        self._ssl = ssl.create_default_context()

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Tuple[int, Any]:
        """Return (http_status, parsed_json_or_none)."""
        q = dict(params or {})
        q["apiKey"] = self._api_key
        url = f"{self._base}{path}"
        if q:
            url = f"{url}?{urlencode(q)}"
        req = Request(url, headers={"Accept": "application/json"}, method="GET")
        try:
            with urlopen(req, timeout=60, context=self._ssl) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                status = getattr(resp, "status", 200) or 200
                try:
                    return int(status), json.loads(body)
                except json.JSONDecodeError:
                    return int(status), {"raw": body[:500]}
        except HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="replace")
                return e.code, json.loads(body)
            except Exception:
                return e.code, {"error": str(e)}
        except URLError as e:
            logger.warning("MassiveClient _get URLError: %s", e)
            return 0, {"error": str(e)}

    def fetch_expirations_and_strikes(
        self, underlying: str, max_pages: int = 20
    ) -> Dict[str, Any]:
        """Paginate /v3/reference/options/contracts; return expirations, strikes, tickers map."""
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"expirations": [], "strikes": [], "error": "symbol or api key missing"}
        expirations: set = set()
        strikes: set = set()
        next_url: Optional[str] = None
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {"underlying_ticker": underlying, "limit": 250}
        pages = 0
        while pages < max_pages:
            pages += 1
            if next_url:
                # next_url is full URL from API; append apiKey if missing
                url = next_url
                if "apiKey=" not in url and "apikey=" not in url.lower():
                    sep = "&" if "?" in url else "?"
                    url = f"{url}{sep}apiKey={self._api_key}"
                req = Request(url, headers={"Accept": "application/json"}, method="GET")
                try:
                    with urlopen(req, timeout=60, context=self._ssl) as resp:
                        body = resp.read().decode("utf-8", errors="replace")
                        data = json.loads(body)
                except Exception as e:
                    return {"expirations": sorted(expirations), "strikes": sorted(strikes), "error": str(e)}
            else:
                status, data = self._get(path, params)
                if status >= 400:
                    return {
                        "expirations": [],
                        "strikes": [],
                        "error": data.get("error", data) if isinstance(data, dict) else str(data),
                    }
            results = data.get("results") if isinstance(data, dict) else None
            if not results:
                break
            for r in results:
                if not isinstance(r, dict):
                    continue
                ed = r.get("expiration_date") or r.get("expiration")
                if ed:
                    expirations.add(_norm_expiry(str(ed)[:10]))
                sp = r.get("strike_price")
                if sp is not None:
                    try:
                        strikes.add(float(sp))
                    except (TypeError, ValueError):
                        pass
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                break
        return {
            "expirations": sorted(expirations),
            "strikes": sorted(strikes),
        }

    def fetch_options_snapshot(self, underlying: str) -> Dict[str, Any]:
        """GET /v3/snapshot/options/{underlying}."""
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"results": [], "error": "symbol or api key missing"}
        status, data = self._get(f"/v3/snapshot/options/{underlying}")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": [], "error": "invalid response"}

    def fetch_option_aggs(
        self,
        options_ticker: str,
        multiplier: int,
        timespan: str,
        start_ms: int,
        end_ms: int,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to} (ms)."""
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": [], "error": "ticker or api key missing"}
        path = f"/v2/aggs/ticker/{ot}/range/{multiplier}/{timespan}/{start_ms}/{end_ms}"
        status, data = self._get(path, {"adjusted": "true", "sort": "asc", "limit": 50000})
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def sleep_backoff(self, attempt: int) -> None:
        time.sleep(min(2.0 ** attempt, 30.0))
