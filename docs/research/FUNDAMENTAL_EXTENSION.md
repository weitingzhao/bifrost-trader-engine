# Fundamental Conditions Extension

> **Version**: `ext_v1`  
> **Date**: 2026-05-11  
> **Total conditions**: 33 (8 SEPA core + 25 extension)

## Overview

The SEPA core evaluates 8 fundamental conditions based on quarterly/annual income
statement data (EPS and revenue growth/acceleration).  This extension adds 25
conditions across 7 new groups, leveraging previously unused raw data tables:
balance sheets, cash flows, ratios, short interest, and short volume.

**Design invariants**:
- `fundamental_pass` / `fundamental_pass_count` / `fundamental_insufficient` columns
  are driven **only** by the original 8 SEPA core conditions.
- Extension results live in `fundamental_eval` JSONB under `groups` and as additional
  entries in the flat `conditions[]` list (backward-compatible).
- Each extension group fails independently; a crash in one group does not affect others
  or the SEPA core evaluation.

## Condition Catalog

### Group `sepa_core` (8 conditions)

| ID | Label | Threshold | Source Table |
|----|-------|-----------|-------------|
| `eps_q2q_ge_25pct` | EPS quarterly YoY growth ≥ 25% | 0.25 | stock_income_statements |
| `rev_q2q_ge_25pct` | Revenue quarterly YoY growth ≥ 25% | 0.25 | stock_income_statements |
| `eps_acc_2q` | EPS YoY growth accelerating 2 quarters | — | stock_income_statements |
| `rev_acc_2q` | Revenue YoY growth accelerating 2 quarters | — | stock_income_statements |
| `eps_3y_ge_15pct` | EPS 3-year CAGR ≥ 15% | 0.15 | stock_income_statements |
| `rev_3y_ge_15pct` | Revenue 3-year CAGR ≥ 15% | 0.15 | stock_income_statements |
| `eps_acc_fy` | EPS annual growth acceleration | — | stock_income_statements |
| `rev_acc_fy` | Revenue annual growth acceleration | — | stock_income_statements |

### Group `quality` (5 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `gross_margin_ge_30pct` | Gross margin ≥ 30% | 0.30 | stock_income_statements | P1 |
| `operating_margin_ge_10pct` | Operating margin ≥ 10% | 0.10 | stock_income_statements | P1 |
| `net_margin_ge_5pct` | Net margin ≥ 5% | 0.05 | stock_income_statements | P1 |
| `ocf_to_ni_ge_0_7` | OCF / net income ≥ 0.7 | 0.70 | stock_cash_flows + stock_income_statements | P0 |
| `interest_coverage_ge_5x` | Interest coverage ≥ 5× | 5.0 | stock_income_statements | P1 |

**Context**: Earnings quality checks.  `ocf_to_ni_ge_0_7` is a classic red-flag
indicator for aggressive accounting.  Zero interest expense → automatic pass.

### Group `balance` (4 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `current_ratio_ge_1_5` | Current ratio ≥ 1.5 | 1.5 | stock_balance_sheets | P1 |
| `quick_ratio_ge_1_0` | Quick ratio ≥ 1.0 | 1.0 | stock_balance_sheets | P1 |
| `debt_to_equity_le_1` | Debt-to-equity ≤ 1.0 | 1.0 | stock_ratios | P0 |
| `net_debt_to_ebitda_le_3` | Net debt / EBITDA ≤ 3.0 | 3.0 | stock_balance_sheets + stock_income_statements | P1 |

**Context**: Balance-sheet health.  Negative EBITDA → `insufficient` for net-debt condition.

### Group `cashflow` (4 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `fcf_positive` | Free cash flow > 0 | 0 | stock_cash_flows | P0 |
| `fcf_margin_ge_5pct` | FCF margin ≥ 5% | 0.05 | stock_cash_flows + stock_income_statements | P1 |
| `fcf_yield_ge_3pct` | FCF yield ≥ 3% | 0.03 | stock_cash_flows + stock_ratios | P1 |
| `capex_intensity_le_15pct` | CapEx / revenue ≤ 15% | 0.15 | stock_cash_flows + stock_income_statements | P2 |

**Context**: FCF = OCF + CapEx (CapEx typically stored as negative).

### Group `valuation` (4 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `pe_le_60` | P/E ≤ 60 | 60.0 | stock_ratios | P0 |
| `ps_le_15` | P/S ≤ 15 | 15.0 | stock_ratios | P1 |
| `pb_le_8` | P/B ≤ 8 | 8.0 | stock_ratios | P1 |
| `ev_to_ebitda_le_30` | EV/EBITDA ≤ 30 | 30.0 | stock_ratios | P1 |

**Context**: Soft valuation caps.  Negative P/E → fail.  All read from
`stock_ratios` latest row (DISTINCT ON ... ORDER BY date DESC).

### Group `profitability` (2 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `roe_ge_15pct` | ROE ≥ 15% | 0.15 | stock_ratios | P0 |
| `roa_ge_5pct` | ROA ≥ 5% | 0.05 | stock_ratios | P1 |

### Group `efficiency` (3 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `asset_turnover_ge_0_5` | Asset turnover ≥ 0.5 | 0.5 | stock_income_statements + stock_balance_sheets | P2 |
| `dso_le_75_days` | Days sales outstanding ≤ 75 | 75.0 | stock_income_statements + stock_balance_sheets | P2 |
| `dio_le_120_days` | Days inventory outstanding ≤ 120 | 120.0 | stock_income_statements + stock_balance_sheets | P2 |

**Context**: Working-capital efficiency.  Uses trailing 4-quarter averages for balance-sheet items.

### Group `sentiment` (3 conditions)

| ID | Label | Threshold | Source Table | Priority |
|----|-------|-----------|-------------|----------|
| `days_to_cover_le_5` | Days to cover ≤ 5 | 5.0 | stock_short_interest | P2 |
| `short_volume_ratio_recent_le_30pct` | Avg short-vol ratio ≤ 30% (10D) | 0.30 | stock_short_volume | P2 |
| `short_interest_pct_of_float_le_15pct` | SI % of shares outstanding ≤ 15% | 0.15 | stock_short_interest + stock_income_statements | P2 |

**Context**: Short-squeeze risk indicators.  Missing share count → `insufficient`.

## SEPA / O'Neil Methodology Alignment

The SEPA core 8 conditions directly implement Mark Minervini's SEPA (Specific Entry
Point Analysis) fundamental criteria, which are themselves rooted in William O'Neil's
CAN SLIM methodology (the "C" = Current quarterly earnings, "A" = Annual earnings).

The extension groups provide complementary dimensions:

| Group | O'Neil / SEPA Relevance |
|-------|------------------------|
| Quality | Earnings quality (OCF/NI) — validates the "E" in CAN SLIM is real |
| Balance | Financial health — screens out overleveraged companies |
| Cashflow | Cash generation — confirms growth is cash-backed, not accounting artifacts |
| Valuation | Valuation sanity check — prevents buying at extreme multiples |
| Profitability | Return metrics — ROE/ROA confirm capital efficiency |
| Efficiency | Operational efficiency — complements revenue growth with asset utilization |
| Sentiment | Short-interest signals — detects potential squeeze risk or bearish consensus |

## Degradation Behavior

| Scenario | Behavior |
|----------|----------|
| Missing income data (< 5 quarterly + < 4 annual) | SEPA core → `insufficient_data`; extension quality/cashflow groups → `insufficient` |
| Missing balance sheets | Balance & efficiency groups → `insufficient`; other groups unaffected |
| Missing cash flows | Quality OCF + cashflow group → conditions fail; other groups unaffected |
| Missing ratios | Balance D/E, valuation, profitability → `insufficient`; others unaffected |
| Missing short interest/volume | Sentiment group → `insufficient`; all other groups unaffected |
| Extension evaluator throws exception | That group skipped; SEPA core and other groups unaffected |
| All tables empty | All groups `insufficient`; `fundamental_pass = false` |

## JSONB Structure

The `fundamental_eval` column in `stock_readiness_daily` carries:

```json
{
  "rule_version": "sepa_fundamentals_v1",
  "extension_version": "ext_v1",
  "fundamental_pass": true,
  "pass_count": 8,
  "insufficient_data": false,
  "conditions": [
    {"id": "eps_q2q_ge_25pct", "group": "sepa_core", "pass": true, "actual": 0.35, "threshold": 0.25, "reason": "..."},
    {"id": "ocf_to_ni_ge_0_7", "group": "quality", "pass": true, "actual": 0.92, "threshold": 0.70, "reason": "..."},
    ...
  ],
  "groups": {
    "sepa_core": {"total": 8, "pass_count": 8, "pass": true, "insufficient": false},
    "quality": {"total": 5, "pass_count": 4, "pass": false, "insufficient": false},
    ...
  },
  "metrics": { ... }
}
```

No schema changes are required — extension data is entirely within the existing JSONB column.

## Source Files

| File | Role |
|------|------|
| `src/research/sepa/fundamentals_ext_engine.py` | 7 group evaluators + merge function + FundamentalsExtConfig |
| `src/research/sepa/fundamentals_engine.py` | SEPA core 8 evaluator (unchanged logic); exports `make_condition` / `to_float` |
| `src/research/sepa/financials_data.py` | 6 batch DB readers for extension data |
| `src/research/sepa/readiness_snapshot.py` | Pipeline wiring (batch reads + evaluation + JSONB merge) |
| `backend/research/routers/data_readiness.py` | API whitelist, catalog endpoint, group data in responses |
| `frontend/src/api/research/dataReadiness.ts` | TypeScript types and fetch functions |
| `frontend/src/components/StockInspectorPanel.tsx` | Extension groups in inspector detail panel |
| `frontend/src/pages/StockScreenerPage.tsx` | Grouped condition filter chips |
| `frontend/src/pages/StockDataReadinessPage.tsx` | Extension coverage cards |
