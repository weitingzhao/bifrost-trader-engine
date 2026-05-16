import type { OptionSnapshotRow } from '../../api'
import { fmtUsd } from '../../utils/format'

const MAX_SLOTS = 4

function fmtOptNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

export function OptionDiscoveryCompareDrawer({
  open,
  onClose,
  rows,
  symbol,
  expiration,
  dteLabel,
  onRemove,
  onClear,
}: {
  open: boolean
  onClose: () => void
  rows: OptionSnapshotRow[]
  symbol: string
  expiration: string
  /** Human-readable DTE from the page (e.g. "12 days"). */
  dteLabel: string
  onRemove: (index: number) => void
  onClear: () => void
}) {
  if (!open) return null

  return (
    <div className="od-compare-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="od-compare-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Compare option contracts"
        onClick={e => e.stopPropagation()}
      >
        <div className="od-compare-drawer-header">
          <h3 className="od-compare-drawer-title">Compare contracts</h3>
          <button type="button" className="button button-secondary button-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <p className="section-hint od-compare-drawer-meta">
          {symbol.trim().toUpperCase()} · {expiration || '—'}
          {dteLabel && dteLabel !== '—' ? ` · ${dteLabel}` : ''} · max {MAX_SLOTS} legs
        </p>
        {rows.length === 0 ? (
          <p className="section-hint">Add contracts from the chain or contract header (Add to compare).</p>
        ) : (
          <>
            <div className="table-wrapper od-compare-table-wrap">
              <table className="data-table od-compare-table">
                <thead>
                  <tr>
                    <th scope="col">Side</th>
                    <th scope="col">Strike</th>
                    <th scope="col">Bid</th>
                    <th scope="col">Ask</th>
                    <th scope="col">Mid</th>
                    <th scope="col">IV</th>
                    <th scope="col" aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.strike}-${r.right}-${i}`}>
                      <td>{r.right === 'P' || r.right === 'PUT' ? 'Put' : 'Call'}</td>
                      <td>{r.strike.toFixed(2)}</td>
                      <td>{r.bid != null ? fmtUsd(r.bid) : '—'}</td>
                      <td>{r.ask != null ? fmtUsd(r.ask) : '—'}</td>
                      <td>{r.mid != null ? fmtUsd(r.mid) : '—'}</td>
                      <td>{fmtOptNum(r.iv, 4)}</td>
                      <td>
                        <button
                          type="button"
                          className="button button-secondary button-sm"
                          onClick={() => onRemove(i)}
                          aria-label={`Remove row ${i + 1}`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="od-compare-drawer-actions">
              <button type="button" className="button button-secondary button-sm" onClick={onClear}>
                Clear all
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

export function canAddCompareRow(current: OptionSnapshotRow[], row: OptionSnapshotRow): boolean {
  if (current.length >= MAX_SLOTS) return false
  const k = (r: OptionSnapshotRow) => `${r.strike}|${(r.right || '').trim().toUpperCase()}`
  return !current.some(r => k(r) === k(row))
}

export function addCompareRow(current: OptionSnapshotRow[], row: OptionSnapshotRow): OptionSnapshotRow[] {
  if (!canAddCompareRow(current, row)) return current
  return [...current, row]
}
