import { useEffect, useState } from 'react'
import { fetchBarsBenchmark } from '../api'
import type { LivePositionRow } from '../pages/portfolio/types'
import { fmtPctCompact, fmtUsd } from '../utils/format'
import { StockBarStatsPanel } from './StockBarStatsPanel'

function fmtMarketValue(position: LivePositionRow): string {
  const q = Number(position.position)
  const px = position.price != null ? Number(position.price) : NaN
  if (!Number.isFinite(q) || !Number.isFinite(px)) return '—'
  return fmtUsd(q * px)
}

export function StockInspectorPanel({
  symbol,
  accountId,
  position,
  onClose,
}: {
  symbol: string
  accountId: string
  position: LivePositionRow
  onClose: () => void
}) {
  const symU = (symbol || '').trim().toUpperCase()
  const qty = Number(position.position)
  const lastPrice = position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null
  const avgCost = position.avgCost != null && Number.isFinite(Number(position.avgCost)) ? Number(position.avgCost) : null
  const prevClose =
    position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
      ? Number(position.daily_prev_close)
      : null
  const pnl =
    position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
      ? Number(position.unrealized_pnl)
      : null
  const sincePct =
    pnl != null && avgCost != null && avgCost !== 0 && Number.isFinite(qty) ? (pnl / (Math.abs(avgCost * qty))) * 100 : null
  const dailyPnl =
    lastPrice != null && prevClose != null && Number.isFinite(qty) ? (lastPrice - prevClose) * qty : null
  const dailyPct =
    dailyPnl != null && prevClose != null && prevClose !== 0 ? ((lastPrice! - prevClose) / prevClose) * 100 : null

  const [benchClose, setBenchClose] = useState<number | null>(null)
  const [benchLoading, setBenchLoading] = useState(false)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setBenchLoading(true)
    fetchBarsBenchmark([symU])
      .then(({ benchmarks }) => {
        if (cancelled) return
        const b = benchmarks[symU]
        const c = b?.close != null && Number.isFinite(b.close) ? b.close : null
        setBenchClose(c)
      })
      .catch(() => {
        if (!cancelled) setBenchClose(null)
      })
      .finally(() => {
        if (!cancelled) setBenchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symU])

  return (
    <div className="riv-stock-inspector" aria-label="Stock position detail">
      <div className="od-detail-header riv-stock-inspector-header">
        <h3 className="od-detail-title">
          {symU}
          <span className="od-detail-expiry"> · {accountId}</span>
        </h3>
        <button type="button" className="od-detail-close" onClick={onClose} aria-label="Close stock inspector">
          ✕
        </button>
      </div>

      <div className="od-contract-detail-stack">
        <section className="od-detail-section" aria-labelledby="riv-stock-sec-position">
          <h4 id="riv-stock-sec-position" className="od-detail-section-title">
            Position
          </h4>
          <div className="od-kv-grid">
            <span className="od-kv-k">Side</span>
            <span className="od-kv-v">{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</span>
            <span className="od-kv-k">Qty</span>
            <span className="od-kv-v">{Number.isFinite(qty) ? String(qty) : '—'}</span>
            <span className="od-kv-k">Avg cost</span>
            <span className="od-kv-v">{fmtUsd(position.avgCost)}</span>
            <span className="od-kv-k">Last</span>
            <span className="od-kv-v">{fmtUsd(position.price)}</span>
            <span className="od-kv-k">Market value</span>
            <span className="od-kv-v">{fmtMarketValue(position)}</span>
            <span className="od-kv-k">Daily $</span>
            <span className={`od-kv-v ${(dailyPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {dailyPnl != null ? fmtUsd(dailyPnl) : '—'}
            </span>
            <span className="od-kv-k">Daily %</span>
            <span className={`od-kv-v ${(dailyPct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {dailyPct != null ? fmtPctCompact(dailyPct) : '—'}
            </span>
            <span className="od-kv-k">Since $</span>
            <span className={`od-kv-v ${(pnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{pnl != null ? fmtUsd(pnl) : '—'}</span>
            <span className="od-kv-k">Since %</span>
            <span className={`od-kv-v ${(sincePct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {sincePct != null ? fmtPctCompact(sincePct) : '—'}
            </span>
          </div>
        </section>

        <section className="od-detail-section" aria-labelledby="riv-stock-sec-benchmark">
          <h4 id="riv-stock-sec-benchmark" className="od-detail-section-title">
            Daily benchmark
          </h4>
          {benchLoading && <p className="section-hint">Loading stock_day close…</p>}
          {!benchLoading && benchClose != null && (
            <div className="od-kv-grid">
              <span className="od-kv-k">stock_day close</span>
              <span className="od-kv-v">{fmtUsd(benchClose)}</span>
            </div>
          )}
          {!benchLoading && benchClose == null && <p className="section-hint">No benchmark bar for this symbol.</p>}
        </section>

        <StockBarStatsPanel symbol={symU} embedded />
      </div>
    </div>
  )
}
