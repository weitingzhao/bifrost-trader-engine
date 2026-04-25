import { useId, useMemo, useState } from 'react'
import type { Execution, PerformanceResponse } from '../../../types'
import { DraggableModal } from '../../../components/DraggableModal'
import { fmtUsd } from '../../../utils/format'
import type { RiskProfile } from '../../../utils/riskProfile'
import type { InstanceLinkedStockPnlRow } from '../../portfolio/ledgerOptHelpers'
import {
  annualReturnDetailFromNetAndExecutions,
  formatHoldDaysRounded0,
  holdDaysForAnnualization,
  holdTimeDaysFromReportDateSpan,
  maxRiskUsdFromProfile,
  netPnlUsdPerDayFromNetAndExecutions,
  underlyingCostSellBreakdown,
  underlyingCostSellOptUsd,
} from './instanceDetailPnlMetrics'

const HOLD_TIME_TOOLTIP =
  'Hold time: maximum Report date minus minimum Report date across executions for this instance (Flex report_date). Displayed as whole calendar days (rounded).'

const ANNUAL_RETURN_HINT =
  'Annual return % = (Net PnL/day ÷ Cost/day) × (365.25 ÷ hold days used) × 100 — same as (net PnL × scale factor ÷ underlying cost) × 100 with scale factor = 365.25 ÷ hold days used.'

const NET_PNL_PER_DAY_HINT =
  'Net PnL per day of hold: Net PnL ÷ hold days used (max(report_date span in calendar days, 1)). Same divisor as Cost/day and Annual return.'

const UNDERLYING_PER_DAY_HINT =
  'Cost per day of hold: Max risk denominator ÷ hold days used, where hold days used = max(report_date span in calendar days, 1).'

const MAX_RISK_HINT =
  'Max risk denominator used for return: prefer absolute Risk profile max loss (defined-risk), otherwise fallback to underlying cost.'

const RETURN_PCT_HINT =
  'Return % = Net PnL ÷ Max risk × 100.'

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
  optionStockSlippageAdjustment = 0,
  linkedStockPnlRows = [],
  execDerivedNetPnl = null,
  riskProfile = null,
}: {
  loading: boolean
  performance: PerformanceResponse | null
  executionsForNotional: Execution[]
  /** Prorated option–stock link slippage (Trade Ledger layer); included in execution-derived Net PnL when fills exist. */
  optionStockSlippageAdjustment?: number
  /** Per parent OPT execution: full slippage, allocation ratio, attributed slippage (matches add-on sum). */
  linkedStockPnlRows?: InstanceLinkedStockPnlRow[]
  /** Net PnL summed bottom-up from execution group PnLs (premium ± commission per fill + stock slippage). */
  execDerivedNetPnl?: number | null
  /** Expiration risk profile; when defined, |max_loss| becomes the return denominator. */
  riskProfile?: RiskProfile | null
}) {
  const metricsExplainTitleId = useId()
  const [metricsExplainOpen, setMetricsExplainOpen] = useState(false)
  const summary = performance?.summary

  const underlyingLines = useMemo(
    () => underlyingCostSellBreakdown(executionsForNotional),
    [executionsForNotional],
  )

  const linkedStockAttributedSum = useMemo(
    () => linkedStockPnlRows.reduce((s, r) => s + r.slippageAttributed, 0),
    [linkedStockPnlRows],
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
  const maxRisk = useMemo(() => maxRiskUsdFromProfile(riskProfile, underlyingCostUsd), [riskProfile, underlyingCostUsd])

  const holdDaysRoundedDisplay = holdSpanDays != null && Number.isFinite(holdSpanDays) ? Math.round(holdSpanDays) : null

  /** Fallback when there are no sliced execution rows (broker summary + link slippage). */
  const summaryNetPnlFallback = useMemo(() => {
    if (summary == null) return null
    return Number(summary.net_pnl) + optionStockSlippageAdjustment
  }, [summary, optionStockSlippageAdjustment])

  const displayNetPnl = execDerivedNetPnl ?? summaryNetPnlFallback

  const netPnlPerDayUsd = useMemo(() => {
    if (displayNetPnl == null || !Number.isFinite(displayNetPnl)) return null
    return netPnlUsdPerDayFromNetAndExecutions(displayNetPnl, executionsForNotional)
  }, [displayNetPnl, executionsForNotional])

  const maxRiskPerDayUsd = useMemo(() => {
    if (holdInfo == null) return null
    if (!Number.isFinite(maxRisk.value) || maxRisk.value <= 0) return null
    return maxRisk.value / holdInfo.daysForAnnual
  }, [maxRisk.value, holdInfo])

  const returnPct = useMemo(() => {
    if (displayNetPnl == null || !Number.isFinite(displayNetPnl)) return null
    if (!Number.isFinite(maxRisk.value) || maxRisk.value <= 0) return null
    let pct = (displayNetPnl / maxRisk.value) * 100
    if (!Number.isFinite(pct)) return null
    if (pct > 999) pct = 999
    if (pct < -999) pct = -999
    return pct
  }, [displayNetPnl, maxRisk.value])

  const annualDetail = useMemo(
    () =>
      summary != null && displayNetPnl != null && Number.isFinite(displayNetPnl)
        ? annualReturnDetailFromNetAndExecutions(displayNetPnl, executionsForNotional, maxRisk.value)
        : null,
    [summary, displayNetPnl, executionsForNotional, maxRisk.value],
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
            {/* Primary Net PnL: exec-derived when available (matches Group PnL sum in Executions table), else backend summary */}
            <div className="instance-detail-pnl-metric">
              <span
                className="instance-detail-pnl-label"
                title={
                  execDerivedNetPnl != null
                    ? 'Sum of per-contract Group PnL from the Executions table below (premium ± commission per fill + linked-stock slippage). Matches Trade Ledger / execution book.'
                    : summaryNetPnlFallback != null
                      ? 'No execution slice in the final book for this instance; showing performance summary net plus prorated option–stock link slippage when applicable.'
                      : undefined
                }
              >
                Net PnL
              </span>
              <span className={`instance-detail-pnl-value ${signedPnlClass(displayNetPnl)}`}>
                {fmtUsd(displayNetPnl)}
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

            {netPnlPerDayUsd != null && holdInfo != null && (
              <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                <span className="instance-detail-pnl-label" title={NET_PNL_PER_DAY_HINT}>
                  Net PnL / day
                </span>
                <span className={`instance-detail-pnl-value tabular-nums ${signedPnlClass(netPnlPerDayUsd)}`} title={NET_PNL_PER_DAY_HINT}>
                  {fmtUsd(netPnlPerDayUsd)}
                  <span className="instance-detail-pnl-source-tag">/day</span>
                </span>
              </div>
            )}

            <div className="instance-detail-pnl-metric">
              <span className="instance-detail-pnl-label" title={MAX_RISK_HINT}>
                Max risk
              </span>
              <span className="instance-detail-pnl-value tabular-nums is-neutral" title={MAX_RISK_HINT}>
                {fmtUsd(maxRisk.value)}
                <span className="instance-detail-pnl-source-tag">
                  {maxRisk.source === 'max_loss' ? 'at exp.' : 'underlying'}
                </span>
              </span>
            </div>

            {maxRiskPerDayUsd != null && holdInfo != null && (
              <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                <span className="instance-detail-pnl-label" title={UNDERLYING_PER_DAY_HINT}>
                  Cost / day
                </span>
                <span className="instance-detail-pnl-value tabular-nums is-neutral" title={UNDERLYING_PER_DAY_HINT}>
                  {fmtUsd(maxRiskPerDayUsd)}
                  <span className="instance-detail-pnl-source-tag">/day</span>
                </span>
              </div>
            )}

            {returnPct != null && (
              <div className="instance-detail-pnl-metric">
                <span className="instance-detail-pnl-label" title={RETURN_PCT_HINT}>
                  Return
                </span>
                <span className={`instance-detail-pnl-value tabular-nums ${signedPnlClass(returnPct)}`}>
                  {returnPct >= 0 ? '+' : ''}
                  {returnPct.toFixed(1)}%
                </span>
              </div>
            )}

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
            <p className="muted" style={{ marginBottom: 'var(--space-3)', borderLeft: '3px solid var(--color-border)', paddingLeft: '0.75rem' }}>
              <strong>Net PnL ({fmtUsd(displayNetPnl)})</strong> — when fills exist in the final book for this instance:
              for each OPT contract group, <code>Σ (premium × qty × 100 − commission)</code> per fill direction (buy subtracts,
              sell adds), plus prorated linked-stock slippage when links exist (same layer as Trade Ledger). Non-OPT fills add
              their DB <code>realized_pnl</code>. This matches the <strong>Group PnL</strong> column in the Executions section.
              {execDerivedNetPnl == null && summaryNetPnlFallback != null ? (
                <>
                  {' '}
                  <em>Current row uses the performance-summary fallback because there is no execution slice.</em>
                </>
              ) : null}
            </p>
            <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
              <strong>Commission</strong> and <strong>trades</strong> come from the performance summary (allocation-weighted).
              Hold time, <strong>Net PnL/day</strong> and <strong>cost/day</strong> (same hold-days-used divisor), underlying
              cost, and <strong>annual return</strong> from (Net PnL/day ÷ Cost/day) × scale × 100 use{' '}
              <strong>execution rows</strong> on this page (final book).
            </p>

            {linkedStockPnlRows.length > 0 && (
              <>
                <h4 className="instance-detail-pnl-explain-sub">Linked stock slippage (this instance)</h4>
                <p style={{ marginBottom: 'var(--space-2)' }}>
                  From <code>POST /executions/option-stock-links/query</code> (same bulk load as Trade Ledger). Total stock
                  slippage vs Flex close for each option execution is multiplied by{' '}
                  <code>|instance qty| ÷ |parent execution qty|</code> when the row is split across instances. The{' '}
                  <strong>Attributed</strong> column sums to the Net PnL add-on above.
                </p>
                <div className="instance-detail-pnl-underlying-breakdown-wrap" style={{ marginBottom: 'var(--space-3)' }}>
                  <table className="table-operations instance-detail-pnl-underlying-table">
                    <thead>
                      <tr>
                        <th>OPT exec #</th>
                        <th className="tabular-nums">Links</th>
                        <th className="tabular-nums">Full slippage</th>
                        <th className="tabular-nums">Ratio</th>
                        <th className="tabular-nums">Attributed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {linkedStockPnlRows.map((row) => (
                        <tr key={row.accountExecutionsId}>
                          <td>#{row.accountExecutionsId}</td>
                          <td className="tabular-nums">{row.linkCount}</td>
                          <td className="tabular-nums">{fmtUsd(row.slippageFull)}</td>
                          <td className="tabular-nums">{row.allocationRatio.toFixed(4)}</td>
                          <td className="tabular-nums">{fmtUsd(row.slippageAttributed)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>
                          <strong>Total attributed (→ Net PnL add-on)</strong>
                        </td>
                        <td className="tabular-nums">
                          <strong>{fmtUsd(linkedStockAttributedSum)}</strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}

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
            {netPnlPerDayUsd != null && holdInfo != null && displayNetPnl != null && Number.isFinite(displayNetPnl) ? (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <strong>Net PnL/day:</strong> {fmtUsd(displayNetPnl)} ÷ {holdInfo.daysForAnnual.toFixed(4)} hold days used ={' '}
                <strong>
                  {fmtUsd(netPnlPerDayUsd)}
                  /day
                </strong>
                .
              </p>
            ) : null}
            {maxRiskPerDayUsd != null && holdInfo != null ? (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <strong>Cost / day:</strong> {fmtUsd(maxRisk.value)} ÷ {holdInfo.daysForAnnual.toFixed(4)} hold days used
                (<code>max(report_date span, 1)</code>, same as annual return divisor){' '}
                {maxRisk.source === 'max_loss' ? '(from |max loss|)' : '(fallback to underlying cost)'} ={' '}
                <strong>
                  {fmtUsd(maxRiskPerDayUsd)}
                  /day
                </strong>
                .
              </p>
            ) : maxRisk.value > 0 ? (
              <p className="muted" style={{ marginBottom: 'var(--space-2)' }}>
                Cost / day needs a <code>report_date</code> span on executions (hold time).
              </p>
            ) : null}

            {returnPct != null && (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <strong>Return %:</strong> {fmtUsd(displayNetPnl)} ÷ {fmtUsd(maxRisk.value)} × 100 ={' '}
                <strong>
                  {returnPct >= 0 ? '+' : ''}
                  {returnPct.toFixed(1)}%
                </strong>
                .
              </p>
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
                <code>(Net PnL/day ÷ Cost/day) × (365.25 ÷ hold days used) × 100</code>
                <span className="muted"> — same as </span>
                <code>(net PnL × scale factor ÷ underlying cost) × 100</code>
                <span className="muted"> with scale = 365.25 ÷ hold days used.</span>
              </dd>
              <dt>Net PnL (for annual %)</dt>
              <dd>
                <strong>{fmtUsd(displayNetPnl)}</strong>
                {execDerivedNetPnl != null ? (
                  <span className="muted"> — execution-derived (same as strip above)</span>
                ) : summary != null ? (
                  <>
                    {' '}
                    <span className="muted">
                      ({fmtUsd(Number(summary.net_pnl))} summary
                      {optionStockSlippageAdjustment !== 0
                        ? ` + ${fmtUsd(optionStockSlippageAdjustment)} linked stock`
                        : ''}
                      )
                    </span>
                  </>
                ) : null}
              </dd>
              <dt>Result</dt>
              <dd>
                {annualDetail != null ? (
                  <>
                    <code>
                      ({annualDetail.netPnlPerDayUsd.toFixed(4)} ÷ {annualDetail.denominatorPerDayUsd.toFixed(4)}) ×{' '}
                      {annualDetail.factor.toFixed(6)} × 100
                    </code>
                    <span className="muted"> (= </span>
                    <code>
                      ({annualDetail.net.toFixed(2)} × {annualDetail.factor.toFixed(6)}) ÷{' '}
                      {annualDetail.denominatorUsd.toFixed(2)} × 100
                    </code>
                    <span className="muted">) ≈ </span>
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
