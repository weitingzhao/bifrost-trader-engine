import { useCallback, useEffect, useState } from 'react'
import type { Execution, IbAccountSnapshot, PerformanceResponse, StatusResponse } from '../types'
import type { BackendOptPair } from '../types'
import { fetchExecutions, fetchPerformance } from '../api'

function fmtChicagoTime(unixSec: number | string | null | undefined): string {
  let sec: number
  if (typeof unixSec === 'string') sec = parseFloat(unixSec)
  else if (typeof unixSec === 'number') sec = unixSec
  else return '—'
  if (!Number.isFinite(sec)) return '—'
  if (sec > 1e12) sec /= 1000
  const d = new Date(sec * 1000)
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = f.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
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

/** Option right to full name: C/CALL -> CALL, P/PUT -> PUT. */
function optionRightToFull(r: string | null | undefined): string {
  if (r == null || String(r).trim() === '') return '—'
  const s = String(r).trim().toUpperCase()
  if (s === 'C' || s === 'CALL') return 'CALL'
  if (s === 'P' || s === 'PUT') return 'PUT'
  return s
}

/** Normalize strike for contract/pair key so 190 and 190.0 (or "190"/"190.0") match. */
function normalizeStrike(s: string | number | null | undefined): string {
  if (s == null || s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? String(n) : String(s).trim()
}

/** PnL = Qty * price * 100 - commission; nulls treated as 0. For Execution: sign by side (SELL +, BUY -). */
function execPnl(e: Execution): number {
  const qty = Number(e.quantity) || 0
  const price = Number(e.price) || 0
  const commission = Number(e.commission) || 0
  const side = (e.side ?? '').toString().trim().toUpperCase()
  const sign = side === 'SELL' ? 1 : -1
  const pnl = sign * qty * price * 100 - commission
  return Number.isFinite(pnl) ? pnl : 0
}

/** PnL for Match (pair): Qty * (p_price - c_price) * 100 - commission; nulls as 0. */
function matchPnl(p: { quantity: number; c_price: number; p_price: number; commission: number }): number {
  const qty = Number(p.quantity) || 0
  const cPrice = Number(p.c_price) || 0
  const pPrice = Number(p.p_price) || 0
  const commission = Number(p.commission) || 0
  const pnl = qty * (pPrice - cPrice) * 100 - commission
  return Number.isFinite(pnl) ? pnl : 0
}

/** Server/DB uses Chicago time. Return [startOfDayUnix, endOfDayUnix] for date YYYY-MM-DD in America/Chicago. */
function getChicagoDayRange(dateStr: string): { since_ts: number; until_ts: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = formatter.formatToParts(new Date(utcNoon))
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '12', 10)
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const offsetMinutes = (hour - 12) * 60 + minute
  const startOfDayChicagoMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60 * 1000
  const untilMs = startOfDayChicagoMs + 24 * 3600 * 1000 - 1
  return {
    since_ts: Math.floor(startOfDayChicagoMs / 1000),
    until_ts: Math.floor(untilMs / 1000),
  }
}

/** Pair BUY↔SELL from the exact list of OPT executions (same symbol, expiry, strike, account_id; side opposite). FIFO. */
function computeOptPairsFromExecutions(
  executions: Execution[],
): { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] {
  const opt = executions.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const byKey: Record<string, Execution[]> = {}
  for (const e of opt) {
    const side = (e.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'
    if (side !== 'BUY' && side !== 'SELL') continue
    const key = [
      e.symbol ?? '',
      e.expiry ?? '',
      String(e.strike ?? ''),
      e.account_id ?? '',
    ].join('\t')
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(e)
  }
  const pairs: { account_id: string; symbol: string; expiry: string; strike: string; quantity: number; c_side: string; c_price: number; p_side: string; p_price: number; commission: number; net_pnl: number }[] = []
  for (const list of Object.values(byKey)) {
    const sorted = [...list].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    const buyQueue: { q: number; p: number; c: number; side: string }[] = []
    const sellQueue: { q: number; p: number; c: number; side: string }[] = []
    for (const x of sorted) {
      const q = Number(x.quantity) || 0
      const p = Number(x.price) || 0
      const comm = Number(x.commission) || 0
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) continue
      const side = (x.side ?? 'BUY').toString().trim().toUpperCase() || 'BUY'
      if (side === 'BUY') buyQueue.push({ q, p, c: comm, side })
      else if (side === 'SELL') sellQueue.push({ q, p, c: comm, side })
    }
    let i = 0
    let j = 0
    const sym = sorted[0]?.symbol ?? ''
    const exp = sorted[0]?.expiry ?? ''
    const str = String(sorted[0]?.strike ?? '')
    const acc = sorted[0]?.account_id ?? ''
    while (i < buyQueue.length && j < sellQueue.length) {
      const bb = buyQueue[i]
      const ss = sellQueue[j]
      const qMatch = Math.min(bb.q, ss.q)
      if (qMatch <= 0) break
      const bAlloc = (qMatch / bb.q) * bb.c
      const sAlloc = (qMatch / ss.q) * ss.c
      const signB = bb.side === 'SELL' ? 1 : -1
      const signS = ss.side === 'SELL' ? 1 : -1
      const legB = signB * qMatch * bb.p * 100 - bAlloc
      const legS = signS * qMatch * ss.p * 100 - sAlloc
      const net = legB + legS
      pairs.push({
        account_id: acc,
        symbol: sym,
        expiry: exp,
        strike: str,
        quantity: Math.round(qMatch * 1e4) / 1e4,
        c_side: bb.side,
        c_price: Math.round(bb.p * 1e4) / 1e4,
        p_side: ss.side,
        p_price: Math.round(ss.p * 1e4) / 1e4,
        commission: Math.round((bAlloc + sAlloc) * 100) / 100,
        net_pnl: Math.round(net * 100) / 100,
      })
      if (qMatch >= bb.q) {
        i += 1
        if (qMatch >= ss.q) j += 1
        else sellQueue[j] = { ...ss, q: ss.q - qMatch, c: ss.c * (1 - qMatch / ss.q) }
      } else {
        buyQueue[i] = { ...bb, q: bb.q - qMatch, c: bb.c * (1 - qMatch / bb.q) }
        j += 1
      }
    }
  }
  return pairs
}

interface PerformancePageProps {
  status: StatusResponse | null
}

export function PerformancePage({ status }: PerformancePageProps) {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string>('')
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day')
  const [daysBack, setDaysBack] = useState(90)
  const [calendarMonth, setCalendarMonth] = useState<string>(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedDayExecutions, setSelectedDayExecutions] = useState<Execution[] | null>(null)
  const [selectedDayOptPairs, setSelectedDayOptPairs] = useState<BackendOptPair[] | null>(null)
  const [selectedDayExecutionsLoading, setSelectedDayExecutionsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const until = Math.floor(Date.now() / 1000)
    let since = until - daysBack * 86400
    // When showing Option PnL Calendar (granularity day), extend range to include the displayed month so we have data for every day in view
    if (granularity === 'day' && calendarMonth) {
      const [y, m] = calendarMonth.split('-').map(Number)
      const firstOfMonth = new Date(y, m - 1, 1)
      const lastOfMonth = new Date(y, m, 0, 23, 59, 59)
      const monthStartTs = Math.floor(firstOfMonth.getTime() / 1000)
      const monthEndTs = Math.min(Math.floor(lastOfMonth.getTime() / 1000), until)
      since = Math.min(since, monthStartTs)
      const untilExtended = Math.max(until, monthEndTs)
      // use range that covers both the "days back" window and the calendar month
      try {
        const res = await fetchPerformance({
          since_ts: since,
          until_ts: untilExtended,
          account_id: accountId || undefined,
          granularity,
        })
        setData(res)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load performance')
        setData(null)
      } finally {
        setLoading(false)
      }
      return
    }
    try {
      const res = await fetchPerformance({
        since_ts: since,
        until_ts: until,
        account_id: accountId || undefined,
        granularity,
      })
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load performance')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [daysBack, accountId, granularity, calendarMonth])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setSelectedDay(null)
  }, [calendarMonth])

  // When a day is selected, fetch executions for that day in SERVER timezone (America/Chicago)
  // with backend BUY↔SELL pairing (include_opt_pairs=true) so each execution has paired_execution_ids and we get opt_pairs
  useEffect(() => {
    if (!selectedDay) {
      setSelectedDayExecutions(null)
      setSelectedDayOptPairs(null)
      return
    }
    const { since_ts: dayStartTs, until_ts: dayEndTs } = getChicagoDayRange(selectedDay)
    setSelectedDayExecutionsLoading(true)
    fetchExecutions(dayStartTs, dayEndTs, 500, true)
      .then((res) => {
        setSelectedDayExecutions(res.executions ?? [])
        setSelectedDayOptPairs('opt_pairs' in res && Array.isArray(res.opt_pairs) ? res.opt_pairs : null)
      })
      .catch(() => {
        setSelectedDayExecutions([])
        setSelectedDayOptPairs(null)
      })
      .finally(() => setSelectedDayExecutionsLoading(false))
  }, [selectedDay])

  const selectedDayQueryParams = selectedDay
    ? (() => {
      const { since_ts, until_ts } = getChicagoDayRange(selectedDay)
      return {
        since_ts,
        until_ts,
        limit: 500,
        note: 'Server calendar day (America/Chicago)',
      }
    })()
    : null

  const accounts: IbAccountSnapshot[] = status?.accounts ?? []
  const summary = data?.summary
  const calendar = data?.calendar ?? []

  return (
    <div className="app-page-stack performance-page">
      <section className="card" aria-label="Performance filters">
        <h2 className="card-title">Performance</h2>
        <p className="section-hint">
          Realized PnL and trading metrics (R-M7 / R-H2) from account executions. Data from GET /executions.
        </p>
        <div className="performance-filters">
          <label className="performance-filter">
            <span>Time range</span>
            <select
              value={daysBack}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              aria-label="Days back"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
              <option value={365}>Last 1 year</option>
            </select>
          </label>
          <label className="performance-filter">
            <span>Account</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Account"
            >
              <option value="">All</option>
              {accounts.map((acc) => (
                <option key={acc.account_id ?? ''} value={acc.account_id ?? ''}>
                  {acc.account_id ?? '—'}
                </option>
              ))}
            </select>
          </label>
          <label className="performance-filter">
            <span>Granularity</span>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as 'day' | 'week' | 'month')}
              aria-label="Granularity"
            >
              <option value="day">By day</option>
              <option value="week">By week</option>
              <option value="month">By month</option>
            </select>
          </label>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </section>

      {error && (
        <div className="card card-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {data && summary && (
        <>
          <section className="card" aria-label="PnL by type (Option vs Stock)">
            <h3 className="card-subtitle">PnL by type (Option vs Stock)</h3>
            <p className="section-hint">
              <strong>Option (OPT)</strong>: Realized = sum of <code>realized_pnl</code> from executions (IB). Unrealized = (price − avg_cost) × contracts × 100 per position.
              <br />
              <strong>Stock (STK)</strong>: Unrealized = (price − avg_cost) × shares. Use this block to verify Option PnL first.
            </p>
            <div className="table-wrap">
              <table className="data-table" role="grid">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Realized PnL</th>
                    <th>Commission</th>
                    <th>Realized Net</th>
                    <th>Trades</th>
                    <th>Unrealized PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const realized = data.realized_by_sec_type ?? []
                    const unrealized = data.unrealized_by_sec_type ?? []
                    const types = new Set([...realized.map((r) => r.sec_type), ...unrealized.map((u) => u.sec_type)])
                    const rows = Array.from(types).sort((a, b) => (a === 'OPT' ? -1 : a === 'STK' ? 1 : a.localeCompare(b)))
                    return rows.map((secType) => {
                      const r = realized.find((x) => x.sec_type === secType)
                      const u = unrealized.find((x) => x.sec_type === secType)
                      return (
                        <tr key={secType}>
                          <td><strong>{secType}</strong></td>
                          <td>{fmtUsd(r?.total_pnl ?? 0)}</td>
                          <td>{fmtUsd(r?.commission ?? 0)}</td>
                          <td className={(r?.net_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtUsd(r?.net_pnl ?? 0)}</td>
                          <td>{r?.trade_count ?? 0}</td>
                          <td className={(u?.total_pnl ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtUsd(u?.total_pnl ?? 0)}</td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
            </div>
            {(data.realized_by_sec_type ?? []).length === 0 && (data.unrealized_by_sec_type ?? []).length === 0 && (
              <p className="section-hint">No executions or positions in the selected range.</p>
            )}
          </section>

          {granularity === 'day' && (
            <section className="card" aria-label="Option PnL Calendar">
              <h3 className="card-subtitle">Option PnL Calendar</h3>
              <p className="section-hint">
                Daily Option Realized and Unrealized in calendar form. Set granularity to &quot;By day&quot;.
              </p>
              <details className="performance-calendar-how">
                <summary>How we calculate Realized and Unrealized</summary>
                <ul>
                  <li><strong>Realized (per day, Option)</strong>: Pair BUY with SELL: same symbol, expiry, strike, account_id; side opposite (BUY↔SELL). FIFO match. Per pair: leg PnL = (SELL ? +1 : -1) × Q × P × 100 − commission; pair_net = sum of legs. Daily Option Realized = sum of these paired PnLs.</li>
                  <li><strong>Unrealized</strong>: As of current time only. Sum over all Option positions of (current_price − avg_cost) × contracts × 100. Source: account_positions + instrument_prices. Not stored by day, so each cell shows &quot;—&quot; for Unrealized; total Option Unrealized is shown below.</li>
                </ul>
              </details>
              {(() => {
                const bySec = data.calendar_by_sec_type ?? []
                const optDays: Record<string, { net_pnl: number; pnl: number; commission: number; trade_count: number; pairs?: import('../types').OptRealizedPair[] }> = {}
                bySec.filter((r) => r.sec_type === 'OPT').forEach((r) => {
                  optDays[r.period_label] = { net_pnl: r.net_pnl, pnl: r.pnl, commission: r.commission, trade_count: r.trade_count, pairs: r.pairs }
                })
                const optUnrealized = (data.unrealized_by_sec_type ?? []).find((u) => u.sec_type === 'OPT')?.total_pnl ?? null
                const [y, m] = calendarMonth.split('-').map(Number)
                const first = new Date(y, m - 1, 1)
                const last = new Date(y, m, 0)
                const startOffset = first.getDay()
                const daysInMonth = last.getDate()
                const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7
                const cells: { day: number | null; dateStr: string | null }[] = []
                for (let i = 0; i < totalCells; i++) {
                  if (i < startOffset) {
                    cells.push({ day: null, dateStr: null })
                  } else if (i < startOffset + daysInMonth) {
                    const day = i - startOffset + 1
                    cells.push({ day, dateStr: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` })
                  } else {
                    cells.push({ day: null, dateStr: null })
                  }
                }
                const hasAnyOptInMonth = cells.some((c) => c.dateStr && optDays[c.dateStr] != null)
                const goPrev = () => {
                  const d = new Date(y, m - 2, 1)
                  setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
                }
                const goNext = () => {
                  const d = new Date(y, m, 1)
                  setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
                }
                const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                return (
                  <>
                    {optUnrealized != null && (
                      <p className="performance-calendar-total-unrealized">
                        Option Unrealized (as of now): <strong className={(optUnrealized ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{fmtUsd(optUnrealized)}</strong>
                      </p>
                    )}
                    {!hasAnyOptInMonth && (
                      <p className="section-hint performance-calendar-no-data">
                        No Option realized in this month (only paired same-day BUY+SELL count). Try a larger range or another month.
                      </p>
                    )}
                    <div className="performance-calendar-nav">
                      <button type="button" className="btn btn-secondary" onClick={goPrev} aria-label="Previous month">← Prev</button>
                      <span className="performance-calendar-title">{monthLabel}</span>
                      <button type="button" className="btn btn-secondary" onClick={goNext} aria-label="Next month">Next →</button>
                    </div>
                    <div className="performance-calendar-grid" role="grid">
                      <div className="performance-calendar-row performance-calendar-header">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((wd) => (
                          <div key={wd} className="performance-calendar-cell performance-calendar-dow">{wd}</div>
                        ))}
                      </div>
                      {Array.from({ length: totalCells / 7 }, (_, rowIdx) => (
                        <div key={rowIdx} className="performance-calendar-row">
                          {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((c, colIdx) => {
                            const info = c.dateStr ? optDays[c.dateStr] : null
                            const showPnL = c.day != null
                            const realizedVal = info ? info.net_pnl : null
                            const toneR = showPnL && realizedVal != null ? (realizedVal >= 0 ? 'tone-positive' : 'tone-negative') : ''
                            const titleParts: string[] = []
                            if (info) {
                              titleParts.push(`Realized: ${fmtUsd(info.net_pnl)} (${info.trade_count} trades)`)
                              titleParts.push(`Unrealized: — (as of now only)`)
                            } else if (c.dateStr) {
                              titleParts.push('No Option trades that day')
                            }
                            return (
                              <div
                                key={colIdx}
                                role={c.dateStr ? 'button' : undefined}
                                tabIndex={c.dateStr ? 0 : undefined}
                                onClick={c.dateStr ? () => setSelectedDay(c.dateStr) : undefined}
                                onKeyDown={c.dateStr ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelectedDay(c.dateStr) } } : undefined}
                                className={`performance-calendar-cell ${c.day == null ? 'performance-calendar-cell-outside' : ''} ${toneR} ${c.dateStr ? 'performance-calendar-cell-clickable' : ''} ${selectedDay === c.dateStr ? 'performance-calendar-cell-selected' : ''}`}
                                title={titleParts.length ? titleParts.join('\n') : (c.dateStr ? 'Click to see contributing records' : undefined)}
                              >
                                {c.day != null && <span className="performance-calendar-day">{c.day}</span>}
                                {showPnL && (
                                  <div className="performance-calendar-pnl-lines">
                                    <span className="performance-calendar-pnl performance-calendar-realized">
                                      R: {realizedVal != null ? fmtUsd(realizedVal) : '—'}
                                    </span>
                                    <span className="performance-calendar-pnl performance-calendar-unrealized">
                                      U: —
                                    </span>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                    {selectedDay != null && (
                      <div className="performance-calendar-day-detail" aria-live="polite">
                        <h4 className="performance-calendar-day-detail-title">
                          Records for {selectedDay}
                          <button type="button" className="btn btn-secondary btn-sm performance-calendar-day-detail-close" onClick={() => setSelectedDay(null)} aria-label="Close">×</button>
                        </h4>
                        {selectedDayExecutionsLoading ? (
                          <p className="section-hint">Loading executions…</p>
                        ) : (
                          <>
                            {selectedDayQueryParams && (
                              <div className="performance-calendar-query-hint">
                                <strong>Query:</strong>{' '}
                                <code>GET /executions?since_ts={selectedDayQueryParams.since_ts}&amp;until_ts={selectedDayQueryParams.until_ts}&amp;limit={selectedDayQueryParams.limit}</code>
                                <br />
                                <small>{selectedDayQueryParams.note}: since_ts/until_ts = this date 00:00–23:59 in America/Chicago (server time).</small>
                              </div>
                            )}
                            {(() => {
                              const allExecs = selectedDayExecutions ?? []
                              const optExecs = allExecs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
                              const backendPairs = selectedDayOptPairs ?? []
                              type DayPair = {
                                account_id: string
                                symbol: string
                                expiry: string
                                strike: string
                                quantity: number
                                c_side: string
                                c_price: number
                                p_side: string
                                p_price: number
                                commission: number
                                net_pnl: number
                                leg_c_execution_id?: number
                                leg_p_execution_id?: number
                              }
                              const dayPairs: DayPair[] = backendPairs.length > 0
                                ? backendPairs.map((p) => ({
                                  account_id: p.account_id,
                                  symbol: p.symbol,
                                  expiry: p.expiry,
                                  strike: p.strike,
                                  quantity: p.quantity,
                                  c_side: p.c_side,
                                  c_price: p.c_price,
                                  p_side: p.p_side,
                                  p_price: p.p_price,
                                  commission: p.commission,
                                  net_pnl: p.net_pnl,
                                  leg_c_execution_id: p.leg_c_execution_id,
                                  leg_p_execution_id: p.leg_p_execution_id,
                                }))
                                : computeOptPairsFromExecutions(allExecs).map((p) => ({
                                  ...p,
                                  leg_c_execution_id: undefined,
                                  leg_p_execution_id: undefined,
                                }))
                              const contractKey = (e: Execution) =>
                                `${e.account_id ?? ''}\t${e.symbol ?? ''}\t${e.expiry ?? ''}\t${normalizeStrike(e.strike)}`
                              const pairKey = (p: { account_id: string; symbol: string; expiry: string; strike: string | number }) =>
                                `${p.account_id}\t${p.symbol}\t${p.expiry}\t${normalizeStrike(p.strike)}`
                              const keyNoAccount = (sym: string, exp: string, str: string | number) =>
                                `${sym}\t${exp}\t${normalizeStrike(str)}`
                              const execById = new Map<number, Execution>()
                              for (const e of allExecs) {
                                if (e.id != null) execById.set(e.id, e)
                              }
                              const dayPairsEnriched: (typeof dayPairs)[0][] = dayPairs.map((p) => ({
                                ...p,
                                account_id: p.account_id ||
                                  (p.leg_c_execution_id != null ? execById.get(p.leg_c_execution_id)?.account_id : undefined) ||
                                  (p.leg_p_execution_id != null ? execById.get(p.leg_p_execution_id)?.account_id : undefined) ||
                                  '',
                              }))
                              const pairByKey = new Map<string, (typeof dayPairs)[0][]>()
                              for (const p of dayPairsEnriched) {
                                const k = pairKey(p)
                                if (!pairByKey.has(k)) pairByKey.set(k, [])
                                pairByKey.get(k)!.push(p)
                              }
                              const pairByKeyNoAccount = new Map<string, (typeof dayPairs)[0][]>()
                              for (const p of dayPairsEnriched) {
                                const kNoAcc = keyNoAccount(p.symbol, p.expiry, p.strike)
                                if (!pairByKeyNoAccount.has(kNoAcc)) pairByKeyNoAccount.set(kNoAcc, [])
                                pairByKeyNoAccount.get(kNoAcc)!.push(p)
                              }
                              const byContract = new Map<string, Execution[]>()
                              for (const e of optExecs) {
                                const sym = e.symbol ?? ''
                                const exp = e.expiry ?? ''
                                const str = e.strike ?? ''
                                const acc = e.account_id ?? ''
                                let k: string
                                if (acc.trim() !== '') {
                                  k = contractKey(e)
                                } else {
                                  const pairList = pairByKeyNoAccount.get(keyNoAccount(sym, exp, str))
                                  k = pairList?.length && pairList[0].account_id
                                    ? pairKey(pairList[0])
                                    : contractKey(e)
                                }
                                if (!byContract.has(k)) byContract.set(k, [])
                                byContract.get(k)!.push(e)
                              }
                              const allContractKeys = new Set<string>(byContract.keys())
                              for (const p of dayPairsEnriched) {
                                allContractKeys.add(pairKey(p))
                              }
                              const contractKeys = Array.from(allContractKeys).sort((a, b) => {
                                const execsA = byContract.get(a) ?? []
                                const execsB = byContract.get(b) ?? []
                                const pairsA = pairByKey.get(a) ?? (a.startsWith('\t') ? pairByKeyNoAccount.get(a.slice(1)) ?? [] : [])
                                const pairsB = pairByKey.get(b) ?? (b.startsWith('\t') ? pairByKeyNoAccount.get(b.slice(1)) ?? [] : [])
                                const legTimes = (pairs: (typeof dayPairsEnriched)) => {
                                  if (pairs.length === 0) return []
                                  const p = pairs[0]
                                  const out: number[] = []
                                  if (p.leg_c_execution_id != null) { const t = execById.get(p.leg_c_execution_id)?.time; if (t != null) out.push(t) }
                                  if (p.leg_p_execution_id != null) { const t = execById.get(p.leg_p_execution_id)?.time; if (t != null) out.push(t) }
                                  return out
                                }
                                const tA = execsA.length > 0
                                  ? Math.min(...execsA.map((e) => e.time ?? 0))
                                  : (() => { const lt = legTimes(pairsA); return lt.length > 0 ? Math.min(...lt) : 0 })()
                                const tB = execsB.length > 0
                                  ? Math.min(...execsB.map((e) => e.time ?? 0))
                                  : (() => { const lt = legTimes(pairsB); return lt.length > 0 ? Math.min(...lt) : 0 })()
                                return tA - tB
                              })
                              return (
                                <>
                                  <h5 className="performance-calendar-day-detail-subtitle">Option executions by contract (server: Chicago)</h5>
                                  <p className="section-hint performance-calendar-count-hint">
                                    {optExecs.length} Option execution(s) in {contractKeys.length} contract(s) (of {allExecs.length} total for this day). One table per contract: <strong>Execution</strong> = same-day trade row; <strong>Match</strong> = BUY↔SELL pair summary from backend.
                                  </p>
                                  {contractKeys.length === 0 ? (
                                    <p className="section-hint">No Option executions in DB for this day (exec_time in server Chicago range).</p>
                                  ) : (
                                    contractKeys.map((key) => {
                                      const execs = byContract.get(key) ?? []
                                      const pairs =
                                        pairByKey.get(key) ??
                                        (key.startsWith('\t') ? pairByKeyNoAccount.get(key.slice(1)) ?? [] : [])
                                      const first = execs[0]
                                      const firstPair = pairs[0]
                                      const symbol = first?.symbol ?? firstPair?.symbol ?? '—'
                                      const expiry = first?.expiry ?? firstPair?.expiry ?? '—'
                                      const strike = first?.strike ?? firstPair?.strike ?? '—'
                                      const rightFull = optionRightToFull(
                                        first?.option_right ??
                                          (firstPair && firstPair.leg_c_execution_id != null
                                            ? execById.get(firstPair.leg_c_execution_id)?.option_right
                                            : firstPair && firstPair.leg_p_execution_id != null
                                              ? execById.get(firstPair.leg_p_execution_id)?.option_right
                                              : undefined)
                                      )
                                      const sortedExecs = [...execs].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
                                      type Row = { type: 'Execution'; e: Execution } | { type: 'Match'; p: (typeof dayPairs)[0] }
                                      const rows: Row[] = [
                                        ...sortedExecs.map((e) => ({ type: 'Execution' as const, e })),
                                        ...pairs.map((p) => ({ type: 'Match' as const, p })),
                                      ]
                                      const groupSumPnl =
                                        sortedExecs.reduce((s, e) => s + execPnl(e), 0) +
                                        pairs.reduce((s, p) => s + matchPnl(p), 0)
                                      return (
                                        <div key={key} className="performance-calendar-contract-group">
                                          <h6 className="performance-calendar-contract-title">
                                            {symbol} {expiry} {strike} {rightFull !== '—' ? rightFull : ''}
                                            <span className={
                                              pairs.length > 0
                                                ? (groupSumPnl >= 0 ? 'tone-positive' : 'tone-negative')
                                                : 'tone-unrealized'
                                            }>
                                              {' '}{fmtUsd(groupSumPnl)}
                                            </span>
                                          </h6>
                                          <table className="performance-calendar-pairs-table performance-calendar-unified-table">
                                            <thead>
                                              <tr>
                                                <th>Record type</th>
                                                <th>Id</th>
                                                <th>Account</th>
                                                <th>EXEC TIME</th>
                                                <th>Side</th>
                                                <th>Qty</th>
                                                <th>Price</th>
                                                <th>Commission</th>
                                                <th>PnL</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {rows.map((row, idx) =>
                                                row.type === 'Match' ? (() => {
                                                  const legC = row.p.leg_c_execution_id != null ? execById.get(row.p.leg_c_execution_id) : undefined
                                                  const legP = row.p.leg_p_execution_id != null ? execById.get(row.p.leg_p_execution_id) : undefined
                                                  const timeC = legC?.time != null ? fmtChicagoTime(legC.time) : null
                                                  const timeP = legP?.time != null ? fmtChicagoTime(legP.time) : null
                                                  const execTimeStr = timeC != null && timeP != null ? `${timeC} — ${timeP}` : timeC ?? timeP ?? '—'
                                                  return (
                                                    <tr key={`match-${idx}`} className="performance-calendar-row-match">
                                                      <td>Match</td>
                                                      <td>
                                                        {row.p.leg_c_execution_id != null && row.p.leg_p_execution_id != null
                                                          ? `${row.p.leg_c_execution_id} / ${row.p.leg_p_execution_id}`
                                                          : '—'}
                                                      </td>
                                                      <td>{row.p.account_id || '—'}</td>
                                                      <td>{execTimeStr}</td>
                                                      <td>{row.p.p_side}</td>
                                                      <td>{row.p.quantity}</td>
                                                      <td>{fmtUsd(row.p.p_price)}</td>
                                                      <td>{fmtUsd(row.p.commission)}</td>
                                                      <td className={(matchPnl(row.p) >= 0 ? 'tone-positive' : 'tone-negative')}>{fmtUsd(matchPnl(row.p))}</td>
                                                    </tr>
                                                  )
                                                })() : (
                                                  <tr key={row.e.id ?? idx} className="performance-calendar-row-execution">
                                                    <td>Execution</td>
                                                    <td>{row.e.id ?? '—'}</td>
                                                    <td>{row.e.account_id ?? '—'}</td>
                                                    <td>{fmtChicagoTime(row.e.time)}</td>
                                                    <td>{row.e.side ?? '—'}</td>
                                                    <td>{row.e.quantity ?? '—'}</td>
                                                    <td>{fmtUsd(row.e.price)}</td>
                                                    <td>{fmtUsd(row.e.commission)}</td>
                                                    <td className={(execPnl(row.e) >= 0 ? 'tone-positive' : 'tone-negative')}>{fmtUsd(execPnl(row.e))}</td>
                                                  </tr>
                                                )
                                              )}
                                            </tbody>
                                          </table>
                                        </div>
                                      )
                                    })
                                  )}
                                </>
                              )
                            })()}
                          </>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
            </section>
          )}

          <section className="card" aria-label="Summary metrics">
            <h3 className="card-subtitle">Summary metrics</h3>
            <div className="performance-summary-grid">
              <div className="performance-metric">
                <span className="performance-metric-label">Total PnL</span>
                <span
                  className={`performance-metric-value tone-${(summary.total_pnl ?? 0) >= 0 ? 'positive' : 'negative'}`}
                >
                  {fmtUsd(summary.total_pnl)}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Realized PnL</span>
                <span className="performance-metric-value">{fmtUsd(summary.total_realized_pnl ?? summary.total_pnl)}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Realized Net</span>
                <span
                  className={`performance-metric-value tone-${(summary.net_pnl ?? 0) >= 0 ? 'positive' : 'negative'}`}
                >
                  {fmtUsd(summary.net_pnl)}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Unrealized PnL</span>
                <span className="performance-metric-value">{fmtUsd(summary.total_unrealized_pnl)}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Commission</span>
                <span className="performance-metric-value">{fmtUsd(summary.total_commission)}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Trade count</span>
                <span className="performance-metric-value">{summary.trade_count ?? 0}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Win rate</span>
                <span className="performance-metric-value">
                  {summary.win_rate != null ? `${(summary.win_rate * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Return %</span>
                <span className="performance-metric-value">
                  {summary.return_pct != null ? `${summary.return_pct.toFixed(2)}%` : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Profit Factor</span>
                <span className="performance-metric-value">
                  {summary.profit_factor != null ? (Number.isFinite(summary.profit_factor) ? summary.profit_factor.toFixed(2) : '∞') : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Max drawdown</span>
                <span className="performance-metric-value tone-negative">
                  {summary.max_drawdown != null ? fmtUsd(-summary.max_drawdown) : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Avg win / Avg loss</span>
                <span className="performance-metric-value">
                  {fmtUsd(summary.avg_win)} / {fmtUsd(summary.avg_loss)}
                </span>
              </div>
            </div>
          </section>

          <section className="card" aria-label="Calendar PnL">
            <h3 className="card-subtitle">Calendar PnL</h3>
            {calendar.length === 0 ? (
              <p className="section-hint">No executions in the selected range.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table" role="grid">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Net PnL</th>
                      <th>Realized PnL</th>
                      <th>Commission</th>
                      <th>Trades</th>
                      <th>Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendar.map((row) => (
                      <tr key={row.period_label}>
                        <td>{row.period_label}</td>
                        <td className={row.net_pnl >= 0 ? 'tone-positive' : 'tone-negative'}>
                          {fmtUsd(row.net_pnl)}
                        </td>
                        <td>{fmtUsd(row.pnl)}</td>
                        <td>{fmtUsd(row.commission)}</td>
                        <td>{row.trade_count}</td>
                        <td>{row.win_rate != null ? `${(row.win_rate * 100).toFixed(1)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
