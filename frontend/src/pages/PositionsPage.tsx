import { useEffect, useMemo, useState } from 'react'
import type { Execution, RealtimeQuote, StatusResponse } from '../types'
import { deleteExecution, fetchQuotes, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  daysUntilExpiry,
  fmtExpiry,
  fmtTs,
  fmtUsd,
  getContractLabelParts,
} from '../utils/format'
import { buildOptExecutionGroups } from './portfolio/buildOptExecutionGroups'
import { ExecutionFormModal } from './portfolio/ExecutionFormModal'
import { QuickCloseModal } from './portfolio/QuickCloseModal'
import type { LivePositionRow, OpenOptionGroup, PortfolioView } from './portfolio/types'
import { OFF_TRACK_ACCOUNT_ID, useExecutions } from './portfolio/useExecutions'

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
  /** Pool=Off only: execution to close against; when set, show Quick Trade (Close) modal */
  const [closeAgainstExec, setCloseAgainstExec] = useState<Execution | null>(null)
  /** Inline error for e.g. delete execution failure (not modal form errors). */
  const [pageError, setPageError] = useState<string | null>(null)

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterPool, setOpenFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [openFilterAccountId, setOpenFilterAccountId] = useState<string>('all')
  const [openTab, setOpenTab] = useState<'options' | 'stocks'>('options')
  const getOpenOptGroupKey = (g: OpenOptionGroup) => `${g.contract_key}-${g.strike}-${g.expiry}-${g.pool_label}`
  const [expandedOpenDetailKeys, setExpandedOpenDetailKeys] = useState<string[]>([])

  const [openAccordionMode, setOpenAccordionMode] = useState<boolean>(false)
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

  const toggleOpenDetailExpand = (key: string) => {
    setExpandedOpenDetailKeys(prev => {
      const isOpen = prev.includes(key)
      if (openAccordionMode) {
        return isOpen ? [] : [key]
      }
      return isOpen ? prev.filter(k => k !== key) : [...prev, key]
    })
  }

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

  const openOptionGroups = useMemo((): OpenOptionGroup[] => {
    const result: OpenOptionGroup[] = []

    if (openFilterPool !== 'Off') {
      const groups = new Map<string, LivePositionRow[]>()
      for (const position of liveOptionPositions) {
        const expiry = position.lastTradeDateOrContractMonth ?? position.expiry ?? ''
        const strike = Number(position.strike) || 0
        const right = (position.right ?? '').toUpperCase().slice(0, 1)
        const contractKey = position.contract_key ?? `${position.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`
        const key = `${contractKey}|${strike}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(position)
      }

      for (const [, positions] of groups) {
        if (positions.length === 0) continue
        const first = positions[0]
        const expiry = first.lastTradeDateOrContractMonth ?? first.expiry ?? ''
        const strike = Number(first.strike) || 0
        const contract_key = first.contract_key ?? `${first.symbol ?? ''}|OPT|${expiry}|${strike}|${(first.right ?? '').toUpperCase().slice(0, 1)}`
        let grossQty = 0
        let netQty = 0
        let costWeightedSum = 0
        let markWeightedSum = 0
        let unrealizedPnl = 0
        let buyVolume = 0
        let sellVolume = 0
        let buyCost = 0
        let sellPremium = 0
        let buyValueRaw = 0
        let sellValueRaw = 0
        for (const position of positions) {
          const qty = Number(position.position) || 0
          const absQty = Math.abs(qty)
          const avgCost = position.avgCost != null && Number.isFinite(Number(position.avgCost))
            ? Number(position.avgCost)
            : null
          const markPrice = position.price != null && Number.isFinite(Number(position.price))
            ? Number(position.price)
            : null
          netQty += qty
          grossQty += absQty
          if (avgCost != null) costWeightedSum += avgCost * absQty
          if (markPrice != null) markWeightedSum += markPrice * absQty
          unrealizedPnl += Number(position.unrealized_pnl) || 0
          if (qty > 0) {
            buyVolume += qty
            if (avgCost != null) {
              buyCost += avgCost * qty * 100
              buyValueRaw += avgCost * qty
            }
          } else if (qty < 0) {
            sellVolume += absQty
            if (avgCost != null) {
              sellPremium += avgCost * absQty * 100
              sellValueRaw += avgCost * absQty
            }
          }
        }
        // Option @ is per-share (e.g. 2.50); API may give avgCost per-share or per-contract. Ledger uses per-share.
        // If displayed @ is 100x too large, avgCost is per-contract (250); store per-share for @: divide by 100.
        const buyAvgPerShare = buyVolume > 0 ? buyValueRaw / buyVolume / 100 : null
        const sellAvgPerShare = sellVolume > 0 ? sellValueRaw / sellVolume / 100 : null
        // When avgCost is per-contract (e.g. 250), total $ = avgCost * qty (no *100). When per-share (2.5), total $ = avgCost * qty * 100.
        const rawBuyAvg = buyVolume > 0 ? buyValueRaw / buyVolume : 0
        const rawSellAvg = sellVolume > 0 ? sellValueRaw / sellVolume : 0
        const isPerContract = rawBuyAvg >= 10 || rawSellAvg >= 10
        const buyCostDollars = isPerContract ? buyVolume * rawBuyAvg : buyCost
        const sellPremiumDollars = isPerContract ? sellVolume * rawSellAvg : sellPremium
        const markPerShare = grossQty > 0 ? markWeightedSum / grossQty : null
        // Unrealized PnL: long PnL (mark*buy_vol*100 - buy_cost) + short PnL (sell_premium - mark*sell_vol*100) = mark*net_qty*100 - buy_cost + sell_premium
        const computedUnrealizedPnl =
          markPerShare != null && Number.isFinite(markPerShare)
            ? markPerShare * netQty * 100 - buyCostDollars + sellPremiumDollars
            : unrealizedPnl
        result.push({
          kind: 'live',
          contract_key,
          strike,
          expiry,
          net_qty: netQty,
          avg_cost: grossQty > 0 ? costWeightedSum / grossQty : null,
          mark_price: grossQty > 0 ? markWeightedSum / grossQty : null,
          unrealized_pnl: computedUnrealizedPnl,
          account_count: new Set(positions.map(position => position.account_id || '—')).size,
          pool_label: 'On',
          buy_volume: buyVolume,
          sell_volume: sellVolume,
          buy_avg_price: buyAvgPerShare,
          sell_avg_price: sellAvgPerShare,
          buy_cost: buyCostDollars,
          sell_premium: sellPremiumDollars,
          positions: positions.slice().sort((a, b) => (b.account_id ?? '').localeCompare(a.account_id ?? '')),
        })
      }
    }

    if (openFilterPool !== 'ON') {
      const openOffTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions).filter(group => group.status === 'unrealized')
      for (const group of openOffTrackGroups) {
        // Unrealized PnL = sum of Details PnL column (per trade: Buy = -(q*p*100-c), Sell = +(q*p*100-c)) => sell_premium - buy_cost
        const unrealizedPnlOff = group.sell_premium - group.buy_cost
        result.push({
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          net_qty: group.net_qty,
          avg_cost: group.buy_avg_price,
          mark_price: null,
          unrealized_pnl: unrealizedPnlOff,
          account_count: new Set(group.trades.map(trade => (trade.account_id ?? '').trim() || '—')).size,
          pool_label: 'Off',
          buy_volume: group.buy_volume,
          sell_volume: group.sell_volume,
          buy_avg_price: group.buy_avg_price,
          sell_avg_price: group.sell_avg_price,
          buy_cost: group.buy_cost,
          sell_premium: group.sell_premium,
          trades: group.trades,
        })
      }
    }

    result.sort((a, b) => {
      const aSymbol = getContractLabelParts(a.contract_key).symbol
      const bSymbol = getContractLabelParts(b.contract_key).symbol
      if (aSymbol !== bSymbol) return aSymbol.localeCompare(bSymbol)
      if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry)
      return a.pool_label.localeCompare(b.pool_label)
    })
    return result
  }, [openFilterPool, liveOptionPositions, openOffTrackBaseExecutions])

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

  /** Pool=On Details: (account_id, contract_key) -> latest execution with id; only show Actions when this position has a matching account_execution. */
  const livePositionExecutionMap = useMemo(() => {
    const map = new Map<string, Execution>()
    const opt = (executions || []).filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
    for (const ex of opt) {
      if (ex.id == null) continue
      const ck = (ex.contract_key ?? '').trim()
      const acc = (ex.account_id ?? '').trim()
      const key = `${acc}|${ck}`
      const existing = map.get(key)
      if (!existing || (ex.time ?? 0) > (existing.time ?? 0)) map.set(key, ex)
    }
    return map
  }, [executions])

  const hasOpenOptions = openOptionGroups.length > 0
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
          onClick={() => { setAddExecOpen(true); setPageError(null) }}
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
          {openOptionGroups.length === 0 && liveStockPositions.length === 0 ? (
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
                      : 'Open stock positions from account snapshots (Live only).'}
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
                  {openOptionGroups.length === 0 ? (
                    <p className="section-hint">No open option positions under the current filters.</p>
                  ) : (
                <>
                  <div className="replay-portfolio-table-wrap">
                    <table className="table-operations replay-opt-groups">
                      <thead>
                        <tr>
                          <th rowSpan={2} className="replay-opt-expand-col"></th>
                          <th rowSpan={2}>Contract</th>
                          <th rowSpan={2}>Expiry</th>
                          <th rowSpan={2}>STRIKE</th>
                          <th rowSpan={2} title="Underlying last price (same as Watchlist Last); (Last − Strike) / Last %">Last</th>
                          <th colSpan={3}>BUY</th>
                          <th colSpan={3}>SELL</th>
                          <th rowSpan={2}>Unrealized PnL</th>
                          <th rowSpan={2}>Account</th>
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
                        {openOptionGroups.map(group => {
                          const groupKey = getOpenOptGroupKey(group)
                          const isExpanded = expandedOpenDetailKeys.includes(groupKey)
                          return (
                            <tr
                              key={groupKey}
                              className="replay-opt-group-row"
                              onClick={() => toggleOpenDetailExpand(groupKey)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpenDetailExpand(groupKey) } }}
                              aria-expanded={isExpanded}
                              aria-label={isExpanded ? 'Collapse open position details' : 'Expand open position details'}
                            >
                              <td className="replay-opt-expand-col">
                                <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                                  {isExpanded ? '▼' : '▶'}
                                </span>
                              </td>
                              <td className="replay-opt-contract">
                                {(() => {
                                  const p = getContractLabelParts(group.contract_key)
                                  const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                  return p.symbol ? (
                                    <>
                                      <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                                    </>
                                  ) : (
                                    group.contract_key
                                  )
                                })()}
                              </td>
                              <td>
                                {fmtExpiry(group.expiry)}
                                {(() => {
                                  const days = daysUntilExpiry(group.expiry)
                                  if (days == null) return null
                                  const label = days >= 0 ? (days === 0 ? ' (today)' : ` (${days}d)`) : ` (${-days}d ago)`
                                  return <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                                })()}
                              </td>
                              <td><strong>{fmtUsd(group.strike)}</strong></td>
                              <td>
                                {(() => {
                                  const underlying = getContractLabelParts(group.contract_key).symbol
                                  const q = underlying ? quotesMap[underlying] : undefined
                                  const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                  const strike = group.strike != null && Number.isFinite(group.strike) ? group.strike : null
                                  const pct = last != null && strike != null && last !== 0
                                    ? ((last - strike) / last) * 100
                                    : null
                                  return (
                                    <>
                                      {last != null ? fmtUsd(last) : '—'}
                                      {pct != null && (
                                        <span className="replay-last-strike-pct" title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}>
                                          {' '}({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
                                        </span>
                                      )}
                                    </>
                                  )
                                })()}
                              </td>
                              <td>{group.buy_volume}</td>
                              <td>{fmtUsd(group.buy_avg_price)}</td>
                              <td><span className="replay-cost">{fmtUsd(group.buy_cost)}</span></td>
                              <td>{group.sell_volume}</td>
                              <td>{fmtUsd(group.sell_avg_price)}</td>
                              <td><span className="replay-premium">{fmtUsd(group.sell_premium)}</span></td>
                              <td>
                                <span className="replay-pnl-unrealized">
                                  {fmtUsd(group.unrealized_pnl ?? 0)}
                                </span>
                              </td>
                              <td>
                                {(() => {
                                  if (group.kind === 'live') {
                                    const accounts = Array.from(
                                      new Set(
                                        (group.positions ?? []).map(p => (p.account_id ?? '').trim()).filter(Boolean),
                                      ),
                                    )
                                    if (accounts.length === 0) return '—'
                                    if (accounts.length === 1) return accounts[0]
                                    return 'Multi'
                                  }
                                  if (group.kind === 'offtrack') {
                                    const accounts = Array.from(
                                      new Set(
                                        (group.trades ?? []).map(t => (t.account_id ?? '').trim()).filter(Boolean),
                                      ),
                                    )
                                    if (accounts.length === 0) return '—'
                                    if (accounts.length === 1) return accounts[0]
                                    return 'Multi'
                                  }
                                  return '—'
                                })()}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="replay-opt-tfoot-total">
                          <td colSpan={11} className="replay-opt-tfoot-label">Total</td>
                          <td>
                            <span className="replay-pnl-unrealized">
                              {fmtUsd(openOptionGroups.reduce((acc, g) => acc + (g.unrealized_pnl ?? 0), 0))}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {expandedOpenDetailKeys.length > 0 && (
                    <>
                      <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                        Details (per trade)
                        <InfoTooltip text="Click a grouped option row above to inspect live account snapshots or Off-Track open trades for that contract." />
                      </h5>
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Contract</th>
                            <th>Expiry</th>
                            <th>STRIKE</th>
                            <th title="Underlying last; (Last − Strike) / Last %">Last</th>
                            <th>Time</th>
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
                          {openOptionGroups
                            .filter(group => expandedOpenDetailKeys.includes(getOpenOptGroupKey(group)))
                            .flatMap(group =>
                              group.kind === 'live'
                                ? (group.positions ?? []).map((position, index) => {
                                  const qty = Number(position.position)
                                  const absQty = Math.abs(qty)
                                  const pricePerShare = position.avgCost != null && Number.isFinite(Number(position.avgCost))
                                    ? (Number(position.avgCost) >= 10 ? Number(position.avgCost) / 100 : Number(position.avgCost))
                                    : null
                                  const commission = 0
                                  const value = (pricePerShare ?? 0) * absQty * 100 - commission
                                  const rowPnl = qty > 0 ? -value : value
                                  const pnlClass = 'replay-pnl-unrealized'
                                  const execForRow = livePositionExecutionMap.get(`${(position.account_id ?? '').trim()}|${group.contract_key}`)
                                  return (
                                    <tr key={`${getOpenOptGroupKey(group)}-live-${position.account_id}-${index}`}>
                                      <td className="replay-opt-contract">
                                        {(() => {
                                          const p = getContractLabelParts(group.contract_key)
                                          const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                          return p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                                            </>
                                          ) : (
                                            group.contract_key
                                          )
                                        })()}
                                      </td>
                                      <td>
                                        {(() => {
                                          const exp = position.lastTradeDateOrContractMonth ?? position.expiry ?? group.expiry
                                          const days = daysUntilExpiry(exp)
                                          return (
                                            <>
                                              {fmtExpiry(exp)}
                                              {days != null && (
                                                <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>
                                                  {' '}({days >= 0 ? `${days}d` : `-${-days}d`})
                                                </span>
                                              )}
                                            </>
                                          )
                                        })()}
                                      </td>
                                      <td><strong>{position.strike != null ? fmtUsd(position.strike) : fmtUsd(group.strike)}</strong></td>
                                      <td>
                                        {(() => {
                                          const underlying = getContractLabelParts(group.contract_key).symbol
                                          const q = underlying ? quotesMap[underlying] : undefined
                                          const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                          const strike = position.strike ?? group.strike
                                          const strikeNum = strike != null && Number.isFinite(strike) ? strike : null
                                          const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                          return (
                                            <>
                                              {last != null ? fmtUsd(last) : '—'}
                                              {pct != null && <span className="replay-last-strike-pct"> ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>}
                                            </>
                                          )
                                        })()}
                                      </td>
                                      <td>{(() => {
                                        // Prefer trade_date (from latest execution), then exec_time, then updated_at
                                        const tradeDate = position.trade_date ?? null
                                        if (tradeDate && tradeDate.trim()) {
                                          return tradeDate.trim().slice(0, 10)
                                        }
                                        const ts = position.exec_time != null ? Number(position.exec_time) : (position.updated_at != null ? Number(position.updated_at) : null)
                                        return ts != null && Number.isFinite(ts) ? fmtTs(ts) : '—'
                                      })()}</td>
                                      <td>{qty > 0 ? 'Buy' : qty < 0 ? 'Sell' : '—'}</td>
                                      <td>{Number.isFinite(qty) ? Math.abs(qty) : '—'}</td>
                                      <td>{fmtUsd(pricePerShare)}</td>
                                      <td>{fmtUsd(0)}</td>
                                      <td><span className={pnlClass}>{fmtUsd(rowPnl)}</span></td>
                                      <td>{position.account_id ?? '—'}</td>
                                      <td>
                                        {execForRow?.id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button type="button" className="btn btn-small" onClick={() => { setEditExec(execForRow); setPageError(null) }}>Edit</button>
                                            <button
                                              type="button"
                                              className="btn btn-small btn-x"
                                              onClick={async () => {
                                                if (!window.confirm('Delete this execution?')) return
                                                const res = await deleteExecution(execForRow.id!)
                                                if (res.ok) {
                                                  if (editExec?.id === execForRow.id) setEditExec(null)
                                                  await loadReplayData()
                                                } else {
                                                  setPageError(res.error ?? 'Delete failed')
                                                }
                                              }}
                                              title="Delete"
                                            >
                                              X
                                            </button>
                                          </span>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                  )
                                })
                                : (group.trades ?? []).map((ex, ti) => {
                                  const s = (ex.side ?? '').toUpperCase()
                                  const sideLabel =
                                    s === 'BUY' || s === 'BOT' || s === 'B'
                                      ? 'Buy'
                                      : s === 'SELL' || s === 'SLD' || s === 'S'
                                        ? 'Sell'
                                        : (ex.side ?? '—')
                                  const q = Number(ex.quantity) || 0
                                  const p = Number(ex.price) || 0
                                  const c = Number(ex.commission) || 0
                                  const value = q * p * 100 - c
                                  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
                                  const pnl = isBuy ? -value : value
                                  const pnlClass = pnl < 0 ? 'replay-pnl-detail-negative' : pnl > 0 ? 'replay-pnl-detail-positive' : ''
                                  return (
                                    <tr key={`${getOpenOptGroupKey(group)}-${ti}-${ex.time ?? ti}`}>
                                      <td className="replay-opt-contract">
                                        {(() => {
                                          const p_ = getContractLabelParts(group.contract_key)
                                          const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                          return p_.symbol ? (
                                            <>
                                              <strong>{p_.symbol}</strong> {p_.rightLabel}{strikeStr}
                                            </>
                                          ) : (
                                            group.contract_key
                                          )
                                        })()}
                                      </td>
                                      <td>
                                        {(() => {
                                          const exp = ex.expiry ?? group.expiry
                                          const days = daysUntilExpiry(exp)
                                          return (
                                            <>
                                              {fmtExpiry(exp)}
                                              {days != null && (
                                                <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>
                                                  {' '}({days >= 0 ? `${days}d` : `-${-days}d`})
                                                </span>
                                              )}
                                            </>
                                          )
                                        })()}
                                      </td>
                                      <td><strong>{fmtUsd(ex.strike ?? group.strike)}</strong></td>
                                      <td>
                                        {(() => {
                                          const underlying = getContractLabelParts(group.contract_key).symbol
                                          const q = underlying ? quotesMap[underlying] : undefined
                                          const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                                          const strike = ex.strike ?? group.strike
                                          const strikeNum = strike != null && Number.isFinite(strike) ? strike : null
                                          const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                                          return (
                                            <>
                                              {last != null ? fmtUsd(last) : '—'}
                                              {pct != null && <span className="replay-last-strike-pct"> ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>}
                                            </>
                                          )
                                        })()}
                                      </td>
                                      <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                                      <td>{sideLabel}</td>
                                      <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                                      <td>{fmtUsd(ex.price)}</td>
                                      <td>{fmtUsd(ex.commission ?? 0)}</td>
                                      <td>
                                        <span className={pnlClass}>{fmtUsd(pnl)}</span>
                                      </td>
                                      <td>{ex.account_id ?? '—'}</td>
                                      <td>
                                        {ex.id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setPageError(null) }}>Edit</button>
                                            <button type="button" className="btn btn-small" onClick={() => { setCloseAgainstExec(ex); setPageError(null) }}>Close</button>
                                            <button
                                              type="button"
                                              className="btn btn-small btn-x"
                                              onClick={async () => {
                                                if (!window.confirm('Delete this execution?')) return
                                                const res = await deleteExecution(ex.id!)
                                                if (res.ok) {
                                                  if (editExec?.id === ex.id) setEditExec(null)
                                                  await loadReplayData()
                                                } else {
                                                  setPageError(res.error ?? 'Delete failed')
                                                }
                                              }}
                                              title="Delete"
                                            >
                                              X
                                            </button>
                                          </span>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                  )
                                }),
                            )}
                        </tbody>
                      </table>
                    </>
                  )}
                </>
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
                            <th>Unrealized PnL</th>
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
                                rows.push(
                                  <tr key={`open-stk-${accId}-${position.symbol ?? ''}-${position.contract_key ?? ''}`}>
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
        onClose={() => { setAddExecOpen(false); setEditExec(null); setPageError(null) }}
        onSuccess={() => { setPageError(null); loadReplayData() }}
      />
      <QuickCloseModal
        exec={closeAgainstExec}
        onClose={() => setCloseAgainstExec(null)}
        onSuccess={() => loadReplayData()}
      />
    </div>
  )
}

