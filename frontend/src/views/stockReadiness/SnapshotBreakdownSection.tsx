import type { SepaSnapshotByTypeRow } from '../../api/research/dataReadiness'
import { fmt } from './stockReadinessUtils'

export function SnapshotByTypeBreakdown({ rows }: { rows: SepaSnapshotByTypeRow[] | null }) {
  if (rows == null) return null
  if (rows.length === 0) {
    return (
      <div className="sdp-step-aside-empty">
        No instrument-type breakdown yet — refresh once to populate{' '}
        <code>cache_stock_snapshot</code>.
      </div>
    )
  }
  const totalSnap = rows.reduce((s, r) => s + (r.snapshot_row_count || 0), 0)
  const totalUni = rows.reduce((s, r) => s + (r.universe_ticker_count || 0), 0)
  return (
    <div className="sdp-step-aside">
      <div className="sdp-step-aside-title">
        Instrument types in <code>cache_stock_snapshot</code>{' '}
        <span className="sdp-step-aside-meta">
          {rows.length} types · {fmt(totalSnap)} snapshot rows · {fmt(totalUni)} universe tickers
        </span>
      </div>
      <div className="sdp-step-aside-table-scroll">
        <table className="sdp-snap-by-type-table">
          <thead>
            <tr>
              <th className="sdp-snap-by-type-code">Code</th>
              <th>Description</th>
              <th className="sdp-snap-by-type-num">Snapshot rows</th>
              <th className="sdp-snap-by-type-num">Universe tickers</th>
              <th className="sdp-snap-by-type-num">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const coverage =
                r.universe_ticker_count > 0
                  ? (r.snapshot_row_count / r.universe_ticker_count) * 100
                  : null
              const lowCoverage = coverage != null && coverage < 90
              return (
                <tr key={r.code}>
                  <td className="sdp-snap-by-type-code">
                    <code>{r.code}</code>
                  </td>
                  <td>{r.description ?? <span className="sdp-step-aside-dim">—</span>}</td>
                  <td className="sdp-snap-by-type-num">{fmt(r.snapshot_row_count)}</td>
                  <td className="sdp-snap-by-type-num sdp-step-aside-dim">
                    {fmt(r.universe_ticker_count)}
                  </td>
                  <td
                    className={`sdp-snap-by-type-num${lowCoverage ? ' sdp-snap-by-type-low' : ''}`}
                  >
                    {coverage == null ? '—' : `${coverage.toFixed(1)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
