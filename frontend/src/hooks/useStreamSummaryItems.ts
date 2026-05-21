import { useMemo } from 'react'
import type { StatusResponse, RealtimeQuote } from '../types'
import type { DailyBenchmark } from '../views/accounts/accountsUtils'
import { computeDailyChange, quoteDisplayLast } from '../views/accounts/accountsUtils'
import { fmtPctCompact, fmtUsdCompact } from '../utils/format'
import type { StreamSummaryItem, StreamTone } from '../components/DashboardStrip'

function toneForNumber(value: number | null | undefined): StreamTone {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

/**
 * Aggregates watchlist symbols into dashboard stream summary items:
 * per-symbol daily P&L rows + total daily % and $.
 */
export function useStreamSummaryItems(
  status: StatusResponse | null,
  quotesMap: Record<string, RealtimeQuote>,
  benchmarks: Record<string, DailyBenchmark>,
  marketStreamsOk: boolean,
): StreamSummaryItem[] {
  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.live_ui?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.live_ui?.subscribed_tickers, quotesMap],
  )

  return useMemo<StreamSummaryItem[]>(() => {
    const accountsList = status?.portfolio?.accounts ?? []
    const rows = watchlistSymbols.map((symbol) => {
      let qty = 0; let totalCost = 0; let hasCost = false
      for (const acc of accountsList) {
        for (const p of acc?.positions ?? []) {
          const sym = (p.symbol || '').trim()
          const secType = (p.secType || '').toString().toUpperCase()
          const posQty = typeof p.position === 'number' ? p.position : 0
          if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
          qty += posQty
          if (p.avgCost != null && Number.isFinite(p.avgCost as number)) {
            totalCost += (p.avgCost as number) * posQty; hasCost = true
          }
        }
      }
      const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
      const symKey = (symbol || '').trim().toUpperCase()
      const quote = quotesMap[symKey] ?? quotesMap[symbol]
      const bench = benchmarks[symKey]
      const curr = quoteDisplayLast(quote)
      const { changePct, pnlVsBench } = computeDailyChange(bench, curr, qty ?? 0)
      const pnlCost = curr != null && avgCost != null && Number.isFinite(qty) && qty !== 0 ? (curr - avgCost) * qty : null
      return { qty, avgCost, pnlCost, pnlVsBench, changePct }
    })

    const totalDailyDollar = rows.reduce(
      (acc, row) => acc + (row.pnlVsBench != null && Number.isFinite(row.pnlVsBench) ? row.pnlVsBench : 0),
      0,
    )
    const sumLastQty = watchlistSymbols.reduce((acc, symbol, index) => {
      const qty = Number.isFinite(rows[index]?.qty) ? rows[index]!.qty : 0
      const sk = (symbol || '').trim().toUpperCase()
      const last = quoteDisplayLast(quotesMap[sk] ?? quotesMap[symbol]) ?? 0
      return acc + last * qty
    }, 0)
    const totalDailyDenom = sumLastQty - totalDailyDollar
    const totalDailyPct =
      totalDailyDenom > 0 && Number.isFinite(totalDailyDollar)
        ? (totalDailyDollar / totalDailyDenom) * 100
        : null

    return [
      {
        label: 'Market Streams',
        value: marketStreamsOk ? 'Online' : 'Offline',
        tone: marketStreamsOk ? 'positive' : 'negative',
      },
      ...watchlistSymbols.map((symbol, i) => {
        const row = rows[i]
        const pct = row?.changePct ?? null
        const dollar = row?.pnlVsBench ?? null
        const valueStr =
          pct != null && dollar != null
            ? `${fmtPctCompact(pct)} / ${fmtUsdCompact(dollar)}`
            : pct != null
              ? fmtPctCompact(pct)
              : dollar != null
                ? fmtUsdCompact(dollar)
                : '—'
        return { label: symbol, value: valueStr, tone: toneForNumber(pct ?? dollar) }
      }),
      { label: 'Daily %', value: fmtPctCompact(totalDailyPct), tone: toneForNumber(totalDailyPct) },
      { label: 'Daily $', value: fmtUsdCompact(totalDailyDollar), tone: toneForNumber(totalDailyDollar) },
    ]
  }, [status?.portfolio?.accounts, status?.live_ui?.reference_indices, watchlistSymbols, quotesMap, benchmarks, marketStreamsOk])
}
