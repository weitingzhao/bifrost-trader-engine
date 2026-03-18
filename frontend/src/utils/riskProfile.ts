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
}

export interface RiskPosition {
  strike: number
  right: 'C' | 'P'
  qty: number
  avg_cost: number
}

function payoffAtPrice(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
  price: number,
): number {
  let total = 0
  for (const p of positions) {
    const intrinsic = p.right === 'C'
      ? Math.max(price - p.strike, 0)
      : Math.max(p.strike - price, 0)
    const absQty = Math.abs(p.qty)
    if (p.qty > 0) {
      total += (intrinsic - p.avg_cost) * absQty * 100
    } else {
      total += (p.avg_cost - intrinsic) * absQty * 100
    }
  }
  if (coveredShares > 0 && underlyingAvgCost != null) {
    total += (price - underlyingAvgCost) * coveredShares
  }
  return total
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
}

function computeEnvelope(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
): EnvelopeResult {
  if (positions.length === 0 && coveredShares <= 0) {
    return { max_gain: 0, max_loss: 0, risk_type: 'defined', breakeven_prices: [] }
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

  const strikes = Array.from(new Set(positions.map(p => p.strike))).sort((a, b) => a - b)
  const pricePoints = [0, ...strikes]
  if (strikes.length > 0) {
    pricePoints.push(strikes[strikes.length - 1] * 2)
  }

  const payoffs = pricePoints.map(s => ({
    price: s,
    payoff: payoffAtPrice(positions, coveredShares, underlyingAvgCost, s),
  }))

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
  if (payoffs.length > 0 && payoffs[payoffs.length - 1].payoff === 0 && payoffs[payoffs.length - 1].price > 0) {
    const lastP = payoffs[payoffs.length - 1].price
    if (!breakevens.includes(lastP)) breakevens.push(lastP)
  }

  const allPayoffs = payoffs.map(p => p.payoff)
  const minPayoff = Math.min(...allPayoffs)
  const maxPayoff = Math.max(...allPayoffs)

  return {
    max_gain: hasUnlimitedUpside ? null : maxPayoff,
    max_loss: hasUnlimitedDownside ? null : minPayoff,
    risk_type: hasUnlimitedDownside ? 'unlimited' : 'defined',
    breakeven_prices: breakevens,
  }
}

export function computeRiskProfile(
  positions: RiskPosition[],
  coveredShares: number,
  underlyingAvgCost: number | null,
): RiskProfile {
  if (positions.length === 0) {
    return {
      max_gain: 0,
      max_loss: 0,
      risk_type: 'defined',
      breakeven_prices: [],
      net_premium: 0,
      naked_short_call_contracts: 0,
      hedged_max_loss: null,
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
  if (nakedShortCallContracts > 0) {
    const hedgedPositions = stripNakedShortCalls(positions, nakedShortCallContracts)
    const hedgedEnv = computeEnvelope(hedgedPositions, coveredShares, underlyingAvgCost)
    hedged_max_loss =
      hedgedEnv.max_loss != null
        ? Math.round(hedgedEnv.max_loss * 100) / 100
        : null
  }

  return {
    max_gain: env.max_gain != null ? Math.round(env.max_gain * 100) / 100 : null,
    max_loss: env.max_loss != null ? Math.round(env.max_loss * 100) / 100 : null,
    risk_type: env.risk_type,
    breakeven_prices: env.breakeven_prices,
    net_premium: Math.round(netPremium * 100) / 100,
    naked_short_call_contracts: nakedShortCallContracts,
    hedged_max_loss,
  }
}

export function formatApproxUsd(v: number): string {
  const abs = Math.abs(v)
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`
  return v < 0 ? `-${str}` : str
}

export function formatRiskLabel(profile: RiskProfile): {
  gainLabel: string
  lossLabel: string
  riskBadge: string
} {
  const fmt = formatApproxUsd
  const lossLabel =
    profile.max_loss == null && profile.naked_short_call_contracts > 0 && profile.hedged_max_loss != null
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
