import { useEffect, useMemo, useState } from 'react'
import type { Execution, RealtimeQuote, StatusResponse } from '../types'
import { deleteExecution, fetchQuotes, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
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
import { buildOptExecutionGroups } from './portfolio/buildOptExecutionGroups'
import { ExecutionFormModal } from './portfolio/ExecutionFormModal'
import type { LinkExecutionContext } from './portfolio/LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './portfolio/LinkExecutionRecordModal'
import type { LinkPositionContext } from './portfolio/LinkPositionModal'
import { LinkPositionModal } from './portfolio/LinkPositionModal'
import { QuickCloseModal } from './portfolio/QuickCloseModal'
import type { InstancePositionGroup, LivePositionRow, OpenOptionPosition, PortfolioView } from './portfolio/types'
import { OFF_TRACK_ACCOUNT_ID, useExecutions } from './portfolio/useExecutions'

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
  const [linkPositionModalOpen, setLinkPositionModalOpen] = useState(false)
  const [linkPositionContext, setLinkPositionContext] = useState<LinkPositionContext | null>(null)
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

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterPool, setOpenFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [openFilterAccountId, setOpenFilterAccountId] = useState<string>('all')
  const [openTab, setOpenTab] = useState<'options' | 'stocks'>('options')
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

  const openFilterAccountOptions = useMemo(() => {
    const accounts = (status?.accounts ?? []).map(a => (a.account_id ?? '').trim()).filter(Boolean)
    const unique = Array.from(new Set(accounts))
    unique.sort()
    return unique
  }, [status?.accounts])

  const hasOpenOptions = allFlatPositions.length > 0
  const hasOpenStocks = liveStockPositions.length > 0
  useEffect(() => {
    if (openTab === 'options' && !hasOpenOptions && hasOpenStocks) {
      setOpenTab('stocks')
      return
    }
    if (openTab === 'stocks' && !hasOpenStocks && hasOpenOptions) {
      setOpenTab('options')
    }
  }, [openTab, hasOpenOptions, hasOpenStocks])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

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
                    {openTab === 'options'
                      ? 'Open option positions by contract; expand a row to see Details and Add/Edit/Close trades.'
                      : 'Open stock positions from account snapshots (Live only). Link stock to strategy instance (e.g. Covered Call underlying).'}
                  </p>
                </div>
              </div>
              {openTab === 'options' ? (
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
                            <th>Opportunity</th>
                            <th>Actions</th>
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
                                  <td colSpan={9}>
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
                                const instId = position.strategy_instance_id
                                const instLabel = position.strategy_instance_label?.trim()
                                const oppName = position.strategy_opportunity_name?.trim()
                                const contractKey = position.contract_key ?? `${position.symbol ?? ''}|STK|||`
                                const instanceTitle = instLabel ? `Instance: ${instLabel}` : instId != null ? `View instance #${instId}` : ''
                                rows.push(
                                  <tr key={`open-stk-${accId}-${position.symbol ?? ''}-${contractKey}`}>
                                    <td>{accId}</td>
                                    <td><strong>{position.symbol ?? '—'}</strong></td>
                                    <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                                    <td>{Number.isFinite(qty) ? qty : '—'}</td>
                                    <td>{fmtUsd(position.avgCost)}</td>
                                    <td>{fmtUsd(position.price)}</td>
                                    <td><span className={pnlClass}>{fmtUsd(pnl ?? 0)}</span></td>
                                    <td className="replay-strategy-opp-cell" title={[instanceTitle, oppName].filter(Boolean).join(' · ') || undefined}>
                                      <span className="replay-strategy-opp-cell-inner">
                                        {instId != null ? (
                                          <a href={`#/strategies/instances/${instId}`} className="ledger-instance-icon-link" target="_blank" rel="noopener noreferrer" title={instanceTitle} aria-label={instanceTitle || 'View strategy instance'} onClick={e => e.stopPropagation()}>
                                            <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
                                          </a>
                                        ) : null}
                                        <span className="replay-strategy-opp-text">{oppName || '—'}</span>
                                      </span>
                                    </td>
                                    <td>
                                      <LinkStrategyIconButton title="Link to strategy instance (e.g. Covered Call underlying)" onClick={() => { setLinkPositionContext({ account_id: (position.account_id ?? accId).trim() || accId, contract_key: contractKey, symbol: position.symbol ?? undefined, strategy_opportunity_id: position.strategy_opportunity_id ?? null, strategy_instance_id: position.strategy_instance_id ?? null, position: qty, avgCost: position.avgCost, price: position.price }); setLinkPositionModalOpen(true); setPageError(null) }} />
                                    </td>
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
      <LinkPositionModal
        open={linkPositionModalOpen}
        context={linkPositionContext}
        onClose={() => {
          setLinkPositionModalOpen(false)
          setLinkPositionContext(null)
        }}
        onSuccess={async () => {
          setPageError(null)
          await loadReplayData()
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

