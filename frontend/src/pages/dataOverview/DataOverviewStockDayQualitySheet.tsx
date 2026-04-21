import { useEffect, useRef } from 'react'
import type { StockDayQualityDetailResponse, StockDayQualityDailyRow } from '../../api'

interface Props {
  open: boolean
  onClose: () => void
  symbol: string | null
  data: StockDayQualityDetailResponse | null
  loading?: boolean
}

function qualityClass(pct: number | null): string {
  if (pct == null) return ''
  const base = 'data-overview-wl-matrix__completeness-pct'
  if (pct >= 97) return `${base} ${base}--ok`
  if (pct >= 85) return `${base} ${base}--warn`
  return `${base} ${base}--bad`
}

function PctCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span>—</span>
  return <span className={qualityClass(pct)}>{pct}%</span>
}

function DailyTable({ rows }: { rows: StockDayQualityDailyRow[] }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No bars found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">OHLC%</th>
            <th scope="col">Volume%</th>
            <th scope="col">VWAP%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.bar_date}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.bar_date}</td>
              <td><PctCell pct={r.ohlc_pct} /></td>
              <td><PctCell pct={r.volume_pct} /></td>
              <td><PctCell pct={r.vwap_pct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DataOverviewStockDayQualitySheet({ open, onClose, symbol, data, loading }: Props) {
  const asideRef = useRef<HTMLDivElement | null>(null)

  // Keyboard close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus trap
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-gap-explain-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-stock-day-quality-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-stock-day-quality-title" className="ref-jobs-sheet-title">
            Bar Quality — <code>stock_day</code>{symbol ? ` · ${symbol}` : ''}
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="ref-jobs-sheet-body">
          {loading ? (
            <p className="data-overview-gap-sheet__muted">Loading…</p>
          ) : data?.error ? (
            <p className="data-overview-gap-sheet__err" role="alert">{data.error}</p>
          ) : data ? (
            <>
              <h4 style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                Daily history (last 90 days){data.latest_date ? ` — latest bar: ${data.latest_date}` : ''}
              </h4>
              <DailyTable rows={data.daily} />
            </>
          ) : (
            <p className="data-overview-gap-sheet__muted">No data.</p>
          )}
        </div>
      </aside>
    </div>
  )
}
