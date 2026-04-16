import type { PerformanceResponse } from '../../../types'
import type { Execution } from '../../../types'
import { fmtUsd } from '../../../utils/format'
import {
  estimateOptionCapitalProxyUsd,
  formatHoldingDurationLabel,
  holdingDaysSince,
} from './instanceDetailPnlMetrics'
import type { HoldingAnchorKind } from './instanceHoldingTooltip'
import { buildHoldingPeriodTooltip } from './instanceHoldingTooltip'

function signedPnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'is-neutral'
  if (n > 1e-9) return 'is-positive'
  if (n < -1e-9) return 'is-negative'
  return 'is-neutral'
}

export function InstancePnLStrip({
  loading,
  performance,
  holdingStartEpochSec,
  holdingAnchor,
  executionsForNotional,
}: {
  loading: boolean
  performance: PerformanceResponse | null
  holdingStartEpochSec: number | null
  holdingAnchor: HoldingAnchorKind | null
  executionsForNotional: Execution[]
}) {
  const summary = performance?.summary

  const holdInfo = (() => {
    if (holdingStartEpochSec == null || !Number.isFinite(holdingStartEpochSec)) return null
    const days = holdingDaysSince(holdingStartEpochSec)
    const label = formatHoldingDurationLabel(holdingStartEpochSec)
    const tooltip =
      holdingAnchor != null
        ? buildHoldingPeriodTooltip(holdingAnchor)
        : 'Hold time: elapsed calendar time from the anchor timestamp through now. Not the difference between Buy and Sell report dates.'
    return { days, label, tooltip }
  })()

  const annualDerived = (() => {
    if (!summary || holdInfo == null) return null
    const net = Number(summary.net_pnl)
    if (!Number.isFinite(net)) return null
    const netAbs = Math.abs(net)
    const basis = estimateOptionCapitalProxyUsd(executionsForNotional, netAbs)
    const years = Math.max(holdInfo.days / 365.25, 1e-6)
    const annualizedUsd = net / years
    let annualReturnPct = (net / basis) * (365.25 / holdInfo.days) * 100
    if (!Number.isFinite(annualReturnPct)) annualReturnPct = 0
    if (annualReturnPct > 999) annualReturnPct = 999
    if (annualReturnPct < -999) annualReturnPct = -999
    return { annualizedUsd, annualReturnPct }
  })()

  if (loading) {
    return (
      <div className="instance-detail-pnl-strip">
        <span className="muted">Loading performance…</span>
      </div>
    )
  }
  if (!summary) {
    return (
      <div className="instance-detail-pnl-strip">
        <span className="muted">No performance data for this instance.</span>
      </div>
    )
  }

  const net = Number(summary.net_pnl)
  const realized = Number(summary.total_realized_pnl)

  return (
    <div className="instance-detail-pnl-strip" role="group" aria-label="PnL this instance">
      <div className="instance-detail-pnl-metric">
        <span className="instance-detail-pnl-label">Net PnL</span>
        <span className={`instance-detail-pnl-value ${signedPnlClass(net)}`}>{fmtUsd(summary.net_pnl)}</span>
      </div>
      <div className="instance-detail-pnl-metric">
        <span className="instance-detail-pnl-label">Realized</span>
        <span className={`instance-detail-pnl-value ${signedPnlClass(realized)}`}>{fmtUsd(summary.total_realized_pnl)}</span>
      </div>
      <div className="instance-detail-pnl-metric">
        <span className="instance-detail-pnl-label">Commission</span>
        <span className="instance-detail-pnl-value is-commission">{fmtUsd(summary.total_commission)}</span>
      </div>
      <div className="instance-detail-pnl-metric">
        <span className="instance-detail-pnl-label">Trades</span>
        <span className="instance-detail-pnl-value tabular-nums is-neutral">{summary.trade_count ?? 0}</span>
      </div>
      {summary.win_rate != null && (
        <div className="instance-detail-pnl-metric">
          <span className="instance-detail-pnl-label">Win rate</span>
          <span className="instance-detail-pnl-value tabular-nums is-neutral">
            {(Number(summary.win_rate) * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {holdInfo != null && (
        <div className="instance-detail-pnl-metric">
          <span className="instance-detail-pnl-label" title={holdInfo.tooltip}>
            Hold time
          </span>
          <span className="instance-detail-pnl-value tabular-nums is-neutral" title={holdInfo.tooltip}>
            {holdInfo.label}
          </span>
        </div>
      )}

      {annualDerived != null && Number.isFinite(annualDerived.annualReturnPct) && (
        <>
          <div className="instance-detail-pnl-metric">
            <span
              className="instance-detail-pnl-label"
              title="Linear extrapolation: net PnL × (365.25 d / hold time). Not compound annual growth."
            >
              Ann. PnL (lin.)
            </span>
            <span className={`instance-detail-pnl-value ${signedPnlClass(annualDerived.annualizedUsd)}`}>
              {fmtUsd(annualDerived.annualizedUsd)}
            </span>
          </div>
          <div className="instance-detail-pnl-metric">
            <span
              className="instance-detail-pnl-label"
              title="Estimated: (net PnL ÷ half-turn option notional proxy) × (365.25 ÷ hold days). See tooltip on Hold time."
            >
              Ann. return (est.)
            </span>
            <span className={`instance-detail-pnl-value tabular-nums ${signedPnlClass(annualDerived.annualReturnPct)}`}>
              {annualDerived.annualReturnPct >= 0 ? '+' : ''}
              {annualDerived.annualReturnPct.toFixed(1)}%
            </span>
          </div>
        </>
      )}
    </div>
  )
}
