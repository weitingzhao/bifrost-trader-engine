import { useEffect, useRef, useState } from 'react'
import {
  fetchBarQualityDetail,
  type BarQualityDailyRow,
  type BarQualityDetailResponse,
  type BarQualityExpiryRow,
  type BarQualityPeriodRow,
} from '../../api/research/research'

interface Props {
  open: boolean
  onClose: () => void
  symbol: string | null
  table: 'option_day' | 'option_min'
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

function DailyTable({ rows }: { rows: BarQualityDailyRow[] }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No bars found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Contracts</th>
            <th scope="col">OHLC%</th>
            <th scope="col">Volume%</th>
            <th scope="col">VWAP%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.bar_day}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.bar_day}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.contract_count.toLocaleString()}</td>
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

function ExpiryTable({ rows, latestDate }: { rows: BarQualityExpiryRow[]; latestDate: string | null }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No expiry data found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Expiry{latestDate ? ` (${latestDate})` : ''}</th>
            <th scope="col">DTE</th>
            <th scope="col">Contracts</th>
            <th scope="col">OHLC%</th>
            <th scope="col">Volume%</th>
            <th scope="col">VWAP%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.expiry}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.expiry}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.dte ?? '—'}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.contract_count.toLocaleString()}</td>
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

function PeriodTable({ rows }: { rows: BarQualityPeriodRow[] }) {
  if (rows.length === 0) return <p className="data-overview-gap-sheet__muted">No period data found.</p>
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Rows</th>
            <th scope="col">Last bar</th>
            <th scope="col">OHLC%</th>
            <th scope="col">Volume%</th>
            <th scope="col">VWAP%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.period}>
              <td><code>{r.period}</code></td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.row_count.toLocaleString()}</td>
              <td style={{ fontSize: 'var(--text-caption)' }}>
                {r.last_bar_time ? r.last_bar_time.slice(0, 16).replace('T', ' ') : '—'}
              </td>
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

type TabKey = 'daily' | 'expiry' | 'period'

export function DataOverviewBarQualitySheet({ open, onClose, symbol, table }: Props) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<BarQualityDetailResponse | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('daily')

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

  // Reset tab when table changes
  useEffect(() => {
    setActiveTab('daily')
  }, [table])

  // Fetch when opened
  useEffect(() => {
    if (!open || !symbol) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setData(null)
    fetchBarQualityDetail(symbol, table).then(result => {
      if (!cancelled) { setData(result); setLoading(false) }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, symbol, table])

  if (!open) return null

  const tabBtn = (key: TabKey, label: string, hidden?: boolean) => {
    if (hidden) return null
    return (
      <button
        type="button"
        role="tab"
        className={`feed-massive-agg-tab${activeTab === key ? ' feed-massive-agg-tab--active' : ''}`}
        aria-selected={activeTab === key}
        tabIndex={activeTab === key ? 0 : -1}
        onClick={() => setActiveTab(key)}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet data-overview-gap-explain-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-bar-quality-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-bar-quality-title" className="ref-jobs-sheet-title">
            Bar Quality — <code>{table}</code>{symbol ? ` · ${symbol}` : ''}
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="ref-jobs-sheet-body">
          <div className="feed-massive-agg-tabs-wrap" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="feed-massive-agg-tabs" role="tablist" aria-label="Bar quality tabs">
              {tabBtn('daily', 'Daily')}
              {tabBtn('expiry', 'By Expiry')}
              {tabBtn('period', 'By Period', table !== 'option_min')}
            </div>
          </div>

          {loading ? (
            <p className="data-overview-gap-sheet__muted">Loading…</p>
          ) : data?.error ? (
            <p className="data-overview-gap-sheet__err" role="alert">{data.error}</p>
          ) : data ? (
            <>
              {activeTab === 'daily' && (
                <>
                  <h4 style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                    Daily history (last 30 days, latest bar per contract per day)
                  </h4>
                  <DailyTable rows={data.daily} />
                </>
              )}
              {activeTab === 'expiry' && (
                <>
                  <h4 style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                    By expiry{data.latest_date ? ` (${data.latest_date} latest bar date)` : ''}
                  </h4>
                  <ExpiryTable rows={data.expiries} latestDate={data.latest_date} />
                </>
              )}
              {activeTab === 'period' && table === 'option_min' && (
                <>
                  <h4 style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
                    By period (all option_min periods)
                  </h4>
                  <PeriodTable rows={data.periods} />
                </>
              )}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
