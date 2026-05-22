import { rl } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import type { Bar } from '../../../types'
import { Button } from '@/components/ui/button'
import { SECTION_TITLE_CLASS } from '../../../components/SectionPageTitle'
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
    <section className={rl.section} aria-labelledby="data-bars-head">
      <h3 id="data-bars-head" className={SECTION_TITLE_CLASS}>
        Bars Preview
        <InfoTooltip text="Load and display stored bars for a single symbol and period. Candlestick chart and table with the most recent bars, sorted by time." />
      </h3>
      <div className={rl.barSymbolRow} style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <label htmlFor="data-bar-symbol" className={rl.barSymbolLabel}>
          Symbol
        </label>
        <input
          id="data-bar-symbol"
          type="text"
          className={rl.barSymbolInput}
          placeholder="Symbol, e.g. NVDA"
          value={barSymbol}
          onChange={(e) => onSymbolChange((e.target.value || '').trim().toUpperCase())}
          aria-label="Symbol for bars"
        />
        <span className={rl.barSymbolLabel}>Period</span>
        <div className={rl.barPeriodRadios} role="group" aria-label="Bar period">
          {BAR_PERIODS.map((p) => (
            <label key={p.value} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', marginRight: '1rem' }}>
              <input type="radio" name="bar-period" value={p.value} checked={barPeriod === p.value} onChange={() => onPeriodChange(p.value)} aria-label={p.label} />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
        <Button type="button" variant="secondary" disabled={barsLoading || !barSymbol.trim()} onClick={() => onLoadBars()} aria-label="Load bars">
          {barsLoading ? 'Loading…' : 'Load'}
        </Button>
      </div>
      <p className={rl.syncHint} style={{ marginTop: '0.5rem', fontSize: '0.9em' }}>
        Backfill runs in Celery Worker (config default ranges per period). See System → Recent operations for job status.
      </p>
      {bars.length > 0 && (
        <div className="data-bars-chart-container">
          <div className={w9.dataBarsChartHeader}>
            <span className={w9.dataBarsChartTitle}>
              {barSymbol || '—'} {barPeriod} · {chartBars.length} bars
            </span>
          </div>
          <BarsCandlestickChart bars={chartBars} period={barPeriod} />
        </div>
      )}
      {bars.length === 0 ? (
        <div className={rl.placeholder}>No bars. Enter symbol, click Load, or run Backfill for a symbol above.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border min-w-0">
          <table className={w9.tableOperations}>
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
        </div>
      )}
    </section>
  )
}
