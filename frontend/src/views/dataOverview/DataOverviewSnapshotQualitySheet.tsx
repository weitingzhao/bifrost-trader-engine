import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  fetchSnapshotQualityDetail,
  type SnapshotQualityDailyRow,
  type SnapshotQualityDetailResponse,
  type SnapshotQualityExpiryRow,
} from '../../api/research/research'

interface Props {
  open: boolean
  onClose: () => void
  symbol: string | null
  source?: string
}

/** Health class matching completenessPctHealthClass in WatchlistOptions. */
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

function DailyTable({ rows }: { rows: SnapshotQualityDailyRow[] }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No snapshots found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Contracts</th>
            <th scope="col">IV%</th>
            <th scope="col">Greeks%</th>
            <th scope="col">OI%</th>
            <th scope="col">Price%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.snap_day}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.snap_day}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.contract_count.toLocaleString()}</td>
              <td><PctCell pct={r.iv_pct} /></td>
              <td><PctCell pct={r.full_greeks_pct} /></td>
              <td><PctCell pct={r.oi_pct} /></td>
              <td><PctCell pct={r.day_price_pct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ExpiryTable({ rows, latestDate }: { rows: SnapshotQualityExpiryRow[]; latestDate: string | null }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No expiry data found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Expiry{latestDate ? ` (${latestDate})` : ''}</th>
            <th scope="col">DTE</th>
            <th scope="col">Contracts</th>
            <th scope="col">IV%</th>
            <th scope="col">Greeks%</th>
            <th scope="col">OI%</th>
            <th scope="col">Price%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.expiry}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.expiry}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.dte ?? '—'}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.contract_count.toLocaleString()}</td>
              <td><PctCell pct={r.iv_pct} /></td>
              <td><PctCell pct={r.full_greeks_pct} /></td>
              <td><PctCell pct={r.oi_pct} /></td>
              <td><PctCell pct={r.day_price_pct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DataOverviewSnapshotQualitySheet({ open, onClose, symbol, source = 'massive' }: Props) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<SnapshotQualityDetailResponse | null>(null)

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

  // Fetch data when opened for a symbol
  useEffect(() => {
    if (!open || !symbol) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setData(null)
    fetchSnapshotQualityDetail(symbol, source).then(result => {
      if (!cancelled) { setData(result); setLoading(false) }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, symbol, source])

  if (!open) return null

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-gap-explain-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-snapshot-quality-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-snapshot-quality-title" className="ref-jobs-sheet-title">
            Snapshot Quality{symbol ? ` — ${symbol}` : ''}
          </h3>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        <div className="ref-jobs-sheet-body">
          {loading ? (
            <p className="data-overview-gap-sheet__muted">Loading…</p>
          ) : data?.error ? (
            <p className="data-overview-gap-sheet__err" role="alert">{data.error}</p>
          ) : data ? (
            <>
              <h4 style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                Daily history (last 30 days, latest snapshot per contract per day)
              </h4>
              <DailyTable rows={data.daily} />

              <h4 style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                By expiry{data.latest_date ? ` (${data.latest_date} latest snapshot)` : ''}
              </h4>
              <ExpiryTable rows={data.expiries} latestDate={data.latest_date} />
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
