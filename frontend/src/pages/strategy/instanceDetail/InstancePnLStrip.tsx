import { useId, useMemo, useState } from 'react'
import type { Execution, PerformanceResponse } from '../../../types'
import { DraggableModal } from '../../../components/DraggableModal'
import { fmtUsd } from '../../../utils/format'
import {
  annualReturnDetailFromNetAndExecutions,
  formatHoldDaysRounded0,
  holdDaysForAnnualization,
  holdTimeDaysFromReportDateSpan,
  underlyingCostSellBreakdown,
  underlyingCostSellOptUsd,
} from './instanceDetailPnlMetrics'

const HOLD_TIME_TOOLTIP =
  'Hold time: maximum Report date minus minimum Report date across executions for this instance (Flex report_date). Displayed as whole calendar days (rounded).'

const ANNUAL_RETURN_HINT =
  'Annual return % = net PnL × scale factor ÷ underlying cost, where scale factor = 365.25 ÷ hold days used.'

const UNDERLYING_HINT = 'Sum of sell-side OPT notionals (strike × |qty| × 100). See ⓘ next to the section title for the full breakdown.'

function signedPnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'is-neutral'
  if (n > 1e-9) return 'is-positive'
  if (n < -1e-9) return 'is-negative'
  return 'is-neutral'
}

export function InstancePnLStrip({
  loading,
  performance,
  executionsForNotional,
}: {
  loading: boolean
  performance: PerformanceResponse | null
  executionsForNotional: Execution[]
}) {
  const metricsExplainTitleId = useId()
  const [metricsExplainOpen, setMetricsExplainOpen] = useState(false)
  const summary = performance?.summary

  const underlyingLines = useMemo(
    () => underlyingCostSellBreakdown(executionsForNotional),
    [executionsForNotional],
  )

  const holdSpanDays = holdTimeDaysFromReportDateSpan(executionsForNotional)
  const holdInfo =
    holdSpanDays != null
      ? {
          daysForAnnual: holdDaysForAnnualization(holdSpanDays),
          label: formatHoldDaysRounded0(holdSpanDays),
          tooltip: HOLD_TIME_TOOLTIP,
        }
      : null

  const underlyingCostUsd = underlyingCostSellOptUsd(executionsForNotional)
  const holdDaysRoundedDisplay = holdSpanDays != null && Number.isFinite(holdSpanDays) ? Math.round(holdSpanDays) : null

  const annualDetail = useMemo(
    () => (summary != null ? annualReturnDetailFromNetAndExecutions(summary.net_pnl, executionsForNotional) : null),
    [summary, executionsForNotional],
  )

  const explainDisabled = loading || summary == null

  return (
    <>
      <div className="instance-detail-pnl-section-head">
        <h3 className="instance-detail-section-title">PnL (this instance)</h3>
        <button
          type="button"
          className="instance-detail-pnl-info-btn instance-detail-pnl-section-info-btn"
          disabled={explainDisabled}
          onClick={() => setMetricsExplainOpen(true)}
          aria-label="How PnL metrics are calculated for this instance"
          title={explainDisabled ? undefined : 'Open calculation details for all metrics in this section'}
        >
          ⓘ
        </button>
      </div>

      {loading ? (
        <div className="instance-detail-pnl-strip">
          <span className="muted">Loading performance…</span>
        </div>
      ) : !summary ? (
        <div className="instance-detail-pnl-strip">
          <span className="muted">No performance data for this instance.</span>
        </div>
      ) : (
        <>
          <div className="instance-detail-pnl-strip" role="group" aria-label="PnL this instance">
            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label">Net PnL</span>
              <span className={`instance-detail-pnl-value ${signedPnlClass(Number(summary.net_pnl))}`}>
                {fmtUsd(summary.net_pnl)}
              </span>
            </div>
            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label">Realized</span>
              <span className={`instance-detail-pnl-value ${signedPnlClass(Number(summary.total_realized_pnl))}`}>
                {fmtUsd(summary.total_realized_pnl)}
              </span>
            </div>
            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label">Commission</span>
              <span className="instance-detail-pnl-value is-commission">{fmtUsd(summary.total_commission)}</span>
            </div>
            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label">Trades</span>
              <span className="instance-detail-pnl-value tabular-nums is-neutral">{summary.trade_count ?? 0}</span>
            </div>

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

            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label" title={UNDERLYING_HINT}>
                Underlying cost
              </span>
              <span className="instance-detail-pnl-value tabular-nums is-neutral" title={UNDERLYING_HINT}>
                {fmtUsd(underlyingCostUsd)}
              </span>
            </div>

            {annualDetail != null && Number.isFinite(annualDetail.annualReturnPct) && (
              <div className="instance-detail-pnl-metric">
                <span className="instance-detail-pnl-label" title={ANNUAL_RETURN_HINT}>
                  Annual return
                </span>
                <span className={`instance-detail-pnl-value tabular-nums ${signedPnlClass(annualDetail.annualReturnPct)}`}>
                  {annualDetail.annualReturnPct >= 0 ? '+' : ''}
                  {annualDetail.annualReturnPct.toFixed(1)}%
                </span>
              </div>
            )}
          </div>

          <DraggableModal
            open={metricsExplainOpen}
            onBackdropClick={() => setMetricsExplainOpen(false)}
            title="PnL (this instance) — calculations"
            titleId={metricsExplainTitleId}
            maxWidth="min(560px, calc(100vw - 24px))"
            footer={
              <div className="data-reset-modal-actions">
                <button type="button" className="btn btn-primary" onClick={() => setMetricsExplainOpen(false)}>
                  Close
                </button>
              </div>
            }
          >
            <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
              Net PnL, realized, commission, and trades come from the <strong>performance summary</strong> for this strategy
              instance (server-side, over the time range requested by the app). Hold time, underlying cost, and annual return
              use <strong>execution rows</strong> loaded for this instance on this page (final book).
            </p>

            <h4 className="instance-detail-pnl-explain-sub">Underlying cost (this instance)</h4>
            <p style={{ marginBottom: 'var(--space-2)' }}>
              For each <strong>OPT</strong> execution with sell side (SELL / SLD / S):{' '}
              <code>line = strike × |qty| × 100</code>. Total underlying cost is the sum of those lines.
            </p>
            {underlyingLines.length === 0 ? (
              <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
                No sell-side OPT rows — underlying cost = {fmtUsd(0)}.
              </p>
            ) : (
              <div className="instance-detail-pnl-underlying-breakdown-wrap">
                <table className="table-operations instance-detail-pnl-underlying-table">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Side</th>
                      <th className="tabular-nums">Strike</th>
                      <th className="tabular-nums">|Qty|</th>
                      <th className="tabular-nums">Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {underlyingLines.map((row, i) => (
                      <tr key={`${row.contractKey}-${i}`}>
                        <td className="instance-detail-pnl-contract-cell" title={row.contractKey}>
                          {row.contractKey.length > 42 ? `${row.contractKey.slice(0, 40)}…` : row.contractKey}
                        </td>
                        <td>{row.side}</td>
                        <td className="tabular-nums">{row.strike}</td>
                        <td className="tabular-nums">{row.qty}</td>
                        <td className="tabular-nums">{fmtUsd(row.lineUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        <strong>Total underlying cost</strong>
                      </td>
                      <td className="tabular-nums">
                        <strong>{fmtUsd(underlyingCostUsd)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <h4 className="instance-detail-pnl-explain-sub">Hold time &amp; scale factor</h4>
            {holdInfo != null && holdSpanDays != null && holdDaysRoundedDisplay != null ? (
              <dl className="info-dl instance-detail-ann-lin-explain-dl">
                <dt>Report date span</dt>
                <dd>
                  Max − min <code>report_date</code>: <strong>{holdDaysRoundedDisplay}</strong> calendar days (rounded; same as
                  Hold time label).
                </dd>
                <dt>Hold days used (divisor)</dt>
                <dd>
                  <code>max(report span days, 1)</code> = <strong>{holdInfo.daysForAnnual.toFixed(4)}</strong>
                </dd>
                <dt>Scale factor</dt>
                <dd>
                  <code>365.25 ÷ hold days used</code> ={' '}
                  <strong>{(365.25 / holdInfo.daysForAnnual).toFixed(6)}</strong>
                </dd>
              </dl>
            ) : (
              <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
                No <code>report_date</code> span — hold time and annual return cannot be computed.
              </p>
            )}

            <h4 className="instance-detail-pnl-explain-sub">Annual return (%)</h4>
            <dl className="info-dl instance-detail-ann-lin-explain-dl">
              <dt>Formula</dt>
              <dd>
                <code>(net PnL × scale factor ÷ underlying cost) × 100</code>
              </dd>
              <dt>Net PnL</dt>
              <dd>{fmtUsd(Number(summary.net_pnl))}</dd>
              <dt>Result</dt>
              <dd>
                {annualDetail != null ? (
                  <>
                    <code>
                      ({annualDetail.net.toFixed(2)} × {annualDetail.factor.toFixed(6)}) ÷{' '}
                      {annualDetail.underlyingCostUsd.toFixed(2)}
                    </code>{' '}
                    × 100 ≈{' '}
                    <strong>
                      {annualDetail.annualReturnPct >= 0 ? '+' : ''}
                      {annualDetail.annualReturnPct.toFixed(1)}%
                    </strong>
                  </>
                ) : (
                  <span className="muted">
                    — (needs report dates, underlying cost &gt; 0, and valid net PnL)
                  </span>
                )}
              </dd>
            </dl>
          </DraggableModal>
        </>
      )}
    </>
  )
}
