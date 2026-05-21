// ── Technical condition labels (used by SepaScreeningChecklist and Readiness Status panel) ──

export const TECH_COND_LABELS: Record<string, string> = {
  // Core 11
  avg_volume_50_gt_threshold: 'Avg Volume 50D > 100K',
  crs_ge_70:                  'CRS ≥ 70',
  close_ge_low52_x_1_3:       'Close ≥ Low52W × 1.3',
  close_ge_high52_x_0_75:     'Close ≥ High52W × 0.75',
  sma50_gt_sma150:            'SMA50 > SMA150',
  sma50_gt_sma200:            'SMA50 > SMA200',
  sma150_gt_sma200:           'SMA150 > SMA200',
  sma200_rising_1m:           'SMA200 Rising (1M)',
  price_gt_sma50:             'Price > SMA50',
  price_gt_sma150:            'Price > SMA150',
  price_gt_sma200:            'Price > SMA200',
  // Momentum
  rsi_14_in_band:               'RSI(14) in [40, 80]',
  macd_hist_positive:           'MACD Histogram > 0 & Rising',
  roc_3m_positive:              'ROC 3M > 0',
  roc_6m_positive:              'ROC 6M > 0',
  roc_12m_positive:             'ROC 12M > 0',
  multi_period_rs_4w_positive:  'RS vs SPY (4W) > 0',
  multi_period_rs_13w_positive: 'RS vs SPY (13W) > 0',
  multi_period_rs_26w_positive: 'RS vs SPY (26W) > 0',
  slope_sma200_positive:        'SMA200 Slope > 0',
  up_down_volume_50d_gt_1:      'Up/Down Vol (50D) > 1',
  // Structure
  realized_vol_contraction:  'Realized Vol Contraction',
  bb_squeeze:                'BB Squeeze Active',
  obv_slope_30d_positive:    'OBV Slope (30D) Positive',
  adx_14_ge_25:              'ADX(14) ≥ 25 (Trending)',
  aroon_oscillator_ge_50:    'Aroon Osc ≥ 50',
  // Sentiment
  days_to_cover_ge_5:                  'Days to Cover ≥ 5',
  short_volume_ratio_le_30pct_recent:  'Short Vol Ratio < 30%',
  short_volume_ratio_trend_4w_falling: 'Short Vol Trend Falling',
}

// ── Fundamental SQL explanation constants ─────────────────────────────────────

export const FUND_SQL_AGGREGATION = `-- Aggregation query behind the Fundamental percentages
-- Table: public.stock_readiness_daily  (as_of_date = CURRENT_DATE)
WITH snapshot AS (
    SELECT
        (fundamental_eval->>'fundamental_pass')::boolean  AS fund_pass,
        (fundamental_eval->>'insufficient_data')::boolean AS no_data,
        fundamental_eval
    FROM public.stock_readiness_daily
    WHERE as_of_date = CURRENT_DATE
      AND included_in_universe = true
      AND fundamental_eval IS NOT NULL
),
per_sym AS (
    SELECT
        fund_pass,
        no_data,
        (fundamental_eval->'conditions' @> '[{"id":"eps_q2q_ge_25pct","pass":true}]'::jsonb) AS cond_eps_q2q,
        (fundamental_eval->'conditions' @> '[{"id":"rev_q2q_ge_25pct","pass":true}]'::jsonb) AS cond_rev_q2q,
        (fundamental_eval->'conditions' @> '[{"id":"eps_acc_2q","pass":true}]'::jsonb)       AS cond_eps_acc_2q,
        (fundamental_eval->'conditions' @> '[{"id":"rev_acc_2q","pass":true}]'::jsonb)       AS cond_rev_acc_2q,
        (fundamental_eval->'conditions' @> '[{"id":"eps_3y_ge_15pct","pass":true}]'::jsonb)  AS cond_eps_3y,
        (fundamental_eval->'conditions' @> '[{"id":"rev_3y_ge_15pct","pass":true}]'::jsonb)  AS cond_rev_3y,
        (fundamental_eval->'conditions' @> '[{"id":"eps_acc_fy","pass":true}]'::jsonb)       AS cond_eps_acc_fy,
        (fundamental_eval->'conditions' @> '[{"id":"rev_acc_fy","pass":true}]'::jsonb)       AS cond_rev_acc_fy
    FROM snapshot
)
SELECT
    count(*)                                                           AS evaluated,
    count(*) FILTER (WHERE fund_pass)                                  AS fund_pass_count,
    count(*) FILTER (WHERE no_data)                                    AS no_data_count,
    count(*) FILTER (WHERE cond_eps_q2q)                               AS eps_q2q_pass,
    count(*) FILTER (WHERE NOT cond_eps_q2q  AND NOT no_data)          AS eps_q2q_fail,
    count(*) FILTER (WHERE cond_rev_q2q)                               AS rev_q2q_pass,
    count(*) FILTER (WHERE NOT cond_rev_q2q  AND NOT no_data)          AS rev_q2q_fail,
    count(*) FILTER (WHERE cond_eps_acc_2q)                            AS eps_acc_2q_pass,
    count(*) FILTER (WHERE NOT cond_eps_acc_2q AND NOT no_data)        AS eps_acc_2q_fail,
    count(*) FILTER (WHERE cond_rev_acc_2q)                            AS rev_acc_2q_pass,
    count(*) FILTER (WHERE NOT cond_rev_acc_2q AND NOT no_data)        AS rev_acc_2q_fail,
    count(*) FILTER (WHERE cond_eps_3y)                                AS eps_3y_pass,
    count(*) FILTER (WHERE NOT cond_eps_3y   AND NOT no_data)          AS eps_3y_fail,
    count(*) FILTER (WHERE cond_rev_3y)                                AS rev_3y_pass,
    count(*) FILTER (WHERE NOT cond_rev_3y   AND NOT no_data)          AS rev_3y_fail,
    count(*) FILTER (WHERE cond_eps_acc_fy)                            AS eps_acc_fy_pass,
    count(*) FILTER (WHERE NOT cond_eps_acc_fy AND NOT no_data)        AS eps_acc_fy_fail,
    count(*) FILTER (WHERE cond_rev_acc_fy)                            AS rev_acc_fy_pass,
    count(*) FILTER (WHERE NOT cond_rev_acc_fy AND NOT no_data)        AS rev_acc_fy_fail
FROM per_sym;`

export const FUND_SQL_SYMBOL = `-- Per-symbol drill-down (replace 'AAPL' with the symbol to inspect)
SELECT
    symbol,
    fundamental_pass,
    fundamental_pass_count,
    fundamental_insufficient,
    fund_cache_expire_at,
    jsonb_pretty(fundamental_eval) AS eval_detail
FROM public.stock_readiness_daily
WHERE as_of_date = CURRENT_DATE
  AND symbol = 'AAPL';`

// ── Per-condition calculation details ─────────────────────────────────────────

export interface CondDetail {
  table: string
  column: string
  period: string
  formula: string
  dataReq: string
  sql: string
}

export const COND_DETAIL: Record<string, CondDetail> = {
  eps_q2q_ge_25pct: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'quarterly'",
    formula:
      'growth = (EPS_Q_current − EPS_same_Q_prior_year) / |EPS_same_Q_prior_year|\nPass when growth ≥ 0.25 (25%)\nSkips quarter if prior-year EPS is zero or negative',
    dataReq: 'At least one pair of matching quarters across two consecutive years (e.g. Q3-2024 vs Q3-2023)',
    sql: `-- EPS QoQ ≥ 25%  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 10
),
latest AS (
  SELECT * FROM q
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 1
)
SELECT
  l.fiscal_year            AS cur_year,
  l.fiscal_quarter         AS quarter,
  l.eps                    AS current_eps,
  p.eps                    AS prior_year_eps,
  ROUND(((l.eps - p.eps) / NULLIF(ABS(p.eps), 0))::numeric, 4)  AS yoy_growth,
  ((l.eps - p.eps) / NULLIF(ABS(p.eps), 0) >= 0.25)             AS passes
FROM latest l
JOIN q p
  ON p.fiscal_year = l.fiscal_year - 1
 AND p.fiscal_quarter = l.fiscal_quarter;`,
  },

  rev_q2q_ge_25pct: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'quarterly'",
    formula:
      'growth = (Rev_Q_current − Rev_same_Q_prior_year) / |Rev_same_Q_prior_year|\nPass when growth ≥ 0.25 (25%)',
    dataReq: 'At least one pair of matching quarters across two consecutive years',
    sql: `-- Revenue QoQ ≥ 25%  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 10
),
latest AS (
  SELECT * FROM q
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 1
)
SELECT
  l.fiscal_year            AS cur_year,
  l.fiscal_quarter         AS quarter,
  l.rev                    AS current_rev,
  p.rev                    AS prior_year_rev,
  ROUND(((l.rev - p.rev) / NULLIF(ABS(p.rev), 0))::numeric, 4)  AS yoy_growth,
  ((l.rev - p.rev) / NULLIF(ABS(p.rev), 0) >= 0.25)             AS passes
FROM latest l
JOIN q p
  ON p.fiscal_year = l.fiscal_year - 1
 AND p.fiscal_quarter = l.fiscal_quarter;`,
  },

  eps_acc_2q: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'quarterly'",
    formula:
      'Computes YoY growth for the 3 most recent quarters (same Q vs prior year)\nPass when growth[Q-2] < growth[Q-1] < growth[Q0]  (strictly accelerating)',
    dataReq: 'At least 3 quarterly YoY growth data points (requires data for Q-2 through Q0 plus same quarters one year prior)',
    sql: `-- EPS Accelerating (2Q)  —  replace 'AAPL' with any symbol
-- Shows 3 consecutive quarterly YoY growth rates (oldest → newest)
-- Passes when every row's yoy_growth > the previous row's yoy_growth
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
),
growth AS (
  SELECT
    c.fiscal_year,
    c.fiscal_quarter,
    ROUND(((c.eps - p.eps) / NULLIF(ABS(p.eps), 0))::numeric, 4) AS yoy_growth
  FROM q c
  JOIN q p
    ON p.fiscal_year = c.fiscal_year - 1
   AND p.fiscal_quarter = c.fiscal_quarter
  WHERE p.eps <> 0
  ORDER BY c.fiscal_year DESC, c.fiscal_quarter DESC
  LIMIT 3
)
SELECT fiscal_year, fiscal_quarter, yoy_growth
FROM growth
ORDER BY fiscal_year, fiscal_quarter;
-- passes = TRUE when row1.yoy_growth < row2.yoy_growth < row3.yoy_growth`,
  },

  rev_acc_2q: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'quarterly'",
    formula:
      'Same logic as EPS Accelerating (2Q) but uses revenues column\nPass when Rev_YoY_growth[Q-2] < Rev_YoY_growth[Q-1] < Rev_YoY_growth[Q0]',
    dataReq: 'At least 3 quarterly YoY growth data points for revenue',
    sql: `-- Revenue Accelerating (2Q)  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
),
growth AS (
  SELECT
    c.fiscal_year,
    c.fiscal_quarter,
    ROUND(((c.rev - p.rev) / NULLIF(ABS(p.rev), 0))::numeric, 4) AS yoy_growth
  FROM q c
  JOIN q p
    ON p.fiscal_year = c.fiscal_year - 1
   AND p.fiscal_quarter = c.fiscal_quarter
  WHERE p.rev <> 0
  ORDER BY c.fiscal_year DESC, c.fiscal_quarter DESC
  LIMIT 3
)
SELECT fiscal_year, fiscal_quarter, yoy_growth
FROM growth
ORDER BY fiscal_year, fiscal_quarter;
-- passes = TRUE when row1.yoy_growth < row2.yoy_growth < row3.yoy_growth`,
  },

  eps_3y_ge_15pct: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'annual'",
    formula:
      'CAGR = (EPS_latest_year / EPS_3_years_ago)^(1/3) − 1\nPass when CAGR ≥ 0.15 (15%)\nSkips if EPS_3_years_ago ≤ 0 or EPS_latest ≤ 0',
    dataReq: 'Minimum 4 annual rows (spans 3 full fiscal years)',
    sql: `-- EPS 3-Year CAGR ≥ 15%  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
)
SELECT
  MAX(CASE WHEN rn = 1 THEN fiscal_year END)  AS latest_year,
  MAX(CASE WHEN rn = 4 THEN fiscal_year END)  AS base_year,
  MAX(CASE WHEN rn = 1 THEN eps END)          AS latest_eps,
  MAX(CASE WHEN rn = 4 THEN eps END)          AS base_eps,
  ROUND((
    POWER(
      MAX(CASE WHEN rn = 1 THEN eps END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN eps END), 0),
      1.0/3
    ) - 1
  )::numeric, 4)                              AS cagr_3y,
  (
    POWER(
      MAX(CASE WHEN rn = 1 THEN eps END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN eps END), 0),
      1.0/3
    ) - 1 >= 0.15
  )                                           AS passes
FROM ranked;`,
  },

  rev_3y_ge_15pct: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'annual'",
    formula:
      'CAGR = (Rev_latest_year / Rev_3_years_ago)^(1/3) − 1\nPass when CAGR ≥ 0.15 (15%)',
    dataReq: 'Minimum 4 annual rows (spans 3 full fiscal years)',
    sql: `-- Revenue 3-Year CAGR ≥ 15%  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
)
SELECT
  MAX(CASE WHEN rn = 1 THEN fiscal_year END)  AS latest_year,
  MAX(CASE WHEN rn = 4 THEN fiscal_year END)  AS base_year,
  MAX(CASE WHEN rn = 1 THEN rev END)          AS latest_rev,
  MAX(CASE WHEN rn = 4 THEN rev END)          AS base_rev,
  ROUND((
    POWER(
      MAX(CASE WHEN rn = 1 THEN rev END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN rev END), 0),
      1.0/3
    ) - 1
  )::numeric, 4)                              AS cagr_3y,
  (
    POWER(
      MAX(CASE WHEN rn = 1 THEN rev END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN rev END), 0),
      1.0/3
    ) - 1 >= 0.15
  )                                           AS passes
FROM ranked;`,
  },

  eps_acc_fy: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'annual'",
    formula:
      'g_latest = EPS_FY0 / EPS_FY1 − 1  (latest year YoY)\ng_prior  = EPS_FY1 / EPS_FY2 − 1  (prior year YoY)\nPass when g_latest > g_prior',
    dataReq: 'Minimum 4 annual rows (needs FY0, FY1, FY2 for two growth rates)',
    sql: `-- EPS Accelerating (FY)  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
),
vals AS (
  SELECT
    MAX(CASE WHEN rn = 1 THEN eps END) AS v0,   -- latest fiscal year
    MAX(CASE WHEN rn = 2 THEN eps END) AS v1,   -- 1 year ago
    MAX(CASE WHEN rn = 3 THEN eps END) AS v2    -- 2 years ago
  FROM ranked
)
SELECT
  v0, v1, v2,
  ROUND((v0 / NULLIF(v1, 0) - 1)::numeric, 4)  AS g_latest,
  ROUND((v1 / NULLIF(v2, 0) - 1)::numeric, 4)  AS g_prior,
  ((v0 / NULLIF(v1, 0) - 1) > (v1 / NULLIF(v2, 0) - 1)) AS passes
FROM vals;`,
  },

  rev_acc_fy: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'annual'",
    formula:
      'g_latest = Rev_FY0 / Rev_FY1 − 1  (latest year YoY)\ng_prior  = Rev_FY1 / Rev_FY2 − 1  (prior year YoY)\nPass when g_latest > g_prior',
    dataReq: 'Minimum 4 annual rows (needs FY0, FY1, FY2 for two growth rates)',
    sql: `-- Revenue Accelerating (FY)  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
),
vals AS (
  SELECT
    MAX(CASE WHEN rn = 1 THEN rev END) AS v0,   -- latest fiscal year
    MAX(CASE WHEN rn = 2 THEN rev END) AS v1,   -- 1 year ago
    MAX(CASE WHEN rn = 3 THEN rev END) AS v2    -- 2 years ago
  FROM ranked
)
SELECT
  v0, v1, v2,
  ROUND((v0 / NULLIF(v1, 0) - 1)::numeric, 4)  AS g_latest,
  ROUND((v1 / NULLIF(v2, 0) - 1)::numeric, 4)  AS g_prior,
  ((v0 / NULLIF(v1, 0) - 1) > (v1 / NULLIF(v2, 0) - 1)) AS passes
FROM vals;`,
  },
}
