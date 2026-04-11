import type { OptionStockLinkRow } from '../../types'
import { fmtTradeDate, fmtUsd } from '../../utils/format'

interface ViewOptionStockLinksModalProps {
  open: boolean
  title: string
  rows: OptionStockLinkRow[]
  slippageTotal: number | null
  onClose: () => void
}

export function ViewOptionStockLinksModal({
  open,
  title,
  rows,
  slippageTotal,
  onClose,
}: ViewOptionStockLinksModalProps) {
  if (!open) return null
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="view-opt-stock-links-title" onClick={onClose}>
      <div className="modal-panel replay-exec-modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
        <h3 id="view-opt-stock-links-title" className="section-subtitle" style={{ marginTop: 0 }}>
          Linked stock executions
        </h3>
        <p className="section-hint" style={{ marginBottom: 'var(--space-3)' }}>
          {title}
        </p>
        {slippageTotal != null && Number.isFinite(slippageTotal) && (
          <p className="section-hint" style={{ marginBottom: 'var(--space-3)' }}>
            Total stock slippage vs close (signed qty × (price − close)): <strong>{fmtUsd(slippageTotal)}</strong>
          </p>
        )}
        {rows.length === 0 ? (
          <p className="section-hint">No link rows.</p>
        ) : (
          <div className="replay-portfolio-table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="table-operations table-compact">
              <thead>
                <tr>
                  <th>Link id</th>
                  <th>Stock id</th>
                  <th>Symbol</th>
                  <th>Trade date</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Close</th>
                  <th>Slippage</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.link_id}>
                    <td>#{row.link_id}</td>
                    <td>#{row.stock_account_executions_id}</td>
                    <td>{row.stock_symbol ?? '—'}</td>
                    <td>{row.stock_trade_date ? fmtTradeDate(row.stock_trade_date) : '—'}</td>
                    <td>{row.stock_quantity != null ? Number(row.stock_quantity) : '—'}</td>
                    <td>{fmtUsd(row.stock_price)}</td>
                    <td>{fmtUsd(row.stock_close_price)}</td>
                    <td>{row.slippage_vs_close != null ? fmtUsd(row.slippage_vs_close) : '—'}</td>
                    <td>{row.role ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
