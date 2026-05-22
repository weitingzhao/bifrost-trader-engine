import { rl } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
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
        <span className={rl.ledgerSummaryRealizedZero}>-</span>
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
    <span className={rl.stockGroupTotalPnl}>
      <span className={rl.stockGroupTotalPnlLabel}>Group U/R PnL</span>
      <span className={w9.ledgerStkUrPnlGroupInlineMetrics}>
        <span className={`ledger-stk-ur-pnl-inline-seg ${ledgerUrPnlLineClass(realized)}`}>
          <span className={w9.ledgerStkUrPnlPrefix}>R</span> {fmtUsd0(realized)}
        </span>
        <span className={w9.ledgerStkUrPnlGroupMetricSep} aria-hidden>
          ·
        </span>
        <span
          className={`ledger-stk-ur-pnl-inline-seg ${
            uFinite ? 'ledger-stk-ur-pnl-unrealized' : 'rl.ledgerSummaryRealizedZero'
          }`}
        >
          <span className={w9.ledgerStkUrPnlPrefix}>U</span> {uFinite ? fmtUsd0(unrealized as number) : '—'}
        </span>
      </span>
    </span>
  )
}
