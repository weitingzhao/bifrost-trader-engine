# State Space Table to Code Mapping

This document maps the Gamma Scalping **state space** (six dimensions O, D, M, L, E, S) to code locations, threshold config, and when the engine outputs `TargetPosition` vs enters SAFE_MODE.

## State Variables

| Variable | Enum | Code Location | Description |
|----------|------|----------------|--------------|
| O | `OptionPositionState` | `src/core/state/enums.py` | Option position / gamma sign |
| D | `DeltaDeviationState` | `src/core/state/enums.py` | Net delta deviation from target |
| M | `MarketRegimeState` | `src/core/state/enums.py` | Market regime (vol/trend/gap/stale) |
| L | `LiquidityState` | `src/core/state/enums.py` | Bid-ask spread / quote quality |
| E | `ExecutionState` | `src/core/state/enums.py` | Order/execution layer state |
| S | `SystemHealthState` | `src/core/state/enums.py` | System health (greeks, data lag, risk halt) |

## Enum Values

- **O**: `NONE` (O0), `LONG_GAMMA` (O1), `SHORT_GAMMA` (O2)
- **D**: `IN_BAND` (D0), `MINOR` (D1), `HEDGE_NEEDED` (D2), `FORCE_HEDGE` (D3), `INVALID` (D4)
- **M**: `QUIET` (M0), `NORMAL` (M1), `TREND` (M2), `CHOPPY_HIGHVOL` (M3), `GAP` (M4), `STALE` (M5)
- **L**: `NORMAL` (L0), `WIDE` (L1), `EXTREME_WIDE` (L2), `NO_QUOTE` (L3)
- **E**: `IDLE` (E0), `ORDER_WORKING` (E1), `PARTIAL_FILL` (E2), `DISCONNECTED` (E3), `BROKER_ERROR` (E4)
- **S**: `OK` (S0), `GREEKS_BAD` (S1), `DATA_LAG` (S2), `RISK_HALT` (S3)

## Threshold Config and Defaults

Config section: `state_space` in `config/config.yaml`. Typed defaults in `src/config/settings.py`.

| Section | Key | Default | Description |
|---------|-----|---------|-------------|
| delta | epsilon_band | 10 | \|net_delta\| ≤ this → D0 IN_BAND |
| delta | hedge_threshold | 25 | \|net_delta\| ≥ this → D2 HEDGE_NEEDED |
| delta | max_delta_limit | 500 | \|net_delta\| ≥ this → D3 FORCE_HEDGE |
| market | vol_window_min | 5 | Min bars for vol/trend (simplified) |
| market | stale_ts_threshold_ms | 5000 | Data older than this → M5 STALE |
| liquidity | wide_spread_pct | 0.1 | spread_pct ≥ this → L1 WIDE |
| liquidity | extreme_spread_pct | 0.5 | spread_pct ≥ this → L2 EXTREME_WIDE |
| system | data_lag_threshold_ms | 1000 | Lag > this → S2 DATA_LAG |
| hedge | min_hedge_shares | 10 | Minimum order size to allow |
| hedge | min_price_move_pct | 0.2 | Min price move % (gate) |
| hedge | cooldown_seconds | 60 | Cooldown between hedges (bypassed on D3) |

## When TargetPosition Is Output vs SAFE_MODE

- **Output target / allow new hedge** when:  
  `(O1 or O2) and (D2 or D3) and (L0 or L1) and E0 and S0`  
  Logic: `src/strategy/hedge_gate.py` → `should_output_target(cs)`.

- **SAFE_MODE (no new hedge)** when:  
  `L2 or L3` (extreme/no quote), or `S1 or S2 or S3` (greeks bad / data lag / risk halt), or `E3 or E4` (disconnected / broker error).  
  Only risk-reduction allowed in SAFE_MODE if implemented.

- **D3 FORCE_HEDGE**: Cooldown is bypassed; `min_hedge_shares` and protective limit logic still apply.  
  Applied in `apply_hedge_gates()` via `force_hedge` passed to `RiskGuard.allow_hedge(..., force_hedge=True)`.

## State Transition Diagrams (Mermaid)

### Execution State (E)

```mermaid
stateDiagram-v2
  E0: E0 IDLE
  E1: E1 ORDER_WORKING
  E2: E2 PARTIAL_FILL
  E3: E3 DISCONNECTED
  E4: E4 BROKER_ERROR
  E0 --> E1: order sent
  E1 --> E2: partial fill
  E1 --> E0: fill/cancel
  E2 --> E0: full fill
  E0 --> E3: disconnect
  E1 --> E3: disconnect
  E2 --> E3: disconnect
  E0 --> E4: broker error
  E3 --> E0: reconnect
  E4 --> E0: recovery
```

### Delta Deviation (D)

```mermaid
stateDiagram-v2
  D0: D0 IN_BAND
  D1: D1 MINOR
  D2: D2 HEDGE_NEEDED
  D3: D3 FORCE_HEDGE
  D4: D4 INVALID
  D0 --> D1: abs_delta > epsilon
  D1 --> D2: abs_delta >= hedge_threshold
  D2 --> D3: abs_delta >= max_limit
  D1 --> D0: abs_delta <= epsilon
  D2 --> D1: abs_delta < hedge_threshold
  D3 --> D2: abs_delta < max_limit
  Any --> D4: greeks invalid
```

## Code References

- **CompositeState**: `src/core/state/composite.py` — holds O,D,M,L,E,S and numeric snapshots; `from_runtime()`, `update(event)`.
- **StateClassifier**: `src/core/state/classifier.py` — `classify(...)` maps position_book, market_data, greeks, execution → CompositeState.
- **Hedge gate**: `src/strategy/hedge_gate.py` — `should_output_target(cs)`, `apply_hedge_gates(intent, cs, guard)`.
- **Execution FSM**: `src/execution/execution_fsm.py` — E transitions; `can_place_order()` blocks duplicate orders when E1/E2.
