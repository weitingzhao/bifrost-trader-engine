# Technical Indicators — 4-Tier Model

本文档描述 SEPA Technical Evaluation 的四层指标体系：公式、阈值、数据源、Tier 归属、JSONB schema、前端字段映射。

---

## 1. 总览

| Tier | Name | Count | Semantic | Module |
|------|------|-------|----------|--------|
| 1 | Core | 11 | Must all pass → `technical_pass` | `phase1_engine.py` + `crs_engine.py` |
| 2 | Momentum | 10 | Scored 0–10 | `momentum_indicators.py` |
| 3 | Structure & Pattern | 5 diagnostics + 5 patterns | Diagnostic (no score) | `structure_indicators.py` + `pattern_indicators.py` |
| 4 | Sentiment | 3 | Signal-based | `short_indicators.py` |

Orchestrator: `technical_engine.py` → `evaluate_symbol_all_tiers()`.

---

## 2. Tier 1: Core (unchanged)

| ID | Formula | Threshold | Data |
|----|---------|-----------|------|
| `avg_volume_50_gt_threshold` | SMA(volume, 50) | ≥ 100,000 | stock_day |
| `crs_ge_70` | percentile_rank(ret_252d vs universe) | ≥ 70 | stock_day |
| `close_ge_low52_x_1_3` | close / min(low, 252d) | ≥ 1.30 | stock_day |
| `close_ge_high52_x_0_75` | close / max(high, 252d) | ≥ 0.75 | stock_day |
| `sma50_gt_sma150` | SMA(50) > SMA(150) | boolean | stock_day |
| `sma50_gt_sma200` | SMA(50) > SMA(200) | boolean | stock_day |
| `sma150_gt_sma200` | SMA(150) > SMA(200) | boolean | stock_day |
| `sma200_rising_1m` | SMA200 today > SMA200 20d ago | boolean | stock_day |
| `price_gt_sma50` | close > SMA(50) | boolean | stock_day |
| `price_gt_sma150` | close > SMA(150) | boolean | stock_day |
| `price_gt_sma200` | close > SMA(200) | boolean | stock_day |

---

## 3. Tier 2: Momentum

每条权重 1，合计 `momentum_score ∈ [0, 10]`。

| ID | Formula | Pass Condition | Data |
|----|---------|----------------|------|
| `rsi_14_in_band` | Wilder RSI(14) | 40 ≤ RSI ≤ 80 | stock_day.close |
| `macd_hist_positive` | MACD(12,26,9) histogram | > 0 and rising last 5d | stock_day.close |
| `roc_3m_positive` | close / close[-63] − 1 | > 0 | stock_day.close |
| `roc_6m_positive` | close / close[-126] − 1 | > 0 | stock_day.close |
| `roc_12m_positive` | close / close[-252] − 1 | > 0 | stock_day.close |
| `multi_period_rs_4w_positive` | stock_ret_20d − spy_ret_20d | > 0 | stock_day + SPY |
| `multi_period_rs_13w_positive` | stock_ret_63d − spy_ret_63d | > 0 | stock_day + SPY |
| `multi_period_rs_26w_positive` | stock_ret_126d − spy_ret_126d | > 0 | stock_day + SPY |
| `slope_sma200_positive` | (SMA200_now − SMA200_20d_ago) / SMA200_20d_ago | > 0 | stock_day.close |
| `up_down_volume_50d_gt_1` | Σ(vol on up days, 50d) / Σ(vol on down days, 50d) | > 1.0 | stock_day |

---

## 4. Tier 3a: Structure / Volatility (diagnostics)

| ID | Formula | Active When | Data |
|----|---------|-------------|------|
| `realized_vol_contraction` | rv30d / rv90d | < 0.70 | stock_day.close |
| `bb_squeeze` | current BB bandwidth ∈ lowest 20% of 126d | true | stock_day.close |
| `obv_slope_30d_positive` | linear regression slope of OBV(30d) | > 0 | stock_day |
| `adx_14_ge_25` | Wilder ADX(14) | ≥ 25 | stock_day OHLC |
| `aroon_oscillator_ge_50` | Aroon Up(14) − Aroon Down(14) | ≥ 50 | stock_day HL |

Metrics also reported: `atr_pct_14`, `realized_vol_30d`, `realized_vol_90d`, `bb_bandwidth_20`, `obv_slope_30d`, `adx_14`, `aroon_oscillator_14`.

---

## 5. Tier 3b: Pattern

| ID | Output | Data |
|----|--------|------|
| `tight_closes_5d` | tight_count, tight_pct, is_tight (spread ≤ 1.5%) | stock_day.close |
| `vcp_contraction_3m` | contraction_count, pullback_depths, is_vcp (≥2 contractions) | stock_day.close |
| `pocket_pivot_count` | count (vol > max down-vol in 10d window, close up) | stock_day |
| `rsl_new_high` | is_new_high (RSL = stock/SPY makes 252d new high in last 10d) | stock_day + SPY |
| `base_metrics` | base_depth_pct, pivot_buy_distance_pct | stock_day OHLC |

---

## 6. Tier 4: Sentiment

| ID | Formula | Pass When | Data |
|----|---------|-----------|------|
| `days_to_cover_ge_5` | latest settlement days_to_cover | ≥ 5.0 | stock_short_interest |
| `short_volume_ratio_le_30pct_recent` | avg(short_volume_ratio, 20d) | < 0.30 | stock_short_volume |
| `short_volume_ratio_trend_4w_falling` | avg(svr, recent 20d) < avg(svr, prior 20d) | true | stock_short_volume |

Metrics: `days_to_cover`, `si_pct_change_2w`, `sv_ratio_avg_4w`, `sv_ratio_trend_falling`, `staleness_days`.

---

## 7. JSONB Schema (`stock_readiness_daily.technical_eval`)

```json
{
  "technical_pass": true,
  "insufficient_data": false,
  "pass_count": 11,
  "fail_count": 0,
  "conditions": [ /* core 11 condition objects */ ],
  "metrics": { "close": 150, "sma50": 145, "sma200": 130, "crs_score": 85.2 },
  "tiers": {
    "core": { "pass": true, "pass_count": 11, "fail_count": 0 },
    "momentum": {
      "score": 7, "max": 10,
      "indicators": [
        { "id": "rsi_14_in_band", "pass": true, "actual": 62.4, "threshold": [40, 80], "reason": "..." }
      ]
    },
    "structure": {
      "diagnostics": [ { "id": "bb_squeeze", "active": true, "value": 0.018 } ],
      "metrics": { "atr_pct_14": 0.034, "realized_vol_30d": 0.21 },
      "patterns": [ { "id": "vcp_contraction_3m", "contraction_count": 3, "is_vcp": true } ],
      "pattern_metrics": { "vcp_contraction_count": 3, "rsl_new_high": true }
    },
    "sentiment": {
      "short": { "days_to_cover": 4.2, "si_pct_change_2w": 0.12, "sv_ratio_avg_4w": 0.28, "staleness_days": 4 },
      "indicators": [ { "id": "days_to_cover_ge_5", "pass": false, "actual": 4.2, "threshold": 5.0 } ]
    }
  },
  "rule_version": "sepa_technical_v2"
}
```

Top-level `technical_pass`, `pass_count`, `fail_count`, `conditions`, `metrics` remain **backward compatible** — identical semantics to pre-tiered version.

---

## 8. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/research/data/readiness/symbol-technical-conditions?symbol=X` | GET | Core 11 + tiers (existing, extended) |
| `/research/data/readiness/symbol-technical-tiers?symbol=X` | GET | Full 4-tier payload |
| `/research/data/readiness/momentum-distribution` | GET | Universe histogram of momentum_score |
| `/research/data/readiness/momentum-filter?include=...&min_score=N` | GET | Filter by momentum sub-conditions |

---

## 9. Frontend Field Mapping

| TS Constant File | Constant | Maps To |
|-----------------|----------|---------|
| `constants/technicalTiers.ts` | `TECH_CORE_CONDITIONS` | Tier 1 condition IDs |
| | `TECH_MOMENTUM_INDICATORS` | Tier 2 indicator IDs |
| | `TECH_STRUCTURE_DIAGNOSTICS` | Tier 3a diagnostic IDs |
| | `TECH_PATTERN_IDS` | Tier 3b pattern IDs |
| | `TECH_SENTIMENT_INDICATORS` | Tier 4 indicator IDs |
| | `TIER_LABELS` | Human labels per tier |

TS types in `api/research/dataReadiness.ts`: `TechnicalTiers`, `TierMomentum`, `TierStructure`, `TierSentiment`.

---

## 10. Configuration (`TechnicalConfig` dataclass)

All thresholds are adjustable via `src/research/sepa/technical_engine.py::TechnicalConfig`:

- `MomentumConfig`: RSI bounds, MACD periods, ROC lookbacks, RS periods, volume thresholds
- `StructureConfig`: ATR period, BB params, vol contraction ratio, OBV slope period, ADX/Aroon periods
- `PatternConfig`: tight close %, VCP parameters, pocket pivot windows, RSL lookback
- `SentimentConfig`: days-to-cover threshold, short volume ratio threshold, trend period
