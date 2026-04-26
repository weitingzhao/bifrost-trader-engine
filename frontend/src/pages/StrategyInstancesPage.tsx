import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { Execution, PerformanceSummary, StrategyInstance, StatusResponse } from '../types'
import type { StrategyOpportunity } from '../api'
import {
  fetchStrategyInstances,
  fetchOpportunities,
  createStrategyInstance,
  deleteStrategyInstance,
  fetchPerformance,
  fetchExecutions,
} from '../api'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { StrategyOpportunityCombobox } from '../components/StrategyOpportunityCombobox'
import { DetailSidebar } from '../components/DetailSidebar'
import { INSTANCE_DETAIL_SIDEBAR_WIDTH_PX } from '../constants/instanceDetailSidebar'
import { StrategyInstanceDetailPage } from './StrategyInstanceDetailPage'
import { fmtUsd, fmtUsd0, parseOptionContractKey } from '../utils/format'
import { computeRiskProfile, type RiskPosition } from '../utils/riskProfile'
import { fetchOptionStockLinkMapForExecutions } from './performance/fetchOptionStockLinkMap'
import { instanceOptionStockSlippageAdjustment, sliceExecutionForInstanceOptView } from './portfolio/ledgerOptHelpers'
import {
  annualReturnDetailFromNetAndExecutions,
  computeInstanceExecDerivedNetPnl,
  computeInstancePositionStatus,
  holdDaysForAnnualization,
  holdSpanDaysForMetrics,
  instanceListEndDateColumn,
  netPnlUsdPerDayFromNetAndExecutions,
  reportDateStartEnd,
  underlyingCostSellOptUsd,
} from './strategy/instanceDetail/instanceDetailPnlMetrics'

function fmtExpiryMonthBubble(ym: string): string {
  const [year, month] = ym.split('-')
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = parseInt(month ?? '', 10) - 1
  if (!year || m < 0 || m > 11 || Number.isNaN(m)) return ym
  return `${MONTHS[m]} '${year.slice(2)}`
}

function signedPnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'is-neutral'
  if (n > 1e-9) return 'is-positive'
  if (n < -1e-9) return 'is-negative'
  return 'is-neutral'
}

/** Parse `YYYY-MM-DD` or `YYYY-MM` (end → last day of month). */
function parseYmdPartsForList(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (s == null || typeof s !== 'string') return null
  const t = s.trim()
  const full = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (full) {
    const y = parseInt(full[1], 10)
    const m = parseInt(full[2], 10)
    const d = parseInt(full[3], 10)
    if (![y, m, d].every(Number.isFinite)) return null
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    return { y, m, d }
  }
  const mon = t.match(/^(\d{4})-(\d{2})$/)
  if (mon) {
    const y = parseInt(mon[1], 10)
    const m = parseInt(mon[2], 10)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
    const last = new Date(y, m, 0).getDate()
    return { y, m, d: last }
  }
  return null
}

function mdDotStart(m: number, d: number): string {
  return `${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`
}

/** End segment: `5.15` (month without leading zero, day padded). */
function mdDotEnd(m: number, d: number): string {
  return `${m}.${String(d).padStart(2, '0')}`
}

function structureHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}

function structureColorStyle(name: string, active: boolean): CSSProperties {
  const hue = structureHue(name)
  if (active) {
    return {
      borderColor: `hsl(${hue} 78% 52%)`,
      background: `hsl(${hue} 85% 20% / 0.42)`,
      color: `hsl(${hue} 96% 78%)`,
      boxShadow: `inset 0 0 0 1px hsl(${hue} 80% 56% / 0.28)`,
    }
  }
  return {
    borderColor: 'transparent',
    background: 'transparent',
    color: `hsl(${hue} 70% 70%)`,
    boxShadow: 'none',
  }
}

/**
 * Compact period cell, e.g. `2026 (04.17~5.15) 28d` — year, (MM.DD~M.DD) window, hold days.
 */
function formatInstanceListPeriodCell(
  startYmd: string | null | undefined,
  endDisplay: string | null | undefined,
  holdSpanDays: number | null | undefined,
  endCellTitle: string | undefined,
): { yearLabel: string; rangeLabel: string; dayLabel: string | null; title: string | undefined } {
  const startP = startYmd != null ? parseYmdPartsForList(String(startYmd).slice(0, 10)) : null
  const endP = endDisplay != null ? parseYmdPartsForList(String(endDisplay).trim()) : null

  const holdInclusiveDays =
    holdSpanDays != null && Number.isFinite(holdSpanDays) ? holdDaysForAnnualization(holdSpanDays) : null

  if (startP == null && endP == null) {
    return {
      yearLabel: '—',
      rangeLabel: '(—~—)',
      dayLabel: holdInclusiveDays != null ? `${holdInclusiveDays}d` : null,
      title: undefined,
    }
  }

  let yearLabel: string
  if (startP && endP) yearLabel = startP.y === endP.y ? String(startP.y) : `${startP.y}~${endP.y}`
  else if (startP) yearLabel = String(startP.y)
  else yearLabel = String(endP!.y)

  const startSeg = startP ? mdDotStart(startP.m, startP.d) : '—'
  const endSeg = endP ? mdDotEnd(endP.m, endP.d) : '—'
  const rangeLabel = `(${startSeg}~${endSeg})`

  const bits: string[] = []
  if (startYmd) bits.push(`Start ${String(startYmd).slice(0, 10)}`)
  if (endDisplay) bits.push(`End ${endDisplay}`)
  if (endCellTitle) bits.push(endCellTitle)
  const title = bits.length > 0 ? bits.join(' · ') : undefined
  return {
    yearLabel,
    rangeLabel,
    dayLabel: holdInclusiveDays != null ? `${holdInclusiveDays}d` : null,
    title,
  }
}

/**
 * Group rollups: total execution-derived Net PnL; sum of underlying (sell-side OPT); annual % uses
 * the same denominator basis as row-level annual (per-instance max risk fallback underlying).
 */
function computeSymbolGroupRollup(
  rows: StrategyInstance[],
  metrics: Map<number, InstanceListMetrics>,
): { totalNet: number | null; sumUnderlying: number | null; groupAnnualPct: number | null } {
  let totalNet = 0
  let sumU = 0
  let sumDenDays = 0
  let anyNet = false

  for (const row of rows) {
    const m = metrics.get(row.strategy_instance_id)
    if (m == null || m.status !== 'ready') continue
    const { sliced, execDerivedNetPnl } = m
    if (execDerivedNetPnl == null || !Number.isFinite(execDerivedNetPnl)) continue
    anyNet = true
    totalNet += execDerivedNetPnl

    const u = underlyingCostSellOptUsd(sliced)
    if (!Number.isFinite(u) || u <= 0) continue
    const den = Number.isFinite(m.maxRiskUsd) && m.maxRiskUsd > 0 ? m.maxRiskUsd : u
    const ps = computeInstancePositionStatus(sliced)
    const hold = holdSpanDaysForMetrics(sliced, ps)
    if (hold == null) continue
    const daysU = holdDaysForAnnualization(hold)
    sumU += u
    sumDenDays += den * daysU
  }

  let groupAnnualPct: number | null = null
  if (anyNet && sumDenDays > 0) {
    let pct = (totalNet * 365.25) / sumDenDays * 100
    if (!Number.isFinite(pct)) pct = 0
    if (pct > 999) pct = 999
    if (pct < -999) pct = -999
    groupAnnualPct = pct
  }

  return {
    totalNet: anyNet ? totalNet : null,
    sumUnderlying: sumU > 0 ? sumU : null,
    groupAnnualPct,
  }
}

const INSTANCE_LIST_METRICS_CHUNK = 5

type InstanceListMetrics =
  | {
      status: 'ready'
      summary: PerformanceSummary | null | undefined
      sliced: Execution[]
      /** Prorated option–stock link slippage (same as Instance Detail Net PnL add-on). */
      linkedStockSlippage: number
      /** Execution-book Net PnL (OPT group premium ± commission + non-OPT realized + slippage). */
      execDerivedNetPnl: number | null
      /** Return denominator: prefer |risk max_loss|, fallback underlying cost. */
      maxRiskUsd: number
    }
  | { status: 'error' }

function computeInstanceMaxRiskUsd(sliced: Execution[], underlyingFallback: number): number {
  const netByKey = new Map<string, { strike: number; right: 'C' | 'P'; qty: number; totalCost: number }>()
  for (const e of sliced) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    const parsed = parseOptionContractKey(e.contract_key)
    const right = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
    const strike = Number(parsed.strike) || 0
    if (right == null || strike <= 0) continue
    const key = `${strike}|${right}`
    const side = (e.side ?? '').toUpperCase()
    const qty = Math.abs(Number(e.quantity) || 0)
    if (qty <= 0) continue
    const price = Number(e.price) || 0
    const signedQty = side === 'BUY' || side === 'BOT' || side === 'B' ? qty : -qty
    const prev = netByKey.get(key) ?? { strike, right, qty: 0, totalCost: 0 }
    prev.qty += signedQty
    prev.totalCost += price * qty * (signedQty > 0 ? 1 : -1)
    netByKey.set(key, prev)
  }

  const positions: RiskPosition[] = []
  for (const v of netByKey.values()) {
    if (Math.abs(v.qty) < 1e-9) continue
    const avgCost = Math.abs(v.totalCost / v.qty)
    positions.push({ strike: v.strike, right: v.right, qty: Math.round(v.qty), avg_cost: avgCost })
  }
  if (positions.length === 0) return underlyingFallback

  const rp = computeRiskProfile(positions, 0, null)
  if (rp.max_loss != null && Number.isFinite(rp.max_loss) && rp.max_loss < 0) return Math.abs(rp.max_loss)
  return underlyingFallback
}

/** Sortable metric columns (within each symbol group only). */
type InstancesSortColumn =
  | 'start'
  | 'end'
  | 'hold'
  | 'net'
  | 'comm'
  | 'und'
  | 'cday'
  | 'npd'
  | 'ret'
  | 'ann'
  | 'exec'
type InstancesSortDir = 'asc' | 'desc'

function getInstanceSortNumericValue(
  row: StrategyInstance,
  m: InstanceListMetrics | undefined,
  col: InstancesSortColumn,
): number {
  if (m == null || m.status !== 'ready') return Number.NaN
  const { summary, sliced } = m
  switch (col) {
    case 'start': {
      const s = reportDateStartEnd(sliced).start
      if (s == null) return Number.NaN
      const t = Date.parse(`${s}T12:00:00.000Z`)
      return Number.isFinite(t) ? t : Number.NaN
    }
    case 'end': {
      const ps = computeInstancePositionStatus(sliced)
      const { sortUtcMs } = instanceListEndDateColumn(sliced, ps)
      return sortUtcMs != null && Number.isFinite(sortUtcMs) ? sortUtcMs : Number.NaN
    }
    case 'net': {
      if (m.execDerivedNetPnl == null || !Number.isFinite(m.execDerivedNetPnl)) return Number.NaN
      return m.execDerivedNetPnl
    }
    case 'comm':
      return summary != null && summary.total_commission != null ? Number(summary.total_commission) : Number.NaN
    case 'hold': {
      const ps = computeInstancePositionStatus(sliced)
      const d = holdSpanDaysForMetrics(sliced, ps)
      return d != null && Number.isFinite(d) ? d : Number.NaN
    }
    case 'und': {
      const u = underlyingCostSellOptUsd(sliced)
      return Number.isFinite(u) ? u : Number.NaN
    }
    case 'cday': {
      const ps = computeInstancePositionStatus(sliced)
      const hold = holdSpanDaysForMetrics(sliced, ps)
      if (hold == null || !Number.isFinite(hold)) return Number.NaN
      const u = underlyingCostSellOptUsd(sliced)
      const den = Number.isFinite(m.maxRiskUsd) && m.maxRiskUsd > 0 ? m.maxRiskUsd : u
      if (!Number.isFinite(den) || den <= 0) return Number.NaN
      return den / holdDaysForAnnualization(hold)
    }
    case 'npd': {
      if (m.execDerivedNetPnl == null || !Number.isFinite(m.execDerivedNetPnl)) return Number.NaN
      const ps = computeInstancePositionStatus(sliced)
      const v = netPnlUsdPerDayFromNetAndExecutions(m.execDerivedNetPnl, sliced, ps)
      return v != null && Number.isFinite(v) ? v : Number.NaN
    }
    case 'ret': {
      if (m.execDerivedNetPnl == null || !Number.isFinite(m.execDerivedNetPnl)) return Number.NaN
      const u = underlyingCostSellOptUsd(sliced)
      const den = Number.isFinite(m.maxRiskUsd) && m.maxRiskUsd > 0 ? m.maxRiskUsd : u
      if (!Number.isFinite(den) || den <= 0) return Number.NaN
      const pct = (m.execDerivedNetPnl / den) * 100
      if (!Number.isFinite(pct)) return Number.NaN
      return Math.min(999, Math.max(-999, pct))
    }
    case 'ann': {
      if (m.execDerivedNetPnl == null || !Number.isFinite(m.execDerivedNetPnl)) return Number.NaN
      const ps = computeInstancePositionStatus(sliced)
      const a = annualReturnDetailFromNetAndExecutions(m.execDerivedNetPnl, sliced, m.maxRiskUsd, ps)
      return a != null && Number.isFinite(a.annualReturnPct) ? a.annualReturnPct : Number.NaN
    }
    case 'exec': {
      const n = row.executions_count
      return n != null && Number.isFinite(Number(n)) ? Number(n) : Number.NaN
    }
    default:
      return Number.NaN
  }
}

function compareInstancesInGroup(
  a: StrategyInstance,
  b: StrategyInstance,
  metrics: Map<number, InstanceListMetrics>,
  col: InstancesSortColumn,
  dir: InstancesSortDir,
): number {
  const va = getInstanceSortNumericValue(a, metrics.get(a.strategy_instance_id), col)
  const vb = getInstanceSortNumericValue(b, metrics.get(b.strategy_instance_id), col)
  const mul = dir === 'asc' ? 1 : -1
  const aMissing = Number.isNaN(va)
  const bMissing = Number.isNaN(vb)
  if (aMissing && bMissing) return a.strategy_instance_id - b.strategy_instance_id
  if (aMissing) return 1
  if (bMissing) return -1
  if (va === vb) return a.strategy_instance_id - b.strategy_instance_id
  return va < vb ? -mul : mul
}

function SortableInstancesTh({
  column,
  className,
  children,
  sort,
  onSort,
  rowSpan,
}: {
  column: InstancesSortColumn
  className?: string
  children: ReactNode
  sort: { column: InstancesSortColumn; dir: InstancesSortDir } | null
  onSort: (c: InstancesSortColumn) => void
  /** Two-row header: parent cells use rowspan 2. */
  rowSpan?: number
}) {
  const active = sort?.column === column
  const dir = sort?.dir
  return (
    <th
      rowSpan={rowSpan}
      className={[className, active ? 'strategy-instances-th-sort-active' : ''].filter(Boolean).join(' ')}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="strategy-instances-sort-btn"
        onClick={() => onSort(column)}
        aria-pressed={active}
        title={
          active
            ? `Sorted ${dir === 'asc' ? 'ascending' : 'descending'} within each symbol group. Click to reverse.`
            : 'Sort within each symbol group by this column'
        }
      >
        <span className="strategy-instances-sort-btn-label">{children}</span>
        {active ? <span className="strategy-instances-sort-caret">{dir === 'asc' ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  )
}

/** One-shot intent from Win Rate (or similar): apply Structure bubble filter when token changes. */
export type InstancesStructureFilterIntent = { token: number; structureName: string }
type InstancesSinceFilter = '' | '1m' | 'q' | 'half' | '1y' | 'ytd'

function ymdUtcDaysAgoMonths(months: number): string {
  const d = new Date()
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0))
  utc.setUTCMonth(utc.getUTCMonth() - months)
  const y = utc.getUTCFullYear()
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const day = String(utc.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function ymdUtcYtdStart(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-01-01`
}

function ymdUtcToday(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sinceFilterThresholdYmd(v: InstancesSinceFilter): string | null {
  if (v === '1m') return ymdUtcDaysAgoMonths(1)
  if (v === 'q') return ymdUtcDaysAgoMonths(3)
  if (v === 'half') return ymdUtcDaysAgoMonths(6)
  if (v === '1y') return ymdUtcDaysAgoMonths(12)
  if (v === 'ytd') return ymdUtcYtdStart()
  return null
}

export interface StrategyInstancesPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  /** Instance id from URL hash #/strategies/instances/:id; when set, detail view is shown. */
  urlStrategyInstanceId?: number | null
  onNavigateToStrategy?: () => void
  breadcrumbLabel?: string
  /** When set with a new `token`, sets the in-panel Structure filter to `structureName`. */
  instancesStructureFilterIntent?: InstancesStructureFilterIntent | null
}

export function StrategyInstancesPage({
  status,
  loadStatus: _loadStatus,
  urlStrategyInstanceId = null,
  onNavigateToStrategy,
  breadcrumbLabel = 'Instances',
  instancesStructureFilterIntent = null,
}: StrategyInstancesPageProps) {
  const [items, setItems] = useState<StrategyInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [accountIdFilter, setAccountIdFilter] = useState<string>('')
  const [opportunityIdFilter, setOpportunityIdFilter] = useState<number | ''>('')
  const [instanceIdFilter, setInstanceIdFilter] = useState<number | ''>('')
  const [instancesForOpportunity, setInstancesForOpportunity] = useState<StrategyInstance[]>([])
  /** In-panel bubble filters (applied after API fetch) */
  const [instStructureFilter, setInstStructureFilter] = useState<string>('')
  const [instSymbolFilter, setInstSymbolFilter] = useState<string>('')
  const [instRightFilter, setInstRightFilter] = useState<'' | 'C' | 'P'>('')
  const [instExpiryFilter, setInstExpiryFilter] = useState<string>('')
  const [instSinceFilter, setInstSinceFilter] = useState<InstancesSinceFilter>('q')
  /** Position status from final-book executions (matches Status column). */
  const [instStatusFilter, setInstStatusFilter] = useState<'' | 'open' | 'closed'>('')
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null)
  const [compareInstanceId, setCompareInstanceId] = useState<number | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createOpportunityId, setCreateOpportunityId] = useState<number | ''>('')
  const [createAccountId, setCreateAccountId] = useState('')
  const [createOpenedAt, setCreateOpenedAt] = useState('')
  const [createLabel, setCreateLabel] = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; instanceId: number | null; label: string; deleting: boolean; error: string | null }>({
    open: false, instanceId: null, label: '', deleting: false, error: null,
  })
  /** Per-instance performance summary + sliced executions (final book), for list PnL columns. */
  const [instanceMetricsById, setInstanceMetricsById] = useState<Map<number, InstanceListMetrics>>(new Map())
  /** Symbol group key → collapsed (rows hidden). Default expanded when key absent. */
  const [collapsedSymbolGroups, setCollapsedSymbolGroups] = useState<Record<string, boolean>>({})
  /** Accordion: only one symbol group expanded at a time. Multi: several may stay open (same as Portfolio Open → Detail view). */
  const [symbolGroupAccordionMode, setSymbolGroupAccordionMode] = useState<boolean>(true)
  const [isNarrowViewport, setIsNarrowViewport] = useState<boolean>(
    () => (typeof window !== 'undefined' ? window.innerWidth <= 960 : false),
  )

  /** Detail view is shown when URL has an instance id or user picked one in-page (e.g. after create). */
  const effectiveDetailId = urlStrategyInstanceId ?? selectedInstanceId

  const accounts = status?.portfolio?.accounts ?? []

  /** Event Account options for Create instance: Host and Secondary from Settings → IB Connection. */
  const eventAccounts = (() => {
    const cfg = status?.config?.ib_client
    if (!cfg) return []
    const list: { account_id: string; label: string }[] = []
    const host = (cfg.account?.event_host ?? '').toString().trim()
    if (host) list.push({ account_id: host, label: 'Host' })
    const secondary = (cfg.account?.event_secondary ?? '').toString().trim()
    if (secondary) list.push({ account_id: secondary, label: 'Secondary' })
    return list
  })()

  const loadOpportunities = useCallback(() => {
    fetchOpportunities(false)
      .then((r) => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])

  useEffect(() => {
    loadOpportunities()
  }, [loadOpportunities])

  useEffect(() => {
    if (instancesStructureFilterIntent == null) return
    const name = instancesStructureFilterIntent.structureName.trim()
    if (name) setInstStructureFilter(name)
  }, [instancesStructureFilterIntent?.token, instancesStructureFilterIntent?.structureName])

  const loadInstances = useCallback(() => {
    setLoading(true)
    setError(null)
    const params: { account_id?: string; strategy_opportunity_id?: number; strategy_instance_ids?: number[] } = {}
    if (accountIdFilter.trim()) params.account_id = accountIdFilter.trim()
    if (opportunityIdFilter !== '' && Number.isFinite(Number(opportunityIdFilter))) {
      params.strategy_opportunity_id = Number(opportunityIdFilter)
    }
    if (instanceIdFilter !== '') params.strategy_instance_ids = [instanceIdFilter]
    fetchStrategyInstances(params)
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [accountIdFilter, opportunityIdFilter, instanceIdFilter])

  useEffect(() => {
    loadInstances()
  }, [loadInstances])

  useEffect(() => {
    if (items.length === 0) {
      setInstanceMetricsById(new Map())
      return
    }
    let cancelled = false
    const ids = items.map((i) => i.strategy_instance_id)
    const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 86400
    const nowTs = Math.floor(Date.now() / 1000)
    setInstanceMetricsById(new Map())
    ;(async () => {
      for (let i = 0; i < ids.length; i += INSTANCE_LIST_METRICS_CHUNK) {
        if (cancelled) return
        const chunk = ids.slice(i, i + INSTANCE_LIST_METRICS_CHUNK)
        const chunkResults = await Promise.all(
          chunk.map(async (id): Promise<[number, InstanceListMetrics]> => {
            try {
              const [perf, execRes] = await Promise.all([
                fetchPerformance({
                  since_ts: oneYearAgo,
                  until_ts: nowTs,
                  granularity: 'day',
                  strategy_instance_id: id,
                  summary_only: true,
                }),
                fetchExecutions(undefined, undefined, 500, false, undefined, id, 'performance_book'),
              ])
              const raw = execRes.executions ?? []
              const sliced = raw
                .map((ex) => sliceExecutionForInstanceOptView(ex, id))
                .filter((row): row is Execution => row != null)
              const linkMap = await fetchOptionStockLinkMapForExecutions(sliced)
              const linkedStockSlippage = instanceOptionStockSlippageAdjustment(raw, id, linkMap)
              const execDerivedNetPnl = computeInstanceExecDerivedNetPnl(sliced, linkedStockSlippage)
              const underlying = underlyingCostSellOptUsd(sliced)
              const maxRiskUsd = computeInstanceMaxRiskUsd(sliced, underlying)
              return [id, { status: 'ready', summary: perf.summary, sliced, linkedStockSlippage, execDerivedNetPnl, maxRiskUsd } as const]
            } catch {
              return [id, { status: 'error' } as const]
            }
          }),
        )
        if (cancelled) return
        setInstanceMetricsById((prev) => {
          const next = new Map(prev)
          for (const [id, row] of chunkResults) next.set(id, row)
          return next
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [items])

  useEffect(() => {
    const onResize = () => setIsNarrowViewport(window.innerWidth <= 960)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const oppIdNum = opportunityIdFilter === '' ? null : Number(opportunityIdFilter)
  useEffect(() => {
    if (oppIdNum == null || !Number.isFinite(oppIdNum)) {
      setInstancesForOpportunity([])
      return
    }
    fetchStrategyInstances({ strategy_opportunity_id: oppIdNum })
      .then(r => setInstancesForOpportunity(r.items ?? []))
      .catch(() => setInstancesForOpportunity([]))
  }, [oppIdNum])

  const opportunitiesById = useMemo(() => {
    const m = new Map<number, StrategyOpportunity>()
    for (const o of opportunities) {
      m.set(o.strategy_opportunity_id, o)
    }
    return m
  }, [opportunities])

  const getScopeSymbol = useCallback((row: StrategyInstance): string => {
    const opp = opportunitiesById.get(row.strategy_opportunity_id)
    if (opp == null) return '—'
    const scopeType = (opp.scope_type ?? '').trim()
    if (scopeType !== 'explicit_symbols' && scopeType !== 'watchlist_stk') return '—'
    const symbols = (opp.symbols ?? [])
      .map((s) => String(s ?? '').trim().toUpperCase())
      .filter((s) => s.length > 0)
    if (symbols.length === 0) return '—'
    return symbols[0]
  }, [opportunitiesById])

  /** Per-instance rights and expiry months derived from live OPT positions via strategy_links. */
  const instancePositionMeta = useMemo(() => {
    const map = new Map<number, { rights: Set<'C' | 'P'>; expiryMonths: Set<string> }>()
    for (const acc of status?.portfolio?.accounts ?? []) {
      for (const p of acc.positions ?? []) {
        if ((p.secType ?? '').toUpperCase() !== 'OPT') continue
        const parsed = parseOptionContractKey(p.contract_key)
        const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
        const s = parsed.expiry.replace(/\D/g, '')
        const ym = s.length >= 6 ? `${s.slice(0, 4)}-${s.slice(4, 6)}` : null
        for (const link of p.strategy_links ?? []) {
          const instId = link.strategy_instance_id
          if (instId == null || !Number.isFinite(instId)) continue
          if (!map.has(instId)) map.set(instId, { rights: new Set(), expiryMonths: new Set() })
          const meta = map.get(instId)!
          if (r) meta.rights.add(r)
          if (ym) meta.expiryMonths.add(ym)
        }
      }
    }
    return map
  }, [status?.portfolio?.accounts])

  /** Available filter options derived from all fetched items (pre-panel-filter). */
  const instanceFilterOptions = useMemo(() => {
    const structures = new Set<string>()
    const symbols = new Set<string>()
    const rights = new Set<'C' | 'P'>()
    const expiryMonths = new Set<string>()
    for (const row of items) {
      const sn = (row.strategy_structure_name ?? '').trim()
      if (sn) structures.add(sn)
      const sym = getScopeSymbol(row)
      if (sym !== '—') symbols.add(sym)
      const meta = instancePositionMeta.get(row.strategy_instance_id)
      if (meta) {
        for (const r of meta.rights) rights.add(r)
        for (const em of meta.expiryMonths) expiryMonths.add(em)
      }
    }
    return {
      structures: Array.from(structures).sort(),
      symbols: Array.from(symbols).sort(),
      rights: Array.from(rights).sort() as ('C' | 'P')[],
      expiryMonths: Array.from(expiryMonths).sort().reverse(),
    }
  }, [items, getScopeSymbol, instancePositionMeta])

  /** items filtered by the in-panel bubble filters (Structure / Symbol / Type / Expiry). */
  const filteredItems = useMemo(() => {
    let list = items
    if (instStructureFilter) {
      list = list.filter(row => (row.strategy_structure_name ?? '').trim() === instStructureFilter)
    }
    if (instSymbolFilter) {
      list = list.filter(row => getScopeSymbol(row) === instSymbolFilter)
    }
    if (instRightFilter) {
      list = list.filter(row => {
        const meta = instancePositionMeta.get(row.strategy_instance_id)
        return meta?.rights.has(instRightFilter) ?? false
      })
    }
    if (instExpiryFilter) {
      list = list.filter(row => {
        const meta = instancePositionMeta.get(row.strategy_instance_id)
        return meta?.expiryMonths.has(instExpiryFilter) ?? false
      })
    }
    if (instStatusFilter) {
      list = list.filter((row) => {
        const m = instanceMetricsById.get(row.strategy_instance_id)
        if (m == null || m.status !== 'ready') return false
        const ps = computeInstancePositionStatus(m.sliced)
        return instStatusFilter === 'open' ? ps === 'open' : ps === 'closed'
      })
    }
    if (instSinceFilter) {
      const threshold = sinceFilterThresholdYmd(instSinceFilter)
      if (threshold != null) {
        list = list.filter((row) => {
          const m = instanceMetricsById.get(row.strategy_instance_id)
          if (m == null || m.status !== 'ready') return false
          const start = reportDateStartEnd(m.sliced).start
          if (start == null) return false
          return start >= threshold
        })
      }
    }
    return list
  }, [
    items,
    instStructureFilter,
    instSymbolFilter,
    instRightFilter,
    instExpiryFilter,
    instSinceFilter,
    instStatusFilter,
    getScopeSymbol,
    instancePositionMeta,
    instanceMetricsById,
  ])

  const groupedItems = useMemo(() => {
    const groups: Array<{ key: string; label: string; rows: StrategyInstance[] }> = []
    const groupIndexByKey = new Map<string, number>()
    for (const row of filteredItems) {
      const symbolKey = getScopeSymbol(row)
      const idx = groupIndexByKey.get(symbolKey)
      if (idx == null) {
        groupIndexByKey.set(symbolKey, groups.length)
        groups.push({ key: symbolKey, label: symbolKey, rows: [row] })
      } else {
        groups[idx].rows.push(row)
      }
    }
    return groups
  }, [filteredItems, getScopeSymbol])

  const sinceRangeText = useMemo(() => {
    if (!instSinceFilter) return null
    const start = sinceFilterThresholdYmd(instSinceFilter)
    if (start == null) return null
    return `${start} ~ ${ymdUtcToday()}`
  }, [instSinceFilter])

  const [instancesSort, setInstancesSort] = useState<{ column: InstancesSortColumn; dir: InstancesSortDir } | null>(null)

  const toggleInstancesSort = useCallback((column: InstancesSortColumn) => {
    setInstancesSort((prev) => {
      if (prev?.column !== column) return { column, dir: 'asc' }
      return { column, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }, [])

  const sortedGroupedItems = useMemo(() => {
    if (instancesSort == null) return groupedItems
    const { column, dir } = instancesSort
    return groupedItems.map((g) => ({
      ...g,
      rows: [...g.rows].sort((a, b) => compareInstancesInGroup(a, b, instanceMetricsById, column, dir)),
    }))
  }, [groupedItems, instancesSort, instanceMetricsById])

  const toggleSymbolGroup = useCallback((key: string) => {
    setCollapsedSymbolGroups((prev) => {
      const wasCollapsed = Boolean(prev[key])
      if (symbolGroupAccordionMode) {
        if (wasCollapsed) {
          const next: Record<string, boolean> = {}
          for (const g of groupedItems) next[g.key] = true
          delete next[key]
          return next
        }
        return { ...prev, [key]: true }
      }
      return { ...prev, [key]: !prev[key] }
    })
  }, [symbolGroupAccordionMode, groupedItems])

  const expandAllSymbolGroups = useCallback(() => {
    if (symbolGroupAccordionMode && groupedItems.length > 0) {
      const next: Record<string, boolean> = {}
      for (const g of groupedItems) next[g.key] = true
      delete next[groupedItems[0].key]
      setCollapsedSymbolGroups(next)
    } else {
      setCollapsedSymbolGroups({})
    }
  }, [symbolGroupAccordionMode, groupedItems])

  const collapseAllSymbolGroups = useCallback(() => {
    setCollapsedSymbolGroups((prev) => {
      const next = { ...prev }
      for (const g of groupedItems) next[g.key] = true
      return next
    })
  }, [groupedItems])

  const openDeleteConfirm = useCallback((row: StrategyInstance) => {
    const displayLabel = row.label ?? row.strategy_opportunity_name ?? `#${row.strategy_instance_id}`
    setConfirmDelete({ open: true, instanceId: row.strategy_instance_id, label: displayLabel, deleting: false, error: null })
  }, [])

  const renderMetricsTds = useCallback((instanceId: number) => {
    const m = instanceMetricsById.get(instanceId)
    if (m == null) {
      return Array.from({ length: 9 }, (_, j) => (
        <td key={`m-${instanceId}-ph-${j}`} className="muted tabular-nums strategy-instance-metric-placeholder">
          …
        </td>
      ))
    }
    if (m.status === 'error') {
      return Array.from({ length: 9 }, (_, j) => (
        <td key={`m-${instanceId}-err-${j}`} className="muted tabular-nums">
          —
        </td>
      ))
    }
    const { summary, sliced, linkedStockSlippage, execDerivedNetPnl } = m
    const positionStatus = computeInstancePositionStatus(sliced)
    const { start } = reportDateStartEnd(sliced)
    const endCol = instanceListEndDateColumn(sliced, positionStatus)
    const holdSpanDays = holdSpanDaysForMetrics(sliced, positionStatus)
    const periodCell = formatInstanceListPeriodCell(start, endCol.display, holdSpanDays, endCol.cellTitle)
    const underlying = underlyingCostSellOptUsd(sliced)
    const den =
      Number.isFinite(m.maxRiskUsd) && m.maxRiskUsd > 0 ? m.maxRiskUsd : Number.isFinite(underlying) ? underlying : 0
    const daysUsed = holdSpanDays != null && Number.isFinite(holdSpanDays) ? holdDaysForAnnualization(holdSpanDays) : null
    const costPerDay =
      den > 0 && daysUsed != null && Number.isFinite(daysUsed) && daysUsed > 0 ? den / daysUsed : null
    const netDisplay = execDerivedNetPnl
    const npd =
      netDisplay != null && Number.isFinite(netDisplay)
        ? netPnlUsdPerDayFromNetAndExecutions(netDisplay, sliced, positionStatus)
        : null
    let returnPct: number | null = null
    if (netDisplay != null && Number.isFinite(netDisplay) && den > 0) {
      let pct = (netDisplay / den) * 100
      if (Number.isFinite(pct)) {
        if (pct > 999) pct = 999
        if (pct < -999) pct = -999
        returnPct = pct
      }
    }
    const annual =
      netDisplay != null && Number.isFinite(netDisplay)
        ? annualReturnDetailFromNetAndExecutions(netDisplay, sliced, m.maxRiskUsd, positionStatus)
        : null
    const linkSlipTitle =
      Math.abs(linkedStockSlippage) > 1e-9
        ? `Includes prorated option–stock link slippage (${fmtUsd(linkedStockSlippage)}).`
        : undefined

    const statusChip = (
      <span
        className={`instance-detail-status-chip instance-detail-overview-status-chip ${
          positionStatus === 'closed' ? 'is-flat' : positionStatus === 'open' ? 'is-open' : 'is-unknown'
        }`}
        title={
          positionStatus === 'closed'
            ? 'All contracts flat (buy and sell quantities net to zero per contract).'
            : positionStatus === 'open'
              ? 'At least one contract has non-zero net quantity.'
              : 'No fills attributed to this instance in the final book.'
        }
      >
        {positionStatus === 'no_fills' ? 'No fills' : positionStatus === 'closed' ? 'Closed' : 'Open'}
      </span>
    )

    return [
      <td key="st">{statusChip}</td>,
      <td key="win" className="tabular-nums strategy-instances-col-period" title={periodCell.title}>
        <span className="strategy-instances-period-year">{periodCell.yearLabel}</span>{' '}
        <span>{periodCell.rangeLabel}</span>{' '}
        {periodCell.dayLabel != null ? <strong className="strategy-instances-period-days">{periodCell.dayLabel}</strong> : null}
      </td>,
      <td
        key="np"
        className={`tabular-nums instance-detail-pnl-value ${signedPnlClass(netDisplay)}`}
        title={linkSlipTitle}
      >
        {netDisplay != null ? fmtUsd(netDisplay) : '—'}
      </td>,
      <td
        key="npd"
        className={`tabular-nums strategy-instances-signed ${npd != null ? signedPnlClass(npd) : 'is-neutral'}`}
        title={linkSlipTitle}
      >
        {npd != null && Number.isFinite(npd) ? fmtUsd(npd) : '—'}
      </td>,
      <td key="uc" className="tabular-nums" title="Sell-side OPT Σ(strike×|qty|×100); rounded to $0.">
        {fmtUsd0(underlying)}
      </td>,
      <td key="cd" className="tabular-nums" title="Capital at risk ÷ hold days used (same denominator as Instance detail). Rounded to $0.">
        {costPerDay != null && Number.isFinite(costPerDay) ? `${fmtUsd0(costPerDay)}/d` : '—'}
      </td>,
      <td
        key="ar"
        className={`tabular-nums instance-detail-pnl-value ${annual != null ? signedPnlClass(annual.annualReturnPct) : 'is-neutral'}`}
        title={linkSlipTitle}
      >
        {annual != null && Number.isFinite(annual.annualReturnPct)
          ? `${annual.annualReturnPct >= 0 ? '+' : ''}${annual.annualReturnPct.toFixed(1)}%`
          : '—'}
      </td>,
      <td
        key="ret"
        className={`tabular-nums strategy-instances-signed ${returnPct != null ? signedPnlClass(returnPct) : 'is-neutral'}`}
        title={linkSlipTitle}
      >
        {returnPct != null && Number.isFinite(returnPct)
          ? `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`
          : '—'}
      </td>,
      <td key="cm" className="tabular-nums instance-detail-pnl-value is-commission">
        {summary ? fmtUsd(summary.total_commission) : '—'}
      </td>,
    ]
  }, [instanceMetricsById])

  const openInstanceDetail = useCallback((instanceId: number) => {
    setSelectedInstanceId(instanceId)
    window.location.hash = `#/strategies/instances/${instanceId}`
  }, [])

  const closeInstanceDetail = useCallback(() => {
    setSelectedInstanceId(null)
    setCompareInstanceId(null)
    window.location.hash = '#/strategies/instances'
  }, [])

  const toggleCompare = useCallback((instanceId: number) => {
    setCompareInstanceId(prev => prev === instanceId ? null : instanceId)
  }, [])

  const instanceListTableBody = useMemo(() => {
    if (items.length === 0) {
      return (
        <tr>
          <td colSpan={13}>No strategy instances found.</td>
        </tr>
      )
    }
    if (filteredItems.length === 0) {
      return (
        <tr>
          <td colSpan={13}>No instances match the current filters.</td>
        </tr>
      )
    }
    return (
      <>
        {sortedGroupedItems.flatMap((group) => {
          const collapsed = Boolean(collapsedSymbolGroups[group.key])
          const rollup = computeSymbolGroupRollup(group.rows, instanceMetricsById)
          const headerRow = (
            <tr key={`group-${group.key}`} className="strategy-instance-symbol-group-row strategy-instance-symbol-group-summary-row">
              <td
                colSpan={2}
                style={{
                  fontWeight: 600,
                  background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))',
                  padding: 0,
                  verticalAlign: 'middle',
                }}
              >
                <button
                  type="button"
                  className="strategy-instance-symbol-group-toggle"
                  onClick={() => toggleSymbolGroup(group.key)}
                  aria-expanded={!collapsed}
                  id={`symbol-group-head-${group.key}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <span className={`replay-opt-expand-icon ${collapsed ? '' : 'expanded'}`} aria-hidden>
                    {collapsed ? '▶' : '▼'}
                  </span>
                  <span>
                    Symbol group: {group.label}
                    <span className="replay-muted" style={{ fontWeight: 400, marginLeft: '0.35rem' }}>
                      ({group.rows.length} instance{group.rows.length !== 1 ? 's' : ''})
                    </span>
                  </span>
                </button>
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell strategy-instances-col-period"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className={`tabular-nums instance-detail-pnl-value strategy-instance-group-summary-cell ${signedPnlClass(rollup.totalNet)}`}
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
                title="Sum of execution-derived Net PnL (same as Instance Detail) for instances with loaded metrics."
              >
                {rollup.totalNet != null ? fmtUsd(rollup.totalNet) : '—'}
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className={`tabular-nums instance-detail-pnl-value strategy-instance-group-summary-cell ${rollup.sumUnderlying != null ? '' : 'is-neutral'}`}
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
                title="Sum of per-instance underlying cost (sell-side OPT); rounded to $0."
              >
                {rollup.sumUnderlying != null ? fmtUsd0(rollup.sumUnderlying) : '—'}
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className={`tabular-nums instance-detail-pnl-value strategy-instance-group-summary-cell ${signedPnlClass(rollup.groupAnnualPct)}`}
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
                title="Group annual return: total Net × 365.25 / Σ(denominator × hold days) × 100. Per row: denominator prefers |max loss| else underlying; hold days = open → min report_date to latest open-leg expiry, else report_date span."
              >
                {rollup.groupAnnualPct != null && Number.isFinite(rollup.groupAnnualPct)
                  ? `${rollup.groupAnnualPct >= 0 ? '+' : ''}${rollup.groupAnnualPct.toFixed(1)}%`
                  : '—'}
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className="tabular-nums muted strategy-instance-group-summary-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              >
                —
              </td>
              <td
                className="strategy-instance-group-summary-cell strategy-instance-actions-cell"
                style={{ background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))' }}
              />
            </tr>
          )
          if (collapsed) return [headerRow]
          const dataRows = group.rows.map((row) => {
            return (
              <tr
                key={row.strategy_instance_id}
                className={effectiveDetailId === row.strategy_instance_id ? 'is-selected' : undefined}
              >
                <td>{row.strategy_instance_id}</td>
                <td className="strategy-instances-col-opp strategy-instances-cell-opp">
                  <div>{row.strategy_opportunity_name ?? row.strategy_opportunity_id ?? '—'}</div>
                  {row.strategy_structure_name ? (
                    <span
                      className="strategy-instances-structure-chip"
                      style={structureColorStyle(row.strategy_structure_name, false)}
                      title={`Structure: ${row.strategy_structure_name}`}
                    >
                      {row.strategy_structure_name}
                    </span>
                  ) : null}
                </td>
                {renderMetricsTds(row.strategy_instance_id)}
                <td className="tabular-nums">{row.executions_count != null ? row.executions_count : '—'}</td>
                <td className="strategy-instance-actions-cell">
                  <div className="strategy-instance-actions-inner">
                    <button
                      type="button"
                      className="btn btn-icon-small"
                      title="Open instance detail"
                      aria-label="Open instance detail"
                      onClick={() => openInstanceDetail(row.strategy_instance_id)}
                    >
                      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    {effectiveDetailId != null && effectiveDetailId !== row.strategy_instance_id && (
                      <button
                        type="button"
                        className={`btn btn-icon-small${compareInstanceId === row.strategy_instance_id ? ' instance-compare-btn--active' : ''}`}
                        title={compareInstanceId === row.strategy_instance_id ? 'Remove from comparison' : 'Compare side-by-side with current instance'}
                        aria-label={compareInstanceId === row.strategy_instance_id ? 'Remove from comparison' : 'Compare side-by-side'}
                        onClick={() => toggleCompare(row.strategy_instance_id)}
                      >
                        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <rect x="3" y="3" width="7" height="18" rx="1" />
                          <rect x="14" y="3" width="7" height="18" rx="1" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-icon-small btn-icon-danger"
                      title="Delete instance"
                      aria-label="Delete instance"
                      onClick={() => openDeleteConfirm(row)}
                    >
                      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4h6v2" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            )
          })
          return [headerRow, ...dataRows]
        })}
      </>
    )
  }, [
    items,
    filteredItems,
    sortedGroupedItems,
    collapsedSymbolGroups,
    instanceMetricsById,
    renderMetricsTds,
    toggleSymbolGroup,
    openDeleteConfirm,
    openInstanceDetail,
    effectiveDetailId,
    compareInstanceId,
    toggleCompare,
  ])

  const openCreateModal = () => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setCreateOpenedAt(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    setCreateOpportunityId('')
    const hostId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
    setCreateAccountId(hostId)
    setCreateLabel('')
    setCreateNotes('')
    setCreateError(null)
    setCreateModalOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (confirmDelete.instanceId == null) return
    setConfirmDelete((s) => ({ ...s, deleting: true, error: null }))
    try {
      await deleteStrategyInstance(confirmDelete.instanceId)
      setConfirmDelete({ open: false, instanceId: null, label: '', deleting: false, error: null })
      loadInstances()
    } catch (err) {
      setConfirmDelete((s) => ({ ...s, deleting: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError(null)
    const oppId = createOpportunityId === '' ? null : Number(createOpportunityId)
    const accountId = createAccountId.trim()
    if (oppId == null || !Number.isFinite(oppId) || !accountId) {
      setCreateError('Opportunity and Account are required.')
      return
    }
    const dateStr = createOpenedAt.trim()
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      setCreateError('Opened at (date) is required.')
      return
    }
    const openedAtIso = `${dateStr}T12:00:00.000Z`
    setCreateLoading(true)
    try {
      const res = await createStrategyInstance({
        strategy_opportunity_id: oppId,
        account_id: accountId,
        opened_at: openedAtIso,
        label: createLabel.trim() || undefined,
        notes: createNotes.trim() || undefined,
      })
      setCreateModalOpen(false)
      loadInstances()
      setSelectedInstanceId(res.strategy_instance_id)
      window.location.hash = `#/strategies/instances/${res.strategy_instance_id}`
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateLoading(false)
    }
  }

  const isCompareMode =
    compareInstanceId != null &&
    effectiveDetailId != null &&
    compareInstanceId !== effectiveDetailId

  const activeSidebarWidth = isCompareMode
    ? Math.min(1880, typeof window !== 'undefined' ? window.innerWidth - 40 : 1880)
    : INSTANCE_DETAIL_SIDEBAR_WIDTH_PX

  const floatingSidebarStyle: CSSProperties | undefined =
    effectiveDetailId != null && !isNarrowViewport
      ? {
          ['--instances-floating-sidebar-width' as string]: `${activeSidebarWidth}px`,
          ['--instances-floating-sidebar-reserve' as string]: `calc(var(--instances-floating-sidebar-width) + 4px)`,
        }
      : undefined

  return (
    <div
      className={`card process-section strategy-instances-page${effectiveDetailId != null && !isNarrowViewport ? ' has-floating-detail-sidebar' : ''}`}
      style={floatingSidebarStyle}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <SectionPageTitle
          menu="Strategy"
          pageTitle={breadcrumbLabel}
          onMenuClick={onNavigateToStrategy}
          menuNavigateAriaLabel="Strategy home"
          infoText="Running strategy instances per account; create from an opportunity, inspect PnL and executions, or open the instance sheet."
          style={{ margin: 0 }}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={openCreateModal}
          aria-label="Create strategy instance"
        >
          Create instance
        </button>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
        <label>
          <span className="filter-label">Account</span>
          <select
            value={accountIdFilter}
            onChange={(e) => setAccountIdFilter(e.target.value)}
            aria-label="Filter by account"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.account_id}
              </option>
            ))}
          </select>
        </label>
        <div className="ledger-filter-field ledger-filter-field--strategy">
          <StrategyOpportunityCombobox
            opportunities={opportunities}
            value={opportunityIdFilter}
            onChange={(id) => {
              setOpportunityIdFilter(id)
              setInstanceIdFilter('')
            }}
          />
        </div>
        {opportunityIdFilter !== '' && (
          <label className="replay-filter-label-instance" title="Instance">
            <span className="replay-filter-label">Instance</span>
            <select
              value={instanceIdFilter === '' ? '' : String(instanceIdFilter)}
              onChange={(e) => setInstanceIdFilter(e.target.value === '' ? '' : Number(e.target.value))}
              className="replay-filter-input replay-filter-select"
              aria-label="Filter by instance"
            >
              <option value="">All</option>
              {instancesForOpportunity.map((si) => (
                <option key={si.strategy_instance_id} value={String(si.strategy_instance_id)}>
                  {si.label?.trim() || `#${si.strategy_instance_id}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error != null && (
        <p className="error-message" style={{ marginTop: '0.5rem' }}>{error}</p>
      )}

      <div className="strategy-instances-workspace">
        <div className={`strategy-instances-list-pane${effectiveDetailId != null && !isNarrowViewport ? ' with-floating-detail-sidebar' : ''}`}>
          {loading ? (
            <p style={{ marginTop: '1rem' }}>Loading…</p>
          ) : (
            <div className="table-wrapper strategy-instances-table-wrap" style={{ overflowX: 'auto', marginTop: '1rem' }}>
          {items.length > 0 && (
            <div className="ledger-strategy-tab-filters" style={{ marginBottom: '0.75rem' }}>
              <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by position status">
                <span className="ledger-strategy-filter-label">Status</span>
                <div className="ledger-strategy-filter-bubbles">
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instStatusFilter === '' ? 'active' : ''}`}
                    onClick={() => setInstStatusFilter('')}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instStatusFilter === 'open' ? 'active' : ''}`}
                    onClick={() => setInstStatusFilter((prev) => (prev === 'open' ? '' : 'open'))}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instStatusFilter === 'closed' ? 'active' : ''}`}
                    onClick={() => setInstStatusFilter((prev) => (prev === 'closed' ? '' : 'closed'))}
                  >
                    Closed
                  </button>
                </div>
              </div>
              {instanceFilterOptions.structures.length > 0 && (
                <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by structure">
                  <span className="ledger-strategy-filter-label">Structure</span>
                  <div className="ledger-strategy-filter-bubbles">
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instStructureFilter === '' ? 'active' : ''}`}
                      onClick={() => setInstStructureFilter('')}
                    >
                      All
                    </button>
                    {instanceFilterOptions.structures.map(s => (
                      <button
                        key={s}
                        type="button"
                        className={`replay-bubble-switch-btn ${instStructureFilter === s ? 'active' : ''}`}
                        style={structureColorStyle(s, instStructureFilter === s)}
                        onClick={() => setInstStructureFilter(prev => prev === s ? '' : s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {instanceFilterOptions.symbols.length > 0 && (
                <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by symbol">
                  <span className="ledger-strategy-filter-label">Symbol</span>
                  <div className="ledger-strategy-filter-bubbles">
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instSymbolFilter === '' ? 'active' : ''}`}
                      onClick={() => setInstSymbolFilter('')}
                    >
                      All
                    </button>
                    {instanceFilterOptions.symbols.map(sym => (
                      <button
                        key={sym}
                        type="button"
                        className={`replay-bubble-switch-btn ${instSymbolFilter === sym ? 'active' : ''}`}
                        onClick={() => setInstSymbolFilter(prev => prev === sym ? '' : sym)}
                      >
                        {sym}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {instanceFilterOptions.rights.length > 1 && (
                <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by call or put">
                  <span className="ledger-strategy-filter-label">Type</span>
                  <div className="ledger-strategy-filter-bubbles">
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instRightFilter === '' ? 'active' : ''}`}
                      onClick={() => setInstRightFilter('')}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instRightFilter === 'C' ? 'active' : ''}`}
                      onClick={() => setInstRightFilter(prev => prev === 'C' ? '' : 'C')}
                    >
                      Call
                    </button>
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instRightFilter === 'P' ? 'active' : ''}`}
                      onClick={() => setInstRightFilter(prev => prev === 'P' ? '' : 'P')}
                    >
                      Put
                    </button>
                  </div>
                </div>
              )}
              <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by period start date">
                <span className="ledger-strategy-filter-label">Since</span>
                <div className="ledger-strategy-filter-bubbles">
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === '' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter('')}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === '1m' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter(prev => prev === '1m' ? '' : '1m')}
                  >
                    1 month
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === 'q' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter(prev => prev === 'q' ? '' : 'q')}
                  >
                    Quarter
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === 'half' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter(prev => prev === 'half' ? '' : 'half')}
                  >
                    Half year
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === '1y' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter(prev => prev === '1y' ? '' : '1y')}
                  >
                    1 year
                  </button>
                  <button
                    type="button"
                    className={`replay-bubble-switch-btn ${instSinceFilter === 'ytd' ? 'active' : ''}`}
                    onClick={() => setInstSinceFilter(prev => prev === 'ytd' ? '' : 'ytd')}
                  >
                    YTD
                  </button>
                </div>
                {sinceRangeText != null && (
                  <span className="section-hint" style={{ marginLeft: '0.5rem' }}>
                    {sinceRangeText}
                  </span>
                )}
              </div>
              {instanceFilterOptions.expiryMonths.length > 1 && (
                <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by expiry month">
                  <span className="ledger-strategy-filter-label">Expiry</span>
                  <div className="ledger-strategy-filter-bubbles">
                    <button
                      type="button"
                      className={`replay-bubble-switch-btn ${instExpiryFilter === '' ? 'active' : ''}`}
                      onClick={() => setInstExpiryFilter('')}
                    >
                      All
                    </button>
                    {instanceFilterOptions.expiryMonths.map(m => (
                      <button
                        key={m}
                        type="button"
                        className={`replay-bubble-switch-btn ledger-expiry-month-btn ${instExpiryFilter === m ? 'active' : ''}`}
                        onClick={() => setInstExpiryFilter(prev => prev === m ? '' : m)}
                        title={m}
                      >
                        {fmtExpiryMonthBubble(m)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {(instStructureFilter || instSymbolFilter || instRightFilter || instSinceFilter || instExpiryFilter || instStatusFilter) && (
                <div className="ledger-strategy-filter-meta">
                  <span>Showing {filteredItems.length} of {items.length} instances</span>
                  <button
                    type="button"
                    className="ledger-strategy-filter-clear"
                    onClick={() => {
                      setInstStructureFilter('')
                      setInstSymbolFilter('')
                      setInstRightFilter('')
                      setInstSinceFilter('')
                      setInstExpiryFilter('')
                      setInstStatusFilter('')
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          )}
          {items.length > 0 && groupedItems.length > 0 && (
            <div className="instance-list-symbol-toolbar">
              <div className="instance-sheet-filter-bubble-row">
                <span className="instance-sheet-filter-bubble-label" id="instance-list-detail-view-label">
                  Detail view
                </span>
                <div
                  className="replay-bubble-switch"
                  role="radiogroup"
                  aria-labelledby="instance-list-detail-view-label"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={symbolGroupAccordionMode}
                    className={`replay-bubble-switch-btn ${symbolGroupAccordionMode ? 'active' : ''}`}
                    onClick={() => setSymbolGroupAccordionMode(true)}
                  >
                    Accordion
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!symbolGroupAccordionMode}
                    className={`replay-bubble-switch-btn ${!symbolGroupAccordionMode ? 'active' : ''}`}
                    onClick={() => setSymbolGroupAccordionMode(false)}
                  >
                    Multi
                  </button>
                </div>
              </div>
              <div className="instance-sheet-filter-bubble-row">
                <span className="instance-sheet-filter-bubble-label" id="instance-list-symbol-groups-label">
                  Symbol groups
                </span>
                <div
                  className="replay-bubble-switch"
                  role="group"
                  aria-labelledby="instance-list-symbol-groups-label"
                >
                  <button
                    type="button"
                    className="replay-bubble-switch-btn"
                    onClick={expandAllSymbolGroups}
                    aria-label="Expand all symbol groups"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className="replay-bubble-switch-btn"
                    onClick={collapseAllSymbolGroups}
                    aria-label="Collapse all symbol groups"
                  >
                    Collapse all
                  </button>
                </div>
              </div>
              <p className="section-hint instance-list-symbol-toolbar-hint">
                {symbolGroupAccordionMode
                  ? 'Accordion: only one symbol group expanded at a time. Expand all keeps the first group open.'
                  : 'Multi: several symbol groups may stay expanded.'}
              </p>
            </div>
          )}
              <table className="data-table strategy-instances-table">
            <thead>
              <tr className="strategy-instances-head-tier1">
                <th rowSpan={2}>ID</th>
                <th rowSpan={2} className="strategy-instances-col-opp">Opportunity</th>
                <th rowSpan={2}>Status</th>
                <SortableInstancesTh
                  column="start"
                  rowSpan={2}
                  className="strategy-instances-col-period strategy-instances-th-long-header"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Window: min report date → end (open: latest open-leg expiry; closed: max report date). Hold = calendar days for metrics. Sort by start date.">
                    Period
                  </span>
                </SortableInstancesTh>
                <th colSpan={2} className="strategy-instances-th-group" scope="colgroup">
                  Net PnL
                </th>
                <th colSpan={2} className="strategy-instances-th-group" scope="colgroup">
                  Underlying Cost
                </th>
                <th colSpan={2} className="strategy-instances-th-group" scope="colgroup">
                  Return %
                </th>
                <SortableInstancesTh
                  column="comm"
                  rowSpan={2}
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Commission">Comm.</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="exec"
                  rowSpan={2}
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Executions count">Exec</abbr>
                </SortableInstancesTh>
                <th rowSpan={2} className="strategy-instances-col-actions">Actions</th>
              </tr>
              <tr className="strategy-instances-head-tier2">
                <SortableInstancesTh
                  column="net"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Execution book Net PnL (same as Instance Detail).">PnL</span>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="npd"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Net PnL per calendar day (same basis as Instance detail strip).">/ day</span>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="und"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Sell-side OPT underlying cost; rounded to $0.">Cost</span>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="cday"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Capital at risk ÷ hold days used for annualization.">/ day</span>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="ann"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <span title="Annual return from execution-derived Net PnL; hold days match Period column.">Annual %</span>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="ret"
                  className="strategy-instances-th-sort-num strategy-instances-th-sub"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Net PnL ÷ capital at risk × 100.">%</abbr>
                </SortableInstancesTh>
              </tr>
            </thead>
            <tbody>
              {instanceListTableBody}
            </tbody>
              </table>
            </div>
          )}
        </div>
        {effectiveDetailId != null && (
          <div className="strategy-instances-inspector-pane">
            <DetailSidebar
              mode={isNarrowViewport ? 'modal' : 'docked'}
              open={effectiveDetailId != null}
              onClose={closeInstanceDetail}
              title={isCompareMode
                ? `Instance #${effectiveDetailId} vs #${compareInstanceId}`
                : `Instance #${effectiveDetailId}`}
              destroyOnClose={false}
              width={activeSidebarWidth}
            >
              {isCompareMode && compareInstanceId != null ? (
                <div className="instance-compare-split">
                  <div className="instance-compare-pane">
                    <StrategyInstanceDetailPage
                      strategyInstanceId={effectiveDetailId}
                      status={status}
                      embedded
                    />
                  </div>
                  <div className="instance-compare-divider" />
                  <div className="instance-compare-pane">
                    <StrategyInstanceDetailPage
                      strategyInstanceId={compareInstanceId}
                      status={status}
                      embedded
                    />
                  </div>
                </div>
              ) : (
                <StrategyInstanceDetailPage
                  strategyInstanceId={effectiveDetailId}
                  status={status}
                  embedded
                />
              )}
            </DetailSidebar>
          </div>
        )}
      </div>

      {confirmDelete.open && (
        <div
          className="modal-overlay"
          onClick={() => { if (!confirmDelete.deleting) setConfirmDelete((s) => ({ ...s, open: false })) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-instance-modal-title"
        >
          <div className="modal-panel" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 id="delete-instance-modal-title" style={{ marginTop: 0 }}>Delete instance</h3>
            <p style={{ margin: '0.5rem 0 1rem' }}>
              Delete instance <strong>{confirmDelete.label}</strong>? This cannot be undone.
              It will fail if any executions are linked to this instance.
            </p>
            {confirmDelete.error != null && (
              <p className="section-hint replay-form-error" style={{ marginBottom: '0.75rem' }}>{confirmDelete.error}</p>
            )}
            <div className="replay-exec-form-actions" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDelete((s) => ({ ...s, open: false }))}
                disabled={confirmDelete.deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
                disabled={confirmDelete.deleting}
              >
                {confirmDelete.deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {createModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => { setCreateModalOpen(false); setCreateError(null) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-instance-modal-title"
        >
          <div className="modal-panel replay-exec-modal create-instance-modal" onClick={e => e.stopPropagation()}>
            <h3 id="create-instance-modal-title" className="create-instance-modal-title">Create strategy instance</h3>
            {createError != null && (
              <p className="section-hint replay-form-error create-instance-modal-error">{createError}</p>
            )}
            <form className="replay-exec-form create-instance-form" onSubmit={handleCreateSubmit}>
              <section className="create-instance-section">
                <div className="replay-exec-form-row">
                  <label>Opportunity</label>
                  <select
                    value={createOpportunityId === '' ? '' : String(createOpportunityId)}
                    onChange={e => setCreateOpportunityId(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                    aria-required="true"
                    className="create-instance-input"
                  >
                    <option value="">— Select opportunity —</option>
                    {opportunities.map(o => (
                      <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                        {o.name ?? `#${o.strategy_opportunity_id}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="replay-exec-form-row create-instance-account-row">
                  <label>Account</label>
                  <div className="create-instance-account-wrap">
                    {eventAccounts.length === 0 ? (
                      <p className="create-instance-account-empty">
                        Configure Event Account in Settings → IB Connection
                      </p>
                    ) : (
                      <div className="structure-active-filter-pills" role="radiogroup" aria-label="Event Account" aria-required="true">
                        {eventAccounts.map(({ account_id }) => (
                          <button
                            key={account_id}
                            type="button"
                            role="radio"
                            aria-checked={createAccountId === account_id}
                            className={`structure-active-filter-pill ${createAccountId === account_id ? 'active' : ''}`}
                            onClick={() => setCreateAccountId(account_id)}
                          >
                            {account_id}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="replay-exec-form-row">
                  <label>Opened at</label>
                  <input
                    type="date"
                    value={createOpenedAt}
                    onChange={e => setCreateOpenedAt(e.target.value)}
                    required
                    aria-required="true"
                    className="create-instance-input"
                  />
                </div>
              </section>
              <section className="create-instance-section create-instance-section-optional">
                <div className="replay-exec-form-row">
                  <label>Label (optional)</label>
                  <input
                    type="text"
                    value={createLabel}
                    onChange={e => setCreateLabel(e.target.value)}
                    placeholder="e.g. Straddle 2025-03"
                    className="create-instance-input"
                  />
                </div>
                <div className="replay-exec-form-row">
                  <label>Notes (optional)</label>
                  <input
                    type="text"
                    value={createNotes}
                    onChange={e => setCreateNotes(e.target.value)}
                    placeholder="Optional notes"
                    className="create-instance-input"
                  />
                </div>
              </section>
              <div className="replay-exec-form-actions create-instance-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setCreateModalOpen(false); setCreateError(null) }}
                  disabled={createLoading}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={createLoading || eventAccounts.length === 0}>
                  {createLoading ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
