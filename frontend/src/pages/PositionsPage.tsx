import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Execution, RealtimeQuote, StatusResponse } from '../types'
import { deleteExecution, fetchQuotes, subscribeQuotes } from '../api'
import { fetchOpportunities, fetchStructures } from '../api/strategies'
import type { StrategyOpportunity, StrategyStructure } from '../api/strategies'
import { InfoTooltip } from '../components/InfoTooltip'
import { computeRiskProfile, formatRiskHedgedBreakdown, formatRiskLabel } from '../utils/riskProfile'
import type { RiskPosition } from '../utils/riskProfile'
import { RiskProfileDl } from '../components/RiskProfileDl'
import {
  daysUntilExpiry,
  fmtDate,
  fmtDaysAgo,
  fmtExpiry,
  fmtUsd,
  getContractLabelParts,
  parseOptionContractKey,
} from '../utils/format'

/** Align position vs execution contract_key: OCC local differs in segment 1; OPT|expiry|strike|right match. */
function optExecutionMatchKey(accountId: string, contractKey: string): string {
  const acc = (accountId ?? '').trim()
  const parts = (contractKey ?? '').split('|')
  if (parts.length >= 5 && (parts[1] ?? '').toUpperCase().trim() === 'OPT') {
    const exp = (parts[2] ?? '').trim()
    const sn = parseFloat(String(parts[3] ?? '').trim())
    const strikeKey = Number.isFinite(sn) ? String(sn) : (parts[3] ?? '').trim()
    const right = (parts[4] ?? '').trim().toUpperCase().slice(0, 1)
    return `${acc}|OPT|${exp}|${strikeKey}|${right}`
  }
  return `${acc}|${(contractKey ?? '').trim()}`
}

/** Option Last-column (Last − Strike) / Last %: color by right and side. Call+Sell: +% red, −% green; Call+Buy: opposite; Put+Sell: +% green, −% red; Put+Buy: opposite. */
function optionLastStrikePctClass(right: string, side: 'Buy' | 'Sell', pct: number): string {
  if (pct === 0 || (right !== 'C' && right !== 'P')) return ''
  const positive = pct > 0
  if (right === 'C') {
    if (side === 'Sell') return positive ? 'pnl-negative' : 'pnl-positive'
    return positive ? 'pnl-positive' : 'pnl-negative'
  }
  if (side === 'Sell') return positive ? 'pnl-positive' : 'pnl-negative'
  return positive ? 'pnl-negative' : 'pnl-positive'
}

function fmtSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** Surplus / gap in shares: 3 decimal places. */
function fmtSurplusShares(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3)
}
import { buildOptExecutionGroups } from './portfolio/buildOptExecutionGroups'
import { ExecutionFormModal } from './portfolio/ExecutionFormModal'
import type { LinkExecutionContext } from './portfolio/LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './portfolio/LinkExecutionRecordModal'
import { QuickCloseModal } from './portfolio/QuickCloseModal'
import type { InstanceAllGroup, InstancePositionGroup, InstanceStockCoverage, LivePositionRow, OpenOptionPosition, PortfolioView, StockCoverageItem } from './portfolio/types'
import { OFF_TRACK_ACCOUNT_ID, useExecutions } from './portfolio/useExecutions'

/** Stock metrics for exactly one (symbol, account); never mixes other accounts. */
function underlyingCoverageStockMetrics(
  stocks: LivePositionRow[],
  symbol: string,
  accountId: string,
): {
  held: number
  cost_basis_total: number | null
  avg_cost_per_share: number | null
  live_last_price: number | null
  daily_pnl: number | null
  daily_pct: number | null
  total_pnl: number | null
  total_pct: number | null
} {
  const sym = (symbol ?? '').toUpperCase().trim()
  const acct = (accountId ?? '').trim()
  let held = 0
  let heldAbs = 0
  let costBasisAbs = 0
  let lastWeightedSum = 0
  let lastWeight = 0
  let dailyPnl = 0
  let dailyBaseAbs = 0
  let totalPnl = 0
  for (const s of stocks) {
    if ((s.symbol ?? '').toUpperCase().trim() !== sym) continue
    if ((s.account_id ?? '').trim() !== acct) continue
    const qty = Number(s.position)
    if (!Number.isFinite(qty) || qty === 0) continue
    const absQty = Math.abs(qty)
    const avgCost = s.avgCost != null && Number.isFinite(Number(s.avgCost)) ? Number(s.avgCost) : null
    const lastPrice = s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
    const dailyPrevClose =
      s.daily_prev_close != null && Number.isFinite(Number(s.daily_prev_close))
        ? Number(s.daily_prev_close)
        : null
    const unrealizedPnl =
      s.unrealized_pnl != null && Number.isFinite(Number(s.unrealized_pnl))
        ? Number(s.unrealized_pnl)
        : lastPrice != null && avgCost != null
          ? (lastPrice - avgCost) * qty
          : 0
    held += qty
    heldAbs += absQty
    if (avgCost != null) costBasisAbs += absQty * avgCost
    if (lastPrice != null) {
      lastWeightedSum += absQty * lastPrice
      lastWeight += absQty
    }
    if (dailyPrevClose != null && lastPrice != null) {
      dailyPnl += (lastPrice - dailyPrevClose) * qty
      dailyBaseAbs += Math.abs(dailyPrevClose * qty)
    }
    totalPnl += unrealizedPnl
  }
  const costBasis = costBasisAbs > 0 ? costBasisAbs : null
  const totalPct =
    costBasis != null && costBasis > 0 && Number.isFinite(totalPnl) ? (totalPnl / costBasis) * 100 : null
  const dailyPct = dailyBaseAbs > 0 ? (dailyPnl / dailyBaseAbs) * 100 : null
  return {
    held,
    cost_basis_total: costBasis,
    avg_cost_per_share: heldAbs > 0 ? costBasisAbs / heldAbs : null,
    live_last_price: lastWeight > 0 ? lastWeightedSum / lastWeight : null,
    daily_pnl: heldAbs > 0 ? dailyPnl : null,
    daily_pct: dailyPct,
    total_pnl: heldAbs > 0 ? totalPnl : null,
    total_pct: totalPct,
  }
}

function StrategyAttributionCells({ ex }: { ex: Execution | null }) {
  if (!ex) return <td className="replay-strategy-opp-cell">—</td>
  const oppName = ex.strategy_opportunity_name?.trim()
  const instanceId = ex.strategy_instance_id
  const instanceLabel = ex.strategy_instance_label?.trim()
  const instanceTitle = instanceLabel ? `Instance: ${instanceLabel}` : instanceId != null ? `View instance #${instanceId}` : ''
  return (
    <td className="replay-strategy-opp-cell" title={[instanceTitle, oppName].filter(Boolean).join(' · ') || undefined}>
      <span className="replay-strategy-opp-cell-inner">
        {instanceId != null ? (
          <a href={`#/strategies/instances/${instanceId}`} className="ledger-instance-icon-link" target="_blank" rel="noopener noreferrer" title={instanceTitle} aria-label={instanceTitle || 'View strategy instance'} onClick={e => e.stopPropagation()}>
            <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
          </a>
        ) : null}
        <span className="replay-strategy-opp-text">{oppName || '—'}</span>
      </span>
    </td>
  )
}

function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button type="button" className="btn btn-icon-small" onClick={e => { e.stopPropagation(); onClick() }} title={title} aria-label={title}>
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </button>
  )
}

interface PositionsPageProps {
  status: StatusResponse | null
  currentView?: PortfolioView
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
}

export function PositionsPage({
  status,
  currentView: _currentView,
  onViewChange,
  showViewTabs: _showViewTabs = true,
}: PositionsPageProps) {
  const { executions, loadReplayData, executionAccountOptions } = useExecutions(status)
  const [addExecOpen, setAddExecOpen] = useState(false)
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkContext, setLinkContext] = useState<LinkExecutionContext | null>(null)
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    exec: Execution | null
  }>({ open: false, title: '', message: '', confirming: false, exec: null })
  /** Pool=Off only: execution to close against; when set, show Quick Trade (Close) modal */
  const [closeAgainstExec, setCloseAgainstExec] = useState<Execution | null>(null)
  /** Inline error for e.g. delete execution failure (not modal form errors). */
  const [pageError, setPageError] = useState<string | null>(null)

  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [structures, setStructures] = useState<StrategyStructure[]>([])

  const loadStrategyMeta = useCallback(async () => {
    try {
      const [oppRes, strRes] = await Promise.all([
        fetchOpportunities(false),
        fetchStructures(false),
      ])
      setOpportunities(oppRes.items ?? [])
      setStructures(strRes.items ?? [])
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { loadStrategyMeta() }, [loadStrategyMeta])

  const oppMap = useMemo(() => {
    const m = new Map<number, StrategyOpportunity>()
    for (const o of opportunities) m.set(o.strategy_opportunity_id, o)
    return m
  }, [opportunities])

  const structureMap = useMemo(() => {
    const m = new Map<number, StrategyStructure>()
    for (const s of structures) m.set(s.strategy_structure_id, s)
    return m
  }, [structures])

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterPool, setOpenFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [openFilterAccountId, setOpenFilterAccountId] = useState<string>('all')
  const [openTab, setOpenTab] = useState<'instance' | 'options' | 'stocks'>('instance')
  const [instanceFilterStructureType, setInstanceFilterStructureType] = useState<string>('all')
  const [instanceFilterScopeType, setInstanceFilterScopeType] = useState<string>('all')
  const [instanceFilterOppName, setInstanceFilterOppName] = useState<string>('all')
  const getPositionKey = (p: OpenOptionPosition, instId: number | null) =>
    `${instId ?? 'none'}-${p.contract_key}-${p.strike}-${p.expiry}-${p.pool_label}-${p.account_id}`
  const [expandedPositionKeys, setExpandedPositionKeys] = useState<string[]>([])
  const togglePositionExpand = (posKey: string) => {
    setExpandedPositionKeys(prev => {
      const isOpen = prev.includes(posKey)
      if (openAccordionMode) return isOpen ? [] : [posKey]
      return isOpen ? prev.filter(k => k !== posKey) : [...prev, posKey]
    })
  }
  type OpenOptSortCol =
    | 'contract'
    | 'expiry'
    | 'strike'
    | 'last'
    | 'qty'
    | 'avg_cost'
    | 'value'
    | 'time'
    | 'un_pnl'
  const [openOptSort, setOpenOptSort] = useState<{ column: OpenOptSortCol; dir: 'asc' | 'desc' }>({
    column: 'expiry',
    dir: 'desc',
  })

  const [openAccordionMode, setOpenAccordionMode] = useState<boolean>(true)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then(res => { if (!cancelled) setQuotesMap(() => Object.fromEntries((res.quotes || []).map(q => [q.symbol, q]))) })
      .catch(() => { if (!cancelled) setQuotesMap({}) })
    const unsub = subscribeQuotes(q => {
      setQuotesMap(prev => ({ ...prev, [q.symbol]: q }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const openOffTrackBaseExecutions = useMemo(() => {
    let list = [...(executions || [])]
    list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expMonth = openFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }
    return list
  }, [executions, openFilterSymbol, openFilterExpiryStart])

  const livePositions = useMemo((): LivePositionRow[] => {
    if (openFilterPool === 'Off') return []
    const accounts = status?.accounts ?? []
    let rows = accounts.flatMap(account => {
      const accId = (account.account_id ?? '').trim()
      if (openFilterAccountId !== 'all' && accId !== openFilterAccountId) return []
      return (account.positions ?? [])
        .filter(position => {
          const qty = Number(position.position)
          return Number.isFinite(qty) && qty !== 0
        })
        .map(position => ({
          ...position,
          account_id: accId,
        }))
    })

    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) {
      rows = rows.filter(position => (position.symbol ?? '').toUpperCase() === sym)
    }

    const expMonth = openFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      rows = rows.filter(position => {
        const secType = (position.secType ?? '').toUpperCase()
        if (secType !== 'OPT') return true
        const ex = (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }

    rows.sort((a, b) => {
      const aSym = (a.symbol ?? '').toUpperCase()
      const bSym = (b.symbol ?? '').toUpperCase()
      if (aSym !== bSym) return aSym.localeCompare(bSym)
      return (a.account_id ?? '').localeCompare(b.account_id ?? '')
    })
    return rows
  }, [openFilterAccountId, openFilterExpiryStart, openFilterPool, openFilterSymbol, status?.accounts])

  const liveOptionPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() === 'OPT'),
    [livePositions],
  )

  const livePositionExecutionsMap = useMemo(() => {
    const map = new Map<string, Execution[]>()
    const opt = (executions || []).filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
    for (const ex of opt) {
      if (ex.account_executions_id == null) continue
      const key = optExecutionMatchKey(ex.account_id ?? '', ex.contract_key ?? '')
      const arr = map.get(key)
      if (arr) arr.push(ex)
      else map.set(key, [ex])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    }
    return map
  }, [executions])

  const instanceGroups = useMemo((): InstancePositionGroup[] => {
    const allPositions: OpenOptionPosition[] = []

    if (openFilterPool !== 'Off') {
      for (const pos of liveOptionPositions) {
        const expiry = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
        const strike = Number(pos.strike) || 0
        const right = (pos.right ?? '').toUpperCase().slice(0, 1)
        const contractKey = pos.contract_key ?? `${pos.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`
        const qty = Number(pos.position) || 0
        const rawAvgCost = pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) ? Number(pos.avgCost) : null
        const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
        const markPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
        const pnl = markPrice != null && avgCostPerShare != null
          ? (markPrice - avgCostPerShare) * qty * 100
          : Number(pos.unrealized_pnl) || 0
        allPositions.push({
          kind: 'live',
          contract_key: contractKey,
          strike,
          expiry,
          qty,
          avg_cost: avgCostPerShare,
          mark_price: markPrice,
          unrealized_pnl: pnl,
          pool_label: 'On',
          account_id: (pos.account_id ?? '').trim(),
          position: pos,
        })
      }
    }

    if (openFilterPool !== 'ON') {
      const offTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions)
        .filter(g => g.status === 'unrealized')
      for (const group of offTrackGroups) {
        const pnl = group.sell_premium - group.buy_cost
        const avgPrice = group.net_qty > 0
          ? (group.buy_avg_price ?? 0)
          : (group.sell_avg_price ?? 0)
        allPositions.push({
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          qty: group.net_qty,
          avg_cost: avgPrice,
          mark_price: null,
          unrealized_pnl: pnl,
          pool_label: 'Off',
          account_id: (group.trades[0]?.account_id ?? '').trim(),
          trades: group.trades,
        })
      }
    }

    const byInstance = new Map<string, { id: number | null; label: string | null; oppName: string | null; openedAt: number | null; positions: OpenOptionPosition[] }>()
    for (const p of allPositions) {
      const matchedExecs = p.kind === 'live'
        ? (livePositionExecutionsMap.get(optExecutionMatchKey(p.account_id, p.contract_key)) ?? [])
        : (p.trades ?? [])
      const execWithInstance = matchedExecs.find(e => e.strategy_instance_id != null && Number.isFinite(Number(e.strategy_instance_id)))
      const instId = execWithInstance?.strategy_instance_id ?? null
      const instLabel = execWithInstance?.strategy_instance_label ?? null
      const oppName = execWithInstance?.strategy_opportunity_name ?? null
      const openedAt = execWithInstance?.strategy_instance_opened_at_epoch ?? null
      const key = instId != null ? String(instId) : '__unassigned__'
      if (!byInstance.has(key)) byInstance.set(key, { id: instId, label: instLabel, oppName, openedAt, positions: [] })
      byInstance.get(key)!.positions.push(p)
    }

    const result: InstancePositionGroup[] = []
    for (const [, group] of byInstance) {
      group.positions.sort((a, b) => {
        const aSym = getContractLabelParts(a.contract_key).symbol
        const bSym = getContractLabelParts(b.contract_key).symbol
        if (aSym !== bSym) return aSym.localeCompare(bSym)
        if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry)
        return a.strike - b.strike
      })
      const totalPnl = group.positions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
      result.push({
        strategy_instance_id: group.id,
        strategy_instance_label: group.label,
        strategy_opportunity_name: group.oppName,
        strategy_instance_opened_at_epoch: group.openedAt,
        positions: group.positions,
        total_unrealized_pnl: totalPnl,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [openFilterPool, liveOptionPositions, openOffTrackBaseExecutions, livePositionExecutionsMap])

  const getPositionTime = (p: OpenOptionPosition): number | null => {
    if (p.kind === 'live' && p.position) {
      const ts = p.position.exec_time != null ? Number(p.position.exec_time) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    if (p.kind === 'offtrack' && p.trades?.length) {
      const ex = p.trades[0]
      const ts = ex.time != null ? Number(ex.time) : ex.created_at != null ? Number(ex.created_at) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    return null
  }

  const getPositionLast = (p: OpenOptionPosition): number | null => {
    const symbol = getContractLabelParts(p.contract_key).symbol
    if (!symbol) return null
    const q = quotesMap[symbol]
    return q?.last != null && Number.isFinite(q.last) ? q.last : null
  }

  const allFlatPositions = useMemo(() => instanceGroups.flatMap(g => g.positions), [instanceGroups])

  const sortedInstanceGroups = useMemo((): InstancePositionGroup[] => {
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    const sortPositions = (positions: OpenOptionPosition[]) => {
      const list = [...positions]
      list.sort((a, b) => {
        if (column === 'contract') {
          const aParts = getContractLabelParts(a.contract_key)
          const bParts = getContractLabelParts(b.contract_key)
          const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
          if (cmp !== 0) return mult * cmp
          const cmpExp = a.expiry.localeCompare(b.expiry)
          if (cmpExp !== 0) return mult * cmpExp
          return mult * (a.strike - b.strike)
        }
        if (column === 'expiry') {
          const cmp = a.expiry.localeCompare(b.expiry)
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'strike') {
          const cmp = a.strike - b.strike
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'last') {
          const aLast = getPositionLast(a) ?? -Infinity
          const bLast = getPositionLast(b) ?? -Infinity
          if (aLast !== bLast) return mult * (aLast - bLast)
          return 0
        }
        if (column === 'qty') {
          return mult * (Math.abs(a.qty) - Math.abs(b.qty))
        }
        if (column === 'avg_cost') {
          return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
        }
        if (column === 'value') {
          const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
          const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
          return mult * (aVal - bVal)
        }
        if (column === 'time') {
          return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
        }
        return mult * (a.unrealized_pnl - b.unrealized_pnl)
      })
      return list
    }
    return instanceGroups.map(g => ({
      ...g,
      positions: sortPositions(g.positions),
    }))
  }, [instanceGroups, openOptSort, quotesMap])

  const liveStockPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() !== 'OPT'),
    [livePositions],
  )

  const instanceAllGroups = useMemo((): InstanceAllGroup[] => {
    type Bucket = {
      id: number | null
      label: string | null
      oppName: string | null
      oppId: number | null
      openedAt: number | null
      options: OpenOptionPosition[]
    }
    const map = new Map<string, Bucket>()
    const mergeMeta = (bucket: Bucket, patch: { label?: string | null; oppName?: string | null; oppId?: number | null; openedAt?: number | null }) => {
      if (patch.label != null && patch.label !== '' && !bucket.label) bucket.label = patch.label
      if (patch.oppName != null && patch.oppName !== '' && !bucket.oppName) bucket.oppName = patch.oppName
      if (patch.oppId != null && bucket.oppId == null) bucket.oppId = patch.oppId
      if (patch.openedAt != null && Number.isFinite(patch.openedAt) && bucket.openedAt == null) bucket.openedAt = patch.openedAt
    }
    for (const g of instanceGroups) {
      const key = g.strategy_instance_id != null ? String(g.strategy_instance_id) : '__unassigned__'
      const existing = map.get(key)
      if (existing) {
        existing.options.push(...g.positions)
        mergeMeta(existing, {
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          openedAt: g.strategy_instance_opened_at_epoch,
        })
      } else {
        map.set(key, {
          id: g.strategy_instance_id,
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          oppId: null,
          openedAt: g.strategy_instance_opened_at_epoch,
          options: [...g.positions],
        })
      }
    }

    const resolveOppId = (bucket: Bucket): number | null => {
      if (bucket.oppId != null) return bucket.oppId
      for (const p of bucket.options) {
        const execs = p.kind === 'live' && p.position
          ? (livePositionExecutionsMap.get(optExecutionMatchKey(p.account_id, p.contract_key)) ?? [])
          : (p.trades ?? [])
        for (const e of execs) {
          if (e.strategy_opportunity_id != null) return e.strategy_opportunity_id
        }
      }
      return null
    }

    const execPremiumPnl = (execs: Execution[]): number => {
      let sellPremium = 0
      let buyCost = 0
      for (const e of execs) {
        const side = (e.side ?? '').toUpperCase()
        const q = Math.abs(Number(e.quantity) || 0)
        const p = Number(e.price) || 0
        const c = Number(e.commission) || 0
        if (side === 'SELL' || side === 'SLD' || side === 'S') {
          sellPremium += p * q * 100 - c
        } else if (side === 'BUY' || side === 'BOT' || side === 'B') {
          buyCost += p * q * 100 + c
        }
      }
      return sellPremium - buyCost
    }

    const computeStockCoverage = (options: OpenOptionPosition[], str: StrategyStructure | undefined): InstanceStockCoverage[] => {
      if (!str?.legs?.length) return []
      const underlyingLeg = str.legs.find(l => (l.role ?? '').toLowerCase() === 'underlying')
      if (!underlyingLeg) return []
      const legDir = (underlyingLeg.direction ?? 'long').toLowerCase() as 'long' | 'short'
      const legQty = underlyingLeg.quantity ?? 1
      /** Same symbol may appear in multiple accounts; stock hedge is per account (no cross-margin). */
      const bySymbolAccount = new Map<string, { symbol: string; account_id: string; contracts: number }>()
      for (const p of options) {
        const sym = getContractLabelParts(p.contract_key).symbol
        if (!sym) continue
        const account_id = (p.account_id ?? '').trim()
        const k = `${sym}\x00${account_id}`
        const prev = bySymbolAccount.get(k) ?? { symbol: sym, account_id, contracts: 0 }
        prev.contracts += Math.abs(p.qty)
        bySymbolAccount.set(k, prev)
      }
      const result: InstanceStockCoverage[] = []
      for (const v of bySymbolAccount.values()) {
        result.push({
          symbol: v.symbol,
          account_id: v.account_id,
          required_shares: v.contracts * 100 * legQty,
          direction: legDir,
        })
      }
      result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
      return result
    }

    const pickWorseRiskProfile = (a: import('../utils/riskProfile').RiskProfile, b: import('../utils/riskProfile').RiskProfile) => {
      if (a.naked_short_call_contracts !== b.naked_short_call_contracts) {
        return a.naked_short_call_contracts > b.naked_short_call_contracts ? a : b
      }
      if (a.max_loss == null && b.max_loss != null) return a
      if (a.max_loss != null && b.max_loss == null) return b
      if (a.max_loss != null && b.max_loss != null && a.max_loss !== b.max_loss) {
        return a.max_loss < b.max_loss ? a : b
      }
      return a
    }

    const result: InstanceAllGroup[] = []
    for (const [, b] of map) {
      let optPnl = 0
      for (const p of b.options) {
        const matchedExecs = p.kind === 'live' && p.position
          ? (livePositionExecutionsMap.get(optExecutionMatchKey(p.account_id, p.contract_key)) ?? [])
          : (p.trades ?? [])
        if (matchedExecs.length > 0) {
          optPnl += execPremiumPnl(matchedExecs)
        } else {
          optPnl += p.unrealized_pnl
        }
      }
      const oppId = resolveOppId(b)
      const opp = oppId != null ? oppMap.get(oppId) : undefined
      const str = opp ? structureMap.get(opp.strategy_structure_id) : undefined
      const coverage = computeStockCoverage(b.options, str)

      let riskProfile = null as import('../utils/riskProfile').RiskProfile | null
      if (b.options.length > 0) {
        const byAcct = new Map<string, OpenOptionPosition[]>()
        for (const p of b.options) {
          const aid = (p.account_id ?? '').trim()
          if (!byAcct.has(aid)) byAcct.set(aid, [])
          byAcct.get(aid)!.push(p)
        }
        for (const optsInAcct of byAcct.values()) {
          const riskPositions: RiskPosition[] = []
          for (const p of optsInAcct) {
            const parsed = parseOptionContractKey(p.contract_key)
            const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
            if (r && p.avg_cost != null) {
              riskPositions.push({ strike: p.strike, right: r, qty: p.qty, avg_cost: p.avg_cost })
            }
          }
          if (riskPositions.length === 0) continue
          let covShares = 0
          let covAvgCost: number | null = null
          const covRows = computeStockCoverage(optsInAcct, str)
          if (covRows.length > 0) {
            const optSym = getContractLabelParts(optsInAcct[0].contract_key).symbol?.toUpperCase() ?? ''
            const row =
              optSym && covRows.some(c => c.symbol.toUpperCase() === optSym)
                ? covRows.find(c => c.symbol.toUpperCase() === optSym)!
                : covRows[0]
            const sym = row.symbol
            const acct = row.account_id
            const heldPos = liveStockPositions.find(
              s =>
                (s.symbol ?? '').toUpperCase() === sym.toUpperCase() &&
                (s.account_id ?? '').trim() === acct,
            )
            const held = heldPos ? Math.abs(Number(heldPos.position) || 0) : 0
            covShares = Math.min(held, row.required_shares)
            covAvgCost = heldPos?.avgCost != null ? Number(heldPos.avgCost) : null
          }
          const rp = computeRiskProfile(riskPositions, covShares, covAvgCost)
          riskProfile = riskProfile == null ? rp : pickWorseRiskProfile(riskProfile, rp)
        }
      }

      result.push({
        strategy_instance_id: b.id,
        strategy_instance_label: b.label,
        strategy_opportunity_name: b.oppName ?? opp?.name ?? null,
        strategy_opportunity_id: oppId,
        strategy_instance_opened_at_epoch: b.openedAt,
        options: b.options,
        stock_coverage: coverage,
        options_unrealized_pnl: optPnl,
        structure_type: str?.structure_type ?? null,
        scope_type: opp?.scope_type ?? null,
        risk_profile: riskProfile,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [instanceGroups, oppMap, structureMap, livePositionExecutionsMap, liveStockPositions])

  const stockCoverageItems = useMemo((): StockCoverageItem[] => {
    const covKey = (sym: string, accountId: string) =>
      `${(sym ?? '').toUpperCase().trim()}\x1f${(accountId ?? '').trim()}`
    type DemandMeta = {
      required: number
      instances: number
      oppNames: Set<string>
      watchlistScopeInstances: number
    }
    const demandMap = new Map<string, DemandMeta>()
    for (const g of instanceAllGroups) {
      const oppName = (g.strategy_opportunity_name ?? '').trim()
      for (const sc of g.stock_coverage) {
        const sym = (sc.symbol ?? '').toUpperCase().trim()
        if (!sym) continue
        const k = covKey(sym, sc.account_id)
        const prev = demandMap.get(k) ?? {
          required: 0,
          instances: 0,
          oppNames: new Set<string>(),
          watchlistScopeInstances: 0,
        }
        prev.required += sc.required_shares
        prev.instances += 1
        if (oppName) prev.oppNames.add(oppName)
        if ((g.scope_type ?? '').trim() === 'watchlist_stk') prev.watchlistScopeInstances += 1
        demandMap.set(k, prev)
      }
    }

    type HeldMeta = {
      held: number
      heldAbs: number
      costBasisAbs: number
      lastWeightedSum: number
      lastWeight: number
      dailyPnl: number
      dailyBaseAbs: number
      totalPnl: number
      optionableTrue: number
      optionableFalse: number
      optionableUnknown: number
    }
    const heldMap = new Map<string, HeldMeta>()
    for (const s of liveStockPositions) {
      const sym = (s.symbol ?? '').toUpperCase().trim()
      if (!sym) continue
      const k = covKey(sym, (s.account_id ?? '').trim())
      const qty = Number(s.position)
      if (!Number.isFinite(qty) || qty === 0) continue
      const absQty = Math.abs(qty)
      const avgCost = s.avgCost != null && Number.isFinite(Number(s.avgCost)) ? Number(s.avgCost) : null
      const lastPrice = s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
      const dailyPrevClose = s.daily_prev_close != null && Number.isFinite(Number(s.daily_prev_close))
        ? Number(s.daily_prev_close)
        : null
      const unrealizedPnl = s.unrealized_pnl != null && Number.isFinite(Number(s.unrealized_pnl))
        ? Number(s.unrealized_pnl)
        : (lastPrice != null && avgCost != null ? (lastPrice - avgCost) * qty : 0)

      const prev = heldMap.get(k) ?? {
        held: 0,
        heldAbs: 0,
        costBasisAbs: 0,
        lastWeightedSum: 0,
        lastWeight: 0,
        dailyPnl: 0,
        dailyBaseAbs: 0,
        totalPnl: 0,
        optionableTrue: 0,
        optionableFalse: 0,
        optionableUnknown: 0,
      }
      prev.held += qty
      prev.heldAbs += absQty
      if (avgCost != null) prev.costBasisAbs += absQty * avgCost
      if (lastPrice != null) {
        prev.lastWeightedSum += absQty * lastPrice
        prev.lastWeight += absQty
      }
      if (dailyPrevClose != null && lastPrice != null) {
        prev.dailyPnl += (lastPrice - dailyPrevClose) * qty
        prev.dailyBaseAbs += Math.abs(dailyPrevClose * qty)
      }
      prev.totalPnl += unrealizedPnl
      if (s.optionable === true) prev.optionableTrue += 1
      else if (s.optionable === false) prev.optionableFalse += 1
      else prev.optionableUnknown += 1
      heldMap.set(k, prev)
    }

    const allKeys = new Set([...demandMap.keys(), ...heldMap.keys()])
    const result: StockCoverageItem[] = []
    for (const key of allKeys) {
      const sep = key.indexOf('\x1f')
      const sym = sep >= 0 ? key.slice(0, sep) : key
      const account_id = sep >= 0 ? key.slice(sep + 1) : ''
      const demand = demandMap.get(key)
      const heldMeta = heldMap.get(key)
      const required = demand?.required ?? 0
      const held = heldMeta?.held ?? 0
      if (required === 0 && held === 0) continue
      const costBasis = heldMeta != null && heldMeta.costBasisAbs > 0 ? heldMeta.costBasisAbs : null
      const totalPnl = heldMeta != null && Number.isFinite(heldMeta.totalPnl) ? heldMeta.totalPnl : null
      const totalPct = costBasis != null && costBasis > 0 && totalPnl != null ? (totalPnl / costBasis) * 100 : null
      const dailyPct = heldMeta != null && heldMeta.dailyBaseAbs > 0 ? (heldMeta.dailyPnl / heldMeta.dailyBaseAbs) * 100 : null

      let optionableSupported: boolean | null = null
      if (heldMeta != null) {
        if (heldMeta.optionableTrue > 0 && heldMeta.optionableFalse === 0) optionableSupported = true
        else if (heldMeta.optionableFalse > 0 && heldMeta.optionableTrue === 0) optionableSupported = false
      }

      result.push({
        symbol: sym,
        account_id,
        required_shares: required,
        held_shares: held,
        surplus_or_gap: held - required,
        instances_needing: demand?.instances ?? 0,
        backing_opportunities: demand != null ? Array.from(demand.oppNames).sort() : [],
        watchlist_scope_instances: demand?.watchlistScopeInstances ?? 0,
        optionable_supported: optionableSupported,
        avg_cost_per_share: heldMeta != null && heldMeta.heldAbs > 0 ? heldMeta.costBasisAbs / heldMeta.heldAbs : null,
        live_last_price: heldMeta != null && heldMeta.lastWeight > 0 ? heldMeta.lastWeightedSum / heldMeta.lastWeight : null,
        cost_basis_total: costBasis,
        daily_pnl: heldMeta != null ? heldMeta.dailyPnl : null,
        daily_pct: dailyPct,
        total_pnl: totalPnl,
        total_pct: totalPct,
      })
    }
    result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
    return result
  }, [instanceAllGroups, liveStockPositions])

  const watchlistOptionableCoverageItems = useMemo(
    () => stockCoverageItems.filter((ci) => (ci.watchlist_scope_instances ?? 0) > 0 && ci.optionable_supported !== false),
    [stockCoverageItems],
  )
  const watchlistNonOptionableCoverageItems = useMemo(
    () => stockCoverageItems.filter((ci) => (ci.watchlist_scope_instances ?? 0) > 0 && ci.optionable_supported === false),
    [stockCoverageItems],
  )
  const nonWatchlistCoverageItems = useMemo(
    () => stockCoverageItems.filter((ci) => (ci.watchlist_scope_instances ?? 0) === 0),
    [stockCoverageItems],
  )

  const unassignedOptStocks = useMemo(
    () => liveStockPositions.filter(s => {
      const opt = s.optionable
      return opt === true
    }),
    [liveStockPositions],
  )

  const independentStocks = useMemo(
    () => liveStockPositions.filter(s => {
      const opt = s.optionable
      return opt !== true
    }),
    [liveStockPositions],
  )

  const filteredInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    let list = instanceAllGroups
    if (instanceFilterStructureType !== 'all') {
      list = list.filter(g => (g.structure_type ?? '') === instanceFilterStructureType)
    }
    if (instanceFilterScopeType !== 'all') {
      if (instanceFilterScopeType === '__none__') {
        list = list.filter(g => !g.scope_type)
      } else {
        list = list.filter(g => g.scope_type === instanceFilterScopeType)
      }
    }
    if (instanceFilterOppName !== 'all') {
      list = list.filter(g => (g.strategy_opportunity_name ?? '') === instanceFilterOppName)
    }
    return list
  }, [instanceAllGroups, instanceFilterStructureType, instanceFilterScopeType, instanceFilterOppName])

  const instanceFilterOptions = useMemo(() => {
    const stSet = new Set<string>()
    const scSet = new Set<string>()
    const oppSet = new Set<string>()
    for (const g of instanceAllGroups) {
      if (g.structure_type) stSet.add(g.structure_type)
      scSet.add(g.scope_type ?? '')
      if (g.strategy_opportunity_name) oppSet.add(g.strategy_opportunity_name)
    }
    return {
      structureTypes: Array.from(stSet).sort(),
      scopeTypes: Array.from(scSet).sort(),
      oppNames: Array.from(oppSet).sort(),
    }
  }, [instanceAllGroups])

  const sortedInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    const sortPositions = (positions: OpenOptionPosition[]) => {
      const list = [...positions]
      list.sort((a, b) => {
        if (column === 'contract') {
          const aParts = getContractLabelParts(a.contract_key)
          const bParts = getContractLabelParts(b.contract_key)
          const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
          if (cmp !== 0) return mult * cmp
          const cmpExp = a.expiry.localeCompare(b.expiry)
          if (cmpExp !== 0) return mult * cmpExp
          return mult * (a.strike - b.strike)
        }
        if (column === 'expiry') {
          const cmp = a.expiry.localeCompare(b.expiry)
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'strike') {
          const cmp = a.strike - b.strike
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'last') {
          const aLast = getPositionLast(a) ?? -Infinity
          const bLast = getPositionLast(b) ?? -Infinity
          if (aLast !== bLast) return mult * (aLast - bLast)
          return 0
        }
        if (column === 'qty') {
          return mult * (Math.abs(a.qty) - Math.abs(b.qty))
        }
        if (column === 'avg_cost') {
          return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
        }
        if (column === 'value') {
          const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
          const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
          return mult * (aVal - bVal)
        }
        if (column === 'time') {
          return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
        }
        return mult * (a.unrealized_pnl - b.unrealized_pnl)
      })
      return list
    }
    return filteredInstanceAllGroups.map(g => ({
      ...g,
      options: sortPositions(g.options),
    }))
  }, [filteredInstanceAllGroups, openOptSort, quotesMap])

  const [expandedInstanceKeys, setExpandedInstanceKeys] = useState<string[]>([])
  const toggleInstanceExpand = (key: string) => {
    setExpandedInstanceKeys(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    )
  }

  const openFilterAccountOptions = useMemo(() => {
    const accounts = (status?.accounts ?? []).map(a => (a.account_id ?? '').trim()).filter(Boolean)
    const unique = Array.from(new Set(accounts))
    unique.sort()
    return unique
  }, [status?.accounts])

  const hasOpenOptions = allFlatPositions.length > 0
  const hasOpenStocks = liveStockPositions.length > 0
  const hasInstances = instanceAllGroups.length > 0
  useEffect(() => {
    if (openTab === 'instance' && !hasInstances) {
      if (hasOpenOptions) setOpenTab('options')
      else if (hasOpenStocks) setOpenTab('stocks')
      return
    }
    if (openTab === 'options' && !hasOpenOptions) {
      if (hasInstances) setOpenTab('instance')
      else if (hasOpenStocks) setOpenTab('stocks')
      return
    }
    if (openTab === 'stocks' && !hasOpenStocks) {
      if (hasInstances) setOpenTab('instance')
      else if (hasOpenOptions) setOpenTab('options')
    }
  }, [openTab, hasInstances, hasOpenOptions, hasOpenStocks])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  const renderStockCoverageSummaryTable = (rows: StockCoverageItem[], keyPrefix: string) => (
    <div className="replay-portfolio-table-wrap">
      <table className="table-operations instance-sheet-sub-table coverage-summary-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Account</th>
            <th>Backed opportunities</th>
            <th>Held</th>
            <th>Required</th>
            <th>Surplus / Gap</th>
            <th>Option support</th>
            <th>Cost basis</th>
            <th>Avg cost</th>
            <th>Live last</th>
            <th>Daily ($ / %)</th>
            <th>Total ($ / %)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((ci) => {
            const statusLabel = ci.held_shares >= ci.required_shares
              ? 'Covered' : ci.held_shares > 0 ? 'Partial' : 'Naked'
            const statusClass = ci.held_shares >= ci.required_shares
              ? 'coverage-status-covered' : ci.held_shares > 0 ? 'coverage-status-partial' : 'coverage-status-naked'
            const optionSupportLabel = ci.optionable_supported === true
              ? 'Optionable'
              : ci.optionable_supported === false
                ? 'Not optionable'
                : 'Mixed / Unknown'
            const backedOpps = ci.backing_opportunities ?? []
            return (
              <tr key={`${keyPrefix}-${ci.symbol}-${ci.account_id || '—'}`}>
                <td><strong>{ci.symbol}</strong></td>
                <td className="replay-muted">{ci.account_id || '—'}</td>
                <td title={backedOpps.join(', ') || undefined}>
                  {backedOpps.length > 0 ? backedOpps.join(', ') : '—'}
                </td>
                <td>{ci.held_shares}</td>
                <td>{ci.required_shares}{ci.instances_needing > 1 && <span className="coverage-shared-hint"> ({ci.instances_needing} inst.)</span>}</td>
                <td><span className={ci.surplus_or_gap >= 0 ? 'pnl-positive' : 'pnl-negative'}>{fmtSurplusShares(ci.surplus_or_gap)}</span></td>
                <td>{optionSupportLabel}</td>
                <td>{fmtUsd(ci.cost_basis_total)}</td>
                <td>{fmtUsd(ci.avg_cost_per_share)}</td>
                <td>{fmtUsd(ci.live_last_price)}</td>
                <td>
                  <span className={((ci.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                    {fmtUsd(ci.daily_pnl)}
                  </span>
                  {' / '}
                  <span className={((ci.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                    {fmtSignedPct(ci.daily_pct)}
                  </span>
                </td>
                <td>
                  <span className={((ci.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                    {fmtUsd(ci.total_pnl)}
                  </span>
                  {' / '}
                  <span className={((ci.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                    {fmtSignedPct(ci.total_pct)}
                  </span>
                </td>
                <td><span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="card process-section replay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Positions'}
          <InfoTooltip text="Open positions (Pool On and Off) and manual execution records." />
        </h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setAddExecOpen(true)
            setPageError(null)
          }}
          aria-label="Add execution record manually (historical)"
        >
          Add Trade
        </button>
      </div>

      <section className="replay-section replay-section-trade-records" aria-label="Open positions">
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" aria-label="Position filters">
              <input
                type="text"
                placeholder="Symbol"
                value={openFilterSymbol}
                onChange={e => setOpenFilterSymbol(e.target.value)}
                className="replay-filter-input replay-filter-input-symbol"
              />
              <label className="replay-filter-label-month">
                <span className="replay-filter-label">Exp</span>
                <input
                  type="month"
                  value={openFilterExpiryStart}
                  onChange={e => setOpenFilterExpiryStart(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="Expiry month"
                />
              </label>
            </div>
            <div className="ib-accounts-tabs">
              <button
                type="button"
                className={`ib-accounts-tab ${openFilterAccountId === 'all' ? 'active' : ''}`}
                onClick={() => setOpenFilterAccountId('all')}
              >
                All
              </button>
              {openFilterAccountOptions.map(id => (
                <button
                  key={id}
                  type="button"
                  className={`ib-accounts-tab ${openFilterAccountId === id ? 'active' : ''}`}
                  onClick={() => setOpenFilterAccountId(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            <div className="replay-fetch-range-group replay-pool-group" role="radiogroup" aria-label="Account filter">
              <span className="replay-fetch-days-label">Account</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="Mix" checked={openFilterPool === 'Mix'} onChange={() => setOpenFilterPool('Mix')} />
                <span>Mix</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="ON" checked={openFilterPool === 'ON'} onChange={() => setOpenFilterPool('ON')} />
                <span>On</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="Off" checked={openFilterPool === 'Off'} onChange={() => setOpenFilterPool('Off')} />
                <span>Off</span>
              </label>
            </div>
            <div className="replay-fetch-range-group" role="radiogroup" aria-label="Open position detail view mode">
              <span className="replay-fetch-days-label">Detail view</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="accordion" checked={openAccordionMode} onChange={() => setOpenAccordionMode(true)} />
                <span>Accordion</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="multi" checked={!openAccordionMode} onChange={() => setOpenAccordionMode(false)} />
                <span>Multi</span>
              </label>
            </div>
          </div>
          {allFlatPositions.length === 0 && liveStockPositions.length === 0 ? (
            <p className="section-hint">No open positions under the current filters. Position data comes from account snapshots in `Accounts`, while Off-Track options are inferred from execution history.</p>
          ) : (
            <div className="replay-portfolio-block">
              <div className="replay-portfolio-header">
                <div className="replay-portfolio-tabs-wrap">
                  <div className="system-tabs replay-portfolio-tabs" role="tablist" aria-label="Open position asset sections">
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-instance"
                      aria-selected={openTab === 'instance'}
                      aria-controls="open-panel-instance"
                      className={`system-tab ${openTab === 'instance' ? 'active' : ''}`}
                      onClick={() => setOpenTab('instance')}
                      disabled={!hasInstances}
                    >
                      Instance
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-options"
                      aria-selected={openTab === 'options'}
                      aria-controls="open-panel-options"
                      className={`system-tab ${openTab === 'options' ? 'active' : ''}`}
                      onClick={() => setOpenTab('options')}
                      disabled={!hasOpenOptions}
                    >
                      Options
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-stocks"
                      aria-selected={openTab === 'stocks'}
                      aria-controls="open-panel-stocks"
                      className={`system-tab ${openTab === 'stocks' ? 'active' : ''}`}
                      onClick={() => setOpenTab('stocks')}
                      disabled={!hasOpenStocks}
                    >
                      Stocks
                    </button>
                  </div>
                  <p className="section-hint replay-portfolio-tab-hint">
                    {openTab === 'instance'
                      ? 'All positions grouped by strategy instance. Each group shows its option and stock positions.'
                      : openTab === 'options'
                        ? 'Open option positions by contract; expand a row to see Details and Add/Edit/Close trades.'
                        : 'Open stock positions from account snapshots (Live only). Tag stock fills with strategy from Ledger / Executions if needed.'}
                  </p>
                </div>
              </div>
              {openTab === 'instance' ? (
                <div
                  id="open-panel-instance"
                  role="tabpanel"
                  aria-labelledby="open-tab-instance"
                  className="system-tab-panel"
                >
                  <div className="instance-sheet-filters">
                    <select
                      className="replay-filter-select"
                      value={instanceFilterStructureType}
                      onChange={e => setInstanceFilterStructureType(e.target.value)}
                      aria-label="Filter by contract type"
                    >
                      <option value="all">All Contract Types</option>
                      {instanceFilterOptions.structureTypes.map(st => (
                        <option key={st} value={st}>{st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                      ))}
                    </select>
                    <select
                      className="replay-filter-select"
                      value={instanceFilterOppName}
                      onChange={e => setInstanceFilterOppName(e.target.value)}
                      aria-label="Filter by opportunity"
                    >
                      <option value="all">All Opportunities</option>
                      {instanceFilterOptions.oppNames.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <select
                      className="replay-filter-select"
                      value={instanceFilterScopeType}
                      onChange={e => setInstanceFilterScopeType(e.target.value)}
                      aria-label="Filter by symbol scope"
                    >
                      <option value="all">All Symbol Scopes</option>
                      <option value="__none__">— None</option>
                      {instanceFilterOptions.scopeTypes.filter(s => s !== '').map(s => (
                        <option key={s} value={s}>{s === 'watchlist_stk' ? 'Watchlist (stocks)' : s === 'explicit_symbols' ? 'Explicit symbols' : s}</option>
                      ))}
                    </select>
                    {(instanceFilterStructureType !== 'all' || instanceFilterScopeType !== 'all' || instanceFilterOppName !== 'all') && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => { setInstanceFilterStructureType('all'); setInstanceFilterScopeType('all'); setInstanceFilterOppName('all') }}
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>
                  {sortedInstanceAllGroups.length === 0 ? (
                    <p className="section-hint">No instances match the current filters.</p>
                  ) : (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations instance-sheet-table">
                        <thead>
                          <tr>
                            <th className="replay-opt-expand-col" />
                            <th>Opportunity</th>
                            <th>Contract Type</th>
                            <th>Symbols</th>
                            <th>Opened</th>
                            <th>Opt</th>
                            <th>Underlying</th>
                            <th>Opt PNL</th>
                            <th>Max Gain</th>
                            <th>Max Loss</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedInstanceAllGroups.map(allGroup => {
                            const instKey = allGroup.strategy_instance_id != null ? String(allGroup.strategy_instance_id) : '__unassigned__'
                            const instLabel = allGroup.strategy_instance_label ?? (allGroup.strategy_instance_id != null ? `Instance #${allGroup.strategy_instance_id}` : 'Unassigned')
                            const oppName = allGroup.strategy_opportunity_name?.trim() || null
                            const openedAt = allGroup.strategy_instance_opened_at_epoch
                            const optN = allGroup.options.length
                            const covN = allGroup.stock_coverage.length
                            const isExpanded = expandedInstanceKeys.includes(instKey)
                            const structLabel = allGroup.structure_type
                              ? allGroup.structure_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                              : '—'
                            const structBadgeClass = allGroup.structure_type
                              ? `instance-sheet-badge instance-sheet-badge-${allGroup.structure_type.replace(/_/g, '-')}`
                              : 'instance-sheet-badge'
                            const opp = allGroup.strategy_opportunity_id != null ? oppMap.get(allGroup.strategy_opportunity_id) : undefined
                            const scopeSymbols = opp?.symbols ?? []
                            const scopeType = allGroup.scope_type
                            const symbolsCell = scopeType === 'watchlist_stk'
                              ? <span className="instance-sheet-badge instance-sheet-badge-scope">Watchlist</span>
                              : scopeSymbols.length > 0
                                ? <span className="instance-sheet-symbols">{scopeSymbols.join(', ')}</span>
                                : <span className="replay-muted">—</span>
                            return [
                              <tr
                                key={`inst-row-${instKey}`}
                                className={`instance-sheet-row ${isExpanded ? 'instance-sheet-row-expanded' : ''}`}
                                onClick={() => toggleInstanceExpand(instKey)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInstanceExpand(instKey) } }}
                                aria-expanded={isExpanded}
                              >
                                <td className="replay-opt-expand-col">
                                  <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                                    {isExpanded ? '▼' : '▶'}
                                  </span>
                                </td>
                                <td className="instance-sheet-opp-cell">
                                  {allGroup.strategy_instance_id != null ? (
                                    <>
                                      {oppName ? (
                                        <span className="instance-sheet-opp-name">{oppName}</span>
                                      ) : null}
                                      <a
                                        href={`#/strategies/instances/${allGroup.strategy_instance_id}`}
                                        className="instance-sheet-inst-link instance-sheet-inst-sublabel"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={`View instance: ${instLabel}`}
                                        onClick={e => e.stopPropagation()}
                                      >
                                        {instLabel}
                                      </a>
                                    </>
                                  ) : (
                                    <span>{oppName || instLabel}</span>
                                  )}
                                </td>
                                <td><span className={structBadgeClass}>{structLabel}</span></td>
                                <td>{symbolsCell}</td>
                                <td>
                                  {openedAt != null && Number.isFinite(openedAt) ? (
                                    <>{fmtDate(openedAt)}{fmtDaysAgo(openedAt) ? <span className="replay-time-ago"> {fmtDaysAgo(openedAt)}</span> : null}</>
                                  ) : '—'}
                                </td>
                                <td>{optN}</td>
                                <td>
                                  {covN > 0 ? (() => {
                                    let allCovered = true
                                    let anyNaked = false
                                    for (const sc of allGroup.stock_coverage) {
                                      const hp = liveStockPositions.find(
                                        s =>
                                          (s.symbol ?? '').toUpperCase() === (sc.symbol ?? '').toUpperCase() &&
                                          (s.account_id ?? '').trim() === (sc.account_id ?? '').trim(),
                                      )
                                      const held = hp ? Math.abs(Number(hp.position) || 0) : 0
                                      if (held >= sc.required_shares) continue
                                      allCovered = false
                                      if (held === 0) anyNaked = true
                                    }
                                    const statusClass = allCovered
                                      ? 'coverage-status-covered'
                                      : anyNaked
                                        ? 'coverage-status-naked'
                                        : 'coverage-status-partial'
                                    const statusLabel = allCovered ? 'Covered' : anyNaked ? 'Naked' : 'Partial'
                                    return <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                                  })() : <span className="replay-muted">—</span>}
                                </td>
                                <td>{optN > 0 ? <span className="replay-pnl-unrealized">{fmtUsd(allGroup.options_unrealized_pnl)}</span> : <span className="replay-muted">—</span>}</td>
                                {(() => {
                                  if (!allGroup.risk_profile) return <><td className="replay-muted">—</td><td className="replay-muted">—</td><td className="replay-muted">—</td></>
                                  const rl = formatRiskLabel(allGroup.risk_profile)
                                  return <>
                                    <td><span className="risk-value-gain">{rl.gainLabel}</span></td>
                                    <td><span className={allGroup.risk_profile.max_loss == null ? 'risk-value-loss risk-value-unlimited' : 'risk-value-loss'}>{rl.lossLabel}</span></td>
                                    <td><span className={`coverage-status-badge ${allGroup.risk_profile.risk_type === 'defined' ? 'risk-badge-defined' : 'risk-badge-unlimited'}`}>{rl.riskBadge}</span></td>
                                  </>
                                })()}
                              </tr>,
                              ...(isExpanded ? [
                                <tr key={`inst-detail-${instKey}`} className="instance-sheet-detail-row">
                                  <td colSpan={11} className="instance-sheet-detail-cell">
                                    {optN > 0 && (
                                      <div className="instance-sheet-sub-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Options ({optN})</h6>
                                        <div className="replay-portfolio-table-wrap">
                                          <table className="table-operations replay-opt-groups instance-sheet-sub-table">
                                            <thead>
                                              <tr>
                                                <th className="replay-opt-expand-col" />
                                                <th>Contract</th>
                                                <th>Expiry</th>
                                                <th>Strike</th>
                                                <th>Last</th>
                                                <th>Qty</th>
                                                <th>@</th>
                                                <th>Value</th>
                                                <th>Time</th>
                                                <th>UN PNL</th>
                                                <th>Pool</th>
                                                <th>Account</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {allGroup.options.map((pos) => {
                                                const posKey = `ia-${instKey}-${getPositionKey(pos, allGroup.strategy_instance_id)}`
                                                const absQty = Math.abs(pos.qty)
                                                const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                                                const value = (pos.avg_cost ?? 0) * absQty * 100
                                                const ts = getPositionTime(pos)
                                                const matchedExecs = pos.kind === 'live' && pos.position
                                                  ? (livePositionExecutionsMap.get(optExecutionMatchKey(pos.account_id, pos.contract_key)) ?? [])
                                                  : (pos.kind === 'offtrack' ? pos.trades ?? [] : [])
                                                const hasExecutions = matchedExecs.length > 0
                                                const isPosExpanded = expandedPositionKeys.includes(posKey)
                                                return [
                                                  <tr
                                                    key={posKey}
                                                    className="detail-position-row"
                                                    onClick={hasExecutions ? (e) => { e.stopPropagation(); togglePositionExpand(posKey) } : undefined}
                                                    role={hasExecutions ? 'button' : undefined}
                                                    tabIndex={hasExecutions ? 0 : undefined}
                                                    onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); togglePositionExpand(posKey) } } : undefined}
                                                    aria-expanded={hasExecutions ? isPosExpanded : undefined}
                                                  >
                                                    <td className="replay-opt-expand-col">
                                                      {hasExecutions ? (
                                                        <span className={`replay-opt-expand-icon ${isPosExpanded ? 'expanded' : ''}`} aria-hidden>
                                                          {isPosExpanded ? '▼' : '▶'}
                                                        </span>
                                                      ) : null}
                                                    </td>
                                                    <td className="replay-opt-contract">
                                                      {(() => {
                                                        const p = getContractLabelParts(pos.contract_key)
                                                        const strikeStr = pos.strike != null ? ` ${pos.strike}` : ''
                                                        return p.symbol ? (<><strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}</>) : pos.contract_key
                                                      })()}
                                                    </td>
                                                    <td>
                                                      {fmtExpiry(pos.expiry)}
                                                      {(() => {
                                                        const days = daysUntilExpiry(pos.expiry)
                                                        if (days == null) return null
                                                        const label = days >= 0 ? (days === 0 ? ' today' : ` ${days}d`) : ` ${-days}d ago`
                                                        return <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                                                      })()}
                                                    </td>
                                                    <td><strong>{fmtUsd(pos.strike)}</strong></td>
                                                    <td>
                                                      {(() => {
                                                        const underlying = getContractLabelParts(pos.contract_key).symbol
                                                        const q = underlying ? quotesMap[underlying] : undefined
                                                        const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                                        const strikeNum = pos.strike != null && Number.isFinite(pos.strike) ? pos.strike : null
                                                        const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                                        const right = parseOptionContractKey(pos.contract_key).right
                                                        const side: 'Buy' | 'Sell' = pos.qty > 0 ? 'Buy' : 'Sell'
                                                        const pctClass = pct != null ? optionLastStrikePctClass(right, side, pct) : ''
                                                        return (
                                                          <>
                                                            {last != null ? fmtUsd(last) : '—'}
                                                            {pct != null && <span className={`replay-last-strike-pct ${pctClass}`.trim()} title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}> {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>}
                                                          </>
                                                        )
                                                      })()}
                                                    </td>
                                                    <td>{sideLabel} {absQty}</td>
                                                    <td>{fmtUsd(pos.avg_cost)}</td>
                                                    <td>{fmtUsd(value)}</td>
                                                    <td>
                                                      {ts != null ? (
                                                        <>{fmtDate(ts)}{fmtDaysAgo(ts) ? <span className="replay-time-ago"> {fmtDaysAgo(ts)}</span> : null}</>
                                                      ) : '—'}
                                                    </td>
                                                    <td><span className="replay-pnl-unrealized">{fmtUsd(pos.unrealized_pnl)}</span></td>
                                                    <td className="replay-muted">{pos.pool_label}</td>
                                                    <td>{pos.account_id || '—'}</td>
                                                  </tr>,
                                                  ...(isPosExpanded ? matchedExecs.map((ex, ei) => {
                                                    const es = (ex.side ?? '').toUpperCase()
                                                    const eSideLabel = es === 'BUY' || es === 'BOT' || es === 'B' ? 'Buy' : es === 'SELL' || es === 'SLD' || es === 'S' ? 'Sell' : (ex.side ?? '—')
                                                    const eQty = Math.abs(Number(ex.quantity) || 0)
                                                    const ePrice = Number(ex.price) || 0
                                                    const eComm = Number(ex.commission) || 0
                                                    const eTs = ex.time != null ? Number(ex.time) : null
                                                    return (
                                                      <tr key={`${posKey}-exec-${ex.account_executions_id ?? ei}`} className="detail-execution-row">
                                                        <td className="replay-opt-expand-col" />
                                                        <td className="detail-exec-indent replay-muted" colSpan={2}>↳ exec #{ex.account_executions_id ?? '?'} ({ex.source ?? '—'})</td>
                                                        <td />
                                                        <td />
                                                        <td>{eSideLabel} {eQty || '—'}</td>
                                                        <td>{fmtUsd(ePrice)}</td>
                                                        <td />
                                                        <td>{eTs != null && Number.isFinite(eTs) ? <>{fmtDate(eTs)}{fmtDaysAgo(eTs) ? <span className="replay-time-ago"> {fmtDaysAgo(eTs)}</span> : null}</> : '—'}</td>
                                                        <td>{eComm ? fmtUsd(eComm) : '—'}</td>
                                                        <td />
                                                        <td className="replay-muted">{ex.account_id ?? '—'}</td>
                                                      </tr>
                                                    )
                                                  }) : []),
                                                ]
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                    {covN > 0 && (
                                      <div className="instance-sheet-sub-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Underlying Coverage</h6>
                                        <div className="replay-portfolio-table-wrap">
                                          <table className="table-operations instance-sheet-sub-table">
                                            <thead>
                                              <tr>
                                                <th>Symbol</th>
                                                <th>Account</th>
                                                <th>Cost basis</th>
                                                <th>Avg cost</th>
                                                <th>Live last</th>
                                                <th>Daily ($ / %)</th>
                                                <th>Total ($ / %)</th>
                                                <th>Direction</th>
                                                <th>Required</th>
                                                <th>Held</th>
                                                <th>Status</th>
                                                <th>Surplus / Gap</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {allGroup.stock_coverage.map(sc => {
                                                const acct = (sc.account_id ?? '').trim()
                                                const m = underlyingCoverageStockMetrics(liveStockPositions, sc.symbol, acct)
                                                const held = m.held
                                                const gap = held - sc.required_shares
                                                const statusLabel =
                                                  held >= sc.required_shares
                                                    ? 'Fully Covered'
                                                    : held > 0
                                                      ? `Partial (${held}/${sc.required_shares})`
                                                      : 'Naked'
                                                const statusClass =
                                                  held >= sc.required_shares
                                                    ? 'coverage-status-covered'
                                                    : held > 0
                                                      ? 'coverage-status-partial'
                                                      : 'coverage-status-naked'
                                                const hasStock = m.held !== 0 || m.cost_basis_total != null
                                                return (
                                                  <tr key={`ia-cov-${instKey}-${sc.symbol}-${acct || 'x'}`}>
                                                    <td><strong>{sc.symbol}</strong></td>
                                                    <td>
                                                      <span className="underlying-coverage-account" title="Stock hedge must be in this account (same as options above)">
                                                        {acct || '—'}
                                                      </span>
                                                    </td>
                                                    <td>{fmtUsd(m.cost_basis_total)}</td>
                                                    <td>{fmtUsd(m.avg_cost_per_share)}</td>
                                                    <td>{fmtUsd(m.live_last_price)}</td>
                                                    <td>
                                                      {hasStock ? (
                                                        <>
                                                          <span className={((m.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtUsd(m.daily_pnl)}
                                                          </span>
                                                          {' / '}
                                                          <span className={((m.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtSignedPct(m.daily_pct)}
                                                          </span>
                                                        </>
                                                      ) : (
                                                        '—'
                                                      )}
                                                    </td>
                                                    <td>
                                                      {hasStock ? (
                                                        <>
                                                          <span className={((m.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtUsd(m.total_pnl)}
                                                          </span>
                                                          {' / '}
                                                          <span className={((m.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                                            {fmtSignedPct(m.total_pct)}
                                                          </span>
                                                        </>
                                                      ) : (
                                                        '—'
                                                      )}
                                                    </td>
                                                    <td>{sc.direction === 'long' ? 'Long' : 'Short'}</td>
                                                    <td>{sc.required_shares}</td>
                                                    <td>{held}</td>
                                                    <td>
                                                      <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                                                    </td>
                                                    <td><span className={gap >= 0 ? 'pnl-positive' : 'pnl-negative'}>{fmtSurplusShares(gap)}</span></td>
                                                  </tr>
                                                )
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                    {allGroup.risk_profile && (
                                      <div className="instance-sheet-sub-section risk-profile-section">
                                        <h6 className="replay-sub instance-sheet-sub-heading">Risk Profile</h6>
                                        <RiskProfileDl profile={allGroup.risk_profile} fmtUsd={fmtUsd} />
                                        {allGroup.risk_profile.naked_short_call_contracts > 0 && (
                                          <ul className="risk-hedged-breakdown" style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                                            {formatRiskHedgedBreakdown(allGroup.risk_profile).map((line, i) => (
                                              <li key={i} className="risk-unlimited-warning">{line}</li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>,
                              ] : []),
                            ]
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="replay-opt-tfoot-total">
                            <td colSpan={7} className="replay-opt-tfoot-label">
                              Total ({sortedInstanceAllGroups.length} instance{sortedInstanceAllGroups.length !== 1 ? 's' : ''})
                            </td>
                            <td>
                              <strong>
                                <span className="replay-pnl-unrealized">
                                  {fmtUsd(sortedInstanceAllGroups.reduce((acc, g) => acc + g.options_unrealized_pnl, 0))}
                                </span>
                              </strong>
                            </td>
                            <td colSpan={3} className="replay-muted">
                              —
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                  {stockCoverageItems.length > 0 && (
                    <div className="coverage-summary-section">
                      <h6 className="replay-sub instance-sheet-sub-heading">Stock Coverage Summary</h6>
                      {watchlistOptionableCoverageItems.length > 0 && (
                        <div style={{ marginBottom: '0.75rem' }}>
                          <p className="section-hint" style={{ margin: '0.2rem 0 0.5rem' }}>
                            Watchlist scope symbols (optionable) currently backing opportunities.
                          </p>
                          {renderStockCoverageSummaryTable(watchlistOptionableCoverageItems, 'watchlist-optionable')}
                        </div>
                      )}
                      {watchlistNonOptionableCoverageItems.length > 0 && (
                        <div style={{ marginBottom: '0.75rem' }}>
                          <p className="section-hint" style={{ margin: '0.2rem 0 0.5rem' }}>
                            Watchlist scope symbols that are not optionable (fixed-income-like / independent); separated because they cannot cover option strategies.
                          </p>
                          {renderStockCoverageSummaryTable(watchlistNonOptionableCoverageItems, 'watchlist-non-optionable')}
                        </div>
                      )}
                      {nonWatchlistCoverageItems.length > 0 && (
                        <div>
                          <p className="section-hint" style={{ margin: '0.2rem 0 0.5rem' }}>
                            Symbols backing opportunities from non-watchlist scope.
                          </p>
                          {renderStockCoverageSummaryTable(nonWatchlistCoverageItems, 'non-watchlist')}
                        </div>
                      )}
                    </div>
                  )}
                  {unassignedOptStocks.length > 0 && (
                    <div className="instance-sheet-stock-section">
                      <h5 className="replay-sub instance-sheet-section-heading">Unassigned — Optionable Stocks</h5>
                      <p className="section-hint">These stocks have tradeable options but no active option strategy instance.</p>
                      <div className="replay-portfolio-table-wrap">
                        <table className="table-operations instance-sheet-sub-table">
                          <thead>
                            <tr>
                              <th>Account</th>
                              <th>Symbol</th>
                              <th>Side</th>
                              <th>Qty</th>
                              <th>Avg Cost</th>
                              <th>Mark</th>
                              <th>UN PNL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {unassignedOptStocks.map(position => {
                              const accId = (position.account_id ?? '').trim() || '—'
                              const qty = Number(position.position)
                              const pnl = position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
                                ? Number(position.unrealized_pnl) : null
                              return (
                                <tr key={`unassigned-opt-${accId}-${position.symbol ?? ''}`}>
                                  <td>{accId}</td>
                                  <td><strong>{position.symbol ?? '—'}</strong></td>
                                  <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                                  <td>{Number.isFinite(qty) ? qty : '—'}</td>
                                  <td>{fmtUsd(position.avgCost)}</td>
                                  <td>{fmtUsd(position.price)}</td>
                                  <td><span className={pnl != null ? 'replay-pnl-unrealized' : ''}>{fmtUsd(pnl ?? 0)}</span></td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {independentStocks.length > 0 && (
                    <div className="instance-sheet-stock-section">
                      <h5 className="replay-sub instance-sheet-section-heading">Independent Holdings</h5>
                      <p className="section-hint">Positions without tradeable options (Index, ETF, etc.); not part of any option strategy.</p>
                      <div className="replay-portfolio-table-wrap">
                        <table className="table-operations instance-sheet-sub-table">
                          <thead>
                            <tr>
                              <th>Account</th>
                              <th>Symbol</th>
                              <th>Side</th>
                              <th>Qty</th>
                              <th>Avg Cost</th>
                              <th>Mark</th>
                              <th>UN PNL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {independentStocks.map(position => {
                              const accId = (position.account_id ?? '').trim() || '—'
                              const qty = Number(position.position)
                              const pnl = position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
                                ? Number(position.unrealized_pnl) : null
                              return (
                                <tr key={`independent-${accId}-${position.symbol ?? ''}`}>
                                  <td>{accId}</td>
                                  <td><strong>{position.symbol ?? '—'}</strong></td>
                                  <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                                  <td>{Number.isFinite(qty) ? qty : '—'}</td>
                                  <td>{fmtUsd(position.avgCost)}</td>
                                  <td>{fmtUsd(position.price)}</td>
                                  <td><span className={pnl != null ? 'replay-pnl-unrealized' : ''}>{fmtUsd(pnl ?? 0)}</span></td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ) : openTab === 'options' ? (
                <div
                  id="open-panel-options"
                  role="tabpanel"
                  aria-labelledby="open-tab-options"
                  className="system-tab-panel"
                >
                  <h5 className="replay-sub">Option positions</h5>
                  {allFlatPositions.length === 0 ? (
                    <p className="section-hint">No open option positions under the current filters.</p>
                  ) : (
                <div className="replay-portfolio-table-wrap">
                  <table className="table-operations replay-opt-groups">
                    <thead>
                      <tr>
                        <th className="replay-opt-expand-col" />
                        {(() => {
                          const cols: { col: OpenOptSortCol; label: string; title?: string }[] = [
                            { col: 'contract', label: 'Contract' },
                            { col: 'expiry', label: 'Expiry' },
                            { col: 'strike', label: 'Strike' },
                            { col: 'last', label: 'Last', title: 'Underlying last price; (Last − Strike) / Last %' },
                            { col: 'qty', label: 'Qty' },
                            { col: 'avg_cost', label: '@' },
                            { col: 'value', label: 'Value' },
                            { col: 'time', label: 'Time' },
                            { col: 'un_pnl', label: 'UN PNL' },
                          ]
                          return cols.map(c => (
                            <th
                              key={c.col}
                              className="replay-th-sortable"
                              title={c.title ?? `Sort by ${c.label}`}
                              onClick={() => setOpenOptSort(prev => prev.column === c.col ? { column: c.col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { column: c.col, dir: 'desc' })}
                              role="button"
                              tabIndex={0}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenOptSort(prev => prev.column === c.col ? { column: c.col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { column: c.col, dir: 'desc' }) } }}
                              aria-sort={openOptSort.column === c.col ? (openOptSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                            >
                              {c.label}{openOptSort.column === c.col ? (openOptSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                            </th>
                          ))
                        })()}
                        <th>Pool</th>
                        <th>Account</th>
                        <th>Opportunity</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedInstanceGroups.map(instGroup => {
                        const instKey = instGroup.strategy_instance_id != null ? String(instGroup.strategy_instance_id) : '__unassigned__'
                        const instLabel = instGroup.strategy_instance_label ?? (instGroup.strategy_instance_id != null ? `Instance #${instGroup.strategy_instance_id}` : 'Unassigned')
                        const oppName = instGroup.strategy_opportunity_name?.trim() || null
                        const openedAt = instGroup.strategy_instance_opened_at_epoch
                        const colCount = 14
                        return [
                          <tr key={`inst-header-${instKey}`} className="replay-portfolio-group-header replay-opt-group-row">
                            <td colSpan={colCount - 1}>
                              <span className="replay-instance-header-content">
                                {instGroup.strategy_instance_id != null ? (
                                  <a
                                    href={`#/strategies/instances/${instGroup.strategy_instance_id}`}
                                    className="ledger-instance-icon-link"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`View instance: ${instLabel}`}
                                  >
                                    <strong>{instLabel}</strong>
                                  </a>
                                ) : (
                                  <strong>{instLabel}</strong>
                                )}
                                {oppName && <span className="replay-muted" style={{ marginLeft: '0.75rem' }}>Opportunity Strategy: {oppName}</span>}
                                {openedAt != null && Number.isFinite(openedAt) && (
                                  <span className="replay-muted" style={{ marginLeft: '0.75rem' }}>
                                    Instance Opened at: {fmtDate(openedAt)}{fmtDaysAgo(openedAt) ? ` (${fmtDaysAgo(openedAt)})` : ''}
                                  </span>
                                )}
                                <span className="replay-muted" style={{ marginLeft: '0.75rem' }}>
                                  {instGroup.positions.length} position{instGroup.positions.length !== 1 ? 's' : ''}
                                </span>
                              </span>
                            </td>
                            <td>
                              <span className="replay-pnl-unrealized">{fmtUsd(instGroup.total_unrealized_pnl)}</span>
                            </td>
                          </tr>,
                          ...instGroup.positions.flatMap((pos) => {
                            const posKey = getPositionKey(pos, instGroup.strategy_instance_id)
                            const absQty = Math.abs(pos.qty)
                            const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                            const value = (pos.avg_cost ?? 0) * absQty * 100
                            const ts = getPositionTime(pos)
                            const matchedExecs = pos.kind === 'live' && pos.position
                              ? (livePositionExecutionsMap.get(optExecutionMatchKey(pos.account_id, pos.contract_key)) ?? [])
                              : (pos.kind === 'offtrack' ? pos.trades ?? [] : [])
                            const hasExecutions = matchedExecs.length > 0
                            const isPosExpanded = expandedPositionKeys.includes(posKey)
                            const posRow = (
                              <tr
                                key={posKey}
                                className="detail-position-row"
                                onClick={hasExecutions ? () => togglePositionExpand(posKey) : undefined}
                                role={hasExecutions ? 'button' : undefined}
                                tabIndex={hasExecutions ? 0 : undefined}
                                onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePositionExpand(posKey) } } : undefined}
                                aria-expanded={hasExecutions ? isPosExpanded : undefined}
                              >
                                <td className="replay-opt-expand-col">
                                  {hasExecutions ? (
                                    <span className={`replay-opt-expand-icon ${isPosExpanded ? 'expanded' : ''}`} aria-hidden>
                                      {isPosExpanded ? '▼' : '▶'}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="replay-opt-contract">
                                  {(() => {
                                    const p = getContractLabelParts(pos.contract_key)
                                    const strikeStr = pos.strike != null ? ` ${pos.strike}` : ''
                                    return p.symbol ? (<><strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}</>) : pos.contract_key
                                  })()}
                                </td>
                                <td>
                                  {fmtExpiry(pos.expiry)}
                                  {(() => {
                                    const days = daysUntilExpiry(pos.expiry)
                                    if (days == null) return null
                                    const label = days >= 0 ? (days === 0 ? ' today' : ` ${days}d`) : ` ${-days}d ago`
                                    return <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                                  })()}
                                </td>
                                <td><strong>{fmtUsd(pos.strike)}</strong></td>
                                <td>
                                  {(() => {
                                    const underlying = getContractLabelParts(pos.contract_key).symbol
                                    const q = underlying ? quotesMap[underlying] : undefined
                                    const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                    const strikeNum = pos.strike != null && Number.isFinite(pos.strike) ? pos.strike : null
                                    const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                    const right = parseOptionContractKey(pos.contract_key).right
                                    const side: 'Buy' | 'Sell' = pos.qty > 0 ? 'Buy' : 'Sell'
                                    const pctClass = pct != null ? optionLastStrikePctClass(right, side, pct) : ''
                                    return (
                                      <>
                                        {last != null ? fmtUsd(last) : '—'}
                                        {pct != null && <span className={`replay-last-strike-pct ${pctClass}`.trim()} title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}> {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>}
                                      </>
                                    )
                                  })()}
                                </td>
                                <td>{sideLabel} {absQty}</td>
                                <td>{fmtUsd(pos.avg_cost)}</td>
                                <td>{fmtUsd(value)}</td>
                                <td>
                                  {ts != null ? (
                                    <>{fmtDate(ts)}{fmtDaysAgo(ts) ? <span className="replay-time-ago"> {fmtDaysAgo(ts)}</span> : null}</>
                                  ) : '—'}
                                </td>
                                <td><span className="replay-pnl-unrealized">{fmtUsd(pos.unrealized_pnl)}</span></td>
                                <td className="replay-muted">{pos.pool_label}</td>
                                <td>{pos.account_id || '—'}</td>
                                <td className="replay-strategy-opp-cell">
                                  {matchedExecs.length === 0 ? '—' : (
                                    <span className="replay-muted">{matchedExecs.length} execution{matchedExecs.length > 1 ? 's' : ''} ↓</span>
                                  )}
                                </td>
                                <td>—</td>
                              </tr>
                            )
                            const execRows = isPosExpanded ? matchedExecs.map((ex, ei) => {
                              const es = (ex.side ?? '').toUpperCase()
                              const eSideLabel = es === 'BUY' || es === 'BOT' || es === 'B' ? 'Buy' : es === 'SELL' || es === 'SLD' || es === 'S' ? 'Sell' : (ex.side ?? '—')
                              const eQty = Math.abs(Number(ex.quantity) || 0)
                              const ePrice = Number(ex.price) || 0
                              const eComm = Number(ex.commission) || 0
                              const eTs = ex.time != null ? Number(ex.time) : null
                              const isOffTrack = pos.kind === 'offtrack'
                              return (
                                <tr key={`${posKey}-exec-${ex.account_executions_id ?? ei}`} className="detail-execution-row">
                                  <td className="replay-opt-expand-col" />
                                  <td className="detail-exec-indent replay-muted">↳ exec #{ex.account_executions_id ?? '?'}</td>
                                  <td className="replay-muted">{ex.source ?? '—'}</td>
                                  <td />
                                  <td />
                                  <td>{eSideLabel} {eQty || '—'}</td>
                                  <td>{fmtUsd(ePrice)}</td>
                                  <td />
                                  <td>{eTs != null && Number.isFinite(eTs) ? <>{fmtDate(eTs)}{fmtDaysAgo(eTs) ? <span className="replay-time-ago"> {fmtDaysAgo(eTs)}</span> : null}</> : '—'}</td>
                                  <td>{eComm ? fmtUsd(eComm) : '—'}</td>
                                  <td className="replay-muted" />
                                  <td className="replay-muted">{ex.account_id ?? '—'}</td>
                                  <StrategyAttributionCells ex={ex} />
                                  <td>
                                    <span className="replay-exec-row-actions">
                                      <button type="button" className="btn btn-icon-small" onClick={e => { e.stopPropagation(); setEditExec(ex); setPageError(null) }} title="Edit" aria-label="Edit execution">
                                        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                      </button>
                                      {ex.account_executions_id != null ? (
                                        <LinkStrategyIconButton title="Assign strategy opportunity and instance" onClick={() => { setLinkContext({ account_executions_id: ex.account_executions_id!, execution: ex }); setLinkModalOpen(true); setPageError(null) }} />
                                      ) : null}
                                      {isOffTrack ? (
                                        <button type="button" className="btn btn-small" onClick={e => { e.stopPropagation(); setCloseAgainstExec(ex); setPageError(null) }}>Close</button>
                                      ) : null}
                                      <button type="button" className="btn btn-icon-small btn-icon-danger" onClick={e => { e.stopPropagation(); setPageError(null); setDeleteConfirmState({ open: true, title: 'Delete execution', message: 'This will permanently remove this execution from trade history. This cannot be undone.', confirming: false, exec: ex }) }} title="Delete" aria-label="Delete execution">
                                        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                                      </button>
                                    </span>
                                  </td>
                                </tr>
                              )
                            }) : []
                            return [posRow, ...execRows]
                          }),
                        ]
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="replay-opt-tfoot-total">
                        <td colSpan={13} className="replay-opt-tfoot-label">Total</td>
                        <td>
                          <span className="replay-pnl-unrealized">
                            {fmtUsd(instanceGroups.reduce((acc, g) => acc + g.total_unrealized_pnl, 0))}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
                </div>
              ) : (
                <div
                  id="open-panel-stocks"
                  role="tabpanel"
                  aria-labelledby="open-tab-stocks"
                  className="system-tab-panel"
                >
                  <h5 className="replay-sub">Stock positions</h5>
                  {liveStockPositions.length === 0 ? (
                    <p className="section-hint">No open stock positions under the current filters.</p>
                  ) : (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Account</th>
                            <th>Symbol</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Avg Cost</th>
                            <th>Mark</th>
                            <th>UN PNL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const byAccount: Record<string, typeof liveStockPositions> = {}
                            for (const position of liveStockPositions) {
                              const accId = (position.account_id ?? '').trim() || '—'
                              if (!byAccount[accId]) byAccount[accId] = []
                              byAccount[accId].push(position)
                            }
                            const accountIds = Object.keys(byAccount).sort()
                            const rows: JSX.Element[] = []
                            for (const accId of accountIds) {
                              rows.push(
                                <tr key={`open-stk-header-${accId}`} className="replay-portfolio-group-header">
                                  <td colSpan={7}>
                                    <strong>{accId}</strong>
                                  </td>
                                </tr>,
                              )
                              for (const position of byAccount[accId]) {
                                const qty = Number(position.position)
                                const pnl = position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
                                  ? Number(position.unrealized_pnl)
                                  : null
                                const pnlClass = pnl == null ? '' : 'replay-pnl-unrealized'
                                const contractKey = position.contract_key ?? `${position.symbol ?? ''}|STK|||`
                                rows.push(
                                  <tr key={`open-stk-${accId}-${position.symbol ?? ''}-${contractKey}`}>
                                    <td>{accId}</td>
                                    <td><strong>{position.symbol ?? '—'}</strong></td>
                                    <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                                    <td>{Number.isFinite(qty) ? qty : '—'}</td>
                                    <td>{fmtUsd(position.avgCost)}</td>
                                    <td>{fmtUsd(position.price)}</td>
                                    <td><span className={pnlClass}>{fmtUsd(pnl ?? 0)}</span></td>
                                  </tr>,
                                )
                              }
                            }
                            return rows
                          })()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>


      {pageError && (
        <p className="section-hint replay-form-error" style={{ marginTop: '0.5rem' }}>{pageError}</p>
      )}
      <ExecutionFormModal
        open={addExecOpen || !!editExec}
        editExec={editExec}
        accountOptions={executionAccountOptions}
        initialDraft={null}
        onClose={() => {
          setAddExecOpen(false)
          setEditExec(null)
          setPageError(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
        }}
      />
      <LinkExecutionRecordModal
        open={linkModalOpen}
        context={linkContext}
        onClose={() => {
          setLinkModalOpen(false)
          setLinkContext(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
        }}
      />
      {deleteConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="positions-delete-exec-title"
          onClick={() => {
            if (!deleteConfirmState.confirming) {
              setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
            }
          }}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="positions-delete-exec-title" className="section-subtitle" style={{ marginTop: 0 }}>
              {deleteConfirmState.title}
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              {deleteConfirmState.message}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))}
                disabled={deleteConfirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={async () => {
                  const exec = deleteConfirmState.exec
                  if (!exec?.account_executions_id) {
                    setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
                    return
                  }
                  setDeleteConfirmState(prev => ({ ...prev, confirming: true }))
                  const res = await deleteExecution(exec.account_executions_id)
                  if (res.ok) {
                    if (editExec?.account_executions_id === exec.account_executions_id) setEditExec(null)
                    await loadReplayData()
                  } else {
                    setPageError(res.error ?? 'Delete failed')
                  }
                  setDeleteConfirmState({ open: false, title: '', message: '', confirming: false, exec: null })
                }}
                disabled={deleteConfirmState.confirming}
              >
                {deleteConfirmState.confirming ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      <QuickCloseModal
        exec={closeAgainstExec}
        onClose={() => setCloseAgainstExec(null)}
        onSuccess={() => loadReplayData()}
      />
    </div>
  )
}

