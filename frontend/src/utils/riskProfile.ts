export type RiskScenarioBreakdown = {
  /** Hypothetical spot at expiration used for this scenario. */
  underlying_price: number
  /** Sum of option legs: intrinsic at S minus avg cost × contracts × 100. */
  options_pnl: number
  /** Covered stock: (S − avg cost) × shares; 0 if stock not in model. */
  stock_pnl: number
}

export type RiskProfile = {
  max_gain: number | null
  max_loss: number | null
  risk_type: 'defined' | 'unlimited'
  breakeven_prices: number[]
  net_premium: number
  /** Net short call contracts not offset by long calls or stock (×100 shares). */
  naked_short_call_contracts: number
  /**
   * When naked_short_call_contracts > 0: worst P&amp;L at expiration of the book
   * after removing that many short-call contracts (highest strikes first).
   * The remaining unlimited tail is from the stripped naked shorts.
   */
  hedged_max_loss: number | null
  /** Scenario (sampled) at which max gain occurs; null if max gain unlimited. */
  max_gain_scenario: RiskScenarioBreakdown | null
  /**
   * Best total P&amp;L among sample spots (0, strikes, 2× top strike), always filled when grid exists.
   * When max gain is Unlimited, use this for Options/Stock breakdown at that best sample; true upside extends further.
   */
  max_gain_sample_scenario: RiskScenarioBreakdown | null
  /** Scenario (sampled) at which max loss occurs; null if max loss unlimited. */
  max_loss_scenario: RiskScenarioBreakdown | null
  /** Same as max_loss_scenario for hedged book when naked shorts exist. */
  hedged_max_loss_scenario: RiskScenarioBreakdown | null
  /** Shares included in stock leg of P&amp;L (coverage cap). */
  stock_shares_modeled: number
  /** False if covered shares &gt; 0 but avg cost missing — stock leg omitted. */
  stock_avg_cost_known: boolean
  /** Inputs used for this profile (for per-field help with worked examples). */
  calc_context: RiskCalcContext | null
}

export type RiskCalcContext = {
  positions: RiskPosition[]
  covered_shares: number
  underlying_avg_cost: number | null
}

export type RiskGridRow = {
  price: number
  options_pnl: number
  stock_pnl: number
  total: number
}

/** Same sampling grid as Max Gain / Max Loss (0, strikes, 2× top strike). */
export function getRiskGridRows(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
): RiskGridRow[] {
  if (positions.length === 0 && coveredShares <= 0) return []
  const strikes = Array.from(new Set(positions.map(p => p.strike))).sort((a, b) => a - b)
  const pricePoints = [0, ...strikes]
  if (strikes.length > 0) {
    pricePoints.push(strikes[strikes.length - 1] * 2)
  }
  return pricePoints.map(price => {
    const options_pnl = payoffOptionsAtPrice(positions, price)
    const stock_pnl = payoffStockAtPrice(coveredShares, underlyingAvgCost, price)
    return { price, options_pnl, stock_pnl, total: options_pnl + stock_pnl }
  })
}

export function netCallShareBalance(
  positions: RiskPosition[],
  coveredShares: number,
): {
  net_short_call_shares: number
  net_long_call_shares: number
  uncovered_short_call_shares: number
} {
  let netShort = 0
  let netLong = 0
  for (const p of positions) {
    if (p.right !== 'C') continue
    if (p.qty < 0) netShort += Math.abs(p.qty) * 100
    else netLong += p.qty * 100
  }
  const uncovered = Math.max(0, netShort - netLong - coveredShares)
  return {
    net_short_call_shares: netShort,
    net_long_call_shares: netLong,
    uncovered_short_call_shares: uncovered,
  }
}

/** One line per option leg at spot S (expiration intrinsic). */
export function legContributionAtS(
  p: RiskPosition,
  S: number,
): { summary: string; detail: string; pnl: number } {
  const intr =
    p.right === 'C' ? Math.max(S - p.strike, 0) : Math.max(p.strike - S, 0)
  const n = Math.abs(p.qty) * 100
  if (p.qty > 0) {
    const pnl = (intr - p.avg_cost) * n
    return {
      summary: `${p.qty} long ${p.right} K=${p.strike}`,
      detail: `intrinsic max(S−K,0)=${intr.toFixed(4)} at S=${S.toFixed(2)} → (${intr.toFixed(4)} − avg ${p.avg_cost}) × ${Math.abs(p.qty)} × 100 = ${pnl.toFixed(2)}`,
      pnl,
    }
  }
  const pnl = (p.avg_cost - intr) * n
  return {
    summary: `${p.qty} short ${p.right} K=${p.strike}`,
    detail: `intrinsic=${intr.toFixed(4)} → (avg ${p.avg_cost} − ${intr.toFixed(4)}) × ${Math.abs(p.qty)} × 100 = ${pnl.toFixed(2)}`,
    pnl,
  }
}

export interface RiskPosition {
  strike: number
  right: 'C' | 'P'
  qty: number
  avg_cost: number
}

export function payoffOptionsAtPrice(positions: RiskPosition[], price: number): number {
  let total = 0
  for (const p of positions) {
    const intrinsic =
      p.right === 'C' ? Math.max(price - p.strike, 0) : Math.max(p.strike - price, 0)
    const absQty = Math.abs(p.qty)
    if (p.qty > 0) {
      total += (intrinsic - p.avg_cost) * absQty * 100
    } else {
      total += (p.avg_cost - intrinsic) * absQty * 100
    }
  }
  return total
}

export function payoffStockAtPrice(
  coveredShares: number,
  underlyingAvgCost: number | null,
  price: number,
): number {
  if (coveredShares <= 0 || underlyingAvgCost == null) return 0
  return (price - underlyingAvgCost) * coveredShares
}

function roundScenario(s: RiskScenarioBreakdown): RiskScenarioBreakdown {
  return {
    underlying_price: Math.round(s.underlying_price * 100) / 100,
    options_pnl: Math.round(s.options_pnl * 100) / 100,
    stock_pnl: Math.round(s.stock_pnl * 100) / 100,
  }
}

/**
 * Remove `contracts` of short-call exposure, unwinding highest short strikes first
 * (typical extra naked leg is often the upper short in ratio structures).
 */
export function stripNakedShortCalls(
  positions: RiskPosition[],
  contracts: number,
): RiskPosition[] {
  if (contracts <= 0) return positions
  const shorts = positions
    .map((p, i) => ({ p, i }))
    .filter(x => x.p.right === 'C' && x.p.qty < 0)
    .sort((a, b) => b.p.strike - a.p.strike)
  let rem = contracts
  const idxToNewQty = new Map<number, number>()
  for (const { p, i } of shorts) {
    if (rem <= 0) break
    const abs = Math.abs(p.qty)
    const dec = Math.min(rem, abs)
    idxToNewQty.set(i, p.qty + dec)
    rem -= dec
  }
  return positions
    .map((p, i) => {
      const nq = idxToNewQty.get(i)
      if (nq === undefined) return p
      return { ...p, qty: nq }
    })
    .filter(p => p.qty !== 0)
}

type EnvelopeResult = {
  max_gain: number | null
  max_loss: number | null
  risk_type: 'defined' | 'unlimited'
  breakeven_prices: number[]
  max_gain_scenario: RiskScenarioBreakdown | null
  max_gain_sample_scenario: RiskScenarioBreakdown | null
  max_loss_scenario: RiskScenarioBreakdown | null
}

function computeEnvelope(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
): EnvelopeResult {
  const emptyBook = positions.length === 0 && coveredShares <= 0
  if (emptyBook) {
    return {
      max_gain: 0,
      max_loss: 0,
      risk_type: 'defined',
      breakeven_prices: [],
      max_gain_scenario: null,
      max_gain_sample_scenario: null,
      max_loss_scenario: null,
    }
  }

  let netShortCallShares = 0
  let netLongCallShares = 0
  for (const p of positions) {
    if (p.right !== 'C') continue
    if (p.qty < 0) netShortCallShares += Math.abs(p.qty) * 100
    else netLongCallShares += p.qty * 100
  }
  const uncoveredUpside = netShortCallShares - netLongCallShares - coveredShares
  const hasUnlimitedDownside = uncoveredUpside > 0

  const hasNetLongCalls = netLongCallShares > netShortCallShares + coveredShares
  const hasUnlimitedUpside = hasNetLongCalls || (coveredShares > 0 && netShortCallShares === 0)

  const rows = getRiskGridRows(positions, coveredShares, underlyingAvgCost)
  const payoffs = rows.map(r => ({ price: r.price, payoff: r.total }))

  const breakevens: number[] = []
  for (let i = 0; i < payoffs.length - 1; i++) {
    const a = payoffs[i]
    const b = payoffs[i + 1]
    if ((a.payoff >= 0 && b.payoff < 0) || (a.payoff < 0 && b.payoff >= 0)) {
      if (b.price !== a.price) {
        const t = a.payoff / (a.payoff - b.payoff)
        breakevens.push(Math.round((a.price + t * (b.price - a.price)) * 100) / 100)
      }
    } else if (a.payoff === 0 && a.price > 0) {
      breakevens.push(a.price)
    }
  }
  if (
    payoffs.length > 0 &&
    payoffs[payoffs.length - 1].payoff === 0 &&
    payoffs[payoffs.length - 1].price > 0
  ) {
    const lastP = payoffs[payoffs.length - 1].price
    if (!breakevens.includes(lastP)) breakevens.push(lastP)
  }

  let minIdx = 0
  let maxIdx = 0
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].total < rows[minIdx].total) minIdx = i
    if (rows[i].total > rows[maxIdx].total) maxIdx = i
  }

  const minRow = rows[minIdx]
  const maxRow = rows[maxIdx]

  const max_loss_scenario: RiskScenarioBreakdown | null = hasUnlimitedDownside
    ? null
    : roundScenario({
        underlying_price: minRow.price,
        options_pnl: minRow.options_pnl,
        stock_pnl: minRow.stock_pnl,
      })
  const max_gain_scenario: RiskScenarioBreakdown | null = hasUnlimitedUpside
    ? null
    : roundScenario({
        underlying_price: maxRow.price,
        options_pnl: maxRow.options_pnl,
        stock_pnl: maxRow.stock_pnl,
      })
  const max_gain_sample_scenario: RiskScenarioBreakdown | null =
    rows.length > 0
      ? roundScenario({
          underlying_price: maxRow.price,
          options_pnl: maxRow.options_pnl,
          stock_pnl: maxRow.stock_pnl,
        })
      : null

  const minPayoff = rows.length ? Math.min(...rows.map(r => r.total)) : 0
  const maxPayoff = rows.length ? Math.max(...rows.map(r => r.total)) : 0

  return {
    max_gain: hasUnlimitedUpside ? null : maxPayoff,
    max_loss: hasUnlimitedDownside ? null : minPayoff,
    risk_type: hasUnlimitedDownside ? 'unlimited' : 'defined',
    breakeven_prices: breakevens,
    max_gain_scenario,
    max_gain_sample_scenario,
    max_loss_scenario,
  }
}

export function computeRiskProfile(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
): RiskProfile {
  const stock_shares_modeled = coveredShares
  const stock_avg_cost_known = coveredShares <= 0 || underlyingAvgCost != null

  if (positions.length === 0) {
    return {
      max_gain: 0,
      max_loss: 0,
      risk_type: 'defined',
      breakeven_prices: [],
      net_premium: 0,
      naked_short_call_contracts: 0,
      hedged_max_loss: null,
      max_gain_scenario: null,
      max_gain_sample_scenario: null,
      max_loss_scenario: null,
      hedged_max_loss_scenario: null,
      stock_shares_modeled,
      stock_avg_cost_known,
      calc_context: null,
    }
  }

  let netPremium = 0
  for (const p of positions) {
    const absQty = Math.abs(p.qty)
    if (p.qty < 0) {
      netPremium += p.avg_cost * absQty * 100
    } else {
      netPremium -= p.avg_cost * absQty * 100
    }
  }

  let netShortCallShares = 0
  let netLongCallShares = 0
  for (const p of positions) {
    if (p.right !== 'C') continue
    if (p.qty < 0) netShortCallShares += Math.abs(p.qty) * 100
    else netLongCallShares += p.qty * 100
  }
  const residualNakedCallShares = Math.max(0, netShortCallShares - netLongCallShares - coveredShares)
  const nakedShortCallContracts =
    residualNakedCallShares > 0 ? Math.ceil(residualNakedCallShares / 100) : 0

  const env = computeEnvelope(positions, coveredShares, underlyingAvgCost)

  let hedged_max_loss: number | null = null
  let hedged_max_loss_scenario: RiskScenarioBreakdown | null = null
  if (nakedShortCallContracts > 0) {
    const hedgedPositions = stripNakedShortCalls(positions, nakedShortCallContracts)
    const hedgedEnv = computeEnvelope(hedgedPositions, coveredShares, underlyingAvgCost)
    hedged_max_loss =
      hedgedEnv.max_loss != null ? Math.round(hedgedEnv.max_loss * 100) / 100 : null
    hedged_max_loss_scenario = hedgedEnv.max_loss_scenario
  }

  return {
    max_gain: env.max_gain != null ? Math.round(env.max_gain * 100) / 100 : null,
    max_loss: env.max_loss != null ? Math.round(env.max_loss * 100) / 100 : null,
    risk_type: env.risk_type,
    breakeven_prices: env.breakeven_prices,
    net_premium: Math.round(netPremium * 100) / 100,
    naked_short_call_contracts: nakedShortCallContracts,
    hedged_max_loss,
    max_gain_scenario: env.max_gain_scenario,
    max_gain_sample_scenario: env.max_gain_sample_scenario,
    max_loss_scenario: env.max_loss_scenario,
    hedged_max_loss_scenario,
    stock_shares_modeled,
    stock_avg_cost_known,
    calc_context: {
      positions: positions.map(p => ({ ...p })),
      covered_shares: coveredShares,
      underlying_avg_cost: underlyingAvgCost,
    },
  }
}

export function formatApproxUsd(v: number): string {
  const abs = Math.abs(v)
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`
  return v < 0 ? `-${str}` : str
}

/** Exact dollars for risk breakdown lines (not k-abbreviated). */
export function formatRiskUsd(v: number): string {
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toFixed(2)}`
}

export function formatRiskLabel(profile: RiskProfile): {
  gainLabel: string
  lossLabel: string
  riskBadge: string
} {
  const fmt = formatApproxUsd
  const lossLabel =
    profile.max_loss == null &&
    profile.naked_short_call_contracts > 0 &&
    profile.hedged_max_loss != null
      ? `${fmt(profile.hedged_max_loss)} + unlimited`
      : profile.max_loss == null
        ? 'Unlimited'
        : fmt(profile.max_loss)
  return {
    gainLabel: profile.max_gain == null ? 'Unlimited' : fmt(profile.max_gain),
    lossLabel,
    riskBadge: profile.risk_type === 'defined' ? 'Defined' : 'Unlimited',
  }
}

/** English lines for detail panels (unlimited call tail breakdown). */
export function formatRiskHedgedBreakdown(profile: RiskProfile): string[] {
  if (profile.naked_short_call_contracts <= 0) return []
  const fmt = formatApproxUsd
  const n = profile.naked_short_call_contracts
  const unit = n === 1 ? 'contract' : 'contracts'
  const lines: string[] = []
  if (profile.hedged_max_loss != null) {
    lines.push(
      `Hedged book (long calls + stock-covered shorts, after pairing): max loss ≈ ${fmt(profile.hedged_max_loss)} at sampled strikes.`,
    )
  }
  lines.push(
    `${n} naked short call ${unit} beyond long/stock hedge — loss grows without bound if the underlying rises.`,
  )
  return lines
}
