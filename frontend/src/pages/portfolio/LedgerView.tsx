import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Execution, OptExecutionGroup, StatusResponse } from '../../types'
import type { StrategyOpportunity } from '../../api'
import type { StrategyInstance } from '../../types'
import { deleteExecution, fetchOpportunities, fetchStrategyInstances } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  fmtExpiry,
  fmtTradeDate,
  fmtTs,
  fmtUsd,
  fmtUsd0,
  getContractLabelParts,
} from '../../utils/format'
import { buildOptExecutionGroups, isOptionExpired } from './buildOptExecutionGroups'
import { ExecutionFormModal } from './ExecutionFormModal'
import { ExpiredCloseModal } from './ExpiredCloseModal'
import type { LinkExecutionContext } from './LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './LinkExecutionRecordModal'
import type { PortfolioView } from './types'
import { useExecutions } from './useExecutions'

export interface LedgerViewProps {
  status: StatusResponse | null
  onViewChange: (view: PortfolioView) => void
}

function getOptGroupKey(g: OptExecutionGroup): string {
  return `${g.contract_key}-${g.strike}-${g.expiry}`
}

type InstanceConsistencyState = 'same' | 'mixed' | 'different' | 'none'

function getInstanceConsistencyState(trades: Execution[]): InstanceConsistencyState {
  if (trades.length === 0) return 'none'
  const instanceIds = trades
    .map(t => t.strategy_instance_id)
    .filter((id): id is number => id != null && Number.isFinite(id))
  const hasAnyInstance = instanceIds.length > 0
  const allHaveInstance = trades.every(
    t => t.strategy_instance_id != null && Number.isFinite(t.strategy_instance_id),
  )
  if (!hasAnyInstance) return 'none'
  if (!allHaveInstance) return 'mixed'
  return new Set(instanceIds).size === 1 ? 'same' : 'different'
}

function getAggregatedInstanceConsistencyState(trades: Execution[]): InstanceConsistencyState {
  if (trades.length === 0) return 'none'
  const byAccount = new Map<string, Execution[]>()
  for (const t of trades) {
    const accountId = (t.account_id ?? '').trim() || '__NO_ACCOUNT__'
    if (!byAccount.has(accountId)) byAccount.set(accountId, [])
    byAccount.get(accountId)!.push(t)
  }
  const states = Array.from(byAccount.values(), accountTrades =>
    getInstanceConsistencyState(accountTrades),
  )
  if (states.every(s => s === 'none')) return 'none'
  if (states.some(s => s === 'different')) return 'different'
  if (states.some(s => s === 'mixed')) return 'mixed'
  if (states.some(s => s === 'none')) return 'mixed'
  if (states.every(s => s === 'same')) return 'same'
  return 'none'
}

function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className="btn btn-icon-small"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </button>
  )
}

export function LedgerView({ status, onViewChange: _onViewChange }: LedgerViewProps) {
  const [ledgerFilterStrategyOpportunityId, setLedgerFilterStrategyOpportunityId] = useState<number | ''>('')
  const [ledgerFilterStrategyInstanceId, setLedgerFilterStrategyInstanceId] = useState<number | ''>('')
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])

  const strategyFilters = useMemo(
    () => ({
      strategy_opportunity_id: ledgerFilterStrategyOpportunityId === '' ? undefined : ledgerFilterStrategyOpportunityId,
      strategy_instance_id: ledgerFilterStrategyInstanceId === '' ? undefined : ledgerFilterStrategyInstanceId,
    }),
    [ledgerFilterStrategyOpportunityId, ledgerFilterStrategyInstanceId],
  )
  const { executions, loadReplayData, executionAccountOptions } = useExecutions(status, strategyFilters)

  useEffect(() => {
    fetchOpportunities(true)
      .then(r => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])
  const oppIdNum = ledgerFilterStrategyOpportunityId === '' ? null : Number(ledgerFilterStrategyOpportunityId)
  useEffect(() => {
    if (oppIdNum == null || !Number.isFinite(oppIdNum)) {
      setInstances([])
      return
    }
    fetchStrategyInstances({ strategy_opportunity_id: oppIdNum })
      .then(r => setInstances(r.items ?? []))
      .catch(() => setInstances([]))
  }, [oppIdNum])

  const [ledgerFilterSymbol, setLedgerFilterSymbol] = useState('')
  const [ledgerFilterExpiryStart, setLedgerFilterExpiryStart] = useState('')
  const [ledgerFilterAccount, setLedgerFilterAccount] = useState<string>('')
  const [ledgerTab, setLedgerTab] = useState<'options' | 'stocks'>('options')
  const [ledgerAccordionMode, setLedgerAccordionMode] = useState<boolean>(false)
  const [ledgerStockGroupByPosition, setLedgerStockGroupByPosition] = useState<boolean>(false)
  const [ledgerStockCategoryTab, setLedgerStockCategoryTab] = useState<string>('All')
  const [ledgerOptSort, setLedgerOptSort] = useState<{
    column: 'expiry' | 'trade_date'
    dir: 'asc' | 'desc'
  }>({ column: 'expiry', dir: 'desc' })
  const [ledgerStockSort, setLedgerStockSort] = useState<{
    column: 'trade_date'
    dir: 'asc' | 'desc'
  }>({ column: 'trade_date', dir: 'desc' })
  const [expandedDetailKeys, setExpandedDetailKeys] = useState<string[]>([])
  const [addExecOpen, setAddExecOpen] = useState(false)
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkContext, setLinkContext] = useState<LinkExecutionContext | null>(null)
  const [expiredCloseKey, setExpiredCloseKey] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    exec: Execution | null
  }>({ open: false, title: '', message: '', confirming: false, exec: null })

  const toggleDetailExpand = useCallback(
    (key: string) => {
      setExpandedDetailKeys(prev => {
        const isOpen = prev.includes(key)
        if (ledgerAccordionMode) {
          return isOpen ? [] : [key]
        }
        return isOpen ? prev.filter(k => k !== key) : [...prev, key]
      })
    },
    [ledgerAccordionMode],
  )

  /** (account_id, contract_key) -> category name for STK positions */
  const positionCategoryByAccountContract = useMemo(() => {
    const map = new Map<string, string>()
    const accounts = status?.accounts ?? []
    for (const acc of accounts) {
      const accountId = (acc.account_id ?? '').trim()
      const positions =
        (acc as { positions?: { account_id?: string; contract_key?: string; category?: string }[] })
          .positions ?? []
      for (const p of positions) {
        const ck = (p.contract_key ?? '').trim()
        if (accountId && ck) {
          const key = `${accountId}|${ck}`
          const name = (p as { category?: string }).category
          if (typeof name === 'string' && name.trim()) map.set(key, name.trim())
        }
      }
    }
    return map
  }, [status?.accounts])

  /** STK contract_key for lookup: symbol|STK||| */
  const stkContractKey = useCallback(
    (sym: string, accId: string) =>
      `${(accId ?? '').trim()}|${(sym ?? '').toString().trim().toUpperCase()}|STK|||`,
    [],
  )

  const getStockExecCategory = useCallback(
    (ex: Execution) =>
      positionCategoryByAccountContract.get(
        stkContractKey(ex.symbol ?? '', ex.account_id ?? ''),
      ) ?? '—',
    [positionCategoryByAccountContract, stkContractKey],
  )

  const ledgerBaseFilteredExecutions = useMemo(() => {
    let list = [...(executions || [])]
    const sym = ledgerFilterSymbol.trim().toUpperCase()
    if (sym) {
      list = list.filter(e => {
        const directSymbol = (e.symbol || '').toUpperCase().trim()
        if (directSymbol === sym || directSymbol.startsWith(sym)) return true
        const ck = (e.contract_key ?? '').trim()
        if (!ck) return false
        const partSymbol = getContractLabelParts(ck).symbol.toUpperCase().trim()
        if (!partSymbol) return false
        return partSymbol === sym || partSymbol.startsWith(sym)
      })
    }
    const expMonth = ledgerFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }
    return list
  }, [executions, ledgerFilterSymbol, ledgerFilterExpiryStart])

  const filteredExecutions = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutions]
    const acc = ledgerFilterAccount.trim()
    if (acc && acc !== 'All') list = list.filter(e => (e.account_id ?? '').trim() === acc)
    return list
  }, [ledgerBaseFilteredExecutions, ledgerFilterAccount])

  const optExecutionGroups = useMemo(
    (): OptExecutionGroup[] => buildOptExecutionGroups(filteredExecutions),
    [filteredExecutions],
  )

  const closedOptionGroups = useMemo(
    () => optExecutionGroups.filter(group => group.status === 'realized'),
    [optExecutionGroups],
  )

  const sortedClosedOptionGroups = useMemo(() => {
    const list = [...closedOptionGroups]
    const { column, dir } = ledgerOptSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'expiry') {
        const sa = (a.expiry ?? '').trim().replace(/-/g, '')
        const sb = (b.expiry ?? '').trim().replace(/-/g, '')
        return mult * sa.localeCompare(sb, undefined, { numeric: true })
      }
      const datesA = [
        ...(a.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const datesB = [
        ...(b.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const va = datesA.length > 0 ? datesA[0] : ''
      const vb = datesB.length > 0 ? datesB[0] : ''
      return mult * va.localeCompare(vb)
    })
    return list
  }, [closedOptionGroups, ledgerOptSort])

  const expiredUnrealizedOptionGroups = useMemo(
    () =>
      optExecutionGroups.filter(
        group => group.status === 'unrealized' && isOptionExpired(group.expiry),
      ),
    [optExecutionGroups],
  )

  const expiredCloseGroup =
    expiredCloseKey != null
      ? expiredUnrealizedOptionGroups.find(g => getOptGroupKey(g) === expiredCloseKey) ?? null
      : null

  const closedOptGroupsPnlSum = useMemo(
    () => closedOptionGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0),
    [closedOptionGroups],
  )

  /** Details sheet: sum of per-trade PnL for expanded rows only (same formula as table). */
  const ledgerDetailsTotalPnl = useMemo(() => {
    const expanded = sortedClosedOptionGroups.filter(g =>
      expandedDetailKeys.includes(getOptGroupKey(g)),
    )
    let sum = 0
    for (const g of expanded) {
      for (const ex of g.trades ?? []) {
        const s = (ex.side ?? '').toUpperCase()
        const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
        const q = Number(ex.quantity) || 0
        const p = Number(ex.price) || 0
        const c = Number(ex.commission) || 0
        const value = q * p * 100 - c
        sum += isBuy ? -value : value
      }
    }
    return sum
  }, [sortedClosedOptionGroups, expandedDetailKeys])

  const ledgerStockCategoryTabs = useMemo(() => {
    const stockExecs = (executions ?? []).filter(
      ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT',
    )
    const set = new Set<string>()
    for (const ex of stockExecs) {
      const cat = positionCategoryByAccountContract.get(
        stkContractKey(ex.symbol ?? '', ex.account_id ?? ''),
      )
      if (typeof cat === 'string' && cat.trim()) set.add(cat.trim())
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b))
    return ['All', ...list, 'Uncategorized']
  }, [executions, positionCategoryByAccountContract, stkContractKey])

  const ledgerOptionsSummaryByMonth = useMemo(() => {
    const byMonth = new Map<string, { count: number; realizedPnl: number }>()
    for (const g of closedOptionGroups) {
      const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
      const ts = times.length > 0 ? Math.max(...times) : 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, realizedPnl: 0 }
      cur.count += 1
      cur.realizedPnl += Number(g.realized_pnl) || 0
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [closedOptionGroups])

  const ledgerStocksSummaryByMonth = useMemo(() => {
    let stockExecs = filteredExecutions.filter(
      ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT',
    )
    if (ledgerStockCategoryTab !== 'All') {
      stockExecs =
        ledgerStockCategoryTab === 'Uncategorized'
          ? stockExecs.filter(ex => getStockExecCategory(ex) === '—')
          : stockExecs.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
    }
    const byMonth = new Map<string, { count: number; notional: number }>()
    for (const ex of stockExecs) {
      const ts = ex.time ?? 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, notional: 0 }
      cur.count += 1
      const q = Number(ex.quantity) || 0
      const p = Number(ex.price) || 0
      cur.notional += Math.abs(q) * p
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [filteredExecutions, ledgerStockCategoryTab, getStockExecCategory])

  const hasOptionExecutions =
    closedOptionGroups.length > 0 || expiredUnrealizedOptionGroups.length > 0
  const hasStockExecutions = useMemo(
    () => filteredExecutions.some(e => (e.sec_type ?? '').toUpperCase() !== 'OPT'),
    [filteredExecutions],
  )

  const sortedStockExecutions = useMemo(() => {
    let list = filteredExecutions.filter(
      ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT',
    )
    if (ledgerStockCategoryTab !== 'All') {
      list =
        ledgerStockCategoryTab === 'Uncategorized'
          ? list.filter(ex => getStockExecCategory(ex) === '—')
          : list.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
    }
    const { dir } = ledgerStockSort
    const mult = dir === 'asc' ? 1 : -1
    list = [...list].sort((a, b) => {
      const va = (a.trade_date ?? '').trim()
      const vb = (b.trade_date ?? '').trim()
      return mult * va.localeCompare(vb)
    })
    return list
  }, [filteredExecutions, ledgerStockCategoryTab, ledgerStockSort, getStockExecCategory])

  useEffect(() => {
    if (ledgerTab === 'options' && !hasOptionExecutions && hasStockExecutions) {
      setLedgerTab('stocks')
      return
    }
    if (ledgerTab === 'stocks' && !hasStockExecutions && hasOptionExecutions) {
      setLedgerTab('options')
    }
  }, [ledgerTab, hasOptionExecutions, hasStockExecutions])

  useEffect(() => {
    if (ledgerTab !== 'stocks') return
    if (!ledgerStockCategoryTabs.includes(ledgerStockCategoryTab)) {
      setLedgerStockCategoryTab('All')
    }
  }, [ledgerTab, ledgerStockCategoryTab, ledgerStockCategoryTabs])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '0.5rem',
        }}
      >
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
      <section
        className="replay-section replay-section-trade-records"
        aria-label="Trade History"
      >
        <div className="replay-filters replay-filters--bar">
          <label className="replay-filter-wrap-symbol">
            <input
              type="text"
              placeholder="e.g. NV → NVDA"
              value={ledgerFilterSymbol}
              onChange={e => setLedgerFilterSymbol(e.target.value)}
              className="replay-filter-input replay-filter-input--symbol"
              aria-label="Symbol filter"
            />
          </label>
          <label className="replay-filter-label-month">
            <span className="replay-filter-label">Exp</span>
            <input
              type="month"
              value={ledgerFilterExpiryStart}
              onChange={e => setLedgerFilterExpiryStart(e.target.value)}
              className="replay-filter-input replay-filter-date"
              title="Expiry month"
            />
          </label>
          <div className="ib-accounts-tabs" role="group" aria-label="Account filter">
            <button
              type="button"
              className={`ib-accounts-tab ${!ledgerFilterAccount || ledgerFilterAccount === 'All' ? 'active' : ''}`}
              onClick={() => setLedgerFilterAccount('')}
            >
              All
            </button>
            {executionAccountOptions.map(accId => (
              <button
                key={accId}
                type="button"
                className={`ib-accounts-tab ${ledgerFilterAccount === accId ? 'active' : ''}`}
                onClick={() => setLedgerFilterAccount(accId)}
              >
                {accId}
              </button>
            ))}
          </div>
          <label className="replay-filter-label-strategy" title="Strategy (opportunity)">
            <span className="replay-filter-label">Strategy</span>
            <select
              value={ledgerFilterStrategyOpportunityId === '' ? '' : String(ledgerFilterStrategyOpportunityId)}
              onChange={e => {
                const v = e.target.value
                setLedgerFilterStrategyOpportunityId(v === '' ? '' : Number(v))
                setLedgerFilterStrategyInstanceId('')
              }}
              className="replay-filter-input replay-filter-select"
              aria-label="Strategy filter"
            >
              <option value="">All</option>
              {opportunities.map(o => (
                <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                  {o.name ?? `#${o.strategy_opportunity_id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="replay-filter-label-instance" title="Instance">
            <span className="replay-filter-label">Instance</span>
            <select
              value={ledgerFilterStrategyInstanceId === '' ? '' : String(ledgerFilterStrategyInstanceId)}
              onChange={e => {
                const v = e.target.value
                setLedgerFilterStrategyInstanceId(v === '' ? '' : Number(v))
              }}
              className="replay-filter-input replay-filter-select"
              aria-label="Instance filter"
              disabled={ledgerFilterStrategyOpportunityId === ''}
            >
              <option value="">All</option>
              {instances.map(si => (
                <option key={si.strategy_instance_id} value={String(si.strategy_instance_id)}>
                  {si.label?.trim() || `#${si.strategy_instance_id}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="replay-portfolio-block">
          <div className="replay-portfolio-header">
            <div className="replay-portfolio-tabs-wrap">
              <div
                className="system-tabs replay-portfolio-tabs"
                role="tablist"
                aria-label="Closed trade asset sections"
              >
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-options"
                  aria-selected={ledgerTab === 'options'}
                  aria-controls="replay-panel-options"
                  className={`system-tab ${ledgerTab === 'options' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('options')}
                  disabled={!hasOptionExecutions}
                >
                  Options
                </button>
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-stocks"
                  aria-selected={ledgerTab === 'stocks'}
                  aria-controls="replay-panel-stocks"
                  className={`system-tab ${ledgerTab === 'stocks' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('stocks')}
                  disabled={!hasStockExecutions}
                >
                  Stocks
                </button>
              </div>
            </div>
            <div className="replay-portfolio-filters">
              {ledgerTab === 'options' && (
                <div
                  className="replay-fetch-range-group"
                  role="radiogroup"
                  aria-label="Detail view mode"
                >
                  <span className="replay-fetch-days-label">Detail view</span>
                  <InfoTooltip text="Completed option trades are grouped by contract and strike so the page reads like a closed-trade ledger." />
                  <label className="replay-fetch-radio">
                    <input
                      type="radio"
                      name="replay-detail-view"
                      value="accordion"
                      checked={ledgerAccordionMode}
                      onChange={() => setLedgerAccordionMode(true)}
                    />
                    <span>Accordion</span>
                  </label>
                  <label className="replay-fetch-radio">
                    <input
                      type="radio"
                      name="replay-detail-view"
                      value="multi"
                      checked={!ledgerAccordionMode}
                      onChange={() => setLedgerAccordionMode(false)}
                    />
                    <span>Multi</span>
                  </label>
                </div>
              )}
              {ledgerTab === 'stocks' && (
                <>
                  <div
                    className="system-tabs replay-stock-group-tabs"
                    role="tablist"
                    aria-label="Stock view mode"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!ledgerStockGroupByPosition}
                      className={`system-tab ${!ledgerStockGroupByPosition ? 'active' : ''}`}
                      onClick={() => setLedgerStockGroupByPosition(false)}
                    >
                      Flat
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={ledgerStockGroupByPosition}
                      className={`system-tab ${ledgerStockGroupByPosition ? 'active' : ''}`}
                      onClick={() => setLedgerStockGroupByPosition(true)}
                    >
                      Position
                    </button>
                  </div>
                  <div
                    className="system-tabs replay-stock-category-tabs"
                    role="tablist"
                    aria-label="Position category filter"
                  >
                    {ledgerStockCategoryTabs.map(cat => (
                      <button
                        key={cat}
                        type="button"
                        role="tab"
                        aria-selected={ledgerStockCategoryTab === cat}
                        className={`system-tab ${ledgerStockCategoryTab === cat ? 'active' : ''}`}
                        onClick={() => setLedgerStockCategoryTab(cat)}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {filteredExecutions.length === 0 ? (
            <p className="section-hint">
              No execution data. Use Overview to fetch from IB (Refresh), or Positions to add manual
              history (Add Trade).
              {[ledgerFilterSymbol, ledgerFilterExpiryStart].some(Boolean) ||
              (ledgerFilterAccount && ledgerFilterAccount !== 'All') ||
              ledgerFilterStrategyOpportunityId !== '' ||
              ledgerFilterStrategyInstanceId !== ''
                ? ' Filters applied.'
                : ''}
            </p>
          ) : (
            <>
              <section
                className="replay-ledger-summary"
                aria-label="Summary by month"
              >
                {ledgerTab === 'options' ? (
                  <>
                    <span className="replay-ledger-summary-label">Summary</span>
                    <span className="replay-ledger-summary-inline">
                      {ledgerOptionsSummaryByMonth.map(
                        ([month, { count, realizedPnl }], i) => (
                          <span key={month}>
                            {i > 0 && (
                              <span className="replay-ledger-summary-sep"> | </span>
                            )}
                            <span className="replay-ledger-summary-item">
                              {month}: {count} groups,{' '}
                              <span
                                className={
                                  realizedPnl >= 0
                                    ? 'replay-pnl-realized'
                                    : 'replay-pnl-detail-negative'
                                }
                              >
                                {fmtUsd0(realizedPnl)}
                              </span>
                            </span>
                          </span>
                        ),
                      )}
                      {ledgerOptionsSummaryByMonth.length > 0 && (
                        <span className="replay-ledger-summary-sep"> | </span>
                      )}
                      <span className="replay-ledger-summary-total">
                        Total:{' '}
                        {ledgerOptionsSummaryByMonth.reduce((s, [, d]) => s + d.count, 0)} groups,{' '}
                        <span
                          className={
                            closedOptGroupsPnlSum >= 0
                              ? 'replay-pnl-realized'
                              : 'replay-pnl-detail-negative'
                          }
                        >
                          {fmtUsd0(closedOptGroupsPnlSum)}
                        </span>
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="replay-ledger-summary-label">Summary</span>
                    <span className="replay-ledger-summary-inline">
                      {ledgerStocksSummaryByMonth.map(
                        ([month, { count, notional }], i) => (
                          <span key={month}>
                            {i > 0 && (
                              <span className="replay-ledger-summary-sep"> | </span>
                            )}
                            <span className="replay-ledger-summary-item">
                              {month}: {count} trades, {fmtUsd0(notional)}
                            </span>
                          </span>
                        ),
                      )}
                      {ledgerStocksSummaryByMonth.length > 0 && (
                        <span className="replay-ledger-summary-sep"> | </span>
                      )}
                      <span className="replay-ledger-summary-total">
                        Total:{' '}
                        {ledgerStocksSummaryByMonth.reduce((s, [, d]) => s + d.count, 0)} trades,{' '}
                        {fmtUsd0(
                          ledgerStocksSummaryByMonth.reduce((s, [, d]) => s + d.notional, 0),
                        )}
                      </span>
                    </span>
                  </>
                )}
              </section>
              {ledgerTab === 'options' ? (
                <div
                  id="replay-panel-options"
                  role="tabpanel"
                  aria-labelledby="replay-tab-options"
                  className="system-tab-panel"
                >
                  {hasOptionExecutions ? (
                    <>
                      <div className="replay-portfolio-table-wrap">
                        <table className="table-operations replay-opt-groups">
                          <thead>
                            <tr>
                              <th rowSpan={2} className="replay-opt-expand-col"></th>
                              <th rowSpan={2}>Contract</th>
                              <th
                                rowSpan={2}
                                className="replay-th-sortable"
                                onClick={e => {
                                  e.stopPropagation()
                                  setLedgerOptSort(prev =>
                                    prev.column === 'expiry'
                                      ? {
                                          column: 'expiry',
                                          dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                        }
                                      : { column: 'expiry', dir: 'desc' },
                                  )
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setLedgerOptSort(prev =>
                                      prev.column === 'expiry'
                                        ? {
                                            column: 'expiry',
                                            dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                          }
                                        : { column: 'expiry', dir: 'desc' },
                                    )
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                title="Sort by Expiry"
                              >
                                Expiry{' '}
                                {ledgerOptSort.column === 'expiry'
                                  ? ledgerOptSort.dir === 'asc'
                                    ? ' ▲'
                                    : ' ▼'
                                  : ''}
                              </th>
                              <th rowSpan={2}>STRIKE</th>
                              <th colSpan={3}>BUY</th>
                              <th colSpan={3}>SELL</th>
                              <th rowSpan={2}>Realized PnL</th>
                              <th rowSpan={2}>Account</th>
                              <th
                                rowSpan={2}
                                className="replay-th-sortable"
                                onClick={e => {
                                  e.stopPropagation()
                                  setLedgerOptSort(prev =>
                                    prev.column === 'trade_date'
                                      ? {
                                          column: 'trade_date',
                                          dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                        }
                                      : { column: 'trade_date', dir: 'desc' },
                                  )
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setLedgerOptSort(prev =>
                                      prev.column === 'trade_date'
                                        ? {
                                            column: 'trade_date',
                                            dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                        }
                                        : { column: 'trade_date', dir: 'desc' },
                                    )
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                title="Sort by Trade date"
                              >
                                Trade date{' '}
                                {ledgerOptSort.column === 'trade_date'
                                  ? ledgerOptSort.dir === 'asc'
                                    ? ' ▲'
                                    : ' ▼'
                                  : ''}
                              </th>
                            </tr>
                            <tr>
                              <th className="replay-th-sub">Size</th>
                              <th className="replay-th-sub">@</th>
                              <th className="replay-th-sub">Cost</th>
                              <th className="replay-th-sub">Size</th>
                              <th className="replay-th-sub">@</th>
                              <th className="replay-th-sub">Premium</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedClosedOptionGroups.map(g => {
                              const uniqueAccounts = Array.from(
                                new Set(
                                  (g.trades ?? [])
                                    .map(t => (t.account_id ?? '').trim())
                                    .filter(Boolean),
                                ),
                              )
                              const accountLabel =
                                uniqueAccounts.length === 0
                                  ? '—'
                                  : uniqueAccounts.length === 1
                                    ? uniqueAccounts[0]
                                    : 'Mix'
                              const groupKey = getOptGroupKey(g)
                              const isExpanded = expandedDetailKeys.includes(groupKey)
                              return (
                                <tr
                                  key={groupKey}
                                  className="replay-opt-group-row"
                                  onClick={() => toggleDetailExpand(groupKey)}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      toggleDetailExpand(groupKey)
                                    }
                                  }}
                                  aria-expanded={isExpanded}
                                  aria-label={
                                    isExpanded
                                      ? 'Collapse group details'
                                      : 'Expand group details'
                                  }
                                >
                                  <td className="replay-opt-expand-col">
                                    <span
                                      className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`}
                                      aria-hidden
                                    >
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  </td>
                                                                    <td className="replay-opt-contract">
                                    {(() => {
                                      const trades = g.trades ?? []
                                      const singleAccountState = getInstanceConsistencyState(trades)
                                      const aggregatedAccountState =
                                        getAggregatedInstanceConsistencyState(trades)
                                      const resolvedState =
                                        new Set(
                                          trades
                                            .map(t => (t.account_id ?? '').trim())
                                            .filter(Boolean),
                                        ).size <= 1
                                          ? singleAccountState
                                          : aggregatedAccountState
                                      const isSameState = resolvedState === 'same'
                                      const isDifferentState = resolvedState === 'different'
                                      const allSameInstance = singleAccountState === 'same'
                                      const singleInstanceId = allSameInstance
                                        ? trades.find(t => t.strategy_instance_id != null && Number.isFinite(t.strategy_instance_id))
                                            ?.strategy_instance_id ?? null
                                        : null
                                      const p = getContractLabelParts(g.contract_key)
                                      const strikeStr =
                                        g.strike != null ? ` ${g.strike}` : ''
                                      const instanceIcon =
                                        resolvedState !== 'none' ? (
                                          isSameState && singleInstanceId != null ? (
                                            <a
                                              href={`#/strategies/instances/${singleInstanceId}`}
                                              className="ledger-instance-icon-link ledger-instance-icon-link--same"
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              title="Instance consistency is green across accounts (click to open when there is a single shared instance)"
                                              aria-label="View strategy instance"
                                              onClick={e => e.stopPropagation()}
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </a>
                                          ) : isSameState ? (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--same"
                                              title="All accounts are consistent on instance assignment (green)"
                                              aria-label="Instance status is green"
                                              onClick={e => e.stopPropagation()}
                                              role="img"
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          ) : isDifferentState ? (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--different"
                                              title="At least one account has different instance IDs in details"
                                              aria-label="Instance status is red"
                                              onClick={e => e.stopPropagation()}
                                              role="img"
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          ) : (
                                            <span
                                              className="ledger-instance-icon-link ledger-instance-icon-link--mixed"
                                              title="At least one account has mixed or missing instance links in details"
                                              aria-label="Instance status is yellow"
                                              onClick={e => e.stopPropagation()}
                                              role="img"
                                            >
                                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <rect x="5" y="5" width="14" height="14" rx="1" />
                                              </svg>
                                            </span>
                                          )
                                        ) : null
                                      return (
                                        <>
                                          {instanceIcon}
                                          {p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}
                                              {strikeStr}
                                            </>
                                          ) : (
                                            g.contract_key
                                          )}
                                        </>
                                      )
                                    })()}
                                  </td>
                                  <td>{fmtExpiry(g.expiry)}</td>
                                  <td>
                                    <strong>{fmtUsd(g.strike)}</strong>
                                  </td>
                                  <td>{g.buy_volume}</td>
                                  <td>{fmtUsd(g.buy_avg_price)}</td>
                                  <td>
                                    <span className="replay-cost">{fmtUsd(g.buy_cost)}</span>
                                  </td>
                                  <td>{g.sell_volume}</td>
                                  <td>{fmtUsd(g.sell_avg_price)}</td>
                                  <td>
                                    <span className="replay-premium">
                                      {fmtUsd(g.sell_premium)}
                                    </span>
                                  </td>
                                  <td>
                                    <span
                                      className={
                                        g.realized_pnl >= 0
                                          ? 'replay-pnl-realized'
                                          : 'replay-pnl-detail-negative'
                                      }
                                    >
                                      {fmtUsd0(g.realized_pnl)}
                                    </span>
                                  </td>
                                  <td>{accountLabel}</td>
                                  <td>
                                    {(() => {
                                      const dates = (g.trades ?? [])
                                        .map(t => t.trade_date)
                                        .filter(
                                          (d): d is string =>
                                            d != null && String(d).trim() !== '',
                                        )
                                      if (dates.length === 0) return '—'
                                      dates.sort()
                                      return fmtTradeDate(dates[0])
                                    })()}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="replay-opt-summary-row">
                              <td colSpan={10}>Total</td>
                              <td>
                                <strong
                                  className={
                                    closedOptGroupsPnlSum >= 0
                                      ? 'replay-pnl-realized'
                                      : 'replay-pnl-detail-negative'
                                  }
                                >
                                  {fmtUsd0(closedOptGroupsPnlSum)}
                                </strong>
                              </td>
                              <td colSpan={2} />
                            </tr>
                          </tfoot>
                        </table>
                      </div>

                      {expiredUnrealizedOptionGroups.length > 0 && (
                        <div className="replay-portfolio-table-wrap replay-portfolio-table-wrap--no-scroll">
                          <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                            Expired but not closed
                            <InfoTooltip text="These option contracts have expired but net quantity is not zero. This usually means some executions are missing in Trade History; please add the missing trades to close the position." />
                          </h5>
                          <table className="table-operations replay-opt-groups">
                            <thead>
                              <tr>
                                <th>Contract</th>
                                <th>Account</th>
                                <th>Expiry</th>
                                <th>STRIKE</th>
                                <th>Net qty</th>
                                <th>Trades (side / qty / price / id)</th>
                                <th>Source</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {expiredUnrealizedOptionGroups.map(g => {
                                const p = getContractLabelParts(g.contract_key)
                                const strikeStr =
                                  g.strike != null ? ` ${g.strike}` : ''
                                const tradesSummary = (g.trades ?? [])
                                  .map(ex => {
                                    const s = (ex.side ?? '').toUpperCase()
                                    const sideLabel =
                                      s === 'BUY' || s === 'BOT' || s === 'B'
                                        ? 'Buy'
                                        : s === 'SELL' || s === 'SLD' || s === 'S'
                                          ? 'Sell'
                                          : (ex.side ?? '—')
                                    const q =
                                      ex.quantity != null ? Number(ex.quantity) : NaN
                                    const p_ =
                                      ex.price != null ? Number(ex.price) : NaN
                                    const idLabel =
                                      ex.account_executions_id != null ? `#${ex.account_executions_id}` : 'id?'
                                    const parts: string[] = []
                                    parts.push(sideLabel)
                                    if (Number.isFinite(q)) parts.push(String(q))
                                    if (Number.isFinite(p_)) parts.push(`@${p_}`)
                                    parts.push(`(${idLabel})`)
                                    return parts.join(' ')
                                  })
                                  .join('; ')
                                const uniqueSources = Array.from(
                                  new Set(
                                    (g.trades ?? [])
                                      .map(ex => (ex.source ?? '').trim())
                                      .filter(src => src.length > 0),
                                  ),
                                )
                                const groupKey = getOptGroupKey(g)
                                const uniqueAccounts = Array.from(
                                  new Set(
                                    (g.trades ?? [])
                                      .map(ex => (ex.account_id ?? '').trim())
                                      .filter(acc => acc.length > 0),
                                  ),
                                )
                                return (
                                  <tr key={`expired-${groupKey}`}>
                                    <td>
                                      {p.symbol ? (
                                        <>
                                          <strong>{p.symbol}</strong> {p.rightLabel}
                                          {strikeStr}
                                        </>
                                      ) : (
                                        g.contract_key
                                      )}
                                    </td>
                                    <td>
                                      {uniqueAccounts.length > 0
                                        ? uniqueAccounts.join(', ')
                                        : '—'}
                                    </td>
                                    <td>{fmtExpiry(g.expiry)}</td>
                                    <td>
                                      <strong>{fmtUsd(g.strike)}</strong>
                                    </td>
                                    <td>{g.net_qty}</td>
                                    <td>{tradesSummary || '—'}</td>
                                    <td>
                                      {uniqueSources.length > 0
                                        ? uniqueSources.join(', ')
                                        : '—'}
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className="btn btn-small"
                                        onClick={() => {
                                          setExpiredCloseKey(groupKey)
                                        }}
                                      >
                                        Close
                                      </button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                        Details (per trade)
                        <InfoTooltip text="Click a closed trade row above to load its execution details." />
                      </h5>
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Contract</th>
                            <th>Expiry</th>
                            <th>STRIKE</th>
                            <th>Time</th>
                            <th>Trade date</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Comm.</th>
                            <th>PnL</th>
                            <th>Account</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expandedDetailKeys.length === 0 ? (
                            <tr>
                              <td
                                colSpan={12}
                                className="replay-detail-placeholder"
                              >
                                Click a closed trade row above to load details
                              </td>
                            </tr>
                          ) : (
                            sortedClosedOptionGroups
                              .filter(g =>
                                expandedDetailKeys.includes(getOptGroupKey(g)),
                              )
                              .flatMap(g =>
                                (g.trades ?? []).map((ex, ti) => {
                                  const s = (ex.side ?? '').toUpperCase()
                                  const sideLabel =
                                    s === 'BUY' || s === 'BOT' || s === 'B'
                                      ? 'Buy'
                                      : s === 'SELL' ||
                                          s === 'SLD' ||
                                          s === 'S'
                                        ? 'Sell'
                                        : (ex.side ?? '—')
                                  const q = Number(ex.quantity) || 0
                                  const p = Number(ex.price) || 0
                                  const c = Number(ex.commission) || 0
                                  const value = q * p * 100 - c
                                  const isBuy =
                                    s === 'BUY' || s === 'BOT' || s === 'B'
                                  const isSell = !isBuy
                                  const pnl = isBuy ? -value : value
                                  // Sell = premium received → show as positive (profit)
                                  const displayPnl = isSell ? Math.abs(pnl) : pnl
                                  const pnlClass =
                                    displayPnl < 0
                                      ? 'replay-pnl-detail-negative'
                                      : displayPnl > 0
                                        ? 'replay-pnl-detail-positive'
                                        : ''
                                  return (
                                    <tr
                                      key={`${getOptGroupKey(g)}-${ti}-${ex.time ?? ti}`}
                                    >
                                      <td>
                                        {(() => {
                                          const p_ = getContractLabelParts(
                                            g.contract_key,
                                          )
                                          const strikeStr_ =
                                            g.strike != null
                                              ? ` ${g.strike}`
                                              : ''
                                          const instanceId = ex.strategy_instance_id
                                          const instanceLabel = ex.strategy_instance_label?.trim()
                                          const instanceTitle = instanceLabel
                                            ? `Instance: ${instanceLabel}`
                                            : instanceId != null
                                              ? `View instance #${instanceId}`
                                              : ''
                                          return (
                                            <>
                                              {instanceId != null && (
                                                <a
                                                  href={`#/strategies/instances/${instanceId}`}
                                                  className="ledger-instance-icon-link"
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  title={instanceTitle}
                                                  aria-label={instanceTitle || 'View strategy instance'}
                                                >
                                                  <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                    <rect x="5" y="5" width="14" height="14" rx="1" />
                                                  </svg>
                                                </a>
                                              )}
                                              {p_.symbol ? (
                                                <>
                                                  <strong>{p_.symbol}</strong>{' '}
                                                  {p_.rightLabel}
                                                  {strikeStr_}
                                                </>
                                              ) : (
                                                g.contract_key
                                              )}
                                            </>
                                          )
                                        })()}
                                      </td>
                                      <td>
                                        {fmtExpiry(ex.expiry ?? g.expiry)}
                                      </td>
                                      <td>
                                        <strong>{fmtUsd(g.strike)}</strong>
                                      </td>
                                      <td>
                                        {ex.time != null
                                          ? fmtTs(ex.time)
                                          : '—'}
                                      </td>
                                      <td>{fmtTradeDate(ex.trade_date)}</td>
                                      <td>{sideLabel}</td>
                                      <td>
                                        {ex.quantity != null
                                          ? Number(ex.quantity)
                                          : '—'}
                                      </td>
                                      <td>{fmtUsd(ex.price)}</td>
                                      <td>
                                        {fmtUsd(ex.commission ?? 0)}
                                      </td>
                                      <td>
                                        <span className={pnlClass}>
                                          {fmtUsd(displayPnl)}
                                        </span>
                                      </td>
                                      <td>{ex.account_id ?? '—'}</td>
                                      <td>
                                        {ex.account_executions_id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button
                                              type="button"
                                              className="btn btn-icon-small"
                                              onClick={() => {
                                                setEditExec(ex)
                                                setPageError(null)
                                              }}
                                              title="Edit"
                                              aria-label="Edit execution"
                                            >
                                              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                              </svg>
                                            </button>
                                            <LinkStrategyIconButton
                                              title="Assign strategy opportunity and instance"
                                              onClick={() => {
                                                setLinkContext({
                                                  account_executions_id:
                                                    ex.account_executions_id!,
                                                  execution: ex,
                                                })
                                                setLinkModalOpen(true)
                                                setPageError(null)
                                              }}
                                            />
                                            <button
                                              type="button"
                                              className="btn btn-icon-small btn-icon-danger"
                                              onClick={() => {
                                                setPageError(null)
                                                setDeleteConfirmState({
                                                  open: true,
                                                  title: 'Delete execution',
                                                  message:
                                                    'This will permanently remove this execution from trade history. This cannot be undone.',
                                                  confirming: false,
                                                  exec: ex,
                                                })
                                              }}
                                              title="Delete"
                                              aria-label="Delete execution"
                                            >
                                              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <polyline points="3 6 5 6 21 6" />
                                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                <line x1="10" y1="11" x2="10" y2="17" />
                                                <line x1="14" y1="11" x2="14" y2="17" />
                                              </svg>
                                            </button>
                                          </span>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                    </tr>
                                  )
                                }),
                              )
                          )}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={9} className="replay-detail-total-label">Total PNL</td>
                            <td
                              className={
                                ledgerDetailsTotalPnl < 0
                                  ? 'replay-pnl-detail-negative'
                                  : ledgerDetailsTotalPnl > 0
                                    ? 'replay-pnl-detail-positive'
                                    : ''
                              }
                            >
                              <strong>{fmtUsd(ledgerDetailsTotalPnl)}</strong>
                            </td>
                            <td colSpan={2} />
                          </tr>
                        </tfoot>
                      </table>
                    </>
                  ) : (
                    <p className="section-hint">
                      No closed option trades under the current filters.
                    </p>
                  )}
                </div>
              ) : (
                <div
                  id="replay-panel-stocks"
                  role="tabpanel"
                  aria-labelledby="replay-tab-stocks"
                  className="system-tab-panel"
                >
                  {hasStockExecutions ? (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th
                              className="replay-th-sortable"
                              onClick={e => {
                                e.stopPropagation()
                                setLedgerStockSort(prev => ({
                                  column: 'trade_date',
                                  dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                }))
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setLedgerStockSort(prev => ({
                                    column: 'trade_date',
                                    dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                  }))
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              title="Sort by Trade date"
                            >
                              Trade date{' '}
                              {ledgerStockSort.dir === 'asc' ? ' ▲' : ' ▼'}
                            </th>
                            <th>Symbol</th>
                            <th>Account</th>
                            <th>Category</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Comm.</th>
                            <th>Source</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const stockExecs = sortedStockExecutions
                            if (!ledgerStockGroupByPosition) {
                              return stockExecs.map((ex, i) => {
                                const s = (ex.side ?? '').toUpperCase()
                                const sideLabel =
                                  s === 'BUY' || s === 'BOT' || s === 'B'
                                    ? 'Buy'
                                    : s === 'SELL' ||
                                        s === 'SLD' ||
                                        s === 'S'
                                      ? 'Sell'
                                      : (ex.side ?? '—')
                                return (
                                  <tr key={i}>
                                    <td>
                                      {ex.time != null
                                        ? fmtTs(ex.time)
                                        : '—'}
                                    </td>
                                    <td>{fmtTradeDate(ex.trade_date)}</td>
                                    <td>{ex.symbol ?? '—'}</td>
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>{getStockExecCategory(ex)}</td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <td>{fmtUsd(ex.commission ?? 0)}</td>
                                    <td>{ex.source ?? '—'}</td>
                                    <td>
                                      {ex.account_executions_id != null ? (
                                        <span className="replay-exec-row-actions">
                                          <button
                                            type="button"
                                            className="btn btn-icon-small"
                                            onClick={() => {
                                              setEditExec(ex)
                                              setPageError(null)
                                            }}
                                            title="Edit"
                                            aria-label="Edit execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                            </svg>
                                          </button>
                                          <LinkStrategyIconButton
                                            title="Assign strategy opportunity and instance"
                                            onClick={() => {
                                              setLinkContext({
                                                account_executions_id:
                                                  ex.account_executions_id!,
                                                execution: ex,
                                              })
                                              setLinkModalOpen(true)
                                              setPageError(null)
                                            }}
                                          />
                                          <button
                                            type="button"
                                            className="btn btn-icon-small btn-icon-danger"
                                            onClick={() => {
                                              setPageError(null)
                                              setDeleteConfirmState({
                                                open: true,
                                                title: 'Delete execution',
                                                message:
                                                  'This will permanently remove this execution from trade history. This cannot be undone.',
                                                confirming: false,
                                                exec: ex,
                                              })
                                            }}
                                            title="Delete"
                                            aria-label="Delete execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <polyline points="3 6 5 6 21 6" />
                                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                              <line x1="10" y1="11" x2="10" y2="17" />
                                              <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                          </button>
                                        </span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  </tr>
                                )
                              })
                            }
                            const groups = new Map<string, Execution[]>()
                            for (const ex of sortedStockExecutions) {
                              const acc = (ex.account_id ?? '').trim()
                              const sym = (ex.symbol ?? '')
                                .toString()
                                .trim()
                                .toUpperCase()
                              const key = `${acc}|${sym}`
                              if (!groups.has(key)) groups.set(key, [])
                              groups.get(key)!.push(ex)
                            }
                            const groupEntries = Array.from(
                              groups.entries(),
                            ).sort(([a], [b]) => {
                              const [accA, symA] = a.split('|')
                              const [accB, symB] = b.split('|')
                              if (symA !== symB)
                                return (symA || '').localeCompare(symB || '')
                              return (accA || '').localeCompare(accB || '')
                            })
                            const rows: JSX.Element[] = []
                            let rowIdx = 0
                            for (const [groupKey, execs] of groupEntries) {
                              const [accId, sym] = groupKey.split('|')
                              const category =
                                positionCategoryByAccountContract.get(
                                  stkContractKey(sym, accId),
                                ) ?? '—'
                              rows.push(
                                <tr
                                  key={`h-${groupKey}`}
                                  className="replay-stock-group-header"
                                >
                                  <td colSpan={11}>
                                    <span className="replay-stock-group-symbol">
                                      {sym || '—'}
                                    </span>
                                    <span className="replay-stock-group-account">
                                      {accId || '—'}
                                    </span>
                                    <span className="replay-stock-group-category">
                                      {category}
                                    </span>
                                  </td>
                                </tr>,
                              )
                              for (const ex of execs) {
                                const s = (ex.side ?? '').toUpperCase()
                                const sideLabel =
                                  s === 'BUY' || s === 'BOT' || s === 'B'
                                    ? 'Buy'
                                    : s === 'SELL' ||
                                        s === 'SLD' ||
                                        s === 'S'
                                      ? 'Sell'
                                      : (ex.side ?? '—')
                                rows.push(
                                  <tr key={rowIdx}>
                                    <td>
                                      {ex.time != null
                                        ? fmtTs(ex.time)
                                        : '—'}
                                    </td>
                                    <td>{fmtTradeDate(ex.trade_date)}</td>
                                    <td>{ex.symbol ?? '—'}</td>
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>{getStockExecCategory(ex)}</td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <td>{fmtUsd(ex.commission ?? 0)}</td>
                                    <td>{ex.source ?? '—'}</td>
                                    <td>
                                      {ex.account_executions_id != null ? (
                                        <span className="replay-exec-row-actions">
                                          <button
                                            type="button"
                                            className="btn btn-icon-small"
                                            onClick={() => {
                                              setEditExec(ex)
                                              setPageError(null)
                                            }}
                                            title="Edit"
                                            aria-label="Edit execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                            </svg>
                                          </button>
                                          <LinkStrategyIconButton
                                            title="Assign strategy opportunity and instance"
                                            onClick={() => {
                                              setLinkContext({
                                                account_executions_id:
                                                  ex.account_executions_id!,
                                                execution: ex,
                                              })
                                              setLinkModalOpen(true)
                                              setPageError(null)
                                            }}
                                          />
                                          <button
                                            type="button"
                                            className="btn btn-icon-small btn-icon-danger"
                                            onClick={() => {
                                              setPageError(null)
                                              setDeleteConfirmState({
                                                open: true,
                                                title: 'Delete execution',
                                                message:
                                                  'This will permanently remove this execution from trade history. This cannot be undone.',
                                                confirming: false,
                                                exec: ex,
                                              })
                                            }}
                                            title="Delete"
                                            aria-label="Delete execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <polyline points="3 6 5 6 21 6" />
                                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                              <line x1="10" y1="11" x2="10" y2="17" />
                                              <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                          </button>
                                        </span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  </tr>,
                                )
                                rowIdx += 1
                              }
                            }
                            return rows
                          })()}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="section-hint">
                      No stock executions under the current filters.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {pageError && (
        <p
          className="section-hint replay-form-error"
          style={{ marginTop: '0.5rem' }}
        >
          {pageError}
        </p>
      )}
      <ExecutionFormModal
        open={addExecOpen || !!editExec}
        editExec={editExec}
        accountOptions={executionAccountOptions}
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
      <ExpiredCloseModal
        group={expiredCloseGroup}
        onClose={() => setExpiredCloseKey(null)}
        onSuccess={() => loadReplayData()}
      />
      {deleteConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-exec-confirm-title"
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
            <h3 id="delete-exec-confirm-title" className="section-subtitle" style={{ marginTop: 0 }}>
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
    </>
  )
}
