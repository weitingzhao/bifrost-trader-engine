import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IbAccountSnapshot, RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchQuotes, postExecutionsFetch, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

type DailyBenchmark = {
  bar_time: number
  close: number
  prev_close?: number | null
  is_today?: boolean
  is_stale?: boolean
}

type PriceSource = 'live' | 'db' | 'daemon' | null

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtExpiry(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '—'
  const s = String(raw).trim().replace(/\D/g, '')
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return raw
}

function getNetLiq(a: IbAccountSnapshot): number {
  const v = a.summary?.NetLiquidation
  if (v == null) return 0
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function rightLabel(r: string | undefined): string {
  if (!r) return '—'
  const u = String(r).toUpperCase()
  if (u === 'C' || u === 'CALL') return 'Call'
  if (u === 'P' || u === 'PUT') return 'Put'
  return r
}

/** 根据 price_updated_at (Unix 秒) 与当前时间差显示：秒 → 分钟 → 小时 → 天 */
function formatLastUpdate(updatedAtSec: number | null | undefined): string {
  if (updatedAtSec == null || !Number.isFinite(updatedAtSec)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - updatedAtSec))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

function optionIntrinsic(isCall: boolean, k: number, s: number): number {
  return isCall ? Math.max(0, s - k) : Math.max(0, k - s)
}

function optionMoneyness(isCall: boolean, k: number, s: number): string {
  if (!Number.isFinite(k) || !Number.isFinite(s)) return '—'
  if (Math.abs(s - k) < 0.01) return 'ATM'
  if (isCall) return s > k ? 'ITM' : 'OTM'
  return s < k ? 'ITM' : 'OTM'
}

function computeDailyChange(
  bench: DailyBenchmark | undefined,
  currPrice: number | null,
  qty: number,
): { changePct: number | null; pnlVsBench: number | null } {
  if (!bench || !Number.isFinite(bench.close) || bench.close <= 0) {
    return { changePct: null, pnlVsBench: null }
  }
  if (currPrice == null || !Number.isFinite(currPrice)) {
    return { changePct: null, pnlVsBench: null }
  }
  const prevClose =
    bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
      ? bench.prev_close
      : null
  const basePrice = bench.is_today && prevClose != null ? prevClose : bench.close
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return { changePct: null, pnlVsBench: null }
  }
  return {
    changePct: ((currPrice - basePrice) / basePrice) * 100,
    pnlVsBench: Number.isFinite(qty) ? (currPrice - basePrice) * qty : null,
  }
}

function resolvePreferredPrice(args: {
  liveQuote?: RealtimeQuote
  dbPrice?: number | null
  dbUpdatedAt?: number | null
  daemonSpot?: number | null
  daemonUpdatedAt?: number | null
}): { price: number | null; source: PriceSource; updatedAtSec: number | null } {
  const liveLast = args.liveQuote?.last
  if (liveLast != null && Number.isFinite(liveLast) && liveLast > 0) {
    return {
      price: liveLast,
      source: 'live',
      updatedAtSec:
        args.liveQuote?.ts != null && Number.isFinite(args.liveQuote.ts)
          ? args.liveQuote.ts
          : null,
    }
  }
  if (args.dbPrice != null && Number.isFinite(args.dbPrice) && args.dbPrice > 0) {
    return {
      price: args.dbPrice,
      source: 'db',
      updatedAtSec:
        args.dbUpdatedAt != null && Number.isFinite(args.dbUpdatedAt)
          ? args.dbUpdatedAt
          : null,
    }
  }
  if (args.daemonSpot != null && Number.isFinite(args.daemonSpot) && args.daemonSpot > 0) {
    return {
      price: args.daemonSpot,
      source: 'daemon',
      updatedAtSec:
        args.daemonUpdatedAt != null && Number.isFinite(args.daemonUpdatedAt)
          ? args.daemonUpdatedAt
          : null,
    }
  }
  return { price: null, source: null, updatedAtSec: null }
}

export interface IbAccountsPageProps {
  status: StatusResponse | null
  accountsDisplay: IbAccountSnapshot[] | null
  ibAccountIndex: number
  setIbAccountIndex: (i: number) => void
  ibAccountsRefreshing: boolean
  onRefreshAccounts: () => Promise<void>
  /** Short feedback after refresh (success/fail/timeout); cleared by parent after a few seconds */
  refreshFeedback?: string | null
}

export function IbAccountsPage({
  status,
  accountsDisplay,
  ibAccountIndex,
  setIbAccountIndex,
  ibAccountsRefreshing,
  onRefreshAccounts,
  refreshFeedback,
}: IbAccountsPageProps) {
  const j = status
  const rawAccounts = (accountsDisplay ?? j?.accounts) as IbAccountSnapshot[] | undefined
  const hasAccounts = Array.isArray(rawAccounts) && rawAccounts.length > 0
  const fetchedAt = j?.accounts_fetched_at
  const accounts = hasAccounts ? [...rawAccounts!].sort((a, b) => getNetLiq(b) - getNetLiq(a)) : []
  const selectedIndex = accounts.length > 0 ? Math.min(ibAccountIndex, accounts.length - 1) : 0
  const acc = accounts[selectedIndex]
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [replaySyncing, setReplaySyncing] = useState(false)

  const overviewTotals = useMemo(() => {
    const list = rawAccounts ?? []
    const optKeys = new Set<string>()
    let stockLines = 0
    let unrealizedPnl = 0
    for (const account of list) {
      for (const position of account.positions ?? []) {
        const qty = Number(position.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        if ((position.secType ?? '').toUpperCase() === 'OPT') {
          const expiry = position.lastTradeDateOrContractMonth ?? position.expiry ?? ''
          const strike = Number(position.strike) || 0
          const right = (position.right ?? '').toUpperCase().slice(0, 1)
          optKeys.add(position.contract_key ?? `${position.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`)
        } else {
          stockLines += 1
        }
        unrealizedPnl += Number(position.unrealized_pnl) || 0
      }
    }
    return { optionContracts: optKeys.size, stockLines, unrealizedPnl }
  }, [rawAccounts])

  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const stockSymbols = useMemo(() => {
    const positions = acc?.positions ?? []
    return [
      ...new Set(
        positions
          .filter((p) => (p.secType ?? '').toUpperCase() === 'STK')
          .map((p) => (p.symbol ?? '').trim())
          .filter(Boolean),
      ),
    ].map((s) => s.toUpperCase())
  }, [acc])
  useEffect(() => {
    if (stockSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(stockSymbols)
      .then((r) => {
        if (!cancelled) setBenchmarks(r.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [stockSymbols.join(',')])
  useEffect(() => {
    if (stockSymbols.length === 0) {
      setQuotesMap({})
      return
    }
    let cancelled = false
    fetchQuotes(stockSymbols)
      .then((res) => {
        if (cancelled || !res.quotes?.length) return
        setQuotesMap((prev) => {
          const next = { ...prev }
          res.quotes.forEach((q) => {
            next[q.symbol] = q
          })
          return next
        })
      })
      .catch(() => {})
    const symbolSet = new Set(stockSymbols.map((s) => s.toUpperCase()))
    const unsub = subscribeQuotes((q) => {
      const sym = (q.symbol || '').toUpperCase()
      if (!sym || !symbolSet.has(sym)) return
      setQuotesMap((prev) => ({ ...prev, [sym]: { ...q, symbol: sym } }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [stockSymbols.join(',')])

  if (!hasAccounts) {
    return (
      <div className="card process-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
            IB Accounts{' '}
            <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
          </h2>
          <button
            type="button"
            className="btn-resume"
            disabled={ibAccountsRefreshing}
            onClick={onRefreshAccounts}
            title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
          >
            {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {refreshFeedback != null && refreshFeedback !== '' && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
            {refreshFeedback}
          </p>
        )}

        <section className="replay-section" aria-labelledby="ib-portfolio-overview-head">
          <h3 id="ib-portfolio-overview-head">Portfolio overview</h3>
          <div className="risk-summary-cards">
            <div className="risk-card">
              <span className="risk-card-label">Accounts</span>
              <span className="risk-card-value">{status?.accounts?.length ?? 0}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Open option contracts</span>
              <span className="risk-card-value">{overviewTotals.optionContracts}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Stock lines</span>
              <span className="risk-card-value">{overviewTotals.stockLines}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">Unrealized PnL</span>
              <span className="risk-card-value">{fmtUsd(overviewTotals.unrealizedPnl)}</span>
            </div>
          </div>
          {fetchedAt != null && Number.isFinite(fetchedAt) && (
            <p className="section-hint replay-overview-fetched-at">
              Live positions snapshot from {new Date(fetchedAt * 1000).toLocaleString()}.
            </p>
          )}
        </section>

        <section className="replay-section" aria-labelledby="ib-fetch-head">
          <h3 id="ib-fetch-head">Fetch from IB</h3>
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch range">
              <span className="replay-fetch-days-label">Fetch</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={1} checked={replayFetchDays === 1} onChange={() => setReplayFetchDays(1)} disabled={replaySyncing} />
                <span>Today</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={3} checked={replayFetchDays === 3} onChange={() => setReplayFetchDays(3)} disabled={replaySyncing} />
                <span>Last 3 days</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={7} checked={replayFetchDays === 7} onChange={() => setReplayFetchDays(7)} disabled={replaySyncing} />
                <span>Last 7 days</span>
              </label>
              <button
                type="button"
                className="btn btn-small replay-fetch-refresh-btn"
                disabled={replaySyncing}
                onClick={async () => {
                  setReplaySyncing(true)
                  await postExecutionsFetch(replayFetchDays)
                  setReplaySyncing(false)
                }}
                aria-label="Fetch executions from IB and write to DB"
              >
                {replaySyncing ? 'Fetching…' : 'Refresh'}
              </button>
            </div>
            {replaySyncing && <span className="replay-sync-hint">Fetching executions from IB…</span>}
          </div>
        </section>

        <p className="section-hint">
          No account data (IB not connected or daemon has not written yet; after connection, data is pulled on heartbeat and written to accounts / account_positions)
        </p>
      </div>
    )
  }

  const aid = acc.account_id ?? `Account-${selectedIndex + 1}`
  const sum = acc.summary ?? {}
  const netLiq = sum.NetLiquidation != null ? parseFloat(String(sum.NetLiquidation)) : undefined
  const totalCash = sum.TotalCashValue != null ? parseFloat(String(sum.TotalCashValue)) : undefined
  const buyingPower = sum.BuyingPower != null ? parseFloat(String(sum.BuyingPower)) : undefined
  const positions = acc.positions ?? []
  const stockPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() !== 'OPT')
  const optionPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() === 'OPT')
  const spot =
    status?.status?.spot != null && Number.isFinite(Number(status.status.spot))
      ? Number(status.status.spot)
      : null
  const statusTs =
    status?.status?.ts != null && Number.isFinite(Number(status.status.ts))
      ? Number(status.status.ts)
      : null

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
          IB Accounts{' '}
          <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
        </h2>
        <button
          type="button"
          className="btn-resume"
          disabled={ibAccountsRefreshing}
          onClick={onRefreshAccounts}
          title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
        >
          {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {refreshFeedback != null && refreshFeedback !== '' && (
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
          {refreshFeedback}
        </p>
      )}

      {fetchedAt != null && Number.isFinite(fetchedAt) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data from {new Date(fetchedAt * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })}
          , {(() => {
            const sec = Math.floor(Date.now() / 1000 - fetchedAt)
            if (sec < 60) return `${sec}s ago`
            if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
            return `${(sec / 3600).toFixed(1)}h ago`
          })()}
        </p>
      )}
      {hasAccounts && (fetchedAt == null || !Number.isFinite(fetchedAt)) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data time unknown (click "Refresh" to have monitor fetch from IB and write to DB; fetch time will appear here)
        </p>
      )}

      <section className="replay-section" aria-labelledby="ib-portfolio-overview-head">
        <h3 id="ib-portfolio-overview-head">Portfolio overview</h3>
        <div className="risk-summary-cards">
          <div className="risk-card">
            <span className="risk-card-label">Accounts</span>
            <span className="risk-card-value">{accounts.length}</span>
          </div>
          <div className="risk-card">
            <span className="risk-card-label">Open option contracts</span>
            <span className="risk-card-value">{overviewTotals.optionContracts}</span>
          </div>
          <div className="risk-card">
            <span className="risk-card-label">Stock lines</span>
            <span className="risk-card-value">{overviewTotals.stockLines}</span>
          </div>
          <div className="risk-card">
            <span className="risk-card-label">Unrealized PnL</span>
            <span className="risk-card-value">{fmtUsd(overviewTotals.unrealizedPnl)}</span>
          </div>
        </div>
        {fetchedAt != null && Number.isFinite(fetchedAt) && (
          <p className="section-hint replay-overview-fetched-at">
            Live positions snapshot from {new Date(fetchedAt * 1000).toLocaleString()}.
          </p>
        )}
      </section>

      <section className="replay-section" aria-labelledby="ib-fetch-head">
        <h3 id="ib-fetch-head">Fetch from IB</h3>
        <div className="replay-toolbar">
          <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch range">
            <span className="replay-fetch-days-label">Fetch</span>
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={1} checked={replayFetchDays === 1} onChange={() => setReplayFetchDays(1)} disabled={replaySyncing} />
              <span>Today</span>
            </label>
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={3} checked={replayFetchDays === 3} onChange={() => setReplayFetchDays(3)} disabled={replaySyncing} />
              <span>Last 3 days</span>
            </label>
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={7} checked={replayFetchDays === 7} onChange={() => setReplayFetchDays(7)} disabled={replaySyncing} />
              <span>Last 7 days</span>
            </label>
            <button
              type="button"
              className="btn btn-small replay-fetch-refresh-btn"
              disabled={replaySyncing}
              onClick={async () => {
                setReplaySyncing(true)
                const res = await postExecutionsFetch(replayFetchDays)
                if (res.ok) await onRefreshAccounts()
                setReplaySyncing(false)
              }}
              aria-label="Fetch executions from IB and write to DB"
            >
              {replaySyncing ? 'Fetching…' : 'Refresh'}
            </button>
          </div>
          {replaySyncing && <span className="replay-sync-hint">Fetching executions from IB…</span>}
        </div>
      </section>

      <div className="ib-accounts-wrap">
        {accounts.length > 1 && (
          <div className="ib-accounts-tabs">
            {accounts.map((a, idx) => (
              <button
                key={a.account_id ?? idx}
                type="button"
                className={`ib-accounts-tab ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => setIbAccountIndex(idx)}
              >
                {a.account_id ?? `Account-${idx + 1}`}
                {(a.positions?.length ?? 0) > 0 && (
                  <span className="section-hint" style={{ marginLeft: '0.35rem', fontWeight: 'normal' }}>
                    ({a.positions!.length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="ib-accounts-content">
          <div className="ib-summary-row">
            <div className="ib-summary-item">
              <span className="label">Account</span>
              <span className="value">{aid}</span>
            </div>
            {netLiq != null && Number.isFinite(netLiq) && (
              <div className="ib-summary-item">
                <span className="label">Net liquidation</span>
                <span className="value">{fmtUsd(netLiq)}</span>
              </div>
            )}
            {totalCash != null && Number.isFinite(totalCash) && (
              <div className="ib-summary-item">
                <span className="label">Total cash</span>
                <span className="value">{fmtUsd(totalCash)}</span>
              </div>
            )}
            {buyingPower != null && Number.isFinite(buyingPower) && (
              <div className="ib-summary-item">
                <span className="label">Buying power</span>
                <span className="value">{fmtUsd(buyingPower)}</span>
              </div>
            )}
          </div>

          <div className="ib-positions-title">Stock positions</div>
          {stockPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <table className="ib-positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Cost</th>
                    <th>Total cost</th>
                    <th>Market</th>
                    <th>Daily %</th>
                    <th>Daily $</th>
                    <th>PnL (Cost)</th>
                    <th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {stockPositions.map((pos, i) => {
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const totalCost = Number.isFinite(qty) && Number.isFinite(cost) ? qty * cost : null
                    const sym = (pos.symbol ?? '').toString().toUpperCase()
                    const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
                    const perPrice =
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null
                    const showSpotForRow =
                      spot != null &&
                      Number.isFinite(spot) &&
                      sym !== '' &&
                      mainSym !== '' &&
                      sym === mainSym
                    const priceInfo = resolvePreferredPrice({
                      liveQuote: quotesMap[sym],
                      dbPrice: perPrice,
                      dbUpdatedAt:
                        pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                          ? Number(pos.price_updated_at)
                          : null,
                      daemonSpot: showSpotForRow ? spot : null,
                      daemonUpdatedAt: showSpotForRow ? statusTs : null,
                    })
                    const currPrice = priceInfo.price
                    const pnl =
                      pos.unrealized_pnl != null && Number.isFinite(pos.unrealized_pnl)
                        ? (priceInfo.source === 'db' ? pos.unrealized_pnl : (
                            currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                              ? (currPrice - cost) * qty
                              : pos.unrealized_pnl
                          ))
                        : currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                          ? (currPrice - cost) * qty
                          : null
                    const bench = benchmarks[sym]
                    const { changePct, pnlVsBench } = computeDailyChange(bench, currPrice, qty)
                    const marketColor =
                      currPrice != null && Number.isFinite(cost)
                        ? (currPrice > cost ? 'var(--color-success, green)' : currPrice < cost ? 'var(--color-danger, #c00)' : undefined)
                        : undefined
                    const pnlColor =
                      pnl != null ? (pnl > 0 ? 'var(--color-success, green)' : pnl < 0 ? 'var(--color-danger, #c00)' : undefined) : undefined
                    return (
                      <tr key={`stk-${pos.symbol}-${i}`} className="ib-pos-stock">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{totalCost != null ? fmtUsd(totalCost) : '—'}</td>
                        <td style={marketColor ? { color: marketColor, fontWeight: 600 } : undefined}>
                          {currPrice != null ? fmtUsd(currPrice) : '—'}
                        </td>
                        <td>
                          {changePct != null && Number.isFinite(changePct) ? (
                            <span style={{ color: changePct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                            <span style={{ color: pnlVsBench >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {fmtUsd(pnlVsBench)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td style={pnlColor ? { color: pnlColor, fontWeight: 600 } : undefined}>
                          {pnl != null ? fmtUsd(pnl) : '—'}
                        </td>
                        <td>
                          {priceInfo.updatedAtSec != null ? formatLastUpdate(priceInfo.updatedAtSec) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {(() => {
                const sumTotal = stockPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                  return acc
                }, 0)
                const sumPnl = stockPositions.reduce((acc, pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
                  const priceInfo = resolvePreferredPrice({
                    liveQuote: quotesMap[sym],
                    dbPrice:
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null,
                    dbUpdatedAt:
                      pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                        ? Number(pos.price_updated_at)
                        : null,
                    daemonSpot:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? spot
                        : null,
                    daemonUpdatedAt:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? statusTs
                        : null,
                  })
                  const p =
                    priceInfo.price != null && pos.avgCost != null && pos.position != null &&
                    Number.isFinite(priceInfo.price) && Number.isFinite(pos.avgCost) && Number.isFinite(pos.position)
                      ? (Number(priceInfo.price) - Number(pos.avgCost)) * Number(pos.position)
                      : NaN
                  return Number.isFinite(p) ? acc + p : acc
                }, 0)
                const sumDailyDollar = stockPositions.reduce((acc, pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const bench = benchmarks[sym]
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
                  const currPrice = resolvePreferredPrice({
                    liveQuote: quotesMap[sym],
                    dbPrice:
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null,
                    dbUpdatedAt:
                      pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                        ? Number(pos.price_updated_at)
                        : null,
                    daemonSpot:
                      spot != null && Number.isFinite(spot) && sym === mainSym
                        ? spot
                        : null,
                    daemonUpdatedAt:
                      spot != null && Number.isFinite(spot) && sym === mainSym
                        ? statusTs
                        : null,
                  }).price
                  const daily = computeDailyChange(bench, currPrice, qty)
                  if (daily.pnlVsBench != null && Number.isFinite(daily.pnlVsBench))
                    return acc + daily.pnlVsBench
                  return acc
                }, 0)
                const totalPct = Number.isFinite(sumTotal) && sumTotal !== 0 && Number.isFinite(sumPnl)
                  ? (sumPnl / sumTotal) * 100
                  : null
                return (
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Stock total cost: {fmtUsd(sumTotal)}
                    {Number.isFinite(sumPnl) && (
                      <span style={{ marginLeft: '1rem', color: sumPnl >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}>
                        PnL (Cost) Total $: {fmtUsd(sumPnl)}
                      </span>
                    )}
                    {Number.isFinite(sumDailyDollar) && (
                      <span style={{ marginLeft: '1rem', color: sumDailyDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}>
                        Daily $ Total: {fmtUsd(sumDailyDollar)}
                      </span>
                    )}
                    {totalPct != null && Number.isFinite(totalPct) && (
                      <span style={{ marginLeft: '1rem', color: totalPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}>
                        Total %: {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%
                      </span>
                    )}
                  </p>
                )
              })()}
            </>
          )}

          <div className="ib-positions-title" style={{ marginTop: '1rem' }}>Option positions</div>
          {optionPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <table className="ib-positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Right</th>
                    <th>Expiry</th>
                    <th>Strike</th>
                    <th>Qty</th>
                    <th>Side</th>
                    <th>Cost</th>
                    <th>Premium</th>
                    <th>Intrinsic</th>
                    <th>Moneyness</th>
                  </tr>
                </thead>
                <tbody>
                  {optionPositions.map((pos, i) => {
                    const expiryRaw = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
                    const strike = pos.strike != null ? Number(pos.strike) : NaN
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const right = (pos.right ?? '').toUpperCase()
                    const isCall = right === 'C' || right === 'CALL'
                    const premium = Number.isFinite(qty) && Number.isFinite(cost) ? -(qty * cost) : null
                    const intrinsic = spot != null && Number.isFinite(strike) ? optionIntrinsic(isCall, strike, spot) : null
                    const moneyness = spot != null && Number.isFinite(strike) ? optionMoneyness(isCall, strike, spot) : '—'
                    const sideLabel = Number.isFinite(qty) ? (qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—') : '—'
                    return (
                      <tr key={`opt-${pos.symbol}-${i}`} className="ib-pos-opt">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{rightLabel(pos.right)}</td>
                        <td>{expiryRaw ? fmtExpiry(expiryRaw) : '—'}</td>
                        <td>{Number.isFinite(strike) ? fmtUsd(strike) : '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{sideLabel}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{premium != null ? fmtUsd(premium) : '—'}</td>
                        <td>{intrinsic != null ? fmtUsd(intrinsic) : '—'}</td>
                        <td>{moneyness}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {(() => {
                const sumPremium = optionPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc - qty * cost
                  return acc
                }, 0)
                if (!Number.isFinite(sumPremium)) return null
                return (
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Option premium total: {fmtUsd(sumPremium)}
                    {spot != null && (
                      <span className="section-desc" style={{ marginLeft: '0.5rem' }}>
                        (spot {fmtUsd(spot)})
                      </span>
                    )}
                  </p>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
