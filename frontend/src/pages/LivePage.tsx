import { useEffect, useMemo, useState } from 'react'
import type { RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchQuotes, subscribeQuotes } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtSince(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - ts))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

export interface LivePageProps {
  status: StatusResponse | null
}

export function LivePage({ status }: LivePageProps) {
  const j = status
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, { bar_time: number; close: number }>>({})

  const watchlistSymbols = useMemo(
    () => [...new Set([...(j?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [j?.subscribed_tickers, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [...new Set([...watchlistSymbols, ...(j?.reference_indices?.map((r: { symbol: string }) => r.symbol) ?? [])])].sort(),
    [watchlistSymbols, j?.reference_indices],
  )

  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((r) => {
        if (!cancelled) setBenchmarks(r.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap((prev) => {
            const next = { ...prev }
            res.quotes!.forEach((q) => {
              next[q.symbol] = q
            })
            return next
          })
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => ({ ...prev, [q.symbol]: q }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const hb = j?.daemon_heartbeat
  const marketStreamsOk =
    j?.redis_quotes_connected === true && hb?.daemon_alive === true && hb?.event_subscribe_ticker === true
  const accountsList = j?.accounts ?? []
  const watchlistRows = watchlistSymbols.map((symbol) => {
    let qty = 0
    let totalCost = 0
    let hasCost = false
    for (const acc of accountsList) {
      const positions = acc?.positions ?? []
      for (const p of positions) {
        const sym = (p.symbol ?? '').trim()
        const secType = (p.secType ?? '').toString().toUpperCase()
        const posQty = typeof p.position === 'number' ? p.position : 0
        if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
        qty += posQty
        if (p.avgCost != null && Number.isFinite(p.avgCost as number)) {
          totalCost += (p.avgCost as number) * posQty
          hasCost = true
        }
      }
    }
    const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
    const quote = quotesMap[symbol]
    const bench = benchmarks[symbol]
    let changePct: number | null = null
    let pnlVsBench: number | null = null
    if (bench && quote && Number.isFinite(quote.last) && Number.isFinite(bench.close) && bench.close > 0) {
      changePct = ((quote.last - bench.close) / bench.close) * 100
      if (qty != null && Number.isFinite(qty)) pnlVsBench = (quote.last - bench.close) * qty
    }
    const pnlCost =
      quote && avgCost != null && Number.isFinite(quote.last) && qty != null && Number.isFinite(qty) && qty !== 0
        ? (quote.last - avgCost) * qty
        : null
    return { symbol, quote, qty: qty || null, avgCost, changePct, pnlVsBench, pnlCost }
  })

  return (
    <div className="app-page-stack">
      <div className="card card-operations realtime-quotes-card">
        <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
          <div className="lamp-wrap-span">
            <div className={`lamp lamp-sm ${marketStreamsOk ? 'green' : 'red'}`} title="Market streams: green when daemon alive, subscribed to ticker, and monitor reads Redis" aria-hidden />
          </div>
          <div>
            <h2 className="daemon-card-title page-title-with-tooltip">
              Market Streams
              <InfoTooltip
                text={
                  marketStreamsOk
                    ? `Ticker data from daemon subscription, pushed via Redis to monitor. Symbols: Watchlist STK + strategy symbol. Daemon alive and Event subscription active. SSE connected, ${watchlistSymbols.length} symbol(s); prices & PnL update when stream arrives.`
                    : 'Ticker data from daemon subscription, pushed via Redis to monitor. Symbols: Watchlist STK + strategy symbol. Requires daemon running (green), Redis, and daemon Event subscription. If daemon is red, streams are offline.'
                }
              />
            </h2>
          </div>
        </div>
        <div className="realtime-quotes-table-wrap">
          <table className="table-operations realtime-quotes-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Cost</th>
                <th>Daily %</th>
                <th>Daily $</th>
                <th>SINCE %</th>
                <th>SINCE $</th>
                <th>Last</th>
                <th>Bid</th>
                <th>Ask</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {watchlistRows.length === 0 ? (
                <tr>
                  <td colSpan={11}>No symbols in watchlist (add symbols in Watchlist or ensure daemon is running)</td>
                </tr>
              ) : (
                watchlistRows.map((row) => {
                  const { symbol, quote: q, qty, avgCost, changePct, pnlVsBench, pnlCost } = row
                  return (
                    <tr key={symbol}>
                      <td><strong>{symbol}</strong></td>
                      <td className="realtime-quote-num">{qty != null && Number.isFinite(qty) ? qty : '—'}</td>
                      <td className="realtime-quote-num">{avgCost != null && Number.isFinite(avgCost) ? fmtUsd(avgCost) : '—'}</td>
                      <td className="realtime-quote-num">
                        {changePct != null && Number.isFinite(changePct) ? (
                          <span className={changePct > 0 ? 'pnl-positive' : changePct < 0 ? 'pnl-negative' : ''}>
                            {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">
                        {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                          <span className={pnlVsBench > 0 ? 'pnl-positive' : pnlVsBench < 0 ? 'pnl-negative' : ''}>
                            {fmtUsd(pnlVsBench)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">
                        {(() => {
                          if (avgCost == null || !Number.isFinite(avgCost) || avgCost <= 0 || !q?.last || !Number.isFinite(q.last)) return '—'
                          const sincePct = ((q.last - avgCost) / avgCost) * 100
                          return (
                            <span className={sincePct > 0 ? 'pnl-positive' : sincePct < 0 ? 'pnl-negative' : ''}>
                              {sincePct >= 0 ? '+' : ''}{sincePct.toFixed(2)}%
                            </span>
                          )
                        })()}
                      </td>
                      <td className="realtime-quote-num">
                        {pnlCost != null && Number.isFinite(pnlCost) ? (
                          <span className={pnlCost > 0 ? 'pnl-positive' : pnlCost < 0 ? 'pnl-negative' : ''}>
                            {fmtUsd(pnlCost)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.last) : '—'}</td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.bid ?? null) : '—'}</td>
                      <td className="realtime-quote-num">{q ? fmtUsd(q.ask ?? null) : '—'}</td>
                      <td className="realtime-quote-since">{q ? fmtSince(q.ts) : '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {watchlistRows.length > 0 &&
          (() => {
            const totalCostPnl = watchlistRows.reduce((acc, row) => {
              const v = row.pnlCost
              return acc + (v != null && Number.isFinite(v) ? v : 0)
            }, 0)
            const totalCost = watchlistRows.reduce((acc, row) => {
              const qty = row.qty != null && Number.isFinite(row.qty) ? row.qty : 0
              const cost = row.avgCost != null && Number.isFinite(row.avgCost) ? row.avgCost : 0
              return acc + qty * cost
            }, 0)
            const totalPct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
            const totalDailyDollar = watchlistRows.reduce((acc, row) => {
              const v = row.pnlVsBench
              return acc + (v != null && Number.isFinite(v) ? v : 0)
            }, 0)
            const sumLastQty = watchlistRows.reduce((acc, row) => {
              const qty = row.qty != null && Number.isFinite(row.qty) ? row.qty : 0
              const last = row.quote?.last != null && Number.isFinite(row.quote.last) ? row.quote.last : 0
              return acc + last * qty
            }, 0)
            const totalDailyDenom = sumLastQty - totalDailyDollar
            const totalDailyPct =
              totalDailyDenom > 0 && Number.isFinite(totalDailyDollar)
                ? (totalDailyDollar / totalDailyDenom) * 100
                : null
            return (
              <p className="replay-sync-hint watchlist-summary-row" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                <span className="watchlist-summary-segment">
                  Total $:{' '}
                  <span
                    className="watchlist-summary-value"
                    style={{ color: totalCostPnl >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}
                  >
                    {fmtUsd(totalCostPnl)}
                  </span>
                </span>
                {totalPct != null && Number.isFinite(totalPct) && (
                  <span className="watchlist-summary-segment">
                    Total %:{' '}
                    <span
                      className="watchlist-summary-value watchlist-summary-value-pct"
                      style={{ color: totalPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)' }}
                    >
                      {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}%
                    </span>
                  </span>
                )}
                {(Number.isFinite(totalDailyDollar) || (totalDailyPct != null && Number.isFinite(totalDailyPct))) && (
                  <>
                    <span className="watchlist-summary-segment">
                      Daily $:{' '}
                      <span
                        className="watchlist-summary-value"
                        style={{
                          color: totalDailyDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                        }}
                      >
                        {fmtUsd(totalDailyDollar)}
                      </span>
                    </span>
                    {totalDailyPct != null && Number.isFinite(totalDailyPct) && (
                      <span className="watchlist-summary-segment">
                        Daily %:{' '}
                        <span
                          className="watchlist-summary-value watchlist-summary-value-pct"
                          style={{
                            color:
                              totalDailyPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                          }}
                        >
                          {totalDailyPct >= 0 ? '+' : ''}{totalDailyPct.toFixed(2)}%
                        </span>
                      </span>
                    )}
                  </>
                )}
              </p>
            )
          })()}
      </div>
    </div>
  )
}
