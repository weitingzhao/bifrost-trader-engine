"""SEPA fundamentals raw tables: gap detection, upserts, and Celery feed helpers.

Massive Stocks REST v1 financials (flat) + short interest / short volume.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from psycopg2.extras import Json

logger = logging.getLogger(__name__)

SOURCE_DEFAULT = "massive"

_FQ_TO_PERIOD = {0: "FY", 1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4"}


def _symbol_from_gap_sql_row(r: Any) -> Optional[str]:
    """Extract symbol from a gap-query row.

    ``RealDictCursor`` rows are mapping-like and do **not** support ``r[0]`` (raises ``KeyError``).
    """
    if not r:
        return None
    v: Any
    if isinstance(r, dict):
        v = r.get("symbol")
    else:
        try:
            v = r[0]
        except (TypeError, KeyError, IndexError):
            return None
    if v is None or v == "":
        return None
    s = str(v).strip().upper()
    return s or None


def fetch_income_rows_for_sepa_from_pg(
    status_config: dict,
    symbol: str,
    *,
    min_quarterly: int = 5,
    min_annual: int = 4,
) -> Optional[Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]]:
    """Build quarterly/annual row dicts for ``evaluate_fundamentals`` from ``stock_income_statements``.

    Returns None if the table is missing or coverage is insufficient.
    """
    sym = (symbol or "").strip().upper()
    if not sym or not status_config:
        return None
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor

        from src.persistence.postgres.connection import _get_conn_params

        params = _get_conn_params(status_config)
        params["connect_timeout"] = 15
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.debug("fetch_income_rows_for_sepa_from_pg connect failed: %s", e)
        return None
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT to_regclass('public.stock_income_statements') IS NOT NULL AS texists"
            )
            if not bool((cur.fetchone() or {}).get("texists")):
                return None
            cur.execute(
                """
                SELECT timeframe, fiscal_year, fiscal_quarter, period_end, filing_date,
                       basic_earnings_per_share, revenue, diluted_earnings_per_share
                FROM public.stock_income_statements
                WHERE symbol = %s AND source = %s AND timeframe = 'quarterly'
                ORDER BY fiscal_year ASC, fiscal_quarter ASC
                """,
                (sym, SOURCE_DEFAULT),
            )
            q_db = cur.fetchall() or []
            cur.execute(
                """
                SELECT timeframe, fiscal_year, fiscal_quarter, period_end, filing_date,
                       basic_earnings_per_share, revenue, diluted_earnings_per_share
                FROM public.stock_income_statements
                WHERE symbol = %s AND source = %s AND timeframe = 'annual'
                ORDER BY fiscal_year ASC
                """,
                (sym, SOURCE_DEFAULT),
            )
            a_db = cur.fetchall() or []
    finally:
        conn.close()
    if len(q_db) < min_quarterly or len(a_db) < min_annual:
        return None

    def _map_q(r: Any) -> Dict[str, Any]:
        fq = int(r.get("fiscal_quarter") or 0)
        fp = _FQ_TO_PERIOD.get(fq, f"Q{fq}" if fq else "FY")
        fd = r.get("filing_date")
        fd_s = fd.isoformat() if hasattr(fd, "isoformat") else (str(fd)[:10] if fd else None)
        pe = r.get("period_end")
        pe_s = pe.isoformat() if hasattr(pe, "isoformat") else (str(pe)[:10] if pe else None)
        return {
            "fiscal_year": int(r.get("fiscal_year") or 0),
            "fiscal_period": fp,
            "filing_date": fd_s,
            "timeframe": "quarterly",
            "start_date": pe_s,
            "end_date": pe_s,
            "basic_earnings_per_share": r.get("basic_earnings_per_share"),
            "diluted_earnings_per_share": r.get("diluted_earnings_per_share"),
            "revenues": r.get("revenue"),
        }

    def _map_a(r: Any) -> Dict[str, Any]:
        fd = r.get("filing_date")
        fd_s = fd.isoformat() if hasattr(fd, "isoformat") else (str(fd)[:10] if fd else None)
        pe = r.get("period_end")
        pe_s = pe.isoformat() if hasattr(pe, "isoformat") else (str(pe)[:10] if pe else None)
        return {
            "fiscal_year": int(r.get("fiscal_year") or 0),
            "fiscal_period": "FY",
            "filing_date": fd_s,
            "timeframe": "annual",
            "start_date": pe_s,
            "end_date": pe_s,
            "basic_earnings_per_share": r.get("basic_earnings_per_share"),
            "diluted_earnings_per_share": r.get("diluted_earnings_per_share"),
            "revenues": r.get("revenue"),
        }

    return ([_map_q(r) for r in q_db], [_map_a(r) for r in a_db])


def _parse_date(val: Any) -> Optional[date]:
    if val is None:
        return None
    if isinstance(val, date) and not isinstance(val, datetime):
        return val
    s = str(val).strip()[:10]
    if len(s) < 10:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _f(row: Dict[str, Any], key: str) -> Optional[float]:
    v = row.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(row: Dict[str, Any], key: str) -> Optional[int]:
    v = row.get(key)
    if v is None:
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _sym_from_row(row: Dict[str, Any], fallback: Optional[str] = None) -> str:
    t = row.get("tickers")
    if isinstance(t, list) and t:
        return str(t[0]).strip().upper()
    if fallback:
        return fallback.strip().upper()
    return ""


def upsert_income_statement_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    """UPSERT rows from GET /stocks/financials/v1/income-statements results[]. Returns rows written."""
    if not rows:
        return 0
    sql = """
    INSERT INTO public.stock_income_statements (
        symbol, timeframe, period_end, filing_date, fiscal_year, fiscal_quarter,
        basic_earnings_per_share, diluted_earnings_per_share, revenue,
        basic_shares_outstanding, diluted_shares_outstanding,
        consolidated_net_income_loss, cost_of_revenue, gross_profit, operating_income,
        total_operating_expenses, selling_general_administrative, research_development,
        depreciation_depletion_amortization, ebitda, interest_income, interest_expense,
        other_income_expense, total_other_income_expense, income_before_income_taxes,
        income_taxes, net_income_loss_attributable_common_shareholders,
        noncontrolling_interest, discontinued_operations, extraordinary_items,
        equity_in_affiliates, preferred_stock_dividends_declared, other_operating_expenses,
        cik, source, fetched_at
    ) VALUES (
        %s,%s,%s,%s,%s,%s,
        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()
    )
    ON CONFLICT (symbol, timeframe, period_end, source) DO UPDATE SET
        filing_date = EXCLUDED.filing_date,
        fiscal_year = EXCLUDED.fiscal_year,
        fiscal_quarter = EXCLUDED.fiscal_quarter,
        basic_earnings_per_share = EXCLUDED.basic_earnings_per_share,
        diluted_earnings_per_share = EXCLUDED.diluted_earnings_per_share,
        revenue = EXCLUDED.revenue,
        basic_shares_outstanding = EXCLUDED.basic_shares_outstanding,
        diluted_shares_outstanding = EXCLUDED.diluted_shares_outstanding,
        consolidated_net_income_loss = EXCLUDED.consolidated_net_income_loss,
        cost_of_revenue = EXCLUDED.cost_of_revenue,
        gross_profit = EXCLUDED.gross_profit,
        operating_income = EXCLUDED.operating_income,
        total_operating_expenses = EXCLUDED.total_operating_expenses,
        selling_general_administrative = EXCLUDED.selling_general_administrative,
        research_development = EXCLUDED.research_development,
        depreciation_depletion_amortization = EXCLUDED.depreciation_depletion_amortization,
        ebitda = EXCLUDED.ebitda,
        interest_income = EXCLUDED.interest_income,
        interest_expense = EXCLUDED.interest_expense,
        other_income_expense = EXCLUDED.other_income_expense,
        total_other_income_expense = EXCLUDED.total_other_income_expense,
        income_before_income_taxes = EXCLUDED.income_before_income_taxes,
        income_taxes = EXCLUDED.income_taxes,
        net_income_loss_attributable_common_shareholders = EXCLUDED.net_income_loss_attributable_common_shareholders,
        noncontrolling_interest = EXCLUDED.noncontrolling_interest,
        discontinued_operations = EXCLUDED.discontinued_operations,
        extraordinary_items = EXCLUDED.extraordinary_items,
        equity_in_affiliates = EXCLUDED.equity_in_affiliates,
        preferred_stock_dividends_declared = EXCLUDED.preferred_stock_dividends_declared,
        other_operating_expenses = EXCLUDED.other_operating_expenses,
        cik = EXCLUDED.cik,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = _sym_from_row(row, fallback_symbol)
        if not sym:
            continue
        pe = _parse_date(row.get("period_end"))
        if not pe:
            continue
        tf = str(row.get("timeframe") or "").strip().lower() or "quarterly"
        fy = int(row.get("fiscal_year") or 0)
        fq = int(row.get("fiscal_quarter") or 0)
        fd = _parse_date(row.get("filing_date"))
        cur.execute(
            sql,
            (
                sym,
                tf,
                pe,
                fd,
                fy,
                fq,
                _f(row, "basic_earnings_per_share"),
                _f(row, "diluted_earnings_per_share"),
                _f(row, "revenue"),
                _f(row, "basic_shares_outstanding"),
                _f(row, "diluted_shares_outstanding"),
                _f(row, "consolidated_net_income_loss"),
                _f(row, "cost_of_revenue"),
                _f(row, "gross_profit"),
                _f(row, "operating_income"),
                _f(row, "total_operating_expenses"),
                _f(row, "selling_general_administrative"),
                _f(row, "research_development"),
                _f(row, "depreciation_depletion_amortization"),
                _f(row, "ebitda"),
                _f(row, "interest_income"),
                _f(row, "interest_expense"),
                _f(row, "other_income_expense"),
                _f(row, "total_other_income_expense"),
                _f(row, "income_before_income_taxes"),
                _f(row, "income_taxes"),
                _f(row, "net_income_loss_attributable_common_shareholders"),
                _f(row, "noncontrolling_interest"),
                _f(row, "discontinued_operations"),
                _f(row, "extraordinary_items"),
                _f(row, "equity_in_affiliates"),
                _f(row, "preferred_stock_dividends_declared"),
                _f(row, "other_operating_expenses"),
                (str(row.get("cik")).strip() if row.get("cik") else None),
                source,
            ),
        )
        n += 1
    return n


def upsert_balance_sheet_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    if not rows:
        return 0
    sql = """
    INSERT INTO public.stock_balance_sheets (
        symbol, timeframe, period_end, filing_date, fiscal_year, fiscal_quarter,
        accounts_payable, accrued_and_other_current_liabilities,
        accumulated_other_comprehensive_income, additional_paid_in_capital,
        cash_and_equivalents, cik, commitments_and_contingencies, common_stock,
        debt_current, deferred_revenue_current, goodwill, intangible_assets_net,
        inventories, long_term_debt_and_capital_lease_obligations, noncontrolling_interest,
        other_assets, other_current_assets, other_equity, other_noncurrent_liabilities,
        preferred_stock, property_plant_equipment_net, receivables, retained_earnings_deficit,
        short_term_investments, total_assets, total_current_assets, total_current_liabilities,
        total_equity, total_equity_attributable_to_parent, total_liabilities,
        total_liabilities_and_equity, treasury_stock, source, fetched_at
    ) VALUES (
        %s,%s,%s,%s,%s,%s,
        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()
    )
    ON CONFLICT (symbol, timeframe, period_end, source) DO UPDATE SET
        filing_date = EXCLUDED.filing_date,
        fiscal_year = EXCLUDED.fiscal_year,
        fiscal_quarter = EXCLUDED.fiscal_quarter,
        accounts_payable = EXCLUDED.accounts_payable,
        accrued_and_other_current_liabilities = EXCLUDED.accrued_and_other_current_liabilities,
        accumulated_other_comprehensive_income = EXCLUDED.accumulated_other_comprehensive_income,
        additional_paid_in_capital = EXCLUDED.additional_paid_in_capital,
        cash_and_equivalents = EXCLUDED.cash_and_equivalents,
        cik = EXCLUDED.cik,
        commitments_and_contingencies = EXCLUDED.commitments_and_contingencies,
        common_stock = EXCLUDED.common_stock,
        debt_current = EXCLUDED.debt_current,
        deferred_revenue_current = EXCLUDED.deferred_revenue_current,
        goodwill = EXCLUDED.goodwill,
        intangible_assets_net = EXCLUDED.intangible_assets_net,
        inventories = EXCLUDED.inventories,
        long_term_debt_and_capital_lease_obligations = EXCLUDED.long_term_debt_and_capital_lease_obligations,
        noncontrolling_interest = EXCLUDED.noncontrolling_interest,
        other_assets = EXCLUDED.other_assets,
        other_current_assets = EXCLUDED.other_current_assets,
        other_equity = EXCLUDED.other_equity,
        other_noncurrent_liabilities = EXCLUDED.other_noncurrent_liabilities,
        preferred_stock = EXCLUDED.preferred_stock,
        property_plant_equipment_net = EXCLUDED.property_plant_equipment_net,
        receivables = EXCLUDED.receivables,
        retained_earnings_deficit = EXCLUDED.retained_earnings_deficit,
        short_term_investments = EXCLUDED.short_term_investments,
        total_assets = EXCLUDED.total_assets,
        total_current_assets = EXCLUDED.total_current_assets,
        total_current_liabilities = EXCLUDED.total_current_liabilities,
        total_equity = EXCLUDED.total_equity,
        total_equity_attributable_to_parent = EXCLUDED.total_equity_attributable_to_parent,
        total_liabilities = EXCLUDED.total_liabilities,
        total_liabilities_and_equity = EXCLUDED.total_liabilities_and_equity,
        treasury_stock = EXCLUDED.treasury_stock,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = _sym_from_row(row, fallback_symbol)
        pe = _parse_date(row.get("period_end"))
        if not sym or not pe:
            continue
        tf = str(row.get("timeframe") or "").strip().lower() or "quarterly"
        fy = int(row.get("fiscal_year") or 0)
        fq = int(row.get("fiscal_quarter") or 0)
        fd = _parse_date(row.get("filing_date"))
        cur.execute(
            sql,
            (
                sym,
                tf,
                pe,
                fd,
                fy,
                fq,
                _f(row, "accounts_payable"),
                _f(row, "accrued_and_other_current_liabilities"),
                _f(row, "accumulated_other_comprehensive_income"),
                _f(row, "additional_paid_in_capital"),
                _f(row, "cash_and_equivalents"),
                (str(row.get("cik")).strip() if row.get("cik") else None),
                _f(row, "commitments_and_contingencies"),
                _f(row, "common_stock"),
                _f(row, "debt_current"),
                _f(row, "deferred_revenue_current"),
                _f(row, "goodwill"),
                _f(row, "intangible_assets_net"),
                _f(row, "inventories"),
                _f(row, "long_term_debt_and_capital_lease_obligations"),
                _f(row, "noncontrolling_interest"),
                _f(row, "other_assets"),
                _f(row, "other_current_assets"),
                _f(row, "other_equity"),
                _f(row, "other_noncurrent_liabilities"),
                _f(row, "preferred_stock"),
                _f(row, "property_plant_equipment_net"),
                _f(row, "receivables"),
                _f(row, "retained_earnings_deficit"),
                _f(row, "short_term_investments"),
                _f(row, "total_assets"),
                _f(row, "total_current_assets"),
                _f(row, "total_current_liabilities"),
                _f(row, "total_equity"),
                _f(row, "total_equity_attributable_to_parent"),
                _f(row, "total_liabilities"),
                _f(row, "total_liabilities_and_equity"),
                _f(row, "treasury_stock"),
                source,
            ),
        )
        n += 1
    return n


def upsert_cash_flow_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    if not rows:
        return 0
    sql = """
    INSERT INTO public.stock_cash_flows (
        symbol, timeframe, period_end, filing_date, fiscal_year, fiscal_quarter,
        net_cash_flow_from_operating_activities, net_cash_flow_from_investing_activities,
        net_cash_flow_from_financing_activities, net_change_in_cash_and_equivalents,
        free_cash_flow, capital_expenditure, depreciation_and_amortization, cik, source, fetched_at
    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
    ON CONFLICT (symbol, timeframe, period_end, source) DO UPDATE SET
        filing_date = EXCLUDED.filing_date,
        fiscal_year = EXCLUDED.fiscal_year,
        fiscal_quarter = EXCLUDED.fiscal_quarter,
        net_cash_flow_from_operating_activities = EXCLUDED.net_cash_flow_from_operating_activities,
        net_cash_flow_from_investing_activities = EXCLUDED.net_cash_flow_from_investing_activities,
        net_cash_flow_from_financing_activities = EXCLUDED.net_cash_flow_from_financing_activities,
        net_change_in_cash_and_equivalents = EXCLUDED.net_change_in_cash_and_equivalents,
        free_cash_flow = EXCLUDED.free_cash_flow,
        capital_expenditure = EXCLUDED.capital_expenditure,
        depreciation_and_amortization = EXCLUDED.depreciation_and_amortization,
        cik = EXCLUDED.cik,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = _sym_from_row(row, fallback_symbol)
        pe = _parse_date(row.get("period_end"))
        if not sym or not pe:
            continue
        tf = str(row.get("timeframe") or "").strip().lower() or "quarterly"
        fy = int(row.get("fiscal_year") or 0)
        fq = int(row.get("fiscal_quarter") or 0)
        fd = _parse_date(row.get("filing_date"))
        op = _f(row, "net_cash_flow_from_operating_activities") or _f(row, "net_cash_flow_from_operatingactivities")
        inv = _f(row, "net_cash_flow_from_investing_activities") or _f(row, "net_cash_flow_from_investingactivities")
        fin = _f(row, "net_cash_flow_from_financing_activities") or _f(row, "net_cash_flow_from_financingactivities")
        chg = _f(row, "net_change_in_cash_and_equivalents") or _f(row, "net_change_in_cash")
        fcf = _f(row, "free_cash_flow")
        capex = _f(row, "capital_expenditure") or _f(row, "capital_expenditures")
        dep = _f(row, "depreciation_and_amortization") or _f(row, "depreciation_depletion_and_amortization")
        cur.execute(
            sql,
            (
                sym,
                tf,
                pe,
                fd,
                fy,
                fq,
                op,
                inv,
                fin,
                chg,
                fcf,
                capex,
                dep,
                (str(row.get("cik")).strip() if row.get("cik") else None),
                source,
            ),
        )
        n += 1
    return n


def upsert_ratios_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    if not rows:
        return 0
    sql = """
    INSERT INTO public.stock_ratios (
        symbol, timeframe, period_end, filing_date, fiscal_year, fiscal_quarter,
        basic_earnings_per_share, diluted_earnings_per_share,
        return_on_equity, return_on_assets, debt_to_equity, current_ratio,
        gross_margin, operating_margin, net_margin,
        revenue, net_income, total_assets, total_equity, total_liabilities,
        cik, source, fetched_at
    ) VALUES (
        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()
    )
    ON CONFLICT (symbol, timeframe, period_end, source) DO UPDATE SET
        filing_date = EXCLUDED.filing_date,
        fiscal_year = EXCLUDED.fiscal_year,
        fiscal_quarter = EXCLUDED.fiscal_quarter,
        basic_earnings_per_share = EXCLUDED.basic_earnings_per_share,
        diluted_earnings_per_share = EXCLUDED.diluted_earnings_per_share,
        return_on_equity = EXCLUDED.return_on_equity,
        return_on_assets = EXCLUDED.return_on_assets,
        debt_to_equity = EXCLUDED.debt_to_equity,
        current_ratio = EXCLUDED.current_ratio,
        gross_margin = EXCLUDED.gross_margin,
        operating_margin = EXCLUDED.operating_margin,
        net_margin = EXCLUDED.net_margin,
        revenue = EXCLUDED.revenue,
        net_income = EXCLUDED.net_income,
        total_assets = EXCLUDED.total_assets,
        total_equity = EXCLUDED.total_equity,
        total_liabilities = EXCLUDED.total_liabilities,
        cik = EXCLUDED.cik,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = _sym_from_row(row, fallback_symbol)
        pe = _parse_date(row.get("period_end") or row.get("end_date"))
        if not sym or not pe:
            continue
        tf = str(row.get("timeframe") or "").strip().lower() or "quarterly"
        fy = int(row.get("fiscal_year") or 0)
        fq = int(row.get("fiscal_quarter") or 0)
        fd = _parse_date(row.get("filing_date"))
        cur.execute(
            sql,
            (
                sym,
                tf,
                pe,
                fd,
                fy,
                fq,
                _f(row, "basic_earnings_per_share"),
                _f(row, "diluted_earnings_per_share"),
                _f(row, "return_on_equity"),
                _f(row, "return_on_assets"),
                _f(row, "debt_to_equity"),
                _f(row, "current_ratio"),
                _f(row, "gross_margin"),
                _f(row, "operating_margin"),
                _f(row, "net_margin"),
                _f(row, "revenue"),
                _f(row, "net_income"),
                _f(row, "total_assets"),
                _f(row, "total_equity"),
                _f(row, "total_liabilities"),
                (str(row.get("cik")).strip() if row.get("cik") else None),
                source,
            ),
        )
        n += 1
    return n


def upsert_short_interest_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    if not rows:
        return 0
    sql = """
    INSERT INTO public.stock_short_interest (
        symbol, settlement_date, short_interest, avg_daily_volume, days_to_cover, cik, source, fetched_at
    ) VALUES (%s,%s,%s,%s,%s,%s,%s,now())
    ON CONFLICT (symbol, settlement_date, source) DO UPDATE SET
        short_interest = EXCLUDED.short_interest,
        avg_daily_volume = EXCLUDED.avg_daily_volume,
        days_to_cover = EXCLUDED.days_to_cover,
        cik = EXCLUDED.cik,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = (row.get("ticker") or row.get("symbol") or fallback_symbol or "")
        sym = str(sym).strip().upper()
        sd = _parse_date(row.get("settlement_date"))
        if not sym or not sd:
            continue
        si = row.get("short_interest") or row.get("short_interest_shares") or row.get("short_shares")
        si_val: Optional[int] = None
        if si is not None:
            try:
                si_val = int(float(si))
            except (TypeError, ValueError):
                si_val = None
        cur.execute(
            sql,
            (
                sym,
                sd,
                si_val,
                _f(row, "avg_daily_volume") or _f(row, "avg_daily_volume_consolidated"),
                _f(row, "days_to_cover"),
                (str(row.get("cik")).strip() if row.get("cik") else None),
                source,
            ),
        )
        n += 1
    return n


def upsert_short_volume_rows(
    cur: Any,
    rows: List[Dict[str, Any]],
    *,
    fallback_symbol: Optional[str] = None,
    source: str = SOURCE_DEFAULT,
) -> int:
    if not rows:
        return 0

    sql = """
    INSERT INTO public.stock_short_volume (
        symbol, trade_date, short_volume, total_volume, short_volume_ratio, exchanges, cik, source, fetched_at
    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now())
    ON CONFLICT (symbol, trade_date, source) DO UPDATE SET
        short_volume = EXCLUDED.short_volume,
        total_volume = EXCLUDED.total_volume,
        short_volume_ratio = EXCLUDED.short_volume_ratio,
        exchanges = EXCLUDED.exchanges,
        cik = EXCLUDED.cik,
        fetched_at = now()
    """
    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        sym = (row.get("ticker") or row.get("symbol") or fallback_symbol or "")
        sym = str(sym).strip().upper()
        td = _parse_date(row.get("date") or row.get("trade_date"))
        if not sym or not td:
            continue
        ex = row.get("exchanges")
        ex_js = Json(ex) if ex is not None else None
        sv = row.get("short_volume")
        tv = row.get("total_volume")
        sv_i = int(float(sv)) if sv is not None else None
        tv_i = int(float(tv)) if tv is not None else None
        cur.execute(
            sql,
            (
                sym,
                td,
                sv_i,
                tv_i,
                _f(row, "short_volume_ratio"),
                ex_js,
                (str(row.get("cik")).strip() if row.get("cik") else None),
                source,
            ),
        )
        n += 1
    return n


_INCOME_GAP_DETAIL_SQL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol,
           count(*)::integer AS n,
           count(*) FILTER (WHERE basic_earnings_per_share IS NOT NULL)::integer AS eps_n,
           count(*) FILTER (WHERE revenue IS NOT NULL)::integer AS rev_n,
           max(period_end) AS max_pe
    FROM public.stock_income_statements
    WHERE source = 'massive' AND timeframe = 'quarterly'
    GROUP BY symbol
),
a AS (
    SELECT symbol, count(*)::integer AS n, max(period_end) AS max_pe
    FROM public.stock_income_statements
    WHERE source = 'massive' AND timeframe = 'annual'
    GROUP BY symbol
)
SELECT
    u.symbol,
    COALESCE(q.n, 0) AS quarterly_rows,
    COALESCE(a.n, 0) AS annual_rows,
    q.max_pe::text AS quarterly_max_period_end,
    a.max_pe::text AS annual_max_period_end,
    CASE
        WHEN q.symbol IS NULL THEN 'missing_quarterly'
        WHEN q.n < 5 THEN 'insufficient_quarterly'
        WHEN q.n > 0 AND (q.eps_n::float / q.n) < 0.8 THEN 'eps_null_ratio_high'
        WHEN q.n > 0 AND (q.rev_n::float / q.n) < 0.8 THEN 'revenue_null_ratio_high'
        WHEN a.symbol IS NULL OR a.n < 4 THEN 'insufficient_annual'
        ELSE NULL
    END AS gap_reason
FROM u
LEFT JOIN q ON q.symbol = u.symbol
LEFT JOIN a ON a.symbol = u.symbol
WHERE q.symbol IS NULL OR q.n < 5 OR a.symbol IS NULL OR a.n < 4
   OR (q.n > 0 AND (q.eps_n::float / q.n) < 0.8)
   OR (q.n > 0 AND (q.rev_n::float / q.n) < 0.8)
ORDER BY u.symbol
LIMIT %s
"""

_INCOME_GAP_COUNT_SQL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol,
           count(*)::integer AS n,
           count(*) FILTER (WHERE basic_earnings_per_share IS NOT NULL)::integer AS eps_n,
           count(*) FILTER (WHERE revenue IS NOT NULL)::integer AS rev_n
    FROM public.stock_income_statements
    WHERE source = 'massive' AND timeframe = 'quarterly'
    GROUP BY symbol
),
a AS (
    SELECT symbol, count(*)::integer AS n
    FROM public.stock_income_statements
    WHERE source = 'massive' AND timeframe = 'annual'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n
FROM u
LEFT JOIN q ON q.symbol = u.symbol
LEFT JOIN a ON a.symbol = u.symbol
WHERE q.symbol IS NULL OR q.n < 5 OR a.symbol IS NULL OR a.n < 4
   OR (q.n > 0 AND (q.eps_n::float / q.n) < 0.8)
   OR (q.n > 0 AND (q.rev_n::float / q.n) < 0.8)
"""


def count_income_statements_gaps(cur: Any) -> int:
    cur.execute(_INCOME_GAP_COUNT_SQL)
    row = cur.fetchone()
    return int(row["n"] or 0) if row else 0


def get_income_statements_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_INCOME_GAP_COUNT_SQL)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_INCOME_GAP_DETAIL_SQL, (max(1, min(int(limit), 5000)),))
    rows = cur.fetchall() or []
    out = [dict(r) for r in rows]
    return out, total


_BALANCE_GAP_COUNT = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n,
           count(*) FILTER (WHERE total_assets IS NOT NULL)::integer AS ta_n
    FROM public.stock_balance_sheets
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n FROM u
LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (q.ta_n::float/q.n) < 0.9)
"""

_BALANCE_GAP_DETAIL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n,
           count(*) FILTER (WHERE total_assets IS NOT NULL)::integer AS ta_n
    FROM public.stock_balance_sheets
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT u.symbol, COALESCE(q.n,0) AS quarterly_rows, NULL::text AS annual_max_period_end,
    CASE WHEN q.symbol IS NULL THEN 'missing'
         WHEN q.n < 4 THEN 'insufficient_quarterly'
         WHEN q.n > 0 AND (q.ta_n::float/q.n) < 0.9 THEN 'total_assets_null_ratio_high'
         ELSE NULL END AS gap_reason
FROM u LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (q.ta_n::float/q.n) < 0.9)
ORDER BY u.symbol LIMIT %s
"""


def count_balance_sheet_gaps(cur: Any) -> int:
    cur.execute(_BALANCE_GAP_COUNT)
    return int((cur.fetchone() or {}).get("n") or 0)


def get_balance_sheet_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_BALANCE_GAP_COUNT)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_BALANCE_GAP_DETAIL, (max(1, min(int(limit), 5000)),))
    return [dict(r) for r in (cur.fetchall() or [])], total


_CF_GAP_COUNT = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n,
           count(*) FILTER (WHERE net_cash_flow_from_operating_activities IS NOT NULL)::integer AS op_n
    FROM public.stock_cash_flows
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n FROM u
LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (op_n::float/q.n) < 0.8)
"""

_CF_GAP_DETAIL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n,
           count(*) FILTER (WHERE net_cash_flow_from_operating_activities IS NOT NULL)::integer AS op_n
    FROM public.stock_cash_flows
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT u.symbol, COALESCE(q.n,0) AS quarterly_rows, NULL::text AS annual_max_period_end,
    CASE WHEN q.symbol IS NULL THEN 'missing'
         WHEN q.n < 4 THEN 'insufficient_quarterly'
         WHEN q.n > 0 AND (op_n::float/q.n) < 0.8 THEN 'operating_cf_null_ratio_high'
         ELSE NULL END AS gap_reason
FROM u LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (op_n::float/q.n) < 0.8)
ORDER BY u.symbol LIMIT %s
"""


def count_cash_flow_gaps(cur: Any) -> int:
    cur.execute(_CF_GAP_COUNT)
    return int((cur.fetchone() or {}).get("n") or 0)


def get_cash_flow_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_CF_GAP_COUNT)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_CF_GAP_DETAIL, (max(1, min(int(limit), 5000)),))
    return [dict(r) for r in (cur.fetchall() or [])], total


_RAT_GAP_COUNT = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n
    FROM public.stock_ratios
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n FROM u
LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4
"""

_RAT_GAP_DETAIL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
q AS (
    SELECT symbol, count(*)::integer AS n
    FROM public.stock_ratios
    WHERE source='massive' AND timeframe='quarterly'
    GROUP BY symbol
)
SELECT u.symbol, COALESCE(q.n,0) AS quarterly_rows, NULL::text AS annual_max_period_end,
    CASE WHEN q.symbol IS NULL OR q.n < 4 THEN 'insufficient_quarterly' ELSE NULL END AS gap_reason
FROM u LEFT JOIN q ON q.symbol=u.symbol
WHERE q.symbol IS NULL OR q.n < 4
ORDER BY u.symbol LIMIT %s
"""


def count_ratios_gaps(cur: Any) -> int:
    cur.execute(_RAT_GAP_COUNT)
    return int((cur.fetchone() or {}).get("n") or 0)


def get_ratios_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_RAT_GAP_COUNT)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_RAT_GAP_DETAIL, (max(1, min(int(limit), 5000)),))
    return [dict(r) for r in (cur.fetchall() or [])], total


_SI_GAP_COUNT = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
h AS (
    SELECT symbol, count(*)::integer AS n,
           max(settlement_date) AS mx
    FROM public.stock_short_interest
    WHERE source='massive'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n FROM u
LEFT JOIN h ON h.symbol=u.symbol
WHERE h.symbol IS NULL OR h.n < 1 OR h.mx < (CURRENT_DATE - integer '45')
"""

_SI_GAP_DETAIL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
h AS (
    SELECT symbol, count(*)::integer AS n,
           max(settlement_date) AS mx
    FROM public.stock_short_interest
    WHERE source='massive'
    GROUP BY symbol
)
SELECT u.symbol, COALESCE(h.n,0) AS quarterly_rows, h.mx::text AS annual_max_period_end,
    CASE WHEN h.symbol IS NULL OR h.n < 1 THEN 'missing'
         WHEN h.mx < (CURRENT_DATE - integer '45') THEN 'stale_settlement'
         ELSE NULL END AS gap_reason
FROM u LEFT JOIN h ON h.symbol=u.symbol
WHERE h.symbol IS NULL OR h.n < 1 OR h.mx < (CURRENT_DATE - integer '45')
ORDER BY u.symbol LIMIT %s
"""


def count_short_interest_gaps(cur: Any) -> int:
    cur.execute(_SI_GAP_COUNT)
    return int((cur.fetchone() or {}).get("n") or 0)


def get_short_interest_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_SI_GAP_COUNT)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_SI_GAP_DETAIL, (max(1, min(int(limit), 5000)),))
    return [dict(r) for r in (cur.fetchall() or [])], total


_SV_GAP_COUNT = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
d AS (
    SELECT symbol, count(*)::integer AS n, max(trade_date) AS mx
    FROM public.stock_short_volume
    WHERE source='massive'
    GROUP BY symbol
)
SELECT count(*)::bigint AS n FROM u
LEFT JOIN d ON d.symbol=u.symbol
WHERE d.symbol IS NULL OR d.n < 5 OR d.mx < (CURRENT_DATE - integer '14')
"""

_SV_GAP_DETAIL = """
WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
d AS (
    SELECT symbol, count(*)::integer AS n, max(trade_date) AS mx
    FROM public.stock_short_volume
    WHERE source='massive'
    GROUP BY symbol
)
SELECT u.symbol, COALESCE(d.n,0) AS quarterly_rows, d.mx::text AS annual_max_period_end,
    CASE WHEN d.symbol IS NULL OR d.n < 5 THEN 'insufficient_rows'
         WHEN d.mx < (CURRENT_DATE - integer '14') THEN 'stale_trade_dates'
         ELSE NULL END AS gap_reason
FROM u LEFT JOIN d ON d.symbol=u.symbol
WHERE d.symbol IS NULL OR d.n < 5 OR d.mx < (CURRENT_DATE - integer '14')
ORDER BY u.symbol LIMIT %s
"""


def count_short_volume_gaps(cur: Any) -> int:
    cur.execute(_SV_GAP_COUNT)
    return int((cur.fetchone() or {}).get("n") or 0)


def get_short_volume_gap_details(cur: Any, *, limit: int = 2000) -> Tuple[List[Dict[str, Any]], int]:
    cur.execute(_SV_GAP_COUNT)
    total = int((cur.fetchone() or {}).get("n") or 0)
    cur.execute(_SV_GAP_DETAIL, (max(1, min(int(limit), 5000)),))
    return [dict(r) for r in (cur.fetchall() or [])], total


def _throttle(sec: float) -> None:
    if sec > 0:
        time.sleep(sec)


def run_feed_stocks_income_statements_job(
    conn: Any,
    client: Any,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.22)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        for tf, lim in (("quarterly", 12), ("annual", 5)):
            data = client.fetch_financials_v1_income_statements(
                tickers=sym, timeframe=tf, limit=lim, sort="period_end.desc"
            )
            if data.get("error"):
                failures.append({"symbol": sym, "timeframe": tf, "error": str(data["error"])})
                continue
            res = data.get("results")
            if not isinstance(res, list):
                continue
            with conn.cursor() as cur:
                n = upsert_income_statement_rows(cur, res, fallback_symbol=sym)
                rows_total += n
            conn.commit()
        _throttle(throttle)
    return {
        "ok": True,
        "kind": "feed_stocks_income_statements",
        "rows_upserted": rows_total,
        "symbols_processed": len([s for s in symbols if str(s).strip()]),
        "failures": failures[:50],
    }


def run_feed_stocks_balance_sheets_job(conn: Any, client: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.22)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        for tf, lim in (("quarterly", 12), ("annual", 5)):
            data = client.fetch_financials_v1_balance_sheets(
                tickers=sym, timeframe=tf, limit=lim, sort="period_end.desc"
            )
            if data.get("error"):
                failures.append({"symbol": sym, "timeframe": tf, "error": str(data["error"])})
                continue
            res = data.get("results")
            if not isinstance(res, list):
                continue
            with conn.cursor() as cur:
                rows_total += upsert_balance_sheet_rows(cur, res, fallback_symbol=sym)
            conn.commit()
        _throttle(throttle)
    return {
        "ok": True,
        "kind": "feed_stocks_balance_sheets",
        "rows_upserted": rows_total,
        "failures": failures[:50],
    }


def run_feed_stocks_cash_flows_job(conn: Any, client: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.22)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        for tf, lim in (("quarterly", 12), ("annual", 5)):
            data = client.fetch_financials_v1_cash_flow_statements(
                tickers=sym, timeframe=tf, limit=lim, sort="period_end.desc"
            )
            if data.get("error"):
                failures.append({"symbol": sym, "timeframe": tf, "error": str(data["error"])})
                continue
            res = data.get("results")
            if not isinstance(res, list):
                continue
            with conn.cursor() as cur:
                rows_total += upsert_cash_flow_rows(cur, res, fallback_symbol=sym)
            conn.commit()
        _throttle(throttle)
    return {
        "ok": True,
        "kind": "feed_stocks_cash_flows",
        "rows_upserted": rows_total,
        "failures": failures[:50],
    }


def run_feed_stocks_ratios_job(conn: Any, client: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.22)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    use_v1 = bool(payload.get("use_v1_endpoint", True))
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        for tf, lim in (("quarterly", 12), ("annual", 5)):
            data: Dict[str, Any]
            if use_v1:
                data = client.fetch_financials_v1_ratios(
                    tickers=sym, timeframe=tf, limit=lim, sort="period_end.desc"
                )
                err = str(data.get("error") or "")
                if err and (
                    "404" in err
                    or "not found" in err.lower()
                    or "status" in err.lower()
                ):
                    data = client.fetch_stock_ratios(sym, limit=lim, sort="filing_date.desc")
            else:
                data = client.fetch_stock_ratios(sym, limit=lim, sort="filing_date.desc")
            if data.get("error"):
                failures.append({"symbol": sym, "timeframe": tf, "error": str(data["error"])})
                continue
            res = data.get("results")
            if not isinstance(res, list):
                continue
            with conn.cursor() as cur:
                rows_total += upsert_ratios_rows(cur, res, fallback_symbol=sym)
            conn.commit()
        _throttle(throttle)
    return {
        "ok": True,
        "kind": "feed_stocks_ratios",
        "rows_upserted": rows_total,
        "failures": failures[:50],
    }


def run_feed_stocks_short_interest_job(conn: Any, client: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.15)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    lim = int(payload.get("limit") or 24)
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        data = client.fetch_stock_short_interest(sym, limit=lim, sort="settlement_date.desc")
        if data.get("error"):
            failures.append({"symbol": sym, "error": str(data["error"])})
            _throttle(throttle)
            continue
        res = data.get("results")
        if not isinstance(res, list):
            res = []
        with conn.cursor() as cur:
            rows_total += upsert_short_interest_rows(cur, res, fallback_symbol=sym)
        conn.commit()
        _throttle(throttle)
    return {"ok": True, "kind": "feed_stocks_short_interest", "rows_upserted": rows_total, "failures": failures[:50]}


def run_feed_stocks_short_volume_job(conn: Any, client: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("payload.symbols must be a non-empty list")
    throttle = float(payload.get("throttle_sec") or 0.15)
    rows_total = 0
    failures: List[Dict[str, str]] = []
    lim = int(payload.get("limit") or 30)
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym:
            continue
        data = client.fetch_stock_short_volume(sym, limit=lim, sort="date.desc")
        if data.get("error"):
            failures.append({"symbol": sym, "error": str(data["error"])})
            _throttle(throttle)
            continue
        res = data.get("results")
        if not isinstance(res, list):
            res = []
        with conn.cursor() as cur:
            rows_total += upsert_short_volume_rows(cur, res, fallback_symbol=sym)
        conn.commit()
        _throttle(throttle)
    return {"ok": True, "kind": "feed_stocks_short_volume", "rows_upserted": rows_total, "failures": failures[:50]}


def financials_gap_symbols_from_db(cur: Any, kind: str, *, batch_size: int = 50) -> Dict[str, Any]:
    """Return gap symbol batches for a fundamentals feed kind (DB-only)."""
    k = (kind or "").strip().lower()
    if k == "feed_stocks_income_statements":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            q AS (
                SELECT symbol,
                       count(*)::integer AS n,
                       count(*) FILTER (WHERE basic_earnings_per_share IS NOT NULL)::integer AS eps_n,
                       count(*) FILTER (WHERE revenue IS NOT NULL)::integer AS rev_n
                FROM public.stock_income_statements
                WHERE source = 'massive' AND timeframe = 'quarterly'
                GROUP BY symbol
            ),
            a AS (
                SELECT symbol, count(*)::integer AS n
                FROM public.stock_income_statements
                WHERE source = 'massive' AND timeframe = 'annual'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN q ON q.symbol = u.symbol
            LEFT JOIN a ON a.symbol = u.symbol
            WHERE q.symbol IS NULL OR q.n < 5 OR a.symbol IS NULL OR a.n < 4
               OR (q.n > 0 AND (q.eps_n::float / q.n) < 0.8)
               OR (q.n > 0 AND (q.rev_n::float / q.n) < 0.8)
            ORDER BY u.symbol
            """
        )
    elif k == "feed_stocks_balance_sheets":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            q AS (
                SELECT symbol, count(*)::integer AS n,
                       count(*) FILTER (WHERE total_assets IS NOT NULL)::integer AS ta_n
                FROM public.stock_balance_sheets
                WHERE source='massive' AND timeframe='quarterly'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN q ON q.symbol=u.symbol
            WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (q.ta_n::float/q.n) < 0.9)
            ORDER BY u.symbol
            """
        )
    elif k == "feed_stocks_cash_flows":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            q AS (
                SELECT symbol, count(*)::integer AS n,
                       count(*) FILTER (WHERE net_cash_flow_from_operating_activities IS NOT NULL)::integer AS op_n
                FROM public.stock_cash_flows
                WHERE source='massive' AND timeframe='quarterly'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN q ON q.symbol=u.symbol
            WHERE q.symbol IS NULL OR q.n < 4 OR (q.n > 0 AND (op_n::float/q.n) < 0.8)
            ORDER BY u.symbol
            """
        )
    elif k == "feed_stocks_ratios":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            q AS (
                SELECT symbol, count(*)::integer AS n
                FROM public.stock_ratios
                WHERE source='massive' AND timeframe='quarterly'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN q ON q.symbol=u.symbol
            WHERE q.symbol IS NULL OR q.n < 4
            ORDER BY u.symbol
            """
        )
    elif k == "feed_stocks_short_interest":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            h AS (
                SELECT symbol, count(*)::integer AS n, max(settlement_date) AS mx
                FROM public.stock_short_interest
                WHERE source='massive'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN h ON h.symbol=u.symbol
            WHERE h.symbol IS NULL OR h.n < 1 OR h.mx < (CURRENT_DATE - integer '45')
            ORDER BY u.symbol
            """
        )
    elif k == "feed_stocks_short_volume":
        cur.execute(
            """
            WITH u AS (SELECT symbol FROM public.v_sepa_us_equity_universe),
            d AS (
                SELECT symbol, count(*)::integer AS n, max(trade_date) AS mx
                FROM public.stock_short_volume
                WHERE source='massive'
                GROUP BY symbol
            )
            SELECT u.symbol FROM u
            LEFT JOIN d ON d.symbol=u.symbol
            WHERE d.symbol IS NULL OR d.n < 5 OR d.mx < (CURRENT_DATE - integer '14')
            ORDER BY u.symbol
            """
        )
    else:
        return {"ok": False, "error": f"unknown fundamentals kind: {kind}"}

    syms = [s for s in (_symbol_from_gap_sql_row(r) for r in (cur.fetchall() or [])) if s]
    bs = max(1, min(int(batch_size), 200))
    batches = [syms[i : i + bs] for i in range(0, len(syms), bs)]
    return {"ok": True, "gap_count": len(syms), "batches": batches}
