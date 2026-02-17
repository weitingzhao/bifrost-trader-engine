# Config Safety Boundary Taxonomy

This document analyzes how all config sections define **safety boundaries** and proposes unified classification schemes.

**Status:** Option 2 (gates) is **implemented**. Config uses `gates.strategy`, `gates.state`, `gates.intent`, `gates.guard`.

## Current Config: Two Implicit Groups (Legacy)

### Group A — "Business / Operational"

| Section   | Keys | Purpose |
|----------|------|---------|
| **structure** | min_dte, max_dte, atm_band_pct | Which positions qualify (DTE, ATM band) |
| **risk**      | max_daily_hedge_count, max_position_shares, max_daily_loss_usd, max_net_delta_shares, max_spread_pct, trading_hours_only, paper_trade | Circuit breakers, daily limits |
| **earnings**  | blackout_days_before, blackout_days_after, dates | Calendar blackout (no hedge around earnings) |
| **greeks**    | risk_free_rate, volatility | Model inputs (Black-Scholes) — *not a boundary* |

### Group B — "State Space Thresholds"

| Section   | Keys | Purpose |
|----------|------|---------|
| **delta**     | epsilon_band, threshold_hedge_shares, max_delta_limit | Map net_delta → D state |
| **market**    | vol_window_min, stale_ts_threshold_ms | Map data freshness → M state |
| **liquidity** | wide_spread_pct, extreme_spread_pct | Map spread → L state |
| **hedge**     | min_hedge_shares, cooldown_seconds, max_hedge_shares_per_order, min_price_move_pct | Order sizing, cost gate |
| **system**    | data_lag_threshold_ms | Map lag → S state |

**Note:** `greeks` is a **model input**, not a safety boundary. It feeds Black-Scholes; validity is checked elsewhere (S1 GREEKS_BAD).

---

## Unified View: All Are Safety Boundaries

Every section except `greeks` answers: **"When is it safe to hedge?"** or **"When must we block?"**

| Dimension | Question | Config |
|-----------|----------|--------|
| **Position** | Which positions count? | structure |
| **Position** | How much delta deviation before hedge? | delta |
| **Market**   | Is data fresh? | market.stale_ts_threshold_ms |
| **Market**   | Is spread acceptable? | liquidity |
| **System**   | Is data lag OK? | system |
| **Execution**| Order size, cooldown, cost gate | hedge |
| **Risk**     | Daily count, position, loss limits | risk |
| **Calendar** | Blackout dates | earnings |

---

## Proposed Taxonomies

### Option 1: By Safety Layer (Defense in Depth)

Organize by **where** the boundary is enforced in the pipeline:

```
safety:
  eligibility:     # Can we trade at all?
    structure:     # min_dte, max_dte, atm_band_pct
    calendar:      # earnings blackout
    trading_hours: # risk.trading_hours_only
  observation:     # State classification (continuous → discrete)
    delta:         # epsilon_band, threshold_hedge_shares, max_delta_limit
    market:        # vol_window_min, stale_ts_threshold_ms
    liquidity:     # wide_spread_pct, extreme_spread_pct
    system:        # data_lag_threshold_ms
  execution:       # How we hedge
    sizing:        # min_hedge_shares, max_hedge_shares_per_order, cooldown_seconds
    cost_gate:    # min_price_move_pct
  limits:          # Circuit breakers
    daily:        # max_daily_hedge_count, max_daily_loss_usd
    position:     # max_position_shares, max_net_delta_shares
    spread:       # max_spread_pct (risk)
```

**Pros:** Clear pipeline order (eligibility → observation → execution → limits).  
**Cons:** Deeper nesting; `risk` is split across `limits` and `eligibility`.

---

### Option 2: By Gate Type (Decision Phase)

Organize by **when** the boundary is checked:

```
gates:
  strategy:   # Before we consider hedge
    structure: { min_dte, max_dte, atm_band_pct }
    earnings:  { blackout_days_before, blackout_days_after, dates }
    trading_hours: true
  state:       # Classification thresholds (O,D,M,L,E,S)
    delta:     { epsilon_band, threshold_hedge_shares, max_delta_limit }
    market:    { vol_window_min, stale_ts_threshold_ms }
    liquidity: { wide_spread_pct, extreme_spread_pct }
    system:    { data_lag_threshold_ms }
  intent:     # Hedge sizing and cost
    hedge:     { min_hedge_shares, cooldown_seconds, max_hedge_shares_per_order, min_price_move_pct }
  guard:      # ExecutionGuard (order-send gate)
    risk:      { max_daily_hedge_count, max_position_shares, max_daily_loss_usd, max_net_delta_shares, max_spread_pct }
```

**Pros:** Maps directly to code (strategy gate → state gate → intent → guard).  
**Cons:** `risk` and `hedge` are conceptually similar (both limit execution).

---

### Option 3: By Domain (What Is Bounded)

Organize by **what** is being bounded:

```
boundaries:
  position:     # Portfolio / delta
    structure:  { min_dte, max_dte, atm_band_pct }
    delta:      { epsilon_band, threshold_hedge_shares, max_delta_limit }
    limits:     { max_position_shares, max_net_delta_shares }  # from risk
  market:       # Market conditions
    regime:     { vol_window_min, stale_ts_threshold_ms }
    liquidity:   { wide_spread_pct, extreme_spread_pct }
    spread:     { max_spread_pct }  # from risk
  system:       # Health
    data_lag:   { data_lag_threshold_ms }
  execution:    # Hedge orders
    sizing:     { min_hedge_shares, max_hedge_shares_per_order, cooldown_seconds }
    cost:       { min_price_move_pct }
  daily:        # Cumulative limits
    count:      { max_daily_hedge_count }
    loss:       { max_daily_loss_usd }
  calendar:     # Blackouts
    earnings:   { blackout_days_before, blackout_days_after, dates }
```

**Pros:** Domain-driven; each section bounds one concept.  
**Cons:** `risk` is split across position, market, daily.

---

### Option 4: Flat + Single Root (Minimal Change)

Keep current flat structure but add a **conceptual root** and **comments** for clarity. No structural change:

```yaml
# === Safety Boundaries (all define "when safe to hedge") ===

# Eligibility: which positions, when
structure: { ... }
earnings:  { ... }

# State classification (O,D,M,L,E,S thresholds)
delta:     { ... }
market:    { ... }
liquidity: { ... }
system:    { ... }

# Execution: sizing and cost gate
hedge:     { ... }

# Circuit breakers
risk:      { ... }

# Model (not a boundary)
greeks:    { ... }
```

**Pros:** Zero migration; only documentation.  
**Cons:** No structural unification.

---

## Recommendation

| Goal | Option |
|------|--------|
| **Minimal change, clear mental model** | Option 4 (document only) |
| **Unified structure, pipeline-aligned** | Option 2 (gates) |
| **Domain-driven, future extensibility** | Option 3 (boundaries) |
| **Defense-in-depth narrative** | Option 1 (safety layers) |

**Suggested path:** Start with **Option 4** (add `CONFIG_SAFETY_TAXONOMY.md` and section comments in config). If you later want structural unification, **Option 2 (gates)** aligns best with the existing code flow: `parse_positions(structure)` → `StateClassifier(delta,market,liquidity,system)` → `gamma_scalper_intent(hedge)` → `ExecutionGuard(risk,earnings)`.

---

## Mapping: Current → Option 2 (gates)

If adopting Option 2, the YAML would look like:

```yaml
gates:
  strategy:
    structure: { min_dte: 21, max_dte: 35, atm_band_pct: 0.03 }
    earnings:  { blackout_days_before: 3, blackout_days_after: 1, dates: [] }
    trading_hours_only: true
  state:
    delta:     { epsilon_band: 10, threshold_hedge_shares: 25, max_delta_limit: 500 }
    market:    { vol_window_min: 5, stale_ts_threshold_ms: 5000 }
    liquidity: { wide_spread_pct: 0.1, extreme_spread_pct: 0.5 }
    system:    { data_lag_threshold_ms: 1000 }
  intent:
    hedge:     { min_hedge_shares: 10, cooldown_seconds: 60, max_hedge_shares_per_order: 500, min_price_move_pct: 0.2 }
  guard:
    risk:      { max_daily_hedge_count: 50, max_position_shares: 2000, max_daily_loss_usd: 5000, ... }

# Unchanged (not gates)
ib: { ... }
symbol: "NVDA"
greeks: { ... }
order: { ... }
```

Code changes: `get_hedge_config`, `get_state_space_config`, `_get_cfg` would read from `config["gates"]["guard"]["risk"]`, `config["gates"]["state"]["delta"]`, etc. Backward compat can support both `gates.X` and top-level `X`.
