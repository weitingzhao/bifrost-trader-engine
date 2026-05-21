import type { Execution } from '../../types'
import { fmtUsd, fmtUsd0 } from '../../utils/format'
import { stkNotionalAbsUsd, stkNotionalSideColorClass, ledgerUrPnlLineClass } from './ledgerViewUtils'

export function LedgerStkNotionalCell({ ex }: { ex: Execution }) {
  const n = stkNotionalAbsUsd(ex)
  if (n == null) return <td>—</td>
  return (
    <td className={`ledger-stk-notional-td ${stkNotionalSideColorClass(ex)}`}>{fmtUsd(n)}</td>
  )
}

/** Per-fill realized only; unrealized is position-level (group header + Total U, not per row). */
export function LedgerStkRowRealizedPnlCell({ realized }: { realized: number }) {
  const isZero = !Number.isFinite(realized) || Math.abs(realized) < 0.005
  return (
    <td className="ledger-stk-row-realized-td">
      {isZero ? (
        <span className="ledger-stk-row-realized-value replay-ledger-summary-realized-zero">-</span>
      ) : (
        <span className={`ledger-stk-row-realized-value ${ledgerUrPnlLineClass(realized)}`}>
          {fmtUsd0(realized)}
        </span>
      )}
    </td>
  )
}

/** Single-line group header: label + R (green/red) + U (yellow). */
export function LedgerStkUrPnlGroupInline({
  realized,
  unrealized,
}: {
  realized: number
  unrealized: number | null | undefined
}) {
  const uFinite = unrealized != null && Number.isFinite(unrealized)
  return (
    <span className="replay-stock-group-total-pnl ledger-stk-ur-pnl-group-inline">
      <span className="replay-stock-group-total-pnl-label">Group U/R PnL</span>
      <span className="ledger-stk-ur-pnl-group-inline-metrics">
        <span className={`ledger-stk-ur-pnl-inline-seg ${ledgerUrPnlLineClass(realized)}`}>
          <span className="ledger-stk-ur-pnl-prefix">R</span> {fmtUsd0(realized)}
        </span>
        <span className="ledger-stk-ur-pnl-group-metric-sep" aria-hidden>
          ·
        </span>
        <span
          className={`ledger-stk-ur-pnl-inline-seg ${
            uFinite ? 'ledger-stk-ur-pnl-unrealized' : 'replay-ledger-summary-realized-zero'
          }`}
        >
          <span className="ledger-stk-ur-pnl-prefix">U</span> {uFinite ? fmtUsd0(unrealized as number) : '—'}
        </span>
      </span>
    </span>
  )
}
