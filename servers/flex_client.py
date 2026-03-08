"""
IB Flex Web Service client for fetching Cash Transactions (deposits, withdrawals, etc.).

Used by Performance Phase 0: POST /transactions/fetch pulls Flex report and writes to
account_transactions; GET /performance uses net_cash_flow from that table.

Config: IB_FLEX_TOKEN and IB_FLEX_QUERY_ID (env) or pass to fetch_cash_transactions().
"""

import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

FLEX_SEND_REQUEST_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest"
FLEX_GET_STATEMENT_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"
USER_AGENT = "Python/3.10"
MAX_GET_STATEMENT_POLLS = 24
POLL_INTERVAL_SEC = 5
MAX_FLEX_DAYS = 366  # IB Flex: date range cannot exceed 366 days when fd/td are used


def _text(elem: Optional[ET.Element], tag: str, default: str = "") -> str:
    if elem is None:
        return default
    child = elem.find(tag)
    if child is not None and child.text:
        return (child.text or "").strip()
    return default


def _normalize_type(flex_type: str, code: str, amount: float = 0) -> str:
    """Map Flex Type/Code to our canonical type: deposit, withdrawal, transfer, dividend, other.
    When type is Deposits/Withdrawals, use amount sign: positive -> deposit, negative -> withdrawal."""
    t = (flex_type or "").strip().lower()
    c = (code or "").strip().upper()
    if "deposits/withdrawals" in t or "deposits and withdrawals" in t:
        return "deposit" if amount >= 0 else "withdrawal"
    if "deposit" in t or "dep" in c or c == "DEP":
        return "deposit"
    if "withdraw" in t or "withdrawal" in t or "wth" in c or c == "WTH":
        return "withdrawal"
    if "transfer" in t or "tra" in c or "internal" in t:
        return "transfer"
    if "dividend" in t or "div" in c or "dvd" in c:
        return "dividend"
    return "other"


def request_report(
    token: str,
    query_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
) -> str:
    """
    Call Flex SendRequest; returns ReferenceCode on success.
    When both from_date and to_date are set, IB allows max 366 days; over that raises ValueError.
    """
    params: Dict[str, str] = {"t": token, "q": query_id, "v": "3"}
    if from_date and to_date:
        try:
            fd = datetime.strptime(from_date.strip()[:8], "%Y%m%d")
            td = datetime.strptime(to_date.strip()[:8], "%Y%m%d")
            if (td - fd).days > MAX_FLEX_DAYS:
                raise ValueError(
                    f"Date range cannot exceed {MAX_FLEX_DAYS} days (IB Flex limit). "
                    "Use from_date and to_date within 366 days, or omit both to use the query default period (e.g. Last 365 Calendar Days)."
                )
        except ValueError as e:
            if "cannot exceed" in str(e):
                raise
            raise ValueError(f"from_date and to_date must be yyyyMMdd format: {e}") from e
        params["fd"] = from_date.strip()[:8]
        params["td"] = to_date.strip()[:8]
    elif from_date or to_date:
        raise ValueError("When overriding dates, both from_date and to_date are required (yyyyMMdd).")
    url = f"{FLEX_SEND_REQUEST_URL}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (HTTPError, URLError) as e:
        logger.warning("Flex SendRequest HTTP error: %s", e)
        raise ValueError(f"Flex SendRequest failed: {e}") from e
    root = ET.fromstring(body)
    status = _text(root, "Status", "").strip().lower()
    if status == "fail":
        err_code = _text(root, "ErrorCode", "")
        err_msg = _text(root, "ErrorMessage", "Unknown error")
        raise ValueError(f"Flex request failed: [{err_code}] {err_msg}")
    ref = _text(root, "ReferenceCode", "").strip()
    if not ref:
        raise ValueError("Flex SendRequest returned no ReferenceCode")
    return ref


def get_statement(token: str, reference_code: str) -> str:
    """
    Call Flex GetStatement with the given ReferenceCode.
    Returns raw response body (XML statement). May poll a few times if report not ready.
    """
    params = {"t": token, "q": reference_code, "v": "3"}
    url = f"{FLEX_GET_STATEMENT_URL}?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    last_err: Optional[str] = None
    for attempt in range(MAX_GET_STATEMENT_POLLS):
        try:
            with urlopen(req, timeout=90) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError) as e:
            last_err = str(e)
            logger.debug("Flex GetStatement attempt %s: %s", attempt + 1, e)
            time.sleep(POLL_INTERVAL_SEC)
            continue
        # If response looks like error XML (Status Fail), treat as not ready and retry
        if body.strip().startswith("<?xml") or body.strip().startswith("<"):
            try:
                root = ET.fromstring(body)
                if _text(root, "Status", "").strip().lower() == "fail":
                    last_err = _text(root, "ErrorMessage", "Report not ready")
                    logger.debug("Flex GetStatement not ready: %s", last_err)
                    time.sleep(POLL_INTERVAL_SEC)
                    continue
            except ET.ParseError:
                pass
        return body
    raise ValueError(
        f"Flex GetStatement did not return report after {MAX_GET_STATEMENT_POLLS} attempts. Last: {last_err}"
    )


def parse_cash_transactions_xml(xml_body: str) -> List[Dict[str, Any]]:
    """
    Parse Flex statement XML and return list of cash transaction dicts.
    Each dict: account_id, ts (Unix float), amount, type, currency, description.
    Handles both element-based and attribute-based CashTransaction nodes.
    """
    def strip_ns(tag: str) -> str:
        if tag and "}" in tag:
            return tag.split("}", 1)[1]
        return tag or ""

    try:
        root = ET.fromstring(xml_body)
    except ET.ParseError as e:
        logger.warning("Flex XML parse error: %s", e)
        return []

    out: List[Dict[str, Any]] = []
    for elem in root.iter():
        if strip_ns(elem.tag) != "CashTransaction":
            continue
        account_id = _text(elem, "accountId") or _text(elem, "AccountId")
        date_time_str = _text(elem, "dateTime") or _text(elem, "DateTime") or _text(elem, "settleDate")
        amount_str = _text(elem, "amount") or _text(elem, "Amount")
        flex_type = _text(elem, "type") or _text(elem, "Type")
        code = _text(elem, "code") or _text(elem, "Code")
        currency = _text(elem, "currency") or _text(elem, "Currency")
        description = _text(elem, "description") or _text(elem, "Description")
        if not account_id:
            account_id = elem.get("accountId") or elem.get("accountID") or ""
        if not date_time_str:
            date_time_str = elem.get("dateTime") or elem.get("settleDate") or ""
        if not amount_str:
            amount_str = elem.get("amount") or "0"
        if not flex_type:
            flex_type = elem.get("type") or ""
        if not code:
            code = elem.get("code") or ""

        try:
            amount = float(amount_str.replace(",", ""))
        except (ValueError, TypeError):
            amount = 0.0
        if not account_id and amount == 0:
            continue
        ts_parsed: Optional[datetime] = None
        s = date_time_str.strip()
        for fmt in ("%Y%m%d;%H%M%S", "%Y%m%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                # Use slice so we don't pass extra chars (e.g. timezone) that break parsing
                n = 19 if "T" in fmt or " " in fmt else 8
                ts_parsed = datetime.strptime(s[:n], fmt)
                if ts_parsed.tzinfo is None:
                    ts_parsed = ts_parsed.replace(tzinfo=timezone.utc)
                break
            except (ValueError, TypeError):
                continue
        if ts_parsed is None and s:
            m = re.search(r"(\d{8})", s)
            if m:
                try:
                    ts_parsed = datetime.strptime(m.group(1), "%Y%m%d").replace(tzinfo=timezone.utc)
                except ValueError:
                    pass
        if ts_parsed is None:
            ts_parsed = datetime.now(timezone.utc)
        ts_float = ts_parsed.timestamp()
        tx_type = _normalize_type(flex_type, code, amount)
        out.append({
            "account_id": account_id.strip(),
            "ts": ts_float,
            "amount": amount,
            "type": tx_type,
            "currency": currency or None,
            "description": description or None,
        })
    return out


def fetch_cash_transactions(
    token: str,
    query_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Request Flex report and parse Cash Transactions.
    from_date / to_date: yyyyMMdd. When both are omitted, uses last 365 days from today (to_date=today, from_date=today-365).
    Returns list of dicts with account_id, ts, amount, type, currency, description.
    """
    if from_date is None and to_date is None:
        today = datetime.now(timezone.utc).date()
        to_date = today.strftime("%Y%m%d")
        from_date = (today - timedelta(days=365)).strftime("%Y%m%d")
        logger.info("Flex date range not specified; using last 365 days: %s to %s", from_date, to_date)
    ref = request_report(token, query_id, from_date, to_date)
    logger.info("Flex SendRequest OK, reference=%s", ref)
    body = get_statement(token, ref)
    return parse_cash_transactions_xml(body)
