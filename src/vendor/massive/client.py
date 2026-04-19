"""HTTP client for Massive / Polygon options REST API (urllib, no extra deps)."""

from __future__ import annotations

import json
import logging
import re
import ssl
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_REST_BASE = "https://api.polygon.io"


def _as_error_str(err: Any) -> str:
    """Polygon/Massive sometimes returns error as a string, object, or list."""
    if isinstance(err, str):
        return err
    if err is None:
        return "Unknown error"
    try:
        return json.dumps(err, default=str)
    except (TypeError, ValueError):
        return str(err)


def _polygon_body_error_message(data: Any, http_status: int) -> Optional[str]:
    """Return a message if JSON indicates logical failure (including HTTP 200 error bodies)."""
    if not isinstance(data, dict):
        return None
    ps = str(data.get("status") or "").upper()
    if ps in ("ERROR", "NOT_AUTHORIZED", "FAILED"):
        for key in ("error", "message"):
            val = data.get(key)
            if val is not None:
                return _as_error_str(val)
        return ps if ps else f"HTTP {http_status}"
    return None


def _redact_url_api_key(url: str) -> str:
    """Replace apiKey / apikey query values with *** for logs and API responses."""
    if not url:
        return url
    return re.sub(r"([?&])(apiKey|apikey)=([^&]*)", r"\1\2=***", url, flags=re.I)


def _norm_expiry(s: str) -> str:
    """Normalize expiration to YYYYMMDD or YYYYMM as stored elsewhere."""
    s = (s or "").strip()
    if len(s) >= 10 and s[4] == "-":
        return s[:4] + s[5:7] + s[8:10]
    return s


def _expiry_to_polygon_date(s: str) -> Optional[str]:
    """Convert YYYYMMDD or YYYY-MM-DD to Polygon's YYYY-MM-DD format. Returns None if invalid."""
    s = (s or "").strip()
    if not s:
        return None
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None


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
    # Normalize strike so query keys match rows written from Polygon strike_price (avoids float drift).
    sk = round(float(strike), 8)
    return f"{sym}|OPT|{exp}|{sk}|{r}"


def contract_key_from_reference_result(
    underlying: str, row: Dict[str, Any]
) -> Optional[str]:
    """Build ``option_contracts.contract_key`` from a Polygon ``/v3/reference/options/contracts`` result row."""
    u = (underlying or "").strip().upper()
    if not u or not isinstance(row, dict):
        return None
    exp = row.get("expiration_date") or row.get("expiration") or ""
    if not exp:
        return None
    ed = _norm_expiry(str(exp)[:10])
    if len(ed) != 8 or not ed.isdigit():
        return None
    sp = row.get("strike_price")
    if sp is None:
        return None
    try:
        strike = float(sp)
    except (TypeError, ValueError):
        return None
    ort = _right_from_contract_type(str(row.get("contract_type") or "call"))
    return contract_key_from_parts(u, ed, strike, ort)


class MassiveClient:
    """Minimal Polygon v3 options REST wrapper."""

    def __init__(self, api_key: str, rest_base: str = DEFAULT_REST_BASE) -> None:
        self._api_key = (api_key or "").strip()
        self._base = (rest_base or DEFAULT_REST_BASE).rstrip("/")
        self._ssl = ssl.create_default_context()

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def _redacted_get_url(self, path: str, params: Optional[Dict[str, Any]] = None) -> str:
        q = dict(params or {})
        q["apiKey"] = "***"
        url = f"{self._base}{path}"
        return f"{url}?{urlencode(q)}" if q else url

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

    def _get_json_from_next_url(self, next_url: str) -> Tuple[int, Any]:
        """Follow Polygon next_url; append apiKey when missing. Returns (http_status, parsed_json)."""
        url = next_url
        if "apiKey=" not in url and "apikey=" not in url.lower():
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}apiKey={self._api_key}"
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
            logger.warning("MassiveClient _get_json_from_next_url URLError: %s", e)
            return 0, {"error": str(e)}

    def count_option_contracts_list_paginated(
        self,
        underlying: str,
        *,
        expiration_date: Optional[str] = None,
        max_pages: int = 20,
        limit: int = 250,
    ) -> Dict[str, Any]:
        """Paginate GET /v3/reference/options/contracts and sum len(results) per page.

        When *expiration_date* is set, only that expiry is counted (server-side filter).
        Returns ``count``, ``truncated`` (True if stopped early due to max_pages), and optional ``error``.
        """
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"count": 0, "truncated": False, "error": "symbol or api key missing"}
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {
            "underlying_ticker": underlying,
            "limit": min(int(limit), 250),
        }
        poly_exp = _expiry_to_polygon_date(expiration_date or "")
        if poly_exp:
            params["expiration_date"] = poly_exp
        total = 0
        next_url: Optional[str] = None
        pages = 0
        truncated = False
        while True:
            if pages >= max_pages:
                if next_url:
                    truncated = True
                break
            pages += 1
            if next_url:
                status, data = self._get_json_from_next_url(next_url)
            else:
                status, data = self._get(path, params)
            if status >= 400:
                err = data.get("error", data) if isinstance(data, dict) else str(data)
                return {"count": total, "truncated": truncated, "error": _as_error_str(err)}
            if not isinstance(data, dict):
                return {"count": total, "truncated": truncated, "error": "invalid response"}
            poly_err = _polygon_body_error_message(data, status)
            if poly_err:
                return {"count": total, "truncated": truncated, "error": poly_err}
            results = data.get("results")
            if not isinstance(results, list):
                break
            total += len(results)
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                break
        return {"count": total, "truncated": truncated, "error": None}

    def collect_option_contract_keys_paginated(
        self,
        underlying: str,
        *,
        expiration_date: Optional[str],
        max_pages: int = 20,
        limit: int = 250,
    ) -> Dict[str, Any]:
        """Paginate GET /v3/reference/options/contracts; return each result row count and derived ``contract_key`` list.

        Used to compare PostgreSQL ``option_contracts.contract_key`` only within the API-returned universe for that
        expiry (rows in DB that are not returned by the reference list are excluded from the comparable PG count).
        """
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"count": 0, "keys": [], "truncated": False, "error": "symbol or api key missing"}
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {
            "underlying_ticker": underlying,
            "limit": min(int(limit), 250),
        }
        poly_exp = _expiry_to_polygon_date(expiration_date or "")
        if poly_exp:
            params["expiration_date"] = poly_exp
        keys: List[str] = []
        total = 0
        next_url: Optional[str] = None
        pages = 0
        truncated = False
        while True:
            if pages >= max_pages:
                if next_url:
                    truncated = True
                break
            pages += 1
            if next_url:
                status, data = self._get_json_from_next_url(next_url)
            else:
                status, data = self._get(path, params)
            if status >= 400:
                err = data.get("error", data) if isinstance(data, dict) else str(data)
                return {"count": total, "keys": keys, "truncated": truncated, "error": _as_error_str(err)}
            if not isinstance(data, dict):
                return {"count": total, "keys": keys, "truncated": truncated, "error": "invalid response"}
            poly_err = _polygon_body_error_message(data, status)
            if poly_err:
                return {"count": total, "keys": keys, "truncated": truncated, "error": poly_err}
            results = data.get("results")
            if not isinstance(results, list):
                break
            for row in results:
                total += 1
                if isinstance(row, dict):
                    ck = contract_key_from_reference_result(underlying, row)
                    if ck:
                        keys.append(ck)
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                break
        return {"count": total, "keys": keys, "truncated": truncated, "error": None}

    def collect_option_contract_reference_rows_paginated(
        self,
        underlying: str,
        *,
        expiration_date: Optional[str],
        max_pages: int = 20,
        limit: int = 250,
    ) -> Dict[str, Any]:
        """Paginate GET /v3/reference/options/contracts; return rows with contract_key for PG/API column parity."""
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"count": 0, "rows": [], "truncated": False, "error": "symbol or api key missing"}
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {
            "underlying_ticker": underlying,
            "limit": min(int(limit), 250),
        }
        poly_exp = _expiry_to_polygon_date(expiration_date or "")
        if poly_exp:
            params["expiration_date"] = poly_exp
        out_rows: List[Dict[str, Any]] = []
        total = 0
        next_url: Optional[str] = None
        pages = 0
        truncated = False
        while True:
            if pages >= max_pages:
                if next_url:
                    truncated = True
                break
            pages += 1
            if next_url:
                status, data = self._get_json_from_next_url(next_url)
            else:
                status, data = self._get(path, params)
            if status >= 400:
                err = data.get("error", data) if isinstance(data, dict) else str(data)
                return {"count": total, "rows": out_rows, "truncated": truncated, "error": _as_error_str(err)}
            if not isinstance(data, dict):
                return {"count": total, "rows": out_rows, "truncated": truncated, "error": "invalid response"}
            poly_err = _polygon_body_error_message(data, status)
            if poly_err:
                return {"count": total, "rows": out_rows, "truncated": truncated, "error": poly_err}
            results = data.get("results")
            if not isinstance(results, list):
                break
            for row in results:
                total += 1
                if isinstance(row, dict):
                    ck = contract_key_from_reference_result(underlying, row)
                    if ck:
                        out_rows.append({"contract_key": ck, "result": row})
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                break
        return {"count": total, "rows": out_rows, "truncated": truncated, "error": None}

    def fetch_expirations_and_strikes(
        self,
        underlying: str,
        max_pages: int = 20,
        *,
        include_debug: bool = False,
        max_contract_samples: int = 200,
        expiration_date: Optional[str] = None,
        collect_contract_rows: bool = False,
    ) -> Dict[str, Any]:
        """Paginate /v3/reference/options/contracts; return expirations, strikes, tickers map.

        When *expiration_date* is set (YYYYMMDD or YYYY-MM-DD), Polygon filters
        server-side so only contracts for that single expiry are returned.

        When *collect_contract_rows* is True, each contract row is appended to
        ``contract_rows`` for PostgreSQL upserts (option_contracts).
        """
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            out_bad: Dict[str, Any] = {"expirations": [], "strikes": [], "error": "symbol or api key missing"}
            if collect_contract_rows:
                out_bad["contract_rows"] = []
            return out_bad
        expirations: set = set()
        strikes: set = set()
        contract_rows: List[Dict[str, Any]] = []
        debug_pages: List[Dict[str, Any]] = []
        contract_samples: List[Dict[str, Any]] = []
        next_url: Optional[str] = None
        path = "/v3/reference/options/contracts"
        params: Dict[str, Any] = {"underlying_ticker": underlying, "limit": 250}
        poly_exp = _expiry_to_polygon_date(expiration_date or "")
        if poly_exp:
            params["expiration_date"] = poly_exp
        pages = 0
        while pages < max_pages:
            pages += 1
            if next_url:
                # next_url is full URL from API; append apiKey if missing
                url = next_url
                if "apiKey=" not in url and "apikey=" not in url.lower():
                    sep = "&" if "?" in url else "?"
                    url = f"{url}{sep}apiKey={self._api_key}"
                url_redacted = _redact_url_api_key(url)
                req = Request(url, headers={"Accept": "application/json"}, method="GET")
                try:
                    with urlopen(req, timeout=60, context=self._ssl) as resp:
                        body = resp.read().decode("utf-8", errors="replace")
                        http_st = int(getattr(resp, "status", 200) or 200)
                        data = json.loads(body)
                except Exception as e:
                    out_e: Dict[str, Any] = {
                        "expirations": sorted(expirations),
                        "strikes": sorted(strikes),
                        "error": str(e),
                    }
                    if collect_contract_rows:
                        out_e["contract_rows"] = contract_rows
                    if include_debug:
                        out_e["massive_debug"] = {"pages": debug_pages, "contract_samples": contract_samples}
                    return out_e
                if include_debug:
                    debug_pages.append(
                        {
                            "page_index": pages,
                            "request": {"method": "GET", "url": url_redacted},
                            "response_status": http_st,
                            "response": data if isinstance(data, dict) else {"_non_object": data},
                        }
                    )
            else:
                url_redacted = self._redacted_get_url(path, params)
                status, data = self._get(path, params)
                if include_debug:
                    debug_pages.append(
                        {
                            "page_index": pages,
                            "request": {"method": "GET", "url": url_redacted},
                            "response_status": int(status),
                            "response": data if isinstance(data, dict) else {"_non_object": data},
                        }
                    )
                if status >= 400:
                    err_body = data.get("error", data) if isinstance(data, dict) else str(data)
                    out_err: Dict[str, Any] = {
                        "expirations": [],
                        "strikes": [],
                        "error": err_body,
                    }
                    if collect_contract_rows:
                        out_err["contract_rows"] = []
                    if include_debug:
                        out_err["massive_debug"] = {"pages": debug_pages, "contract_samples": []}
                    return out_err
            results = data.get("results") if isinstance(data, dict) else None
            if not results:
                break
            for r in results:
                if not isinstance(r, dict):
                    continue
                if include_debug and len(contract_samples) < max_contract_samples:
                    contract_samples.append(dict(r))
                ed = r.get("expiration_date") or r.get("expiration")
                if ed:
                    expirations.add(_norm_expiry(str(ed)[:10]))
                sp = r.get("strike_price")
                if sp is not None:
                    try:
                        strikes.add(float(sp))
                    except (TypeError, ValueError):
                        pass
                if collect_contract_rows and ed and sp is not None:
                    try:
                        contract_rows.append(
                            {
                                "ticker": (r.get("ticker") or "").strip(),
                                "expiration_date": _norm_expiry(str(ed)[:10]),
                                "strike_price": float(sp),
                                "contract_type": (r.get("contract_type") or "").strip(),
                            }
                        )
                    except (TypeError, ValueError):
                        pass
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                break
        out: Dict[str, Any] = {
            "expirations": sorted(expirations),
            "strikes": sorted(strikes),
        }
        if collect_contract_rows:
            out["contract_rows"] = contract_rows
        if include_debug:
            out["massive_debug"] = {
                "pages": debug_pages,
                "contract_samples": contract_samples,
                "contract_samples_truncated": len(contract_samples) >= max_contract_samples,
            }
        return out

    def fetch_option_contracts_list(
        self,
        underlying: str,
        *,
        expiration_date: Optional[str] = None,
        contract_type: Optional[str] = None,
        strike_price: Optional[float] = None,
        strike_price_gte: Optional[float] = None,
        strike_price_lte: Optional[float] = None,
        limit: Optional[int] = None,
        sort: Optional[str] = None,
        order: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v3/reference/options/contracts — raw contract listing with filters."""
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"results": [], "error": "symbol or api key missing"}
        params: Dict[str, Any] = {
            "underlying_ticker": underlying,
            "limit": min(int(limit or 100), 250),
        }
        poly_exp = _expiry_to_polygon_date(expiration_date or "")
        if poly_exp:
            params["expiration_date"] = poly_exp
        if contract_type:
            params["contract_type"] = contract_type.lower()
        if strike_price is not None:
            params["strike_price"] = strike_price
        if strike_price_gte is not None:
            params["strike_price.gte"] = strike_price_gte
        if strike_price_lte is not None:
            params["strike_price.lte"] = strike_price_lte
        if sort:
            params["sort"] = sort
        if order:
            params["order"] = order
        status, data = self._get("/v3/reference/options/contracts", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": [], "error": "invalid response"}

    def fetch_option_contract_detail(self, options_ticker: str) -> Dict[str, Any]:
        """GET /v3/reference/options/contracts/{options_ticker} — single contract metadata."""
        options_ticker = (options_ticker or "").strip()
        if not options_ticker or not self._api_key:
            return {"results": {}, "error": "options_ticker or api key missing"}
        status, data = self._get(f"/v3/reference/options/contracts/{options_ticker}")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": {}, "error": err}
        return data if isinstance(data, dict) else {"results": {}, "error": "invalid response"}

    def fetch_options_snapshot(
        self,
        underlying: str,
        *,
        strike_price: Optional[float] = None,
        strike_price_gte: Optional[float] = None,
        strike_price_lte: Optional[float] = None,
        expiration_date: Optional[str] = None,
        expiration_date_gte: Optional[str] = None,
        expiration_date_lte: Optional[str] = None,
        contract_type: Optional[str] = None,
        limit: Optional[int] = None,
        sort: Optional[str] = None,
        order: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v3/snapshot/options/{underlying} with optional filters."""
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"results": [], "error": "symbol or api key missing"}
        params: Dict[str, Any] = {}
        if strike_price is not None:
            params["strike_price"] = strike_price
        if strike_price_gte is not None:
            params["strike_price.gte"] = strike_price_gte
        if strike_price_lte is not None:
            params["strike_price.lte"] = strike_price_lte
        if expiration_date:
            poly = _expiry_to_polygon_date(expiration_date)
            if poly:
                params["expiration_date"] = poly
        if expiration_date_gte:
            poly = _expiry_to_polygon_date(expiration_date_gte)
            if poly:
                params["expiration_date.gte"] = poly
        if expiration_date_lte:
            poly = _expiry_to_polygon_date(expiration_date_lte)
            if poly:
                params["expiration_date.lte"] = poly
        if contract_type:
            params["contract_type"] = contract_type.lower()
        if limit is not None:
            params["limit"] = min(int(limit), 250)
        if sort:
            params["sort"] = sort
        if order:
            params["order"] = order
        status, data = self._get(f"/v3/snapshot/options/{underlying}", params or None)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": [], "error": "invalid response"}

    def fetch_options_snapshot_all_pages(
        self,
        underlying: str,
        *,
        page_delay_sec: float = 0.2,
        max_pages: int = 500,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Paginate GET /v3/snapshot/options/{underlying} until next_url is empty.

        Merges all ``results`` into a single list. Stops on error or *max_pages*.
        """
        underlying = (underlying or "").strip().upper()
        if not underlying or not self._api_key:
            return {"results": [], "error": "symbol or api key missing", "pages": 0}
        merged: List[Dict[str, Any]] = []
        next_url: Optional[str] = None
        pages = 0
        path = f"/v3/snapshot/options/{underlying}"
        while pages < max_pages:
            if next_url:
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
                    logger.warning("fetch_options_snapshot_all_pages page error: %s", e)
                    return {"results": merged, "error": str(e), "pages": pages}
            else:
                # First page: reuse same query params as fetch_options_snapshot
                q: Dict[str, Any] = {}
                if kwargs.get("strike_price") is not None:
                    q["strike_price"] = kwargs["strike_price"]
                if kwargs.get("strike_price_gte") is not None:
                    q["strike_price.gte"] = kwargs["strike_price_gte"]
                if kwargs.get("strike_price_lte") is not None:
                    q["strike_price.lte"] = kwargs["strike_price_lte"]
                exp = kwargs.get("expiration_date")
                if exp:
                    poly = _expiry_to_polygon_date(str(exp))
                    if poly:
                        q["expiration_date"] = poly
                eg = kwargs.get("expiration_date_gte")
                if eg:
                    poly = _expiry_to_polygon_date(str(eg))
                    if poly:
                        q["expiration_date.gte"] = poly
                el = kwargs.get("expiration_date_lte")
                if el:
                    poly = _expiry_to_polygon_date(str(el))
                    if poly:
                        q["expiration_date.lte"] = poly
                if kwargs.get("contract_type"):
                    q["contract_type"] = str(kwargs["contract_type"]).lower()
                lim = kwargs.get("limit")
                if lim is not None:
                    q["limit"] = min(int(lim), 250)
                if kwargs.get("sort"):
                    q["sort"] = str(kwargs["sort"])
                if kwargs.get("order"):
                    q["order"] = str(kwargs["order"])
                status, data = self._get(path, q or None)
                if status >= 400:
                    err = data.get("error", data) if isinstance(data, dict) else str(data)
                    return {"results": merged, "error": err, "pages": pages}
            if not isinstance(data, dict):
                return {"results": merged, "error": "invalid response", "pages": pages}
            chunk = data.get("results") or []
            if isinstance(chunk, list):
                merged.extend([x for x in chunk if isinstance(x, dict)])
            pages += 1
            next_url = data.get("next_url") if isinstance(data, dict) else None
            if not next_url:
                return {"results": merged, "error": None, "pages": pages}
            time.sleep(max(0.0, float(page_delay_sec)))
        return {"results": merged, "error": None, "pages": pages, "truncated": True}

    def fetch_option_contract_snapshot(self, underlying: str, option_contract: str) -> Dict[str, Any]:
        """GET /v3/snapshot/options/{underlyingAsset}/{optionContract}."""
        underlying = (underlying or "").strip().upper()
        option_contract = (option_contract or "").strip()
        if not underlying or not option_contract or not self._api_key:
            return {"results": {}, "error": "underlying, option_contract, or api key missing"}
        status, data = self._get(f"/v3/snapshot/options/{underlying}/{option_contract}")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": {}, "error": err}
        return data if isinstance(data, dict) else {"results": {}, "error": "invalid response"}

    def fetch_unified_snapshot(
        self,
        *,
        tickers: Optional[str] = None,
        asset_type: Optional[str] = None,
        ticker_gte: Optional[str] = None,
        ticker_lte: Optional[str] = None,
        limit: Optional[int] = None,
        sort: Optional[str] = None,
        order: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v3/snapshot — cross-asset unified snapshot."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        params: Dict[str, Any] = {}
        if tickers:
            params["ticker.any_of"] = tickers
        if asset_type:
            params["type"] = asset_type
        if ticker_gte:
            params["ticker.gte"] = ticker_gte
        if ticker_lte:
            params["ticker.lte"] = ticker_lte
        if limit is not None:
            params["limit"] = min(int(limit), 250)
        if sort:
            params["sort"] = sort
        if order:
            params["order"] = order
        status, data = self._get("/v3/snapshot", params or None)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    @staticmethod
    def _v2_range_aggs_query_params(ticker: str) -> Dict[str, Any]:
        """Query params for GET /v2/aggs/ticker/.../range/...

        Polygon **indices** (``I:SPX``) and **options** (``O:…``) omit ``adjusted``:
        index docs omit it; option contract bars can behave poorly or omit fields like ``vw``
        when ``adjusted=true`` is forced like equities.
        Stocks use ``adjusted=true`` by default.
        """
        t = (ticker or "").strip().upper()
        base: Dict[str, Any] = {"sort": "asc", "limit": 50000}
        if t.startswith("I:") or t.startswith("O:"):
            return base
        return {**base, "adjusted": "true"}

    def fetch_option_aggs(
        self,
        options_ticker: str,
        multiplier: int,
        timespan: str,
        start_ms: int,
        end_ms: int,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to} (ms).

        Follows ``next_url`` and merges ``results`` from all pages (Polygon caps page size).
        """
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": [], "error": "ticker or api key missing"}
        enc = quote(ot, safe="")
        path = f"/v2/aggs/ticker/{enc}/range/{multiplier}/{timespan}/{start_ms}/{end_ms}"
        params = self._v2_range_aggs_query_params(ot)
        status, data = self._get(path, params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        if not isinstance(data, dict):
            return {"results": []}
        logical = _polygon_body_error_message(data, status)
        if logical:
            return {"results": [], "error": logical}

        merged_results: List[Any] = []
        seen: Optional[Dict[str, Any]] = data
        max_pages = 200
        pages = 0
        while seen and pages < max_pages:
            pages += 1
            chunk = seen.get("results") or []
            if isinstance(chunk, list):
                merged_results.extend(chunk)
            next_url = seen.get("next_url") if isinstance(seen, dict) else None
            if not next_url:
                break
            url = next_url
            if "apiKey=" not in url and "apikey=" not in url.lower():
                sep = "&" if "?" in url else "?"
                url = f"{url}{sep}apiKey={self._api_key}"
            req = Request(url, headers={"Accept": "application/json"}, method="GET")
            try:
                with urlopen(req, timeout=120, context=self._ssl) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                    st = int(getattr(resp, "status", 200) or 200)
                    if st >= 400:
                        break
                    seen = json.loads(body)
            except (OSError, ValueError, json.JSONDecodeError) as e:
                logger.warning("fetch_option_aggs next_url fetch failed: %s", e)
                break
            if not isinstance(seen, dict):
                break
            logical = _polygon_body_error_message(seen, 200)
            if logical:
                break

        out = dict(data)
        out["results"] = merged_results
        out["next_url"] = None
        out["resultsCount"] = len(merged_results)
        return out

    def fetch_option_open_close(
        self,
        options_ticker: str,
        date: str,
        *,
        adjusted: bool = True,
    ) -> Dict[str, Any]:
        """GET /v1/open-close/{optionsTicker}/{date} — daily OHLC + pre/after-hours."""
        ot = (options_ticker or "").strip()
        d = (date or "").strip()
        if not ot or not d or not self._api_key:
            return {"error": "options_ticker, date, or api key missing"}
        params: Dict[str, Any] = {}
        if not adjusted:
            params["adjusted"] = "false"
        status, data = self._get(f"/v1/open-close/{ot}/{d}", params or None)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"error": err}
        return data if isinstance(data, dict) else {"error": "invalid response"}

    def fetch_option_previous_day(
        self,
        options_ticker: str,
        *,
        adjusted: bool = True,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/ticker/{optionsTicker}/prev — previous trading day OHLC."""
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": [], "error": "ticker or api key missing"}
        params: Dict[str, Any] = {}
        if not adjusted:
            params["adjusted"] = "false"
        status, data = self._get(f"/v2/aggs/ticker/{ot}/prev", params or None)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    # ── Stock aggregates (same Polygon paths as options; ticker e.g. AAPL) ──

    def fetch_stock_aggs(
        self,
        ticker: str,
        multiplier: int,
        timespan: str,
        start_ms: int,
        end_ms: int,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/ticker/{ticker}/range/... — custom-range OHLCV for a stock symbol."""
        return self.fetch_option_aggs(ticker, multiplier, timespan, start_ms, end_ms)

    def fetch_stock_open_close(
        self,
        ticker: str,
        date: str,
        *,
        adjusted: bool = True,
    ) -> Dict[str, Any]:
        """GET /v1/open-close/{ticker}/{date} — daily OHLC + pre/after-hours for a stock."""
        return self.fetch_option_open_close(ticker, date, adjusted=adjusted)

    def fetch_stock_previous_day(
        self,
        ticker: str,
        *,
        adjusted: bool = True,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/ticker/{ticker}/prev — previous trading day OHLC for a stock."""
        return self.fetch_option_previous_day(ticker, adjusted=adjusted)

    def fetch_stock_grouped_daily(
        self,
        date: str,
        *,
        adjusted: bool = True,
    ) -> Dict[str, Any]:
        """GET /v2/aggs/grouped/locale/us/market/stocks/{date} — all US stocks for one date."""
        d = (date or "").strip()
        if not d or not self._api_key:
            return {"results": [], "error": "date or api key missing"}
        enc = quote(d, safe="")
        params: Dict[str, Any] = {"adjusted": "true" if adjusted else "false"}
        status, data = self._get(
            f"/v2/aggs/grouped/locale/us/market/stocks/{enc}",
            params,
        )
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        if isinstance(data, dict):
            logical = _polygon_body_error_message(data, status)
            if logical:
                return {"results": [], "error": logical}
        return data if isinstance(data, dict) else {"results": []}

    # ── Corporate actions (Stocks REST) ──

    def fetch_dividends(
        self, ticker: str, limit: int = 1000
    ) -> Dict[str, Any]:
        """GET /v3/reference/dividends?ticker=…  (Polygon Stocks reference)."""
        ticker = (ticker or "").strip().upper()
        if not ticker or not self._api_key:
            return {"results": [], "error": "ticker or api key missing"}
        status, data = self._get(
            "/v3/reference/dividends",
            {"ticker": ticker, "limit": limit, "order": "desc", "sort": "ex_dividend_date"},
        )
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_splits(
        self, ticker: str, limit: int = 1000
    ) -> Dict[str, Any]:
        """GET /v3/reference/splits?ticker=…  (Polygon Stocks reference)."""
        ticker = (ticker or "").strip().upper()
        if not ticker or not self._api_key:
            return {"results": [], "error": "ticker or api key missing"}
        status, data = self._get(
            "/v3/reference/splits",
            {"ticker": ticker, "limit": limit, "order": "desc", "sort": "execution_date"},
        )
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    # ── Tickers reference (Stocks REST, read-only) ──

    def fetch_reference_tickers(
        self,
        *,
        ticker: Optional[str] = None,
        instrument_type: Optional[str] = None,
        market: Optional[str] = None,
        exchange: Optional[str] = None,
        search: Optional[str] = None,
        active: Optional[bool] = None,
        date: Optional[str] = None,
        limit: int = 100,
        sort: str = "ticker",
        order: str = "asc",
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v3/reference/tickers — paginated ticker universe (Polygon Stocks reference)."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        lim = min(max(int(limit), 1), 1000)
        params: Dict[str, Any] = {"limit": lim, "sort": sort, "order": order}
        if ticker:
            params["ticker"] = ticker.strip()
        if instrument_type:
            params["type"] = instrument_type.strip()
        if market:
            params["market"] = market.strip()
        if exchange:
            params["exchange"] = exchange.strip()
        if search:
            params["search"] = search.strip()
        if active is not None:
            params["active"] = "true" if active else "false"
        if date:
            params["date"] = date.strip()
        if cursor:
            params["cursor"] = cursor.strip()
        status, data = self._get("/v3/reference/tickers", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": _as_error_str(err)}
        if isinstance(data, dict):
            logical = _polygon_body_error_message(data, status)
            if logical:
                return {"results": [], "error": logical}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_ticker_detail(self, ticker: str, *, date: Optional[str] = None) -> Dict[str, Any]:
        """GET /v3/reference/tickers/{ticker} — single ticker metadata."""
        sym = (ticker or "").strip()
        if not sym or not self._api_key:
            return {"error": "ticker or api key missing"}
        enc = quote(sym, safe="")
        params: Dict[str, Any] = {}
        if date:
            params["date"] = date.strip()
        status, data = self._get(f"/v3/reference/tickers/{enc}", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"error": _as_error_str(err)}
        if isinstance(data, dict):
            logical = _polygon_body_error_message(data, status)
            if logical:
                return {"error": logical}
        return data if isinstance(data, dict) else {"error": "invalid response"}

    def fetch_ticker_types(
        self,
        *,
        asset_class: Optional[str] = None,
        locale: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v3/reference/tickers/types — instrument type codes."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        params: Dict[str, Any] = {}
        if asset_class:
            params["asset_class"] = asset_class.strip()
        if locale:
            params["locale"] = locale.strip()
        status, data = self._get("/v3/reference/tickers/types", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": _as_error_str(err)}
        if isinstance(data, dict):
            logical = _polygon_body_error_message(data, status)
            if logical:
                return {"results": [], "error": logical}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_related_companies(self, ticker: str) -> Dict[str, Any]:
        """GET /v1/related-companies/{ticker} — peer / related tickers."""
        sym = (ticker or "").strip().upper()
        if not sym or not self._api_key:
            return {"error": "ticker or api key missing"}
        enc = quote(sym, safe="")
        status, data = self._get(f"/v1/related-companies/{enc}")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"error": _as_error_str(err)}
        if isinstance(data, dict):
            logical = _polygon_body_error_message(data, status)
            if logical:
                return {"error": logical}
        return data if isinstance(data, dict) else {"error": "invalid response"}

    # ── Market Ops (cross-asset reference, read-only) ──

    def fetch_market_conditions(
        self,
        *,
        asset_class: Optional[str] = None,
        data_type: Optional[str] = None,
        limit: int = 1000,
    ) -> Dict[str, Any]:
        """GET /v3/reference/conditions — trade/quote condition codes."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        params: Dict[str, Any] = {"limit": limit}
        if asset_class:
            params["asset_class"] = asset_class
        if data_type:
            params["data_type"] = data_type
        status, data = self._get("/v3/reference/conditions", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_market_exchanges(self, *, asset_class: Optional[str] = None, locale: Optional[str] = None) -> Dict[str, Any]:
        """GET /v3/reference/exchanges — list of exchanges."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        params: Dict[str, Any] = {}
        if asset_class:
            params["asset_class"] = asset_class
        if locale:
            params["locale"] = locale
        status, data = self._get("/v3/reference/exchanges", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_market_holidays(self) -> Dict[str, Any]:
        """GET /v3/reference/market/holidays — upcoming market holidays."""
        if not self._api_key:
            return {"results": [], "error": "api key missing"}
        status, data = self._get("/v3/reference/market/holidays")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_market_status(self) -> Dict[str, Any]:
        """GET /v1/marketstatus/now — current trading status."""
        if not self._api_key:
            return {"error": "api key missing"}
        status, data = self._get("/v1/marketstatus/now")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"error": err}
        return data if isinstance(data, dict) else {"error": "invalid response"}

    # ── Technical Indicators (cross-asset, read-only) ──

    def _fetch_indicator(
        self,
        indicator: str,
        ticker: str,
        *,
        timespan: str = "day",
        window: int = 14,
        series_type: str = "close",
        adjusted: bool = True,
        order: str = "desc",
        limit: int = 100,
        expand_underlying: bool = False,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Generic helper for GET /v1/indicators/{indicator}/{ticker}."""
        ticker = (ticker or "").strip().upper()
        if not ticker or not self._api_key:
            return {"results": {}, "error": "ticker or api key missing"}
        params: Dict[str, Any] = {
            "timespan": timespan,
            "window": window,
            "series_type": series_type,
            "adjusted": str(adjusted).lower(),
            "order": order,
            "limit": limit,
            "expand_underlying": str(expand_underlying).lower(),
        }
        if extra:
            params.update(extra)
        status, data = self._get(f"/v1/indicators/{indicator}/{ticker}", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": {}, "error": err}
        return data if isinstance(data, dict) else {"results": {}}

    def fetch_indicator_sma(self, ticker: str, **kwargs: Any) -> Dict[str, Any]:
        """GET /v1/indicators/sma/{ticker} — Simple Moving Average."""
        return self._fetch_indicator("sma", ticker, **kwargs)

    def fetch_indicator_ema(self, ticker: str, **kwargs: Any) -> Dict[str, Any]:
        """GET /v1/indicators/ema/{ticker} — Exponential Moving Average."""
        return self._fetch_indicator("ema", ticker, **kwargs)

    def fetch_indicator_rsi(self, ticker: str, **kwargs: Any) -> Dict[str, Any]:
        """GET /v1/indicators/rsi/{ticker} — Relative Strength Index."""
        return self._fetch_indicator("rsi", ticker, **kwargs)

    def fetch_indicator_macd(
        self,
        ticker: str,
        *,
        short_window: int = 12,
        long_window: int = 26,
        signal_window: int = 9,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """GET /v1/indicators/macd/{ticker} — MACD."""
        extra = {
            "short_window": short_window,
            "long_window": long_window,
            "signal_window": signal_window,
        }
        return self._fetch_indicator(
            "macd", ticker, extra=extra, **kwargs,
        )

    # ── Trades & Quotes (Options REST) ──

    def fetch_last_trade(self, options_ticker: str) -> Dict[str, Any]:
        """GET /v2/last/trade/{optionsTicker} — most recent trade for a contract."""
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": {}, "error": "options_ticker or api key missing"}
        status, data = self._get(f"/v2/last/trade/{ot}")
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": {}, "error": err}
        return data if isinstance(data, dict) else {"results": {}}

    def fetch_option_quotes(
        self,
        options_ticker: str,
        *,
        timestamp_gte: Optional[str] = None,
        timestamp_lte: Optional[str] = None,
        limit: int = 100,
        sort: str = "timestamp",
        order: str = "asc",
    ) -> Dict[str, Any]:
        """GET /v3/quotes/{optionsTicker} — historical BBO quotes for a contract."""
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": [], "error": "options_ticker or api key missing"}
        params: Dict[str, Any] = {
            "limit": min(int(limit), 50000),
            "sort": sort,
            "order": order,
        }
        if timestamp_gte:
            params["timestamp.gte"] = timestamp_gte
        if timestamp_lte:
            params["timestamp.lte"] = timestamp_lte
        status, data = self._get(f"/v3/quotes/{ot}", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def fetch_option_trades(
        self,
        options_ticker: str,
        *,
        timestamp_gte: Optional[str] = None,
        timestamp_lte: Optional[str] = None,
        limit: int = 100,
        sort: str = "timestamp",
        order: str = "asc",
    ) -> Dict[str, Any]:
        """GET /v3/trades/{optionsTicker} — tick-level trade data for a contract."""
        ot = (options_ticker or "").strip()
        if not ot or not self._api_key:
            return {"results": [], "error": "options_ticker or api key missing"}
        params: Dict[str, Any] = {
            "limit": min(int(limit), 50000),
            "sort": sort,
            "order": order,
        }
        if timestamp_gte:
            params["timestamp.gte"] = timestamp_gte
        if timestamp_lte:
            params["timestamp.lte"] = timestamp_lte
        status, data = self._get(f"/v3/trades/{ot}", params)
        if status >= 400:
            err = data.get("error", data) if isinstance(data, dict) else str(data)
            return {"results": [], "error": err}
        return data if isinstance(data, dict) else {"results": []}

    def sleep_backoff(self, attempt: int) -> None:
        time.sleep(min(2.0 ** attempt, 30.0))
