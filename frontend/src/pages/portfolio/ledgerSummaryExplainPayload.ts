import type { Execution, OptExecutionGroup } from '../../types'
import { fmtTsShort, fmtUsd0 } from '../../utils/format'
import { formatPeriodLabel, monthKeyToPeriodKey, type LedgerSummaryPeriod } from './ledgerSummaryPeriod'
import type { LedgerMetricExplainKind } from './ledgerMetricExplainKinds'

export const LEDGER_METRIC_EXPLAIN_MAX_ROWS = 50

export interface LedgerMetricExplainPayload {
  ledgerTabLabel: string
  summaryPeriodModeLabel: string
  bucketLabel: string
  metricLabel: string
  displayedFormatted: string
  displayedRaw: number
  /** Worked example: one or more lines (plain text / numbers). */
  formulaLines: string[]
  detailColumnHeaders: string[]
  detailRows: Array<Record<string, string | number>>
  truncatedCount: number
  emptyMessage?: string
}

function monthStrFromExecution(ex: Execution): string | null {
  const ts = ex.time ?? 0
  if (!ts) return null
  return new Date(ts * 1000).toISOString().slice(0, 7)
}

function stockExecsInPeriodBucket(
  stockExecs: Execution[],
  period: LedgerSummaryPeriod,
  bucketKey: string,
): Execution[] {
  const out: Execution[] = []
  for (const ex of stockExecs) {
    const m = monthStrFromExecution(ex)
    if (!m) continue
    const pk = monthKeyToPeriodKey(m, period)
    if (pk === bucketKey) out.push(ex)
  }
  return out
}

function closedGroupsInPeriodBucket(
  groups: OptExecutionGroup[],
  period: LedgerSummaryPeriod,
  bucketKey: string,
): OptExecutionGroup[] {
  const out: OptExecutionGroup[] = []
  for (const g of groups) {
    const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
    const ts = times.length > 0 ? Math.max(...times) : 0
    const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
    if (!monthStr) continue
    const pk = monthKeyToPeriodKey(monthStr, period)
    if (pk === bucketKey) out.push(g)
  }
  return out
}

function sumRealizedPnL(execRows: Execution[]): number {
  let s = 0
  for (const ex of execRows) s += Number(ex.realized_pnl) || 0
  return s
}

function sumNotional(execRows: Execution[]): number {
  let s = 0
  for (const ex of execRows) {
    const q = Number(ex.quantity) || 0
    const p = Number(ex.price) || 0
    s += Math.abs(q) * p
  }
  return s
}

function buildRealizedPnLFormula(execRows: Execution[]): string[] {
  if (execRows.length === 0) return ['Σ COALESCE(realized_pnl, 0) = 0 (no rows in this bucket)']
  const terms = execRows.map(ex => Number(ex.realized_pnl) || 0)
  const sum = terms.reduce((a, b) => a + b, 0)
  if (terms.length <= 12) {
    const parts = terms.map(t => fmtUsd0(t))
    return [`${parts.join(' + ')} = ${fmtUsd0(sum)}`]
  }
  const head = terms.slice(0, 4).map(t => fmtUsd0(t)).join(' + ')
  const tail = terms.slice(-3).map(t => fmtUsd0(t)).join(' + ')
  return [
    `${head} + … (${terms.length} terms) + ${tail}`,
    `= ${fmtUsd0(sum)}`,
  ]
}

function buildNotionalFormula(execRows: Execution[]): string[] {
  if (execRows.length === 0) return ['Σ |qty| × price = 0 (no rows in this bucket)']
  const lineVals = execRows.map(ex => {
    const q = Number(ex.quantity) || 0
    const p = Number(ex.price) || 0
    return Math.abs(q) * p
  })
  const sum = lineVals.reduce((a, b) => a + b, 0)
  if (lineVals.length <= 10) {
    const parts = lineVals.map(v => fmtUsd0(v))
    return [`${parts.join(' + ')} = ${fmtUsd0(sum)}`]
  }
  return [
    `Σ |qty| × price over ${lineVals.length} executions`,
    `= ${fmtUsd0(sum)}`,
  ]
}

function buildGroupPnLFormula(groups: OptExecutionGroup[]): string[] {
  if (groups.length === 0) return ['Σ group.realized_pnl = 0 (no groups in this bucket)']
  const terms = groups.map(g => Number(g.realized_pnl) || 0)
  const sum = terms.reduce((a, b) => a + b, 0)
  if (terms.length <= 12) {
    const parts = terms.map(t => fmtUsd0(t))
    return [`${parts.join(' + ')} = ${fmtUsd0(sum)}`]
  }
  const head = terms.slice(0, 4).map(t => fmtUsd0(t)).join(' + ')
  const tail = terms.slice(-3).map(t => fmtUsd0(t)).join(' + ')
  return [`${head} + … (${terms.length} terms) + ${tail}`, `= ${fmtUsd0(sum)}`]
}

/** Same key as LedgerView `stkContractKey`: account|SYMBOL|STK||| */
function stockStkPositionKey(ex: Execution): string {
  return `${(ex.account_id ?? '').trim()}|${(ex.symbol ?? '').toString().trim().toUpperCase()}|STK|||`
}

export interface BuildLedgerMetricExplainPayloadInput {
  kind: LedgerMetricExplainKind
  id: string
  ledgerTabLabel: string
  summaryPeriodModeLabel: string
  ledgerSummaryPeriod: LedgerSummaryPeriod
  closedOptionGroups: OptExecutionGroup[]
  stockFilteredExecutions: Execution[]
  closedOptGroupsPnlSum: number
  /** STK position unrealized from GET /status; optional for kinds that need it. */
  stkUnrealizedByAccountContract?: Map<string, number | null>
}

export function buildLedgerMetricExplainPayload(
  input: BuildLedgerMetricExplainPayloadInput,
): LedgerMetricExplainPayload {
  const {
    kind,
    id,
    ledgerTabLabel,
    summaryPeriodModeLabel,
    ledgerSummaryPeriod,
    closedOptionGroups,
    stockFilteredExecutions,
    closedOptGroupsPnlSum,
    stkUnrealizedByAccountContract = new Map<string, number | null>(),
  } = input

  const period = ledgerSummaryPeriod

  if (kind === 'options_period_realized') {
    const bucketKey = id.replace(/^opt-pnl-/, '')
    const bucketLabel = formatPeriodLabel(bucketKey, period)
    const groups = closedGroupsInPeriodBucket(closedOptionGroups, period, bucketKey)
    const sum = groups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0)
    const allRows = groups.map((g, i) => {
      const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
      const ts = times.length > 0 ? Math.max(...times) : 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : '—'
      return {
        '#': i + 1,
        contract: (g.contract_key ?? '—').slice(0, 48),
        month_bucket: monthStr,
        realized_pnl: fmtUsd0(Number(g.realized_pnl) || 0),
      }
    })
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel,
      metricLabel: 'Realized PnL (option closed groups, this period cell)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildGroupPnLFormula(groups),
      detailColumnHeaders: ['#', 'contract', 'month_bucket', 'realized_pnl'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage:
        groups.length === 0 ? 'No closed option groups map to this period under current filters.' : undefined,
    }
  }

  if (kind === 'options_total_realized') {
    const sum = closedOptGroupsPnlSum
    const allRows = closedOptionGroups.map((g, i) => {
      const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
      const ts = times.length > 0 ? Math.max(...times) : 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : '—'
      return {
        '#': i + 1,
        contract: (g.contract_key ?? '—').slice(0, 48),
        month_bucket: monthStr,
        realized_pnl: fmtUsd0(Number(g.realized_pnl) || 0),
      }
    })
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel: 'Total (all closed groups)',
      metricLabel: 'Realized PnL (all closed option groups)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildGroupPnLFormula(closedOptionGroups),
      detailColumnHeaders: ['#', 'contract', 'month_bucket', 'realized_pnl'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage:
        closedOptionGroups.length === 0 ? 'No closed option groups under current filters.' : undefined,
    }
  }

  if (kind === 'stocks_period_realized') {
    const bucketKey = id.replace(/^stk-rz-/, '')
    const bucketLabel = formatPeriodLabel(bucketKey, period)
    const execRows = stockExecsInPeriodBucket(stockFilteredExecutions, period, bucketKey)
    const sum = sumRealizedPnL(execRows)
    const allRows = execRows.map((ex, i) => ({
      '#': i + 1,
      symbol: ex.symbol ?? '—',
      account: ex.account_id ?? '—',
      time: ex.time != null ? fmtTsShort(ex.time) : '—',
      qty: ex.quantity ?? '—',
      price: ex.price != null ? fmtUsd0(ex.price) : '—',
      realized_pnl: fmtUsd0(Number(ex.realized_pnl) || 0),
    }))
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel,
      metricLabel: 'Realized PnL (stock executions, this period cell)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildRealizedPnLFormula(execRows),
      detailColumnHeaders: ['#', 'symbol', 'account', 'time', 'qty', 'price', 'realized_pnl'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage:
        execRows.length === 0 ? 'No stock executions map to this period under current filters.' : undefined,
    }
  }

  if (kind === 'stocks_period_notional') {
    const bucketKey = id.replace(/^stk-nv-/, '')
    const bucketLabel = formatPeriodLabel(bucketKey, period)
    const execRows = stockExecsInPeriodBucket(stockFilteredExecutions, period, bucketKey)
    const sum = sumNotional(execRows)
    const allRows = execRows.map((ex, i) => {
      const q = Number(ex.quantity) || 0
      const p = Number(ex.price) || 0
      const line = Math.abs(q) * p
      return {
        '#': i + 1,
        symbol: ex.symbol ?? '—',
        account: ex.account_id ?? '—',
        time: ex.time != null ? fmtTsShort(ex.time) : '—',
        qty: ex.quantity ?? '—',
        price: ex.price != null ? fmtUsd0(ex.price) : '—',
        line_notional: fmtUsd0(line),
      }
    })
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel,
      metricLabel: 'Notional (stock executions, this period cell)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildNotionalFormula(execRows),
      detailColumnHeaders: ['#', 'symbol', 'account', 'time', 'qty', 'price', 'line_notional'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage:
        execRows.length === 0 ? 'No stock executions map to this period under current filters.' : undefined,
    }
  }

  if (kind === 'stocks_total_realized') {
    const execRows = stockFilteredExecutions
    const sum = sumRealizedPnL(execRows)
    const allRows = execRows.map((ex, i) => ({
      '#': i + 1,
      symbol: ex.symbol ?? '—',
      account: ex.account_id ?? '—',
      time: ex.time != null ? fmtTsShort(ex.time) : '—',
      qty: ex.quantity ?? '—',
      price: ex.price != null ? fmtUsd0(ex.price) : '—',
      realized_pnl: fmtUsd0(Number(ex.realized_pnl) || 0),
    }))
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel: 'Total (all in-scope stock executions)',
      metricLabel: 'Realized PnL (total)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildRealizedPnLFormula(execRows),
      detailColumnHeaders: ['#', 'symbol', 'account', 'time', 'qty', 'price', 'realized_pnl'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage: execRows.length === 0 ? 'No stock executions under current filters.' : undefined,
    }
  }

  if (kind === 'stocks_total_notional') {
    const execRows = stockFilteredExecutions
    const sum = sumNotional(execRows)
    const allRows = execRows.map((ex, i) => {
      const q = Number(ex.quantity) || 0
      const p = Number(ex.price) || 0
      const line = Math.abs(q) * p
      return {
        '#': i + 1,
        symbol: ex.symbol ?? '—',
        account: ex.account_id ?? '—',
        time: ex.time != null ? fmtTsShort(ex.time) : '—',
        qty: ex.quantity ?? '—',
        price: ex.price != null ? fmtUsd0(ex.price) : '—',
        line_notional: fmtUsd0(line),
      }
    })
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel: 'Total (all in-scope stock executions)',
      metricLabel: 'Notional (total)',
      displayedFormatted: fmtUsd0(sum),
      displayedRaw: sum,
      formulaLines: buildNotionalFormula(execRows),
      detailColumnHeaders: ['#', 'symbol', 'account', 'time', 'qty', 'price', 'line_notional'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage: execRows.length === 0 ? 'No stock executions under current filters.' : undefined,
    }
  }

  if (kind === 'stocks_total_unrealized') {
    const execRows = stockFilteredExecutions
    const seen = new Set<string>()
    const distinctKeys: string[] = []
    for (const ex of execRows) {
      const k = stockStkPositionKey(ex)
      if (seen.has(k)) continue
      seen.add(k)
      distinctKeys.push(k)
    }
    let sum = 0
    let anyPosition = false
    for (const key of distinctKeys) {
      if (!stkUnrealizedByAccountContract.has(key)) continue
      anyPosition = true
      const u = stkUnrealizedByAccountContract.get(key)
      if (u != null && Number.isFinite(u)) sum += u
    }
    const allRows = distinctKeys.map((key, i) => {
      const parts = key.split('|')
      const account = parts[0] ?? '—'
      const sym = parts[1] ?? '—'
      const has = stkUnrealizedByAccountContract.has(key)
      const u = stkUnrealizedByAccountContract.get(key)
      const uStr =
        !has ? '—' : u != null && Number.isFinite(u) ? fmtUsd0(u) : '—'
      return {
        '#': i + 1,
        symbol: sym,
        account,
        contract_key: key.slice(0, 48),
        unrealized_pnl: uStr,
      }
    })
    const truncated =
      allRows.length > LEDGER_METRIC_EXPLAIN_MAX_ROWS
        ? allRows.length - LEDGER_METRIC_EXPLAIN_MAX_ROWS
        : 0
    const detailRows = allRows.slice(0, LEDGER_METRIC_EXPLAIN_MAX_ROWS)
    const formulaLines = anyPosition
      ? [
          'For each distinct (account, STK contract_key) in filtered executions, take unrealized_pnl from GET /status portfolio positions (if present).',
          `Σ unrealized_pnl = ${fmtUsd0(sum)}`,
        ]
      : ['No matching STK position rows in the current status snapshot for in-scope execution keys.']
    return {
      ledgerTabLabel,
      summaryPeriodModeLabel,
      bucketLabel: 'Total (distinct STK positions for in-scope fills)',
      metricLabel: 'Unrealized PnL (total)',
      displayedFormatted: anyPosition ? fmtUsd0(sum) : '—',
      displayedRaw: anyPosition ? sum : NaN,
      formulaLines,
      detailColumnHeaders: ['#', 'symbol', 'account', 'contract_key', 'unrealized_pnl'],
      detailRows,
      truncatedCount: truncated,
      emptyMessage: execRows.length === 0 ? 'No stock executions under current filters.' : undefined,
    }
  }

  return {
    ledgerTabLabel,
    summaryPeriodModeLabel,
    bucketLabel: '—',
    metricLabel: '—',
    displayedFormatted: '—',
    displayedRaw: NaN,
    formulaLines: [],
    detailColumnHeaders: [],
    detailRows: [],
    truncatedCount: 0,
  }
}
