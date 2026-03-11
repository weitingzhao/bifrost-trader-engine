import type { Bar } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { fmtTs, fmtUsd } from '../../../utils/format'
import { BAR_PERIODS } from '../constants'
import { BarsCandlestickChart } from '../BarsCandlestickChart'

export interface DataBarsPreviewPanelProps {
  barSymbol: string
  barPeriod: string
  bars: Bar[]
  barsLoading: boolean
  barsTimeSort: 'asc' | 'desc'
  chartBars: Bar[]
  tableBars: Bar[]
  onSymbolChange: (value: string) => void
  onPeriodChange: (period: string) => void
  onLoadBars: () => void
  onBarsTimeSortToggle: () => void
}

export function DataBarsPreviewPanel({
  barSymbol,
  barPeriod,
  bars,
  barsLoading,
  barsTimeSort,
  chartBars,
  tableBars,
  onSymbolChange,
  onPeriodChange,
  onLoadBars,
  onBarsTimeSortToggle,
}: DataBarsPreviewPanelProps) {
  return (
    <section className="replay-section" aria-labelledby="data-bars-head">
      <h3 id="data-bars-head" className="page-title-with-tooltip">
        Preview
        <InfoTooltip text="Load bars from DB for a symbol and period. Backfill is triggered per symbol in the coverage table above (uses config default ranges)." />
      </h3>
      <div className="replay-bar-symbol-row" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <label htmlFor="data-bar-symbol" className="replay-bar-symbol-label">
          Symbol
        </label>
        <input
          id="data-bar-symbol"
          type="text"
          className="replay-bar-symbol-input"
          placeholder="Symbol, e.g. NVDA"
          value={barSymbol}
          onChange={(e) => onSymbolChange((e.target.value || '').trim().toUpperCase())}
          aria-label="Symbol for bars"
        />
        <span className="replay-bar-symbol-label">Period</span>
        <div className="replay-bar-period-radios" role="group" aria-label="Bar period">
          {BAR_PERIODS.map((p) => (
            <label key={p.value} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', marginRight: '1rem' }}>
              <input type="radio" name="bar-period" value={p.value} checked={barPeriod === p.value} onChange={() => onPeriodChange(p.value)} aria-label={p.label} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
        <button type="button" className="btn btn-secondary" disabled={barsLoading || !barSymbol.trim()} onClick={() => onLoadBars()} aria-label="Load bars">
          {barsLoading ? 'Loading…' : 'Load'}
        </button>
      </div>
      <p className="replay-sync-hint" style={{ marginTop: '0.5rem', fontSize: '0.9em' }}>
        Backfill runs in Celery Worker (config default ranges per period). See System → Recent operations for job status.
      </p>
      {bars.length > 0 && (
        <div className="data-bars-chart-container">
          <div className="data-bars-chart-header">
            <span className="data-bars-chart-title">
              {barSymbol || '—'} {barPeriod} · {chartBars.length} bars
            </span>
          </div>
          <BarsCandlestickChart bars={chartBars} period={barPeriod} />
        </div>
      )}
      {bars.length === 0 ? (
        <div className="replay-placeholder">No bars. Enter symbol, click Load, or run Backfill for a symbol above.</div>
      ) : (
        <table className="table-operations">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className="table-sort-header"
                  onClick={onBarsTimeSortToggle}
                  aria-sort={barsTimeSort === 'desc' ? 'descending' : 'ascending'}
                  aria-label={`Sort by time ${barsTimeSort === 'desc' ? '(newest first), click for oldest first' : '(oldest first), click for newest first'}`}
                >
                  Time {barsTimeSort === 'desc' ? '↓' : '↑'}
                </button>
              </th>
              <th>Open</th>
              <th>High</th>
              <th>Low</th>
              <th>Close</th>
              <th>Vol</th>
            </tr>
          </thead>
          <tbody>
            {tableBars.map((b, i) => (
              <tr key={i}>
                <td>{b.time != null ? fmtTs(b.time) : '—'}</td>
                <td>{fmtUsd(b.open)}</td>
                <td>{fmtUsd(b.high)}</td>
                <td>{fmtUsd(b.low)}</td>
                <td>{fmtUsd(b.close)}</td>
                <td>{b.volume != null ? Number(b.volume).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
