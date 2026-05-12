/**
 * Technical Indicator Tier definitions — shared across StockDataReadiness,
 * StockScreener, and StockInspectorPanel.
 */

// ── Tier 1: Core (11 conditions, unchanged SEPA template) ─────────────────────

export const TECH_CORE_CONDITIONS = [
  { id: 'avg_volume_50_gt_threshold', label: 'Avg Volume 50D > 100K', short: 'Vol', group: 'vol' },
  { id: 'crs_ge_70', label: 'CRS ≥ 70', short: 'CRS', group: 'vol' },
  { id: 'close_ge_low52_x_1_3', label: 'Close ≥ 1.3× 52W Low', short: '≥Low', group: 'price' },
  { id: 'close_ge_high52_x_0_75', label: 'Close ≥ 0.75× 52W High', short: '≥High', group: 'price' },
  { id: 'sma50_gt_sma150', label: 'SMA50 > SMA150', short: '50>150', group: 'sma' },
  { id: 'sma50_gt_sma200', label: 'SMA50 > SMA200', short: '50>200', group: 'sma' },
  { id: 'sma150_gt_sma200', label: 'SMA150 > SMA200', short: '150>200', group: 'sma' },
  { id: 'sma200_rising_1m', label: 'SMA200 Rising (1M)', short: '200↑', group: 'sma' },
  { id: 'price_gt_sma50', label: 'Price > SMA50', short: 'P>50', group: 'price' },
  { id: 'price_gt_sma150', label: 'Price > SMA150', short: 'P>150', group: 'price' },
  { id: 'price_gt_sma200', label: 'Price > SMA200', short: 'P>200', group: 'price' },
] as const

// ── Tier 2: Momentum (10 scored indicators) ───────────────────────────────────

export const TECH_MOMENTUM_INDICATORS = [
  { id: 'rsi_14_in_band', label: 'RSI(14) in [40, 80]', short: 'RSI' },
  { id: 'macd_hist_positive', label: 'MACD Histogram > 0 & Rising', short: 'MACD' },
  { id: 'roc_3m_positive', label: 'ROC 3M > 0', short: 'ROC3M' },
  { id: 'roc_6m_positive', label: 'ROC 6M > 0', short: 'ROC6M' },
  { id: 'roc_12m_positive', label: 'ROC 12M > 0', short: 'ROC12M' },
  { id: 'multi_period_rs_4w_positive', label: 'RS vs SPY (4W) > 0', short: 'RS4W' },
  { id: 'multi_period_rs_13w_positive', label: 'RS vs SPY (13W) > 0', short: 'RS13W' },
  { id: 'multi_period_rs_26w_positive', label: 'RS vs SPY (26W) > 0', short: 'RS26W' },
  { id: 'slope_sma200_positive', label: 'SMA200 Slope > 0', short: 'Slope' },
  { id: 'up_down_volume_50d_gt_1', label: 'Up/Down Vol (50D) > 1', short: 'U/D' },
] as const

// ── Tier 3: Structure / Pattern (diagnostics) ─────────────────────────────────

export const TECH_STRUCTURE_DIAGNOSTICS = [
  { id: 'realized_vol_contraction', label: 'Realized Vol Contraction', short: 'VolC' },
  { id: 'bb_squeeze', label: 'BB Squeeze Active', short: 'BBSq' },
  { id: 'obv_slope_30d_positive', label: 'OBV Slope (30D) Positive', short: 'OBV' },
  { id: 'adx_14_ge_25', label: 'ADX(14) ≥ 25 (Trending)', short: 'ADX' },
  { id: 'aroon_oscillator_ge_50', label: 'Aroon Osc ≥ 50', short: 'Aroon' },
] as const

export const TECH_PATTERN_IDS = [
  { id: 'tight_closes_5d', label: 'Tight Closes (5D)', short: 'Tight' },
  { id: 'vcp_contraction_3m', label: 'VCP Contractions', short: 'VCP' },
  { id: 'pocket_pivot_count', label: 'Pocket Pivots', short: 'PP' },
  { id: 'rsl_new_high', label: 'RSL New High', short: 'RSL↑' },
  { id: 'base_metrics', label: 'Base Depth & Pivot', short: 'Base' },
] as const

// ── Tier 4: Sentiment (Short Interest / Short Volume) ─────────────────────────

export const TECH_SENTIMENT_INDICATORS = [
  { id: 'days_to_cover_ge_5', label: 'Days to Cover ≥ 5', short: 'DTC' },
  { id: 'short_volume_ratio_le_30pct_recent', label: 'Short Vol Ratio < 30%', short: 'SVR' },
  { id: 'short_volume_ratio_trend_4w_falling', label: 'Short Vol Trend Falling', short: 'SV↓' },
] as const

// ── Tier labels for UI grouping ───────────────────────────────────────────────

export type TierName = 'core' | 'momentum' | 'structure' | 'sentiment'

export const TIER_LABELS: Record<TierName, { label: string; description: string }> = {
  core: { label: 'Core Template', description: '11 SEPA trend template conditions (must all pass)' },
  momentum: { label: 'Momentum', description: 'Scored 0–10 based on trend strength indicators' },
  structure: { label: 'Structure & Pattern', description: 'Volatility contraction, accumulation, and chart patterns' },
  sentiment: { label: 'Sentiment', description: 'Short interest and short volume signals' },
}
