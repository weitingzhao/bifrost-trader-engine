import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Execution,
  Operation,
  OptExecutionGroup,
  RiskSummaryResponse,
  StatusResponse,
} from '../types'
import {
  createExecution,
  deleteExecution,
  fetchExecutions,
  fetchRiskSummary,
  postExecutionsFetch,
  updateExecution,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtUsd0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

function fmtExpiry(expiry: string | null | undefined): string {
  if (!expiry || !expiry.trim()) return '—'
  const s = expiry.trim()
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    const y = s.slice(0, 4)
    const m = s.slice(4, 6)
    const d = s.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  if (s.length === 6 && /^\d{6}$/.test(s)) {
    const y = s.slice(0, 4)
    const m = s.slice(4, 6)
    return `${y}-${m}`
  }
  return s
}

function unixToDatetimeLocal(ts: number | string | null | undefined): string {
  if (ts == null) return ''
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}`
}

function datetimeLocalToUnix(value: string): number {
  if (!value || !value.trim()) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(value).getTime() / 1000)
}

function getContractLabelParts(contract_key: string): { symbol: string; rightLabel: string } {
  const parts = contract_key.split('|')
  const symbol = parts[0]?.trim() || ''
  const right = (parts[4] ?? parts[parts.length - 1] ?? '').toString().toUpperCase()
  const rightLabel = right === 'C' ? 'CALL' : right === 'P' ? 'PUT' : right || ''
  return { symbol, rightLabel }
}

interface PositionPnlPageProps {
  status: StatusResponse | null
  operations: Operation[]
}

export function PositionPnlPage({ status, operations }: PositionPnlPageProps) {
  const [riskSummary, setRiskSummary] = useState<RiskSummaryResponse | null>(null)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [replayLoading, setReplayLoading] = useState(false)
  const [replaySyncing, setReplaySyncing] = useState(false)
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [addExecOpen, setAddExecOpen] = useState(false)
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [execFormError, setExecFormError] = useState<string | null>(null)
  const [execForm, setExecForm] = useState({
    account_id: '',
    time: '',
    symbol: '',
    sec_type: 'STK',
    side: 'BUY',
    quantity: '',
    price: '',
    expiry: '',
    strike: '',
    option_right: 'C',
    commission: '',
    realized_pnl: '',
    currency: 'USD',
  })
  const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

  const [filterSymbol, setFilterSymbol] = useState('')
  const [filterExpiryStart, setFilterExpiryStart] = useState('')
  const [filterExpiryEnd, setFilterExpiryEnd] = useState('')
  const [filterExecStart, setFilterExecStart] = useState('')
  const [filterExecEnd, setFilterExecEnd] = useState('')
  const [filterPool, setFilterPool] = useState<'ALL' | 'ON' | 'Off'>('ALL')

  const getOptGroupKey = (g: OptExecutionGroup) => `${g.contract_key}-${g.strike}-${g.expiry}`
  const [expandedDetailKeys, setExpandedDetailKeys] = useState<string[]>([])
  const toggleDetailExpand = (key: string) => {
    setExpandedDetailKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  const filteredExecutions = useMemo(() => {
    let list = [...(executions || [])]
    const sym = filterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expStart = filterExpiryStart.trim().replace(/-/g, '')
    if (expStart) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex + '01'
        return cmp >= expStart.slice(0, 8)
      })
    }
    const expEnd = filterExpiryEnd.trim().replace(/-/g, '')
    if (expEnd) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex.length === 6 ? ex + '31' : ex
        return cmp <= expEnd.slice(0, 8)
      })
    }
    if (filterExecStart.trim()) {
      const t = datetimeLocalToUnix(filterExecStart)
      if (Number.isFinite(t)) list = list.filter(e => (e.time ?? 0) >= t)
    }
    if (filterExecEnd.trim()) {
      const t = datetimeLocalToUnix(filterExecEnd + 'T23:59:59')
      if (Number.isFinite(t)) list = list.filter(e => (e.time ?? 0) <= t)
    }
    if (filterPool === 'ON') list = list.filter(e => (e.account_id ?? '').trim() !== OFF_TRACK_ACCOUNT_ID)
    else if (filterPool === 'Off') list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    return list
  }, [executions, filterSymbol, filterExpiryStart, filterExpiryEnd, filterExecStart, filterExecEnd, filterPool])

  const filteredOperations = useMemo(() => {
    let list = [...(operations || [])]
    if (filterExecStart.trim()) {
      const t = datetimeLocalToUnix(filterExecStart)
      if (Number.isFinite(t)) list = list.filter(op => (op.ts ?? 0) >= t)
    }
    if (filterExecEnd.trim()) {
      const t = datetimeLocalToUnix(filterExecEnd + 'T23:59:59')
      if (Number.isFinite(t)) list = list.filter(op => (op.ts ?? 0) <= t)
    }
    return list
  }, [operations, filterExecStart, filterExecEnd])

  const executionAccountOptions = useMemo(() => {
    const fromStatus = ((status?.accounts as { account_id?: string }[] | undefined) ?? [])
      .map(a => (a.account_id ?? '').trim())
      .filter(Boolean)
    const fromExec = (executions || [])
      .map(e => (e.account_id ?? '').trim())
      .filter(Boolean)
    const merged = Array.from(new Set([...fromStatus, ...fromExec]))
    merged.sort().reverse()
    if (!merged.includes(OFF_TRACK_ACCOUNT_ID)) {
      merged.push(OFF_TRACK_ACCOUNT_ID)
    }
    return merged
  }, [status?.accounts, executions])
  useEffect(() => {
    if (addExecOpen) {
      const defaultAccount = executionAccountOptions[0] ?? ''
      setExecForm({
        account_id: defaultAccount,
        time: unixToDatetimeLocal(Date.now() / 1000),
        symbol: '',
        sec_type: 'STK',
        side: 'BUY',
        quantity: '',
        price: '',
        expiry: '',
        strike: '',
        option_right: 'C',
        commission: '',
        realized_pnl: '',
        currency: 'USD',
      })
    }
  }, [addExecOpen])
  useEffect(() => {
    if (editExec) {
      setExecForm({
        account_id: editExec.account_id ?? '',
        time: unixToDatetimeLocal(editExec.time),
        symbol: editExec.symbol ?? '',
        sec_type: (editExec.sec_type ?? 'STK').toUpperCase(),
        side: (editExec.side ?? 'BUY').toUpperCase(),
        quantity: String(editExec.quantity ?? ''),
        price: String(editExec.price ?? ''),
        expiry: editExec.expiry ?? '',
        strike: String(editExec.strike ?? ''),
        option_right: (editExec.option_right ?? 'C').toUpperCase().slice(0, 1),
        commission: String(editExec.commission ?? ''),
        realized_pnl: String(editExec.realized_pnl ?? ''),
        currency: editExec.currency ?? 'USD',
      })
    }
  }, [editExec])

  const optExecutionGroups = useMemo((): OptExecutionGroup[] => {
    const opt = filteredExecutions.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
    const key = (e: Execution) => `${e.contract_key ?? ''}|${e.strike ?? 0}`
    const groups = new Map<string, Execution[]>()
    for (const e of opt) {
      const k = key(e)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(e)
    }
    const result: OptExecutionGroup[] = []
    for (const [, trades] of groups) {
      if (trades.length === 0) continue
      const first = trades[0]
      const contract_key = first.contract_key ?? ''
      const strike = Number(first.strike) ?? 0
      const expiry = first.expiry ?? ''
      let buy_qty = 0
      let sell_qty = 0
      let buy_value = 0
      let sell_value = 0
      let buy_value_raw = 0
      let sell_value_raw = 0
      for (const t of trades) {
        const q = Number(t.quantity) || 0
        const p = Number(t.price) || 0
        const c = Number(t.commission) || 0
        const v = p * q * 100 - c
        const side = (t.side ?? '').toUpperCase()
        if (side === 'BUY' || side === 'BOT' || side === 'B') {
          buy_qty += q
          buy_value += v
          buy_value_raw += p * q
        } else if (side === 'SELL' || side === 'SLD' || side === 'S') {
          sell_qty += q
          sell_value += v
          sell_value_raw += p * q
        }
      }
      const net_qty = buy_qty - sell_qty
      const buy_cost = buy_value
      const sell_premium = sell_value
      const realized_pnl = sell_premium - buy_cost
      const buy_avg_price = buy_qty > 0 ? buy_value_raw / buy_qty : null
      const sell_avg_price = sell_qty > 0 ? sell_value_raw / sell_qty : null
      result.push({
        contract_key,
        strike,
        expiry,
        net_qty,
        buy_volume: buy_qty,
        sell_volume: sell_qty,
        buy_avg_price,
        sell_avg_price,
        buy_cost,
        sell_premium,
        realized_pnl,
        status: net_qty === 0 ? 'realized' : 'unrealized',
        trades: trades.slice().sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
      })
    }
    result.sort((a, b) => (b.trades[0]?.time ?? 0) - (a.trades[0]?.time ?? 0))
    return result
  }, [filteredExecutions])

  const optGroupsPnlSum = useMemo(() => {
    return optExecutionGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0)
  }, [optExecutionGroups])

  const loadReplayData = useCallback(async () => {
    setReplayLoading(true)
    try {
      const summary = await fetchRiskSummary()
      setRiskSummary(summary)
      const execRes = await fetchExecutions(undefined, undefined, 100)
      setExecutions(execRes.executions || [])
    } catch {
      setRiskSummary(null)
      setExecutions([])
    } finally {
      setReplayLoading(false)
    }
  }, [])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  return (
    <div className="card process-section replay-page">
      <h2 className="page-title-with-tooltip">
        Position & PnL
        <InfoTooltip text="Option and hedge leg position structure and PnL analysis; separate from real-time monitor." />
      </h2>
      <div className="replay-toolbar">
        <label htmlFor="replay-fetch-days" className="replay-fetch-days-label">Fetch range</label>
        <select
          id="replay-fetch-days"
          className="replay-fetch-days-select"
          value={replayFetchDays}
          onChange={e => setReplayFetchDays(Number(e.target.value) as 1 | 3 | 7)}
          disabled={replaySyncing}
          aria-label="Execution fetch range"
        >
          <option value={1}>Today</option>
          <option value={3}>Last 3 days</option>
          <option value={7}>Last 7 days</option>
        </select>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={replaySyncing || replayLoading}
          onClick={async () => {
            setReplaySyncing(true)
            const res = await postExecutionsFetch(replayFetchDays)
            if (!res.ok) {
              setReplaySyncing(false)
              return
            }
            await loadReplayData()
            setReplaySyncing(false)
          }}
          aria-label="Fetch executions from IB and write to DB"
        >
          {replaySyncing ? 'Fetching…' : 'Refresh replay data'}
        </button>
        {replaySyncing && (
          <span className="replay-sync-hint">Fetching executions from IB…</span>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => { setAddExecOpen(true); setExecFormError(null); }}
          aria-label="Add execution record manually (historical)"
        >
          Add history
        </button>
      </div>

      <section className="replay-section" aria-labelledby="risk-summary-head">
        <h3 id="risk-summary-head">Risk model</h3>
        {replayLoading ? (
          <p className="section-hint">Loading…</p>
        ) : riskSummary ? (
          <div className="risk-summary-cards">
            <div className="risk-card">
              <span className="risk-card-label">Daily hedge count</span>
              <span className="risk-card-value">{riskSummary.daily_hedge_count ?? '—'}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Daily PnL (USD)</span>
              <span className="risk-card-value">
                {fmtUsd(riskSummary.daily_pnl)}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Spot</span>
              <span className="risk-card-value">
                {fmtUsd(riskSummary.spot)}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Ops (24h)</span>
              <span className="risk-card-value">{riskSummary.operations_count_24h ?? 0}</span>
            </div>
          </div>
        ) : (
          <p className="section-hint">Unable to load risk summary (check API and DB).</p>
        )}
      </section>

      <section className="replay-section" aria-labelledby="trade-records-head">
        <h3 id="trade-records-head">Trade records</h3>
        <div className="replay-filters">
          <label className="replay-filter-wrap-symbol">
            <input
              type="text"
              placeholder="Symbol"
              value={filterSymbol}
              onChange={e => setFilterSymbol(e.target.value)}
              className="replay-filter-input"
            />
          </label>
          <label>
            <span className="replay-filter-label">Expiry</span>
            <input
              type="date"
              value={filterExpiryStart}
              onChange={e => setFilterExpiryStart(e.target.value)}
              className="replay-filter-input replay-filter-date"
              title="Start"
            />
            <span className="replay-filter-sep">～</span>
            <input
              type="date"
              value={filterExpiryEnd}
              onChange={e => setFilterExpiryEnd(e.target.value)}
              className="replay-filter-input replay-filter-date"
              title="End"
            />
          </label>
          <label>
            <span className="replay-filter-label">Submit</span>
            <input
              type="date"
              value={filterExecStart}
              onChange={e => setFilterExecStart(e.target.value)}
              className="replay-filter-input replay-filter-date"
              title="Start"
            />
            <span className="replay-filter-sep">～</span>
            <input
              type="date"
              value={filterExecEnd}
              onChange={e => setFilterExecEnd(e.target.value)}
              className="replay-filter-input replay-filter-date"
              title="End"
            />
          </label>
          <label>
            <span className="replay-filter-label">POOL</span>
            <select
              value={filterPool}
              onChange={e => setFilterPool(e.target.value as 'ALL' | 'ON' | 'Off')}
              className="replay-filter-input replay-filter-select"
              aria-label="Pool filter"
            >
              <option value="ALL">ALL</option>
              <option value="ON">ON</option>
              <option value="Off">Off</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-small replay-filter-clear"
            onClick={() => {
              setFilterSymbol('')
              setFilterExpiryStart('')
              setFilterExpiryEnd('')
              setFilterExecStart('')
              setFilterExecEnd('')
              setFilterPool('ALL')
            }}
          >
            Clear filters
          </button>
        </div>
        <h4 className="replay-sub page-title-with-tooltip">
          Strategy operations (hedge)
          <InfoTooltip text={'From GET /operations; account-level executions (R-A2) shown in "Portfolio" below.'} />
        </h4>
        <table className="table-operations">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {filteredOperations.length === 0 ? (
              <tr><td colSpan={6}>None</td></tr>
            ) : (
              filteredOperations.slice(0, 50).map((op, i) => (
                <tr key={`${op.ts}-${i}`}>
                  <td>{fmtTs(op.ts)}</td>
                  <td>{op.type ?? ''}</td>
                  <td>{op.side ?? ''}</td>
                  <td>{op.quantity ?? ''}</td>
                  <td>{fmtUsd(op.price)}</td>
                  <td>{op.state_reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <h4 className="replay-sub page-title-with-tooltip">
          Portfolio
          <InfoTooltip text="Options grouped by contract_key and strike; Cost/Premium = Size×@×100−Commission; PnL = Premium − Cost; color by status (realized green, unrealized yellow)." />
        </h4>
        {filteredExecutions.length === 0 ? (
          <p className="section-hint">No data; click "Refresh replay data" to fetch from IB, or "Add history" to add manually.{([filterSymbol, filterExpiryStart, filterExpiryEnd, filterExecStart, filterExecEnd].some(Boolean) || filterPool !== 'ALL') ? ' Filters applied; clear to see all.' : ''}</p>
        ) : (
          <>
            {optExecutionGroups.length > 0 && (
              <>
                <table className="table-operations replay-opt-groups">
                  <thead>
                    <tr>
                      <th rowSpan={2} className="replay-opt-expand-col"></th>
                      <th rowSpan={2}>Contract</th>
                      <th rowSpan={2}>Expiry</th>
                      <th rowSpan={2}>STRIKE</th>
                      <th colSpan={3}>BUY</th>
                      <th colSpan={3}>SELL</th>
                      <th rowSpan={2}>Net</th>
                      <th rowSpan={2}>Status</th>
                      <th rowSpan={2}>PnL</th>
                      <th rowSpan={2}>Pool</th>
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
                    {optExecutionGroups.map((g) => {
                      const stateLabel = g.net_qty === 0 ? 'Realized' : g.net_qty > 0 ? 'Holding' : 'Selling'
                      const poolLabel = g.trades.some(t => (t.account_id ?? '').trim() === 'Off-Track') ? 'Off' : 'On'
                      const groupKey = getOptGroupKey(g)
                      const isExpanded = expandedDetailKeys.includes(groupKey)
                      return (
                        <tr
                          key={groupKey}
                          className="replay-opt-group-row"
                          onClick={() => toggleDetailExpand(groupKey)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDetailExpand(groupKey); } }}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? 'Collapse group details' : 'Expand group details'}
                        >
                          <td className="replay-opt-expand-col">
                            <span className="replay-opt-expand-icon" aria-hidden>{isExpanded ? '▼' : '▶'}</span>
                          </td>
                          <td className="replay-opt-contract">
                            {(() => {
                              const p = getContractLabelParts(g.contract_key)
                              return p.symbol ? (
                                <>
                                  <strong>{p.symbol}</strong> {p.rightLabel}
                                </>
                              ) : (
                                g.contract_key
                              )
                            })()}
                          </td>
                          <td>{fmtExpiry(g.expiry)}</td>
                          <td><strong>{fmtUsd(g.strike)}</strong></td>
                          <td>{g.buy_volume}</td>
                          <td>{fmtUsd(g.buy_avg_price)}</td>
                          <td><span className="replay-cost">{fmtUsd(g.buy_cost)}</span></td>
                          <td>{g.sell_volume}</td>
                          <td>{fmtUsd(g.sell_avg_price)}</td>
                          <td><span className="replay-premium">{fmtUsd(g.sell_premium)}</span></td>
                          <td>{g.net_qty}</td>
                          <td>
                            <span className={g.status === 'realized' ? 'replay-status-realized' : 'replay-status-unrealized'}>
                              {stateLabel}
                            </span>
                          </td>
                          <td>
                            <span className={g.status === 'realized' ? 'replay-pnl-realized' : 'replay-pnl-unrealized'}>
                              {fmtUsd0(g.realized_pnl)}
                            </span>
                          </td>
                          <td>{poolLabel}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="replay-opt-summary-row">
                      <td colSpan={12}>Total</td>
                      <td>
                        <strong className={optGroupsPnlSum >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                          {fmtUsd0(optGroupsPnlSum)}
                        </strong>
                      </td>
                      <td>—</td>
                    </tr>
                  </tfoot>
                </table>

                <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                  Details (per trade)
                  <InfoTooltip text="Click a group row above to load its trade details." />
                </h5>
                <table className="table-operations">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Expiry</th>
                      <th>STRIKE</th>
                      <th>Time</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Commission</th>
                      <th>PnL</th>
                      <th>Pool</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expandedDetailKeys.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="replay-detail-placeholder">Click a group row above to load details</td>
                      </tr>
                    ) : (
                      optExecutionGroups
                        .filter(g => expandedDetailKeys.includes(getOptGroupKey(g)))
                        .flatMap((g) =>
                          g.trades.map((ex, ti) => {
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
                        const pnlClass =
                          pnl < 0 ? 'replay-pnl-detail-negative' : pnl > 0 ? 'replay-pnl-detail-positive' : ''
                        return (
                          <tr key={`${getOptGroupKey(g)}-${ti}-${ex.time ?? ti}`}>
                            <td>
                              {(() => {
                                const p_ = getContractLabelParts(g.contract_key)
                                return p_.symbol ? (
                                  <>
                                    <strong>{p_.symbol}</strong> {p_.rightLabel}
                                  </>
                                ) : (
                                  g.contract_key
                                )
                              })()}
                            </td>
                            <td>{fmtExpiry(ex.expiry ?? g.expiry)}</td>
                            <td><strong>{fmtUsd(g.strike)}</strong></td>
                            <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                            <td>{sideLabel}</td>
                            <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                            <td>{fmtUsd(ex.price)}</td>
                            <td>{fmtUsd(ex.commission)}</td>
                            <td>
                              <span className={pnlClass}>{fmtUsd(pnl)}</span>
                            </td>
                            <td>{(ex.account_id ?? '').trim() === 'Off-Track' ? 'Off' : 'On'}</td>
                            <td>
                              {ex.id != null ? (
                                <span className="replay-exec-row-actions">
                                  <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setExecFormError(null); }}>Edit</button>
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
                                        setExecFormError(res.error ?? 'Delete failed')
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
                        )
                    )}
                  </tbody>
                </table>
              </>
            )}

            {filteredExecutions.some(e => (e.sec_type ?? '').toUpperCase() !== 'OPT') && (
              <>
                <h5 className="replay-sub">Non-option (stock) details</h5>
                <table className="table-operations">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Commission</th>
                      <th>Source</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExecutions
                      .filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
                      .map((ex, i) => {
                        const s = (ex.side ?? '').toUpperCase()
                        const sideLabel =
                          s === 'BUY' || s === 'BOT' || s === 'B'
                            ? 'Buy'
                            : s === 'SELL' || s === 'SLD' || s === 'S'
                              ? 'Sell'
                              : (ex.side ?? '—')
                        return (
                          <tr key={i}>
                            <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                            <td>{ex.symbol ?? '—'}</td>
                            <td>{sideLabel}</td>
                            <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                            <td>{fmtUsd(ex.price)}</td>
                            <td>{fmtUsd(ex.commission)}</td>
                            <td>{ex.source ?? '—'}</td>
                            <td>
                              {ex.id != null ? (
                                <span className="replay-exec-row-actions">
                                  <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setExecFormError(null); }}>Edit</button>
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
                                        setExecFormError(res.error ?? 'Delete failed')
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
                      })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      {(addExecOpen || editExec) && (
        <div className="modal-overlay" onClick={() => { setAddExecOpen(false); setEditExec(null); setExecFormError(null); }} role="dialog" aria-modal="true" aria-labelledby="exec-modal-title">
          <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
            <h3 id="exec-modal-title">{editExec ? 'Edit execution' : 'Add history'}</h3>
            {execFormError && <p className="section-hint replay-form-error">{execFormError}</p>}
            <form
              className="replay-exec-form"
              onSubmit={async e => {
                e.preventDefault()
                setExecFormError(null)
                const sym = execForm.symbol.trim()
                const q = Number(execForm.quantity)
                const p = Number(execForm.price)
                if (!sym || !Number.isFinite(q) || !Number.isFinite(p)) {
                  setExecFormError('Fill symbol, quantity, and price.')
                  return
                }
                const timeUnix = datetimeLocalToUnix(execForm.time)
                const isOpt = (execForm.sec_type || 'STK').toUpperCase() === 'OPT'
                if (isOpt) {
                  const strikeNum = execForm.strike != null && execForm.strike !== '' ? Number(execForm.strike) : NaN
                  if (!Number.isFinite(strikeNum) || strikeNum <= 0) {
                    setExecFormError('Option strike is required and must be > 0.')
                    return
                  }
                }
                let contract_key: string | undefined
                if (isOpt && sym) {
                  const rawStrike = execForm.strike ? Number(execForm.strike) : 0
                  const strikeStr = Number.isFinite(rawStrike) ? rawStrike.toFixed(1) : '0.0'
                  contract_key = `${sym}|OPT|${execForm.expiry || ''}|${strikeStr}|${(execForm.option_right || 'C').toUpperCase().slice(0, 1)}`
                } else {
                  contract_key = undefined
                }
                if (editExec?.id != null) {
                  const body: Record<string, unknown> = {
                    exec_time: timeUnix,
                    symbol: sym,
                    sec_type: execForm.sec_type || 'STK',
                    side: (execForm.side || 'BUY').toUpperCase(),
                    quantity: q,
                    price: p,
                    account_id: execForm.account_id.trim(),
                    strike: execForm.strike ? Number(execForm.strike) : undefined,
                    option_right: execForm.option_right || undefined,
                    contract_key: contract_key || undefined,
                    commission: execForm.commission ? Number(execForm.commission) : undefined,
                    realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                    currency: execForm.currency.trim() || undefined,
                  }
                  const expiryTrimmed = execForm.expiry.trim()
                  if (isOpt && expiryTrimmed && /^\d{6,8}$/.test(expiryTrimmed)) {
                    body.expiry = expiryTrimmed
                  }
                  const res = await updateExecution(editExec.id, body)
                  if (res.ok) {
                    setEditExec(null)
                    setAddExecOpen(false)
                    await loadReplayData()
                  } else {
                    setExecFormError(res.error ?? 'Update failed')
                  }
                } else {
                  const body: Record<string, unknown> = {
                    account_id: execForm.account_id.trim(),
                    time: timeUnix,
                    symbol: sym,
                    sec_type: execForm.sec_type || 'STK',
                    side: (execForm.side || 'BUY').toUpperCase(),
                    quantity: q,
                    price: p,
                    source: 'manual',
                    expiry: execForm.expiry.trim() || undefined,
                    strike: execForm.strike ? Number(execForm.strike) : undefined,
                    option_right: execForm.option_right || undefined,
                    contract_key: contract_key || undefined,
                    commission: execForm.commission ? Number(execForm.commission) : undefined,
                    realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                    currency: execForm.currency.trim() || undefined,
                  }
                  const res = await createExecution(body)
                  if (res.ok) {
                    setAddExecOpen(false)
                    await loadReplayData()
                  } else {
                    setExecFormError(res.error ?? 'Add failed')
                  }
                }
              }}
            >
              <div className="replay-exec-form-row">
                <label>Account</label>
                <select
                  value={execForm.account_id}
                  onChange={e => setExecForm(f => ({ ...f, account_id: e.target.value }))}
                  required
                >
                  {executionAccountOptions.map(accId => (
                    <option key={accId} value={accId}>
                      {accId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="replay-exec-form-row">
                <label>Time</label>
                <input type="datetime-local" value={execForm.time} onChange={e => setExecForm(f => ({ ...f, time: e.target.value }))} required />
              </div>
              <div className="replay-exec-form-row">
                <label>Symbol</label>
                <input type="text" value={execForm.symbol} onChange={e => setExecForm(f => ({ ...f, symbol: e.target.value.trim().toUpperCase() }))} placeholder="e.g. NVDA" required />
              </div>
              <div className="replay-exec-form-row">
                <label>Type</label>
                <div className="replay-exec-type-radios">
                  <label>
                    <input
                      type="radio"
                      name="exec-sec-type"
                      value="STK"
                      checked={(execForm.sec_type || 'STK').toUpperCase() === 'STK'}
                      onChange={e => setExecForm(f => ({ ...f, sec_type: e.target.value }))}
                    />
                    STK
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="exec-sec-type"
                      value="OPT"
                      checked={(execForm.sec_type || 'STK').toUpperCase() === 'OPT'}
                      onChange={e => setExecForm(f => ({ ...f, sec_type: e.target.value }))}
                    />
                    OPT
                  </label>
                </div>
              </div>
              <div className="replay-exec-form-row">
                <label>Side</label>
                <select value={execForm.side} onChange={e => setExecForm(f => ({ ...f, side: e.target.value }))}>
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </div>
              <div className="replay-exec-form-row">
                <label>Quantity</label>
                <input type="number" step="any" value={execForm.quantity} onChange={e => setExecForm(f => ({ ...f, quantity: e.target.value }))} required />
              </div>
              <div className="replay-exec-form-row">
                <label>Price</label>
                <input type="number" step="any" value={execForm.price} onChange={e => setExecForm(f => ({ ...f, price: e.target.value }))} required />
              </div>
              {(execForm.sec_type || 'STK').toUpperCase() === 'OPT' && (
                <>
                  <div className="replay-exec-form-row">
                    <label>Expiry (YYYYMMDD)</label>
                    <input type="text" value={execForm.expiry} onChange={e => setExecForm(f => ({ ...f, expiry: e.target.value }))} placeholder="20251219" />
                  </div>
                  <div className="replay-exec-form-row">
                    <label>STRIKE</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={execForm.strike}
                      onChange={e => setExecForm(f => ({ ...f, strike: e.target.value }))}
                      required
                      placeholder="Required, > 0"
                    />
                  </div>
                  <div className="replay-exec-form-row">
                    <label>Right</label>
                    <div className="replay-exec-type-radios">
                      <label>
                        <input
                          type="radio"
                          name="exec-option-right"
                          value="C"
                          checked={(execForm.option_right || 'C').toUpperCase() === 'C'}
                          onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))}
                        />
                        Call
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="exec-option-right"
                          value="P"
                          checked={(execForm.option_right || 'C').toUpperCase() === 'P'}
                          onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))}
                        />
                        Put
                      </label>
                    </div>
                  </div>
                </>
              )}
              <div className="replay-exec-form-row">
                <label>Commission</label>
                <input type="number" step="any" value={execForm.commission} onChange={e => setExecForm(f => ({ ...f, commission: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="replay-exec-form-row">
                <label>Realized PnL</label>
                <input type="number" step="any" value={execForm.realized_pnl} onChange={e => setExecForm(f => ({ ...f, realized_pnl: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="replay-exec-form-row">
                <label>Currency</label>
                <input type="text" value={execForm.currency} onChange={e => setExecForm(f => ({ ...f, currency: e.target.value }))} placeholder="USD" />
              </div>
              <div className="replay-exec-form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => { setAddExecOpen(false); setEditExec(null); setExecFormError(null); }}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editExec ? 'Save' : 'Add'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

