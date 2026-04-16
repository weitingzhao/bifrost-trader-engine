import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { StrategyOpportunityCombobox } from '../components/StrategyOpportunityCombobox'
import { StrategyInstanceDetailPage } from './StrategyInstanceDetailPage'
import { fmtUsd, parseOptionContractKey } from '../utils/format'
import { sliceExecutionForInstanceOptView } from './portfolio/ledgerOptHelpers'
import {
  annualReturnDetailFromNetAndExecutions,
  computeInstancePositionStatus,
  formatHoldDaysRounded0,
  holdTimeDaysFromReportDateSpan,
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

const INSTANCE_LIST_METRICS_CHUNK = 5

type InstanceListMetrics =
  | { status: 'ready'; summary: PerformanceSummary | null | undefined; sliced: Execution[] }
  | { status: 'error' }

/** Sortable metric columns (within each symbol group only). */
type InstancesSortColumn = 'start' | 'end' | 'net' | 'real' | 'comm' | 'hold' | 'und' | 'ann' | 'exec'
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
      const s = reportDateStartEnd(sliced).end
      if (s == null) return Number.NaN
      const t = Date.parse(`${s}T12:00:00.000Z`)
      return Number.isFinite(t) ? t : Number.NaN
    }
    case 'net':
      return summary != null && summary.net_pnl != null ? Number(summary.net_pnl) : Number.NaN
    case 'real':
      return summary != null && summary.total_realized_pnl != null ? Number(summary.total_realized_pnl) : Number.NaN
    case 'comm':
      return summary != null && summary.total_commission != null ? Number(summary.total_commission) : Number.NaN
    case 'hold': {
      const d = holdTimeDaysFromReportDateSpan(sliced)
      return d != null && Number.isFinite(d) ? d : Number.NaN
    }
    case 'und': {
      const u = underlyingCostSellOptUsd(sliced)
      return Number.isFinite(u) ? u : Number.NaN
    }
    case 'ann': {
      if (summary == null) return Number.NaN
      const a = annualReturnDetailFromNetAndExecutions(summary.net_pnl, sliced)
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
}: {
  column: InstancesSortColumn
  className?: string
  children: ReactNode
  sort: { column: InstancesSortColumn; dir: InstancesSortDir } | null
  onSort: (c: InstancesSortColumn) => void
}) {
  const active = sort?.column === column
  const dir = sort?.dir
  return (
    <th
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

export interface StrategyInstancesPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  /** Instance id from URL hash #/strategies/instances/:id; when set, detail view is shown. */
  urlStrategyInstanceId?: number | null
  onNavigateToStrategy?: () => void
  breadcrumbLabel?: string
}

export function StrategyInstancesPage({
  status,
  loadStatus: _loadStatus,
  urlStrategyInstanceId = null,
  onNavigateToStrategy,
  breadcrumbLabel = 'Instances',
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
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null)
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
              return [id, { status: 'ready', summary: perf.summary, sliced } as const]
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
    return list
  }, [items, instStructureFilter, instSymbolFilter, instRightFilter, instExpiryFilter, getScopeSymbol, instancePositionMeta])

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
    const { summary, sliced } = m
    const positionStatus = computeInstancePositionStatus(sliced)
    const { start, end } = reportDateStartEnd(sliced)
    const holdSpanDays = holdTimeDaysFromReportDateSpan(sliced)
    const holdLabel = holdSpanDays != null ? formatHoldDaysRounded0(holdSpanDays) : '—'
    const underlying = underlyingCostSellOptUsd(sliced)
    const annual = summary != null ? annualReturnDetailFromNetAndExecutions(summary.net_pnl, sliced) : null

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
      <td key="sd" className="tabular-nums strategy-instances-col-start">
        {start ?? '—'}
      </td>,
      <td key="ed" className="tabular-nums strategy-instances-col-end">
        {end ?? '—'}
      </td>,
      <td
        key="np"
        className={`tabular-nums instance-detail-pnl-value ${signedPnlClass(summary?.net_pnl != null ? Number(summary.net_pnl) : null)}`}
      >
        {summary ? fmtUsd(summary.net_pnl) : '—'}
      </td>,
      <td
        key="tr"
        className={`tabular-nums instance-detail-pnl-value ${signedPnlClass(
          summary?.total_realized_pnl != null ? Number(summary.total_realized_pnl) : null,
        )}`}
      >
        {summary ? fmtUsd(summary.total_realized_pnl) : '—'}
      </td>,
      <td key="cm" className="tabular-nums instance-detail-pnl-value is-commission">
        {summary ? fmtUsd(summary.total_commission) : '—'}
      </td>,
      <td key="ht" className="tabular-nums">
        {holdLabel}
      </td>,
      <td key="uc" className="tabular-nums">
        {fmtUsd(underlying)}
      </td>,
      <td
        key="ar"
        className={`tabular-nums instance-detail-pnl-value ${annual != null ? signedPnlClass(annual.annualReturnPct) : 'is-neutral'}`}
      >
        {annual != null && Number.isFinite(annual.annualReturnPct)
          ? `${annual.annualReturnPct >= 0 ? '+' : ''}${annual.annualReturnPct.toFixed(1)}%`
          : '—'}
      </td>,
    ]
  }, [instanceMetricsById])

  const instanceListTableBody = useMemo(() => {
    if (items.length === 0) {
      return (
        <tr>
          <td colSpan={14}>No strategy instances found.</td>
        </tr>
      )
    }
    if (filteredItems.length === 0) {
      return (
        <tr>
          <td colSpan={14}>No instances match the current filters.</td>
        </tr>
      )
    }
    return (
      <>
        {sortedGroupedItems.flatMap((group) => {
          const collapsed = Boolean(collapsedSymbolGroups[group.key])
          const headerRow = (
            <tr key={`group-${group.key}`} className="strategy-instance-symbol-group-row">
              <td
                colSpan={14}
                style={{
                  fontWeight: 600,
                  background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))',
                  padding: 0,
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
            </tr>
          )
          if (collapsed) return [headerRow]
          const dataRows = group.rows.map((row) => {
            return (
              <tr key={row.strategy_instance_id}>
                <td>{row.strategy_instance_id}</td>
                <td className="strategy-instances-col-opp strategy-instances-cell-opp">
                  {row.strategy_opportunity_name ?? row.strategy_opportunity_id ?? '—'}
                </td>
                <td>{row.account_id}</td>
                {renderMetricsTds(row.strategy_instance_id)}
                <td className="tabular-nums">{row.executions_count != null ? row.executions_count : '—'}</td>
                <td className="strategy-instance-actions-cell">
                  <div className="strategy-instance-actions-inner">
                    <a
                      href={`#/strategies/instances/${row.strategy_instance_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-icon-small"
                      title="View instance"
                      aria-label="View instance"
                    >
                      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </a>
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
    renderMetricsTds,
    toggleSymbolGroup,
    openDeleteConfirm,
  ])

  if (effectiveDetailId != null) {
    return (
      <StrategyInstanceDetailPage
        strategyInstanceId={effectiveDetailId}
        status={status}
      />
    )
  }

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

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={onNavigateToStrategy}
          >
            Strategy
          </button>
          {' / '}
          {breadcrumbLabel}
        </h2>
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

      {loading ? (
        <p style={{ marginTop: '1rem' }}>Loading…</p>
      ) : (
        <div className="table-wrapper" style={{ overflowX: 'auto', marginTop: '1rem' }}>
          {items.length > 0 && (
            instanceFilterOptions.structures.length > 0 ||
            instanceFilterOptions.symbols.length > 0 ||
            instanceFilterOptions.rights.length > 1 ||
            instanceFilterOptions.expiryMonths.length > 1
          ) && (
            <div className="ledger-strategy-tab-filters" style={{ marginBottom: '0.75rem' }}>
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
              {(instStructureFilter || instSymbolFilter || instRightFilter || instExpiryFilter) && (
                <div className="ledger-strategy-filter-meta">
                  <span>Showing {filteredItems.length} of {items.length} instances</span>
                  <button
                    type="button"
                    className="ledger-strategy-filter-clear"
                    onClick={() => {
                      setInstStructureFilter('')
                      setInstSymbolFilter('')
                      setInstRightFilter('')
                      setInstExpiryFilter('')
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
              <tr>
                <th>ID</th>
                <th className="strategy-instances-col-opp">Opportunity</th>
                <th>
                  <abbr title="Account">Acct</abbr>
                </th>
                <th>Status</th>
                <SortableInstancesTh
                  column="start"
                  className="strategy-instances-col-start"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Start date (min Report date)">Start</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="end"
                  className="strategy-instances-col-end"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="End date (max Report date)">End</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="net"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Net PnL">Net</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="real"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Realized PnL">Real.</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="comm"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Commission">Comm.</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="hold"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Hold time">Hold</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="und"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Underlying cost">Und.</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="ann"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Annual return">Ann.</abbr>
                </SortableInstancesTh>
                <SortableInstancesTh
                  column="exec"
                  className="strategy-instances-th-sort-num"
                  sort={instancesSort}
                  onSort={toggleInstancesSort}
                >
                  <abbr title="Executions count">Exec</abbr>
                </SortableInstancesTh>
                <th className="strategy-instances-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {instanceListTableBody}
            </tbody>
          </table>
        </div>
      )}

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
