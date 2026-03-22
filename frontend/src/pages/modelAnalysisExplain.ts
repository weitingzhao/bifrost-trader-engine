/**
 * Copy for Model Analysis (R-M8): CAR rules and stress methodology.
 * UI strings in English per project rules.
 */

export type CarLegType =
  | 'premium_paid'
  | 'cash_secured'
  | 'covered_stock_cost'
  | 'naked_unbounded'
  | 'unknown'

export type CarExplainCode = 'net_portfolio_max_loss' | 'sum_of_legs' | 'unbounded'

/** One-line label for API `capital_at_risk.explain` */
export function carExplainCodeTitle(code: string): string {
  switch (code) {
    case 'net_portfolio_max_loss':
      return 'Net portfolio max loss (capped CAR)'
    case 'sum_of_legs':
      return 'Sum of per-leg capital (heuristic)'
    case 'unbounded':
      return 'Unbounded leg — CAR not a finite sum'
    default:
      return code
  }
}

/** Paragraph for API `capital_at_risk.explain` */
export function carExplainCodeBody(code: string): string {
  switch (code) {
    case 'net_portfolio_max_loss':
      return (
        'The sum of per-leg heuristic capital would overstate downside for this book. ' +
        'The model therefore uses the net maximum loss from the same expiration payoff envelope as Max Loss (absolute value) as effective CAR, ' +
        'because the legs offset within the same underlying. This is closer to portfolio-level risk than adding legs in isolation.'
      )
    case 'sum_of_legs':
      return (
        'Effective CAR equals the sum of per-leg heuristic amounts (see leg table below). ' +
        'Use this when legs do not overlap in a way that reduces combined downside vs. simple addition.'
      )
    case 'unbounded':
      return (
        'At least one leg is treated as unbounded capital (e.g. naked short call without stock cover in the heuristic). ' +
        'Finite CAR is not shown; rely on Max Loss / payoff scenarios where defined.'
      )
    default:
      return ''
  }
}

/** Short description for each per-leg `type` from the API */
export function carLegTypeDescription(type: string): string {
  switch (type as CarLegType) {
    case 'premium_paid':
      return 'Long option: capital at risk ≈ premium paid (|avg cost| × |contracts| × 100).'
    case 'cash_secured':
      return 'Short put: heuristic CAR = strike × |contracts| × 100 (cash-secured put style; not broker margin).'
    case 'covered_stock_cost':
      return 'Short call with stock cover: CAR for covered shares = stock avg cost × covered shares (capped by position).'
    case 'naked_unbounded':
      return 'Short call without enough long stock in this symbol group: heuristic CAR is unbounded; see Max Loss / scenarios.'
    case 'unknown':
      return 'Could not classify leg for CAR heuristic.'
    default:
      return type
  }
}

/** Intro block for the CAR section (shown once per symbol expand) */
export const CAR_SECTION_INTRO =
  'Capital at risk (CAR) here is a heuristic denominator for return-on-capital and annualization — not broker margin or Reg-T. ' +
  'Per option leg we apply simple rules (premium paid, CSP strike notional, covered call stock cost, or unbounded naked short call). ' +
  'When the combined book’s worst-case loss at expiration is less than the sum of those leg amounts, we cap effective CAR at that net max loss (see Explain code below).'

/** Stress test methodology (matches server `servers/portfolio_model/core.py`) */
export const STRESS_METHODOLOGY_SECTIONS: { title: string; body: string }[] = [
  {
    title: 'Spot shock',
    body:
      'For each scenario, the stressed spot is **S′ = S × (1 + spot shock)** with fixed shocks **−10%, −5%, +5%, +10%**, where **S** is the current underlying mark used for this symbol.',
  },
  {
    title: 'Stock P&L',
    body:
      'If you hold stock in this symbol, **Stock P&L = (S′ − stock avg cost) × shares**. Options do not change stock quantity in this stress.',
  },
  {
    title: 'Intrinsic path (baseline)',
    body:
      '**Intrinsic** rows value options as **expiration intrinsic** at S′: max(S′−K,0) for calls and max(K−S′,0) for puts, versus your **avg cost** per share on each leg, times contracts × 100. No time value — conservative scenario-style P&L.',
  },
  {
    title: 'Black–Scholes reprice (when IV is available)',
    body:
      'When option mid prices allow **implied volatility** to be solved (Black–Scholes, risk-free **r = 4%** per year, time **T** = calendar days to **farthest expiry** in this symbol group ÷ 365), we reprice each leg at **(S′, σ′)**. **IV shock** is **±0.05** in **absolute volatility** (e.g. 0.30 → 0.35), not percentage points of the vol itself. Option P&L = change in model price vs your **avg cost** entry, aggregated per leg.',
  },
  {
    title: 'When IV stress is unavailable',
    body:
      'If implied vol cannot be recovered for legs (missing mid, deep ITM/near-expiry numerics, etc.), only **intrinsic** rows are shown for that symbol and **IV stress is disabled** — see column Method in exported API (`intrinsic` vs `bs_reprice` / `mixed_intrinsic`).',
  },
]
