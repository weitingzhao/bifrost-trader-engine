"""Fetch IB Flex Trades and upsert account_executions (or from uploaded XML)."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from src.connector.flex_client import fetch_trades, parse_trades_xml
from src.portfolio.services.execution_utils import rows_span
from src.monitor.reader import write_account_executions_to_db

logger = logging.getLogger(__name__)


def fetch_flex_trades_and_upsert_executions(
    reader: Any,
    control_via_db: Optional[dict],
    body: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Mirror POST /executions/fetch-flex (no HTTP)."""
    if not control_via_db:
        return {"ok": False, "error": "PostgreSQL is required to write account_executions.", "count": 0}
    try:
        entries: List[Dict[str, Any]] = []
        flex_list = reader.get_flex_config(purpose="trades")
        for a in flex_list:
            tok = (a.get("token") or "").strip()
            qid = (a.get("query_id") or "").strip()
            if tok and qid:
                role = (a.get("role") or "").strip() or "unknown"
                label = (a.get("query_label") or "").strip() or None
                entries.append({"token": tok, "query_id": qid, "role": role, "query_label": label})
        if not entries:
            return {
                "ok": False,
                "error": "No Flex credentials for trades: configure in Settings → IB Connection → Flex (token and query_id with purpose=trades).",
                "count": 0,
            }
        payload = body or {}
        from_date = (payload.get("from_date") or "").strip() or None
        to_date = (payload.get("to_date") or "").strip() or None
        range_mode = "manual" if from_date or to_date else "auto"
        range_days = None
        if from_date is None and to_date is None:
            stats_before = reader.get_flex_executions_stats()
            ib_cfg = reader.get_ib_config() or {}
            try:
                default_days = max(1, int(ib_cfg.get("flex_default_range_days", 30)))
            except Exception:
                default_days = 30
            try:
                init_days = max(1, int(ib_cfg.get("flex_init_range_days", 360)))
            except Exception:
                init_days = 360
            yesterday = date.today() - timedelta(days=1)
            to_date = yesterday.strftime("%Y%m%d")
            max_date = stats_before.get("max_date") if stats_before else None
            if not stats_before or (stats_before.get("count") or 0) == 0 or max_date is None:
                start = yesterday - timedelta(days=init_days)
                from_date = start.strftime("%Y%m%d")
                range_mode = "init"
                range_days = init_days
            else:
                try:
                    last_date = getattr(max_date, "date", lambda: max_date)()
                except Exception:
                    last_date = yesterday
                days_since_last = max(0, (yesterday - last_date).days)
                total_days = days_since_last + default_days
                start = yesterday - timedelta(days=total_days)
                from_date = start.strftime("%Y%m%d")
                range_mode = "incremental"
                range_days = total_days

        all_rows: List[Dict[str, Any]] = []
        errors: List[str] = []
        rows_per_fetch: List[int] = []
        per_query: List[Dict[str, Any]] = []
        for i, entry in enumerate(entries):
            token = entry["token"]
            query_id = entry["query_id"]
            role = entry.get("role") or "unknown"
            label = entry.get("query_label")
            try:
                rows = fetch_trades(token, query_id, from_date=from_date, to_date=to_date)
                used_fallback = False
                if not rows:
                    try:
                        rows_fallback = fetch_trades(token, query_id, period=5)
                        if rows_fallback:
                            rows = rows_fallback
                            used_fallback = True
                    except ValueError as e_fallback:
                        errors.append(f"Flex fallback (period=5) {i + 1}/{len(entries)} ({role} {query_id}): {e_fallback}")
                rows_per_fetch.append(len(rows))
                all_rows.extend(rows)
                span_from, span_to = rows_span(rows)
                per_query.append(
                    {
                        "role": role,
                        "query_id": query_id,
                        "label": label,
                        "rows": len(rows),
                        "data_from": span_from,
                        "data_to": span_to,
                        "used_fallback": used_fallback,
                    }
                )
            except ValueError as e:
                rows_per_fetch.append(-1)
                errors.append(f"Flex query {i + 1}/{len(entries)} ({role} {query_id}): {e}")
            except Exception:
                raise

        if errors and not all_rows:
            return {"ok": False, "error": "; ".join(errors), "count": 0, "by_account": len(entries), "by_account_counts": rows_per_fetch}

        data_from = None
        data_to = None
        if all_rows:
            min_d = None
            max_d = None
            for item in per_query:
                s_from = item.get("data_from")
                s_to = item.get("data_to")
                try:
                    if s_from:
                        d_from = datetime.strptime(s_from, "%Y-%m-%d").date()
                        if min_d is None or d_from < min_d:
                            min_d = d_from
                    if s_to:
                        d_to = datetime.strptime(s_to, "%Y-%m-%d").date()
                        if max_d is None or d_to > max_d:
                            max_d = d_to
                except Exception:
                    continue
            if min_d is not None:
                data_from = min_d.isoformat()
            if max_d is not None:
                data_to = max_d.isoformat()

        if not all_rows:
            return {
                "ok": True,
                "count": 0,
                "message": "No trades in Flex report.",
                "by_account": len(entries),
                "by_account_counts": rows_per_fetch,
                "data_from": data_from,
                "data_to": data_to,
                "raw_count": 0,
                "per_query": per_query,
            }

        raw_count = len(all_rows)
        if not write_account_executions_to_db(control_via_db, all_rows):
            return {
                "ok": False,
                "error": "Failed to write account_executions.",
                "count": 0,
                "raw_count": raw_count,
                "data_from": data_from,
                "data_to": data_to,
                "by_account": len(entries),
                "by_account_counts": rows_per_fetch,
                "per_query": per_query,
                "range_mode": range_mode,
                "range_days": range_days,
                "range_from": from_date,
                "range_to": to_date,
            }
        updated_accounts = len({(r.get("account_id") or "").strip() for r in all_rows if (r.get("account_id") or "").strip()})
        stats_after = reader.get_flex_executions_stats()
        last_date_after = stats_after.get("max_date") if stats_after else None
        last_date_after_str = None
        if last_date_after is not None:
            try:
                d = getattr(last_date_after, "date", lambda: last_date_after)()
                last_date_after_str = d.isoformat()
            except Exception:
                last_date_after_str = str(last_date_after)
        msg = f"Upserted {len(all_rows)} execution(s) from {len(entries)} Flex account config row(s); affected {updated_accounts} account(s)."
        if last_date_after_str:
            msg += f" Latest Flex execution date after update: {last_date_after_str}."
        if data_from and data_to:
            msg += f" Flex data time span: {data_from} .. {data_to}."
        if rows_per_fetch and len(rows_per_fetch) > 0 and rows_per_fetch[0] == 0 and (len(rows_per_fetch) == 1 or any(c > 0 for c in rows_per_fetch[1:])):
            msg += " Host (Query ID " + str(entries[0]["query_id"]) + ") returned 0 trades; in Settings > IB Connection > Flex ensure the purpose=trades row uses a Query that includes Activity > Trades and the date range covers your trades."
        if errors:
            msg += " Partial errors: " + "; ".join(errors)
        return {
            "ok": True,
            "count": len(all_rows),
            "raw_count": raw_count,
            "message": msg,
            "by_account": len(entries),
            "by_account_counts": rows_per_fetch,
            "per_query": per_query,
            "updated_accounts": updated_accounts,
            "range_mode": range_mode,
            "range_days": range_days,
            "range_from": from_date,
            "range_to": to_date,
            "last_flex_date_after": last_date_after_str,
            "data_from": data_from,
            "data_to": data_to,
        }
    except Exception as e:
        logger.exception("fetch_flex_trades_and_upsert_executions failed: %s", e)
        return {"ok": False, "error": str(e), "count": 0}


def upsert_executions_from_uploaded_flex_xml(control_via_db: Optional[dict], raw_xml: str) -> Dict[str, Any]:
    """Mirror POST /executions/fetch-flex-upload (no HTTP)."""
    if not control_via_db:
        return {"ok": False, "error": "PostgreSQL is required to write account_executions.", "count": 0}
    try:
        raw_xml = (raw_xml or "").strip()
        if not raw_xml:
            return {"ok": False, "error": "Missing xml field in request body.", "count": 0}
        rows = parse_trades_xml(raw_xml)
        if not rows:
            return {
                "ok": False,
                "error": "No Trade rows parsed from XML. Ensure this is a Flex Trades report (Activity → Trades).",
                "count": 0,
            }
        if not write_account_executions_to_db(control_via_db, rows):
            return {"ok": False, "error": "Failed to write account_executions.", "count": 0}
        updated_accounts = len({(r.get("account_id") or "").strip() for r in rows if (r.get("account_id") or "").strip()})
        return {
            "ok": True,
            "count": len(rows),
            "updated_accounts": updated_accounts,
            "message": f"Upserted {len(rows)} execution(s) from uploaded Flex XML for {updated_accounts} account(s).",
        }
    except Exception as e:
        logger.exception("upsert_executions_from_uploaded_flex_xml failed: %s", e)
        return {"ok": False, "error": str(e), "count": 0}
