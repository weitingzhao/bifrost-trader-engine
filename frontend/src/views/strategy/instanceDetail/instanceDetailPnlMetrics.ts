import type { Execution, StrategyInstance } from '../../../types'
import { fmtExpiry, fmtTradeDate, fmtTs, fmtUsd, parseOptionContractKey } from '../../../utils/format'
import type { RiskProfile } from '../../../utils/riskProfile'
import { buildOptExecutionGroups } from '../../portfolio/buildOptExecutionGroups'

/** Same epsilon as {@link buildOptExecutionGroups} net flat check. */
const NET_QTY_EPS = 1e-9

/**
 * Instance position state from performance-book execution rows (this instance’s qty).
 * Per contract: buy volume vs sell volume → net qty; **Closed** when every contract is flat (net ≈ 0).
 */
export type InstancePositionStatus = 'no_fills' | 'open' | 'closed'

export function computeInstancePositionStatus(executions: Execution[]): InstancePositionStatus {
  if (!executions.length) return 'no_fills'

  const optGroups = buildOptExecutionGroups(executions)
  for (const g of optGroups) {
    if (Math.abs(g.net_qty) >= NET_QTY_EPS) return 'open'
  }

  const nonOpt = executions.filter((e) => (e.sec_type ?? '').toUpperCase() !== 'OPT')
  const keyOf = (e: Execution) => {
    const ck = (e.contract_key ?? '').trim()
    if (ck !== '') return ck
    const sym = (e.symbol ?? '').trim().split(/\s+/)[0] ?? ''
    const st = (e.sec_type ?? '').toUpperCase() || '—'
    return `${sym}|${st}`
  }
  const byKey = new Map<string, Execution[]>()
  for (const e of nonOpt) {
    const k = keyOf(e)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(e)
  }
  for (const [, trades] of byKey) {
    let net = 0
    for (const t of trades) {
      const q = Math.abs(Number(t.quantity) || 0)
      if (q < NET_QTY_EPS) continue
      const side = (t.side ?? '').toUpperCase()
      if (side === 'BUY' || side === 'BOT' || side === 'B') net += q
      else if (side === 'SELL' || side === 'SLD' || side === 'S') net -= q
    }
    if (Math.abs(net) >= NET_QTY_EPS) return 'open'
  }

  return 'closed'
}

/** IB-style sell side (open short / sell to open / sell leg). */
export function isExecutionSellSide(e: Execution): boolean {
  const s = (e.side ?? '').toUpperCase().trim()
  return s === 'SELL' || s === 'SLD' || s === 'S'
}

/** Parse YYYY-MM-DD to UTC ms; invalid → null. */
function parseYmdToUtcMs(s: string | null | undefined): number | null {
  if (s == null || typeof s !== 'string') return null
  const t = s.trim().slice(0, 10)
  if (t.length < 10) return null
  const ms = Date.parse(`${t}T12:00:00.000Z`)
  return Number.isFinite(ms) ? ms : null
}

function executionStrikeUsd(e: Execution): number | null {
  const direct = Number(e.strike)
  if (Number.isFinite(direct) && direct > 0) return direct
  const parsed = parseOptionContractKey(e.contract_key)
  const fromKey = Number(parsed.strike)
  if (Number.isFinite(fromKey) && fromKey > 0) return fromKey
  return null
}

/** One sell-side OPT row contributing to underlying cost (this instance’s execution slice). */
export type UnderlyingCostSellLine = {
  contractKey: string
  strike: number
  qty: number
  lineUsd: number
  side: string
}

/**
 * Per-row breakdown: strike × |qty| × 100 for each OPT sell (SELL / SLD / S), sorted by contract key.
 */
export function underlyingCostSellBreakdown(executions: Execution[]): UnderlyingCostSellLine[] {
  const rows: UnderlyingCostSellLine[] = []
  for (const e of executions) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    if (!isExecutionSellSide(e)) continue
    const strike = executionStrikeUsd(e)
    if (strike == null || strike <= 0) continue
    const q = Math.abs(Number(e.quantity) || 0)
    if (q <= 0) continue
    const lineUsd = strike * q * 100
    const contractKey = (e.contract_key ?? '').trim() || `(opt|strike=${strike})`
    rows.push({ contractKey, strike, qty: q, lineUsd, side: (e.side ?? '').trim() || '—' })
  }
  rows.sort((a, b) => a.contractKey.localeCompare(b.contractKey))
  return rows
}

/** Total underlying cost: Σ lineUsd from {@link underlyingCostSellBreakdown}. */
export function underlyingCostSellOptUsd(executions: Execution[]): number {
  return underlyingCostSellBreakdown(executions).reduce((s, r) => s + r.lineUsd, 0)
}

/**
 * Underlying cost per calendar-day unit of **hold time used** — same divisor as annual return:
 * {@link underlyingCostSellOptUsd} ÷ {@link holdDaysForAnnualization}(`report_date` span in days).
 * Null when there is no `report_date` span, or underlying cost is zero.
 */
export function underlyingCostUsdPerDayFromExecutions(executions: Execution[]): number | null {
  const spanDays = holdTimeDaysFromReportDateSpan(executions)
  if (spanDays == null) return null
  const total = underlyingCostSellOptUsd(executions)
  if (total <= 0) return null
  const daysUsed = holdDaysForAnnualization(spanDays)
  if (!Number.isFinite(daysUsed) || daysUsed <= 0) return null
  return total / daysUsed
}

export function maxRiskUsdFromProfile(
  riskProfile: RiskProfile | null | undefined,
  underlyingCostFallback: number,
): { value: number; source: 'max_loss' | 'underlying' } {
  if (riskProfile && riskProfile.max_loss != null && Number.isFinite(riskProfile.max_loss) && riskProfile.max_loss < 0) {
    return { value: Math.abs(riskProfile.max_loss), source: 'max_loss' }
  }
  return { value: Math.max(0, Number(underlyingCostFallback) || 0), source: 'underlying' }
}

/**
 * Capital at risk denominator: structure-type-aware, following industry convention.
 *
 * | Structure type        | Denominator (industry standard)                 | Source tag            |
 * |-----------------------|-------------------------------------------------|-----------------------|
 * | covered_call          | Stock cost basis: shares × avg cost             | stock_cost_basis      |
 * | cash_secured_put      | Cash-secured amount: strike × qty × 100         | cash_secured          |
 * | iron_condor / spreads | Max loss at expiration (defined risk)            | max_loss_at_exp       |
 * | straddle_strangle     | Margin proxy or max loss when defined            | max_loss_at_exp       |
 * | leaps / custom / …    | Max loss → underlying fallback                  | max_loss_at_exp / underlying_notional |
 *
 * Cascades: structure-specific preferred source → risk profile max loss → underlying cost fallback.
 */
export type CapitalAtRiskSource =
  | 'stock_cost_basis'
  | 'cash_secured'
  | 'max_loss_at_exp'
  | 'underlying_notional'

export interface CapitalAtRiskResult {
  value: number
  source: CapitalAtRiskSource
  methodLabel: string
  methodHint: string
}

function stockCostBasisFromRiskProfile(riskProfile: RiskProfile | null | undefined): number | null {
  const ctx = riskProfile?.calc_context
  if (ctx == null) return null
  const shares = ctx.covered_shares
  const avgCost = ctx.underlying_avg_cost
  if (shares > 0 && avgCost != null && Number.isFinite(avgCost) && avgCost > 0) {
    return shares * avgCost
  }
  return null
}

function cashSecuredAmountFromExecutions(executions: Execution[]): number {
  let total = 0
  for (const e of executions) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    const right = ((e.option_right ?? '').toUpperCase().charAt(0))
    if (right !== 'P') continue
    if (!isExecutionSellSide(e)) continue
    const strike = executionStrikeUsd(e)
    if (strike == null || strike <= 0) continue
    const q = Math.abs(Number(e.quantity) || 0)
    if (q <= 0) continue
    total += strike * q * 100
  }
  return total
}

function maxLossFromProfile(riskProfile: RiskProfile | null | undefined): number | null {
  if (riskProfile && riskProfile.max_loss != null && Number.isFinite(riskProfile.max_loss) && riskProfile.max_loss < 0) {
    return Math.abs(riskProfile.max_loss)
  }
  return null
}

/** Reference amounts (A–D) always computable for display; (E) is documented only (margin not modeled). */
export interface RiskDenominatorCandidates {
  /** (A) Long equity at average cost — covered-call style ROC denominator. */
  aStockCostBasisUsd: number | null
  aUnavailableReason: string | null
  /** (B) Short-put obligation proxy: Σ (strike × |qty| × 100) on sell-side puts. */
  bCashSecuredUsd: number
  /** (C) Bounded loss at expiration from risk profile. */
  cMaxLossAtExpUsd: number | null
  cUnavailableReason: string | null
  /** (D) Sell-side OPT Σ (strike × |qty| × 100). */
  dUnderlyingNotionalUsd: number
}

export function computeRiskDenominatorCandidates(
  riskProfile: RiskProfile | null | undefined,
  executions: Execution[],
): RiskDenominatorCandidates {
  const stockBasis = stockCostBasisFromRiskProfile(riskProfile)
  let aUnavailableReason: string | null = null
  if (stockBasis == null) {
    if (!riskProfile) aUnavailableReason = 'No risk profile for this view.'
    else if (riskProfile.calc_context == null) aUnavailableReason = 'Risk profile has no stock calc_context.'
    else if (!(riskProfile.calc_context.covered_shares > 0))
      aUnavailableReason = 'covered_shares is zero — no long stock basis for (A).'
    else if (
      riskProfile.calc_context.underlying_avg_cost == null ||
      !Number.isFinite(riskProfile.calc_context.underlying_avg_cost) ||
      riskProfile.calc_context.underlying_avg_cost <= 0
    )
      aUnavailableReason = 'underlying_avg_cost missing or invalid — cannot form shares × avg cost.'
    else aUnavailableReason = 'Stock cost basis unavailable.'
  }

  const ml = maxLossFromProfile(riskProfile)
  let cUnavailableReason: string | null = null
  if (ml == null) {
    if (!riskProfile) cUnavailableReason = 'No risk profile — (C) not available.'
    else if (riskProfile.max_loss == null || !Number.isFinite(riskProfile.max_loss))
      cUnavailableReason = 'Risk profile max_loss is missing or not finite.'
    else if (riskProfile.max_loss >= 0)
      cUnavailableReason = `max_loss is ${riskProfile.max_loss} (needs negative finite max_loss for bounded loss at expiration).`
    else cUnavailableReason = '(C) max loss at expiration not available.'
  }

  return {
    aStockCostBasisUsd: stockBasis,
    aUnavailableReason: stockBasis == null ? aUnavailableReason : null,
    bCashSecuredUsd: cashSecuredAmountFromExecutions(executions),
    cMaxLossAtExpUsd: ml,
    cUnavailableReason: ml == null ? cUnavailableReason : null,
    dUnderlyingNotionalUsd: underlyingCostSellOptUsd(executions),
  }
}

export type RiskDenominatorLetter = 'A' | 'B' | 'C' | 'D'

export function capitalSourceToLetter(source: CapitalAtRiskSource): RiskDenominatorLetter {
  if (source === 'stock_cost_basis') return 'A'
  if (source === 'cash_secured') return 'B'
  if (source === 'max_loss_at_exp') return 'C'
  return 'D'
}

export interface CapitalAtRiskMindFlowStep {
  n: number
  heading: string
  body: string
}

export interface CapitalAtRiskDiagnostics {
  result: CapitalAtRiskResult
  candidates: RiskDenominatorCandidates
  mindFlowSteps: CapitalAtRiskMindFlowStep[]
  /** Rule-by-rule narrative matching {@link computeCapitalAtRiskWithDiagnostics} (for expanded “step by step”). */
  ruleTraceLines: string[]
  chosenLetter: RiskDenominatorLetter
  selectionWhy: string
}

/**
 * Same denominator as {@link computeCapitalAtRisk}, plus A–D reference amounts, a top-of-modal mind flow, and a decision trace.
 */
export function computeCapitalAtRiskWithDiagnostics(
  structureType: string | null,
  riskProfile: RiskProfile | null | undefined,
  executions: Execution[],
): CapitalAtRiskDiagnostics {
  const candidates = computeRiskDenominatorCandidates(riskProfile, executions)
  const trace: string[] = []
  const st = (structureType ?? '').toLowerCase()
  const stRaw = (structureType ?? '').trim() || '(none)'

  let result: CapitalAtRiskResult | null = null

  if (st === 'covered_call') {
    trace.push(
      'Branch: covered_call — prefer (A) stock cost basis; if (A) is missing, try (C) max loss at expiration before the global cascade.',
    )
    const stockBasis = stockCostBasisFromRiskProfile(riskProfile)
    if (stockBasis != null && stockBasis > 0) {
      result = {
        value: stockBasis,
        source: 'stock_cost_basis',
        methodLabel: 'Stock cost basis',
        methodHint:
          'Covered Call: capital at risk = shares held × average cost per share. Industry standard for ROC on covered call strategies.',
      }
      trace.push(`→ Stop: use (A) = ${fmtUsd(stockBasis)} as Capital at risk.`)
    } else {
      trace.push(
        `(A) not usable${candidates.aUnavailableReason ? ` — ${candidates.aUnavailableReason}` : ''}. Within covered_call, try (C).`,
      )
      const ml = maxLossFromProfile(riskProfile)
      if (ml != null && ml > 0) {
        result = {
          value: ml,
          source: 'max_loss_at_exp',
          methodLabel: 'Max loss at exp.',
          methodHint:
            'Covered Call: stock avg cost unavailable; using |max loss| at expiration as a proxy denominator.',
        }
        trace.push(`→ Stop: use (C) = ${fmtUsd(ml)} as Capital at risk (covered_call fallback).`)
      } else {
        trace.push('(C) not usable in this branch — fall through to generic cascade.')
      }
    }
  }

  if (result == null && st === 'cash_secured_put') {
    trace.push('Branch: cash_secured_put — prefer (B) cash secured = Σ short-put strike × |qty| × 100 on this instance execution slice.')
    const csa = cashSecuredAmountFromExecutions(executions)
    if (csa > 0) {
      result = {
        value: csa,
        source: 'cash_secured',
        methodLabel: 'Cash secured',
        methodHint:
          'Cash Secured Put: capital at risk = put strike × contracts × 100. Industry standard — the cash you must hold to cover assignment.',
      }
      trace.push(`→ Stop: use (B) = ${fmtUsd(csa)} as Capital at risk.`)
    } else {
      trace.push(`(B) = ${fmtUsd(0)} on this slice (no modeled short puts) — fall through to generic cascade.`)
    }
  }

  if (
    result == null &&
    (st === 'iron_condor' ||
      st === 'bull_put_spread' ||
      st === 'bear_call_spread' ||
      st === 'calendar_spread')
  ) {
    trace.push(`Branch: ${st} (defined-risk spread) — prefer (C) max loss at expiration when bounded.`)
    const ml = maxLossFromProfile(riskProfile)
    if (ml != null && ml > 0) {
      result = {
        value: ml,
        source: 'max_loss_at_exp',
        methodLabel: 'Max loss at exp.',
        methodHint:
          'Defined-risk spread: capital at risk = |max loss| at expiration (width of spread × contracts × 100 − net credit). Industry standard for vertical / iron condor ROC.',
      }
      trace.push(`→ Stop: use (C) = ${fmtUsd(ml)} as Capital at risk.`)
    } else {
      trace.push('(C) not available — fall through to generic cascade.')
    }
  }

  if (result == null && st === 'straddle_strangle') {
    trace.push('Branch: straddle_strangle — prefer (C) max loss at expiration when bounded.')
    const ml = maxLossFromProfile(riskProfile)
    if (ml != null && ml > 0) {
      result = {
        value: ml,
        source: 'max_loss_at_exp',
        methodLabel: 'Max loss at exp.',
        methodHint:
          'Straddle / Strangle: using |max loss| at expiration as the risk denominator. For undefined-risk profiles, falls back to underlying notional.',
      }
      trace.push(`→ Stop: use (C) = ${fmtUsd(ml)} as Capital at risk.`)
    } else {
      trace.push('(C) not available — fall through to generic cascade.')
    }
  }

  if (result == null) {
    trace.push('Generic cascade (all other structure_type values, or earlier branches did not lock a denominator): try (C), else (D).')
    const ml = maxLossFromProfile(riskProfile)
    if (ml != null && ml > 0) {
      result = {
        value: ml,
        source: 'max_loss_at_exp',
        methodLabel: 'Max loss at exp.',
        methodHint:
          'Capital at risk = |max loss| at expiration from the risk profile (defined risk). Preferred industry denominator when max loss is bounded.',
      }
      trace.push(`→ Stop: use (C) = ${fmtUsd(ml)} as Capital at risk.`)
    } else {
      const underlying = underlyingCostSellOptUsd(executions)
      result = {
        value: Math.max(0, underlying),
        source: 'underlying_notional',
        methodLabel: 'Underlying notional',
        methodHint:
          'Fallback: Σ (strike × |qty| × 100) for sell-side option legs. Used when structure type is unknown or max loss / stock cost basis cannot be determined.',
      }
      trace.push(
        `(C) not usable${candidates.cUnavailableReason ? ` — ${candidates.cUnavailableReason}` : ''}. → Use (D) = ${fmtUsd(Math.max(0, underlying))} as Capital at risk.`,
      )
    }
  }

  const chosenLetter = capitalSourceToLetter(result.source)
  const selectionWhy = buildCapitalAtRiskSelectionWhy(st, stRaw, result, candidates)

  const aLine =
    candidates.aStockCostBasisUsd != null && candidates.aStockCostBasisUsd > 0
      ? `(A) Stock cost basis = ${fmtUsd(candidates.aStockCostBasisUsd)}.`
      : `(A) Stock cost basis — ${candidates.aUnavailableReason ?? '—'}.`
  const bLine = `(B) Cash secured (short puts) = ${fmtUsd(candidates.bCashSecuredUsd)}.`
  const cLine =
    candidates.cMaxLossAtExpUsd != null && candidates.cMaxLossAtExpUsd > 0
      ? `(C) Max loss at expiration = ${fmtUsd(candidates.cMaxLossAtExpUsd)}.`
      : `(C) Max loss at expiration — ${candidates.cUnavailableReason ?? '—'}.`
  const dLine = `(D) Underlying notional (sell-side OPT) = ${fmtUsd(candidates.dUnderlyingNotionalUsd)}.`
  const referenceBlock = [aLine, bLine, cLine, dLine, '(E) Reg-T / portfolio margin is not modeled — no value.'].join('\n')

  const explicit =
    st === 'covered_call' ||
    st === 'cash_secured_put' ||
    st === 'iron_condor' ||
    st === 'bull_put_spread' ||
    st === 'bear_call_spread' ||
    st === 'calendar_spread' ||
    st === 'straddle_strangle'

  const mindFlowSteps: CapitalAtRiskMindFlowStep[] = [
    {
      n: 1,
      heading: 'Identify structure_type',
      body: `Linked value is "${stRaw}". ${explicit ? 'This type has an explicit rule path in Risk & cost before the generic cascade.' : 'This type uses the generic cascade (prefer bounded max loss, else sell-side notional).'} ${RISK_COST_EXPLICIT_STRUCTURE_COUNT} structure types have dedicated branches (see bottom of this dialog).`,
    },
    {
      n: 2,
      heading: 'Compute reference amounts for this instance',
      body: referenceBlock,
    },
    {
      n: 3,
      heading: 'Run selection rules (same order as the engine)',
      body: 'The decision log below lists each branch in order until the engine stops at a denominator.',
    },
    {
      n: 4,
      heading: 'Lock in Capital at risk',
      body: `Chosen: (${chosenLetter}) ${result.methodLabel} = ${fmtUsd(result.value)}. ${selectionWhy}`,
    },
  ]

  return {
    result,
    candidates,
    mindFlowSteps,
    ruleTraceLines: trace,
    chosenLetter,
    selectionWhy,
  }
}

function buildCapitalAtRiskSelectionWhy(
  stNorm: string,
  stRaw: string,
  result: CapitalAtRiskResult,
  c: RiskDenominatorCandidates,
): string {
  if (result.source === 'stock_cost_basis') {
    return `Because structure_type is covered_call and (A) is positive (${fmtUsd(result.value)}), Return % / Cost per day / annualization use equity cost basis — not (D) option notional.`
  }
  if (result.source === 'cash_secured') {
    return `Because structure_type is cash_secured_put and (B) is positive (${fmtUsd(result.value)}), the panel uses the cash-secured put obligation as the industry-standard denominator.`
  }
  if (result.source === 'max_loss_at_exp') {
    if (stNorm === 'covered_call') {
      return `Covered call path: (A) was unavailable; the engine fell back to (C) = ${fmtUsd(result.value)} as the risk denominator.`
    }
    if (
      stNorm === 'iron_condor' ||
      stNorm === 'bull_put_spread' ||
      stNorm === 'bear_call_spread' ||
      stNorm === 'calendar_spread' ||
      stNorm === 'straddle_strangle'
    ) {
      return `Defined-risk / straddle branch for "${stRaw}": bounded (C) is the standard ROC denominator (${fmtUsd(result.value)}).`
    }
    return `Generic rule: bounded loss (C) = ${fmtUsd(result.value)} is preferred whenever the risk profile exposes it; (D) was not used as the denominator.`
  }
  return `(C) was not available (${c.cUnavailableReason ?? 'see risk profile'}). The engine uses (D) underlying notional = ${fmtUsd(result.value)} so Return % and Cost/day still have a positive denominator.`
}

export function computeCapitalAtRisk(
  structureType: string | null,
  riskProfile: RiskProfile | null | undefined,
  executions: Execution[],
): CapitalAtRiskResult {
  return computeCapitalAtRiskWithDiagnostics(structureType, riskProfile, executions).result
}

/** Structure keys with explicit denominator rules in {@link computeCapitalAtRisk} (others use the generic cascade). */
export const RISK_COST_EXPLICIT_STRUCTURE_KEYS = [
  'covered_call',
  'cash_secured_put',
  'iron_condor',
  'bull_put_spread',
  'bear_call_spread',
  'calendar_spread',
  'straddle_strangle',
] as const

export const RISK_COST_EXPLICIT_STRUCTURE_COUNT = RISK_COST_EXPLICIT_STRUCTURE_KEYS.length

/** Raw expiry string from the latest (by calendar) open OPT leg; digits may be YYYYMMDD or YYYYMM. */
function openPositionLatestOptExpiryRaw(executions: Execution[]): string | null {
  const groups = buildOptExecutionGroups(executions)
  let bestRaw: string | null = null
  let bestVal = -Infinity
  for (const g of groups) {
    if (Math.abs(g.net_qty) < NET_QTY_EPS) continue
    const raw = String(g.expiry ?? '').trim()
    const fromKey = parseOptionContractKey(g.contract_key).expiry
    const exp = raw && raw !== '—' ? raw : fromKey !== '—' ? fromKey : ''
    if (!exp || exp === '—') continue
    const v = expirySortValueFromRaw(exp)
    if (v > bestVal) {
      bestVal = v
      bestRaw = exp
    }
  }
  return bestRaw
}

function expiryRawToEndUtcMs(raw: string): number | null {
  const d = String(raw).replace(/\D/g, '')
  if (d.length >= 8) return parseYmdToUtcMs(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)
  if (d.length >= 6) return parseEndDisplayToUtcMs(`${d.slice(0, 4)}-${d.slice(4, 6)}`)
  return null
}

/**
 * Hold span for Instances list / PnL strip when position status is known:
 * - **closed** or **no_fills**: min→max `report_date` (unchanged).
 * - **open**: min `report_date` (Start Date) → **latest** OPT expiry among **current** (non-flat) legs (aligned with End Date column).
 */
export function holdTimeSpanDaysForInstanceList(
  executions: Execution[],
  positionStatus: InstancePositionStatus,
): number | null {
  if (positionStatus !== 'open') {
    return holdTimeDaysFromReportDateSpan(executions)
  }
  const raw = openPositionLatestOptExpiryRaw(executions)
  const endMs = raw != null ? expiryRawToEndUtcMs(raw) : null
  const report = reportDateStartEnd(executions)
  const startMs = parseYmdToUtcMs(report.start)
  if (endMs == null || startMs == null) {
    return holdTimeDaysFromReportDateSpan(executions)
  }
  return Math.max((endMs - startMs) / 86400000, 0)
}

/** Hold span for PnL / annualization: optional position status applies open → expiry end rule. */
export function holdSpanDaysForMetrics(executions: Execution[], positionStatus?: InstancePositionStatus): number | null {
  if (positionStatus === undefined) {
    return holdTimeDaysFromReportDateSpan(executions)
  }
  return holdTimeSpanDaysForInstanceList(executions, positionStatus) ?? holdTimeDaysFromReportDateSpan(executions)
}

/**
 * Net PnL per day of **hold time used** — same divisor as {@link underlyingCostUsdPerDayFromExecutions} and annual return:
 * `netPnl ÷ holdDaysForAnnualization(hold span)`.
 * When `positionStatus` is passed, hold span matches the Instances list / detail strip (open → min report_date → latest open-leg expiry).
 */
export function netPnlUsdPerDayFromNetAndExecutions(
  netPnl: number | null | undefined,
  executions: Execution[],
  positionStatus?: InstancePositionStatus,
): number | null {
  const spanDays = holdSpanDaysForMetrics(executions, positionStatus)
  if (spanDays == null) return null
  const net = Number(netPnl)
  if (!Number.isFinite(net)) return null
  const daysUsed = holdDaysForAnnualization(spanDays)
  if (!Number.isFinite(daysUsed) || daysUsed <= 0) return null
  return net / daysUsed
}

/** Min / max `report_date` (YYYY-MM-DD) across executions; null when none. */
export function reportDateStartEnd(executions: Execution[]): { start: string | null; end: string | null } {
  let min: string | null = null
  let max: string | null = null
  for (const e of executions) {
    const raw = e.report_date
    if (raw == null || typeof raw !== 'string') continue
    const d = raw.trim().slice(0, 10)
    if (d.length < 10) continue
    if (min == null || d < min) min = d
    if (max == null || d > max) max = d
  }
  return { start: min, end: max }
}

/**
 * Annual return % for Instance Detail / list: **(Net PnL/day ÷ Cost/day) × (365.25 ÷ hold days used) × 100**, where
 * both per-day amounts use the same **hold span** (see {@link holdSpanDaysForMetrics}); divisor in days = `max(span days + 1, 1)`.
 * Algebraically identical to `net × (365.25 ÷ days) ÷ underlying × 100` (since Net/day ÷ Cost/day = net ÷ underlying).
 * Returns null when hold span or underlying cost blocks the calculation.
 * @param positionStatus When set (e.g. from {@link computeInstancePositionStatus}), **open** rows use hold span =
 *   min `report_date` → latest OPT expiry among **non-flat** legs (aligned with End Date on the Instances list).
 */
export function annualReturnDetailFromNetAndExecutions(
  netPnl: number | null | undefined,
  executions: Execution[],
  maxRiskUsd?: number | null,
  positionStatus?: InstancePositionStatus,
): {
  annualReturnPct: number
  net: number
  denominatorUsd: number
  denominatorSource: 'max_risk' | 'underlying'
  daysUsedForAnnual: number
  factor: number
  netPnlPerDayUsd: number
  denominatorPerDayUsd: number
} | null {
  const holdSpanDays = holdSpanDaysForMetrics(executions, positionStatus)
  if (holdSpanDays == null) return null
  const maxRiskN = Number(maxRiskUsd)
  const useMaxRisk = Number.isFinite(maxRiskN) && maxRiskN > 0
  const denominatorUsd = useMaxRisk ? maxRiskN : underlyingCostSellOptUsd(executions)
  if (denominatorUsd <= 0) return null
  const net = Number(netPnl)
  if (!Number.isFinite(net)) return null
  const daysUsedForAnnual = holdDaysForAnnualization(holdSpanDays)
  const netPnlPerDayUsd = net / daysUsedForAnnual
  const denominatorPerDayUsd = denominatorUsd / daysUsedForAnnual
  const factor = 365.25 / daysUsedForAnnual
  let annualReturnPct = (netPnlPerDayUsd / denominatorPerDayUsd) * factor * 100
  if (!Number.isFinite(annualReturnPct)) annualReturnPct = 0
  if (annualReturnPct > 999) annualReturnPct = 999
  if (annualReturnPct < -999) annualReturnPct = -999
  return {
    annualReturnPct,
    net,
    denominatorUsd,
    denominatorSource: useMaxRisk ? 'max_risk' : 'underlying',
    daysUsedForAnnual,
    factor,
    netPnlPerDayUsd,
    denominatorPerDayUsd,
  }
}

export type AnnualReturnDetailFromExecutions = NonNullable<ReturnType<typeof annualReturnDetailFromNetAndExecutions>>

/** Calendar span (min→max Report date) in days; null if no execution has `report_date`. */
export function holdTimeDaysFromReportDateSpan(executions: Execution[]): number | null {
  let minMs = Infinity
  let maxMs = -Infinity
  let any = false
  for (const e of executions) {
    const ms = parseYmdToUtcMs(e.report_date)
    if (ms == null) continue
    any = true
    minMs = Math.min(minMs, ms)
    maxMs = Math.max(maxMs, ms)
  }
  if (!any || !Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null
  return Math.max((maxMs - minMs) / 86400000, 0)
}

/** Hold time label: inclusive calendar days (start/end both counted), rounded to integer. */
export function formatHoldDaysRounded0(spanDays: number): string {
  if (!Number.isFinite(spanDays) || spanDays < 0) return '—'
  return `${holdDaysForAnnualization(spanDays)} d`
}

/** Days used in annualization: inclusive days = span + 1, with a 1-day floor. */
export function holdDaysForAnnualization(spanDays: number): number {
  if (!Number.isFinite(spanDays) || spanDays < 0) return 1
  return Math.max(spanDays + 1, 1)
}

/** Parse list End Date display (YYYY-MM-DD or YYYY-MM) to UTC ms for sorting. */
function parseEndDisplayToUtcMs(s: string | null | undefined): number | null {
  if (s == null || typeof s !== 'string') return null
  const t = s.trim()
  if (!t) return null
  if (t.length >= 10) {
    const ms = Date.parse(`${t.slice(0, 10)}T12:00:00.000Z`)
    return Number.isFinite(ms) ? ms : null
  }
  const m = t.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null
  const last = new Date(y, mo, 0).getDate()
  return Date.UTC(y, mo - 1, last, 12, 0, 0)
}

function expirySortValueFromRaw(exp: string): number {
  const d = String(exp).replace(/\D/g, '')
  if (d.length >= 8) return parseInt(d.slice(0, 8), 10)
  if (d.length >= 6) {
    const y = parseInt(d.slice(0, 4), 10)
    const m = parseInt(d.slice(4, 6), 10)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 0
    const lastDay = new Date(y, m, 0).getDate()
    return y * 10000 + m * 100 + lastDay
  }
  return 0
}

/**
 * Latest formatted OPT expiry among option legs with non-zero net qty (open).
 * Returns null when there is no such leg or expiry cannot be parsed.
 */
export function openPositionLatestOptExpiryYmd(executions: Execution[]): string | null {
  const bestRaw = openPositionLatestOptExpiryRaw(executions)
  if (bestRaw == null) return null
  const formatted = fmtExpiry(bestRaw)
  return formatted === '—' ? null : formatted
}

/** Latest formatted OPT expiry among all option contract groups in the slice (any net qty). */
export function latestOptExpiryYmdAmongExecutions(executions: Execution[]): string | null {
  const groups = buildOptExecutionGroups(executions)
  let bestRaw: string | null = null
  let bestVal = -Infinity
  for (const g of groups) {
    const raw = String(g.expiry ?? '').trim()
    const fromKey = parseOptionContractKey(g.contract_key).expiry
    const exp = raw && raw !== '—' ? raw : fromKey !== '—' ? fromKey : ''
    if (!exp || exp === '—') continue
    const v = expirySortValueFromRaw(exp)
    if (v > bestVal) {
      bestVal = v
      bestRaw = exp
    }
  }
  if (bestRaw == null) return null
  const formatted = fmtExpiry(bestRaw)
  return formatted === '—' ? null : formatted
}

function instanceOpenedAtUnixSec(instance: StrategyInstance): number | null {
  if (instance.opened_at_epoch != null && Number.isFinite(Number(instance.opened_at_epoch))) {
    return Number(instance.opened_at_epoch)
  }
  if (instance.opened_at != null && typeof instance.opened_at === 'string' && instance.opened_at.trim() !== '') {
    const ms = Date.parse(instance.opened_at)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return null
}

function maxExecutionTimeSec(executions: Execution[]): number | null {
  let max = -Infinity
  for (const e of executions) {
    const t = e.time
    if (t == null || !Number.isFinite(Number(t))) continue
    max = Math.max(max, Number(t))
  }
  return max === -Infinity ? null : max
}

function maxTradeDateYmd(executions: Execution[]): string | null {
  let max: string | null = null
  for (const e of executions) {
    const raw = e.trade_date
    if (raw == null || typeof raw !== 'string') continue
    const d = raw.trim().slice(0, 10)
    if (d.length < 10) continue
    if (max == null || d > max) max = d
  }
  return max
}

export type InstanceThroughEndKind =
  | 'closed_last_exec'
  | 'closed_trade_date'
  | 'closed_report_date'
  | 'open_option_expiry'
  | 'open_fallback_report'
  | 'unknown'

/**
 * Overview “Open → end”: when flat (**closed**), end is last activity (exec `time`, else trade/report date);
 * when still **open**, end is the latest option contract expiry among executions (else latest report date).
 */
export function computeInstanceThroughEnd(args: {
  instance: StrategyInstance
  executions: Execution[]
  positionStatus: InstancePositionStatus
}): {
  openSec: number | null
  endLabel: string | null
  kind: InstanceThroughEndKind
  title: string
} {
  const openSec = instanceOpenedAtUnixSec(args.instance)
  const { positionStatus, executions } = args

  if (positionStatus === 'no_fills') {
    return {
      openSec,
      endLabel: null,
      kind: 'unknown',
      title: 'No performance-book fills for this instance yet; end date unknown.',
    }
  }

  if (positionStatus === 'closed') {
    const lastExec = maxExecutionTimeSec(executions)
    if (lastExec != null) {
      return {
        openSec,
        endLabel: fmtTs(lastExec),
        kind: 'closed_last_exec',
        title: 'Flat position: end time is the latest execution timestamp in the performance book.',
      }
    }
    const lastTrade = maxTradeDateYmd(executions)
    if (lastTrade != null) {
      return {
        openSec,
        endLabel: fmtTradeDate(lastTrade),
        kind: 'closed_trade_date',
        title: 'Flat position: end is the latest trade date (no execution time on record).',
      }
    }
    const report = reportDateStartEnd(executions)
    if (report.end != null) {
      return {
        openSec,
        endLabel: fmtTradeDate(report.end),
        kind: 'closed_report_date',
        title: 'Flat position: end is the latest report date in the performance book.',
      }
    }
    return {
      openSec,
      endLabel: null,
      kind: 'unknown',
      title: 'Flat position, but no dates found on execution rows.',
    }
  }

  const exp = latestOptExpiryYmdAmongExecutions(executions)
  if (exp != null) {
    return {
      openSec,
      endLabel: exp,
      kind: 'open_option_expiry',
      title:
        'Still open: end shows the latest option contract expiry among executions (proxy until closed).',
    }
  }
  const report = reportDateStartEnd(executions)
  if (report.end != null) {
    return {
      openSec,
      endLabel: fmtTradeDate(report.end),
      kind: 'open_fallback_report',
      title: 'Still open: no option expiry on file; using latest report date as a proxy end.',
    }
  }
  return {
    openSec,
    endLabel: null,
    kind: 'unknown',
    title: 'Still open: no option expiry or report date on execution rows.',
  }
}

/**
 * Instance list End Date column: for **open** positions, show latest OPT expiry among open legs;
 * otherwise max `report_date` (same as before). Sort key uses the displayed date.
 */
export function instanceListEndDateColumn(
  executions: Execution[],
  positionStatus: InstancePositionStatus,
): { display: string | null; sortUtcMs: number | null; cellTitle: string | undefined } {
  const report = reportDateStartEnd(executions)
  if (positionStatus === 'open') {
    const exp = openPositionLatestOptExpiryYmd(executions)
    if (exp != null) {
      return {
        display: exp,
        sortUtcMs: parseEndDisplayToUtcMs(exp),
        cellTitle: `Option expiry (latest among open legs). Max report date: ${report.end ?? '—'}.`,
      }
    }
  }
  const sortUtcMs = parseYmdToUtcMs(report.end)
  return {
    display: report.end,
    sortUtcMs,
    cellTitle: report.end != null ? 'Max report date in the performance window.' : undefined,
  }
}

/**
 * Net PnL for one strategy instance from the performance-book execution slice (same as Instance Detail /
 * Executions Group PnL sum): OPT groups from {@link buildOptExecutionGroups}, non-OPT adds DB
 * `realized_pnl`, plus prorated option–stock link slippage.
 */
export function computeInstanceExecDerivedNetPnl(sliced: Execution[], linkedStockSlippage: number): number | null {
  if (sliced.length === 0) return null
  const groups = buildOptExecutionGroups(sliced)
  let sum = groups.reduce((s, g) => s + g.realized_pnl, 0)
  for (const e of sliced) {
    if ((e.sec_type ?? '').toUpperCase() === 'OPT') continue
    const rp = e.realized_pnl
    if (rp != null && Number.isFinite(Number(rp))) sum += Number(rp)
  }
  const slip = Number.isFinite(linkedStockSlippage) ? linkedStockSlippage : 0
  return sum + slip
}
