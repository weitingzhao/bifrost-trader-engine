import { useId, useMemo, useState, type ReactNode } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import type { Execution, PerformanceResponse } from '../../../types'
import { DraggableModal } from '../../../components/DraggableModal'
import { Button } from '@/components/ui/button'
import { fmtUsd } from '../../../utils/format'
import type { RiskProfile } from '../../../utils/riskProfile'
import type { InstanceLinkedStockPnlRow } from '../../portfolio/ledgerOptHelpers'
import {
  annualReturnDetailFromNetAndExecutions,
  computeCapitalAtRiskWithDiagnostics,
  computeInstancePositionStatus,
  formatHoldDaysRounded0,
  holdDaysForAnnualization,
  holdSpanDaysForMetrics,
  netPnlUsdPerDayFromNetAndExecutions,
  underlyingCostSellBreakdown,
  underlyingCostSellOptUsd,
} from './instanceDetailPnlMetrics'
import { InstanceRiskCostExplainBody } from './InstanceRiskCostExplainBody'
import { InstanceReturnExplainBody } from './InstanceReturnExplainBody'
import { explainHighlightText } from './explainTextHighlight'
import { getStructureTypeLabel } from '../strategyFormUtils'

const HOLD_TIME_TOOLTIP =
  'Hold time: Open — min report_date to latest OPT expiry among open legs (calendar days, rounded). Closed — max minus min report_date.'

const ANNUAL_RETURN_HINT =
  'Annual return % = (Net PnL/day ÷ Cost/day) × (365.25 ÷ hold days used) × 100 — hold days: open = min report_date → latest open-leg expiry; closed = report_date span.'

const NET_PNL_PER_DAY_HINT =
  'Net PnL per day of hold: Net PnL ÷ hold days used (max(hold span calendar days, 1)). Same divisor as Cost/day and Annual return.'

const UNDERLYING_PER_DAY_HINT =
  'Cost per day of hold: Capital at risk ÷ hold days used, where hold days used = max(report_date span in calendar days, 1).'

const RETURN_PCT_HINT =
  'Return % = Net PnL ÷ Capital at risk × 100.'

function PnlExplainKpi({ children }: { children: ReactNode }) {
  return <strong className="instance-detail-modal-explain-kpi">{children}</strong>
}

function signedPnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'is-neutral'
  if (n > 1e-9) return 'is-positive'
  if (n < -1e-9) return 'is-negative'
  return 'is-neutral'
}

function PnlBand({
  title,
  children,
  titleExtra,
}: {
  title: string
  children: ReactNode
  /** Optional control next to the band title (e.g. help button). */
  titleExtra?: ReactNode
}) {
  return (
    <div className="instance-detail-pnl-band" role="group" aria-label={title}>
      <div className="instance-detail-pnl-band-head">
        <div className="instance-detail-pnl-band-title">{title}</div>
        {titleExtra != null ? <span className="instance-detail-pnl-band-head-extra">{titleExtra}</span> : null}
      </div>
      <div className="instance-detail-pnl-band-metrics">{children}</div>
    </div>
  )
}

export function InstancePnLStrip({
  strategyInstanceId,
  loading,
  performance,
  executionsForNotional,
  optionStockSlippageAdjustment = 0,
  linkedStockPnlRows = [],
  execDerivedNetPnl = null,
  riskProfile = null,
  structureType = null,
  structureDisplayName = null,
}: {
  strategyInstanceId: number
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
  /** Structure type from the linked strategy structure (e.g. covered_call, cash_secured_put). */
  structureType?: string | null
  /** Human-readable structure name from the instance (e.g. "Covered Call 10% OTM"). */
  structureDisplayName?: string | null
}) {
  const metricsExplainTitleId = useId()
  const riskCostExplainTitleId = useId()
  const returnExplainTitleId = useId()
  const [metricsExplainOpen, setMetricsExplainOpen] = useState(false)
  const [riskCostExplainOpen, setRiskCostExplainOpen] = useState(false)
  const [returnExplainOpen, setReturnExplainOpen] = useState(false)
  const summary = performance?.summary

  const underlyingLines = useMemo(
    () => underlyingCostSellBreakdown(executionsForNotional),
    [executionsForNotional],
  )

  const linkedStockAttributedSum = useMemo(
    () => linkedStockPnlRows.reduce((s, r) => s + r.slippageAttributed, 0),
    [linkedStockPnlRows],
  )

  const positionStatus = useMemo(() => computeInstancePositionStatus(executionsForNotional), [executionsForNotional])

  const holdSpanDays = useMemo(
    () => holdSpanDaysForMetrics(executionsForNotional, positionStatus),
    [executionsForNotional, positionStatus],
  )
  const holdInfo =
    holdSpanDays != null
      ? {
          daysForAnnual: holdDaysForAnnualization(holdSpanDays),
          label: formatHoldDaysRounded0(holdSpanDays),
          tooltip: HOLD_TIME_TOOLTIP,
        }
      : null

  const underlyingCostUsd = underlyingCostSellOptUsd(executionsForNotional)
  const riskCostDiagnostics = useMemo(
    () => computeCapitalAtRiskWithDiagnostics(structureType, riskProfile, executionsForNotional),
    [structureType, riskProfile, executionsForNotional],
  )
  const capitalAtRisk = riskCostDiagnostics.result

  const structureTypeDisplay = useMemo(() => getStructureTypeLabel(structureType), [structureType])

  const holdDaysRoundedDisplay =
    holdSpanDays != null && Number.isFinite(holdSpanDays) ? Math.round(holdSpanDays) : null

  /** Fallback when there are no sliced execution rows (broker summary + link slippage). */
  const summaryNetPnlFallback = useMemo(() => {
    if (summary == null) return null
    return Number(summary.net_pnl) + optionStockSlippageAdjustment
  }, [summary, optionStockSlippageAdjustment])

  const displayNetPnl = execDerivedNetPnl ?? summaryNetPnlFallback

  const netPnlPerDayUsd = useMemo(() => {
    if (displayNetPnl == null || !Number.isFinite(displayNetPnl)) return null
    return netPnlUsdPerDayFromNetAndExecutions(displayNetPnl, executionsForNotional, positionStatus)
  }, [displayNetPnl, executionsForNotional, positionStatus])

  const costPerDayUsd = useMemo(() => {
    if (holdInfo == null) return null
    if (!Number.isFinite(capitalAtRisk.value) || capitalAtRisk.value <= 0) return null
    return capitalAtRisk.value / holdInfo.daysForAnnual
  }, [capitalAtRisk.value, holdInfo])

  const returnPct = useMemo(() => {
    if (displayNetPnl == null || !Number.isFinite(displayNetPnl)) return null
    if (!Number.isFinite(capitalAtRisk.value) || capitalAtRisk.value <= 0) return null
    let pct = (displayNetPnl / capitalAtRisk.value) * 100
    if (!Number.isFinite(pct)) return null
    if (pct > 999) pct = 999
    if (pct < -999) pct = -999
    return pct
  }, [displayNetPnl, capitalAtRisk.value])

  const annualDetail = useMemo(
    () =>
      summary != null && displayNetPnl != null && Number.isFinite(displayNetPnl)
        ? annualReturnDetailFromNetAndExecutions(displayNetPnl, executionsForNotional, capitalAtRisk.value, positionStatus)
        : null,
    [summary, displayNetPnl, executionsForNotional, capitalAtRisk.value, positionStatus],
  )

  const explainDisabled = loading || summary == null

  return (
    <>
      <div className="instance-detail-pnl-section-head">
        <h3 className="instance-detail-section-title">PnL</h3>
        <button
          type="button"
          className="instance-detail-pnl-info-btn instance-detail-pnl-section-info-btn"
          disabled={explainDisabled}
          onClick={() => setMetricsExplainOpen(true)}
          aria-label="How PnL metrics are calculated"
          title={explainDisabled ? undefined : 'Open calculation details for all metrics in this section'}
        >
          ⓘ
        </button>
      </div>

      {loading ? (
        <div className="instance-detail-pnl-panel instance-detail-pnl-panel--muted">
          <span className="muted">Loading performance…</span>
        </div>
      ) : !summary ? (
        <div className="instance-detail-pnl-panel instance-detail-pnl-panel--muted">
          <span className="muted">No performance data for this instance.</span>
        </div>
      ) : (
        <>
          <div className="instance-detail-pnl-panel" role="region" aria-label="PnL metrics">
            <div className="instance-detail-pnl-bands">
              <PnlBand title="PnL & commission">
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
                  <span className={`instance-detail-pnl-value ${signedPnlClass(displayNetPnl)}`}>{fmtUsd(displayNetPnl)}</span>
                </div>
                <div className="instance-detail-pnl-metric">
                  <span className="instance-detail-pnl-label">Commission</span>
                  <span className="instance-detail-pnl-value is-commission">{fmtUsd(summary.total_commission)}</span>
                </div>
                {netPnlPerDayUsd != null && holdInfo != null && (
                  <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                    <span className="instance-detail-pnl-label" title={NET_PNL_PER_DAY_HINT}>
                      Net PnL / day
                    </span>
                    <span
                      className={`instance-detail-pnl-value tabular-nums ${signedPnlClass(netPnlPerDayUsd)}`}
                      title={NET_PNL_PER_DAY_HINT}
                    >
                      {fmtUsd(netPnlPerDayUsd)}
                      <span className="instance-detail-pnl-source-tag">/day</span>
                    </span>
                  </div>
                )}
              </PnlBand>

              <PnlBand
                title="Risk & cost"
                titleExtra={
                  <button
                    type="button"
                    className="instance-detail-pnl-band-help-btn"
                    onClick={() => setRiskCostExplainOpen(true)}
                    aria-label="Open Risk and cost methodology for this instance"
                  >
                    ?
                  </button>
                }
              >
                <div className="instance-detail-pnl-metric">
                  <span className="instance-detail-pnl-label" title={capitalAtRisk.methodHint}>
                    Risk
                  </span>
                  <span className="instance-detail-pnl-value tabular-nums is-neutral" title={capitalAtRisk.methodHint}>
                    {fmtUsd(capitalAtRisk.value)}
                    <span className="instance-detail-pnl-source-tag instance-detail-pnl-source-tag--block">
                      {capitalAtRisk.methodLabel}
                    </span>
                  </span>
                </div>
                {riskProfile != null && riskProfile.max_loss != null && Number.isFinite(riskProfile.max_loss) && (
                  <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                    <span className="instance-detail-pnl-label" title="Max loss at expiration from the risk profile (options + stock legs).">
                      Max loss
                    </span>
                    <span className="instance-detail-pnl-value tabular-nums is-neutral">
                      {fmtUsd(Math.abs(riskProfile.max_loss))}
                      <span className="instance-detail-pnl-source-tag">at exp.</span>
                    </span>
                  </div>
                )}
                {underlyingCostUsd > 0 && capitalAtRisk.source !== 'underlying_notional' && (
                  <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                    <span className="instance-detail-pnl-label" title="Σ (strike × |qty| × 100) for sell-side OPT legs — underlying notional exposure.">
                      Notional
                    </span>
                    <span className="instance-detail-pnl-value tabular-nums is-neutral">
                      {fmtUsd(underlyingCostUsd)}
                    </span>
                  </div>
                )}
                {costPerDayUsd != null && holdInfo != null && (
                  <div className="instance-detail-pnl-metric instance-detail-pnl-metric--secondary">
                    <span className="instance-detail-pnl-label" title={UNDERLYING_PER_DAY_HINT}>
                      Cost / day
                    </span>
                    <span className="instance-detail-pnl-value tabular-nums is-neutral" title={UNDERLYING_PER_DAY_HINT}>
                      {fmtUsd(costPerDayUsd)}
                      <span className="instance-detail-pnl-source-tag">/day</span>
                    </span>
                  </div>
                )}
              </PnlBand>

              <PnlBand title="Times">
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
              </PnlBand>

              <PnlBand
                title="Return"
                titleExtra={
                  <button
                    type="button"
                    className="instance-detail-pnl-band-help-btn"
                    onClick={() => setReturnExplainOpen(true)}
                    aria-label="How Return percent and annual return are calculated for this instance"
                  >
                    ?
                  </button>
                }
              >
                <div className="instance-detail-pnl-metric">
                  <span className="instance-detail-pnl-label" title={RETURN_PCT_HINT}>
                    Return %
                  </span>
                  <span
                    className={`instance-detail-pnl-value tabular-nums ${
                      returnPct != null ? signedPnlClass(returnPct) : 'is-neutral'
                    }`}
                  >
                    {returnPct != null ? (
                      <>
                        {returnPct >= 0 ? '+' : ''}
                        {returnPct.toFixed(1)}%
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
                <div className="instance-detail-pnl-metric">
                  <span className="instance-detail-pnl-label" title={ANNUAL_RETURN_HINT}>
                    Annual return
                  </span>
                  <span
                    className={`instance-detail-pnl-value tabular-nums ${
                      annualDetail != null && Number.isFinite(annualDetail.annualReturnPct)
                        ? signedPnlClass(annualDetail.annualReturnPct)
                        : 'is-neutral'
                    }`}
                  >
                    {annualDetail != null && Number.isFinite(annualDetail.annualReturnPct) ? (
                      <>
                        {annualDetail.annualReturnPct >= 0 ? '+' : ''}
                        {annualDetail.annualReturnPct.toFixed(1)}%
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
              </PnlBand>
            </div>
          </div>

          <DraggableModal
            open={metricsExplainOpen}
            onBackdropClick={() => setMetricsExplainOpen(false)}
            title="PnL — calculations"
            titleId={metricsExplainTitleId}
            maxWidth="min(560px, calc(100vw - 24px))"
            footer={
              <div className={w9.dataResetModalActions}>
                <Button type="button" onClick={() => setMetricsExplainOpen(false)}>
                  Close
                </Button>
              </div>
            }
          >
            <p className="muted" style={{ marginBottom: 'var(--space-3)', borderLeft: '3px solid var(--color-border)', paddingLeft: '0.75rem' }}>
              <PnlExplainKpi>Net PnL</PnlExplainKpi> (<PnlExplainKpi>{fmtUsd(displayNetPnl)}</PnlExplainKpi>) — when fills exist in the final book for this instance:
              for each <PnlExplainKpi>OPT</PnlExplainKpi> contract group, <code>Σ (premium × qty × 100 − commission)</code> per fill direction (buy subtracts,
              sell adds), plus prorated linked-stock slippage when links exist (same layer as <PnlExplainKpi>Trade Ledger</PnlExplainKpi>). Non-OPT fills add
              their DB <code>realized_pnl</code>. This matches the <PnlExplainKpi>Group PnL</PnlExplainKpi> column in the Executions section.
              {execDerivedNetPnl == null && summaryNetPnlFallback != null ? (
                <>
                  {' '}
                  <em>
                    {explainHighlightText(
                      'Current row uses the performance-summary fallback because there is no execution slice.',
                    )}
                  </em>
                </>
              ) : null}
            </p>
            <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
              <PnlExplainKpi>Commission</PnlExplainKpi> and <PnlExplainKpi>trades</PnlExplainKpi> come from the <PnlExplainKpi>performance summary</PnlExplainKpi>{' '}
              (allocation-weighted). <PnlExplainKpi>Hold time</PnlExplainKpi>, <PnlExplainKpi>Net PnL/day</PnlExplainKpi> and <PnlExplainKpi>Cost / day</PnlExplainKpi>{' '}
              (same <PnlExplainKpi>hold days used</PnlExplainKpi> divisor), underlying cost, and <PnlExplainKpi>Annual return</PnlExplainKpi> from{' '}
              <PnlExplainKpi>(Net PnL/day ÷ Cost/day) × scale × 100</PnlExplainKpi> use <PnlExplainKpi>execution rows</PnlExplainKpi> on this page (final book).
            </p>

            {linkedStockPnlRows.length > 0 && (
              <>
                <h4 className="instance-detail-pnl-explain-sub">Linked stock slippage (this instance)</h4>
                <p style={{ marginBottom: 'var(--space-2)' }}>
                  From <code>POST /executions/option-stock-links/query</code> (same bulk load as <PnlExplainKpi>Trade Ledger</PnlExplainKpi>). Total stock
                  slippage vs Flex close for each option execution is multiplied by{' '}
                  <code>|instance qty| ÷ |parent execution qty|</code> when the row is split across instances. The{' '}
                  <PnlExplainKpi>Attributed</PnlExplainKpi> column sums to the <PnlExplainKpi>Net PnL</PnlExplainKpi> add-on above.
                </p>
                <div className="instance-detail-pnl-underlying-breakdown-wrap" style={{ marginBottom: 'var(--space-3)' }}>
                  <table className={cn(w9.tableOperations, 'instance-detail-pnl-underlying-table')}>
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
                          <td className="tabular-nums">
                            <PnlExplainKpi>{fmtUsd(row.slippageFull)}</PnlExplainKpi>
                          </td>
                          <td className="tabular-nums">
                            <PnlExplainKpi>{row.allocationRatio.toFixed(4)}</PnlExplainKpi>
                          </td>
                          <td className="tabular-nums">
                            <PnlExplainKpi>{fmtUsd(row.slippageAttributed)}</PnlExplainKpi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>
                          <PnlExplainKpi>Total attributed (→ Net PnL add-on)</PnlExplainKpi>
                        </td>
                        <td className="tabular-nums">
                          <PnlExplainKpi>{fmtUsd(linkedStockAttributedSum)}</PnlExplainKpi>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}

            <h4 className="instance-detail-pnl-explain-sub">Underlying cost (this instance)</h4>
            <p style={{ marginBottom: 'var(--space-2)' }}>
              For each <PnlExplainKpi>OPT</PnlExplainKpi> execution with sell side (SELL / SLD / S):{' '}
              <code>line = strike × |qty| × 100</code>. Total <PnlExplainKpi>underlying notional</PnlExplainKpi> cost is the sum of those lines.
            </p>
            {underlyingLines.length === 0 ? (
              <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
                {explainHighlightText(`No sell-side OPT rows — underlying cost = ${fmtUsd(0)}.`)}
              </p>
            ) : (
              <div className="instance-detail-pnl-underlying-breakdown-wrap">
                <table className={cn(w9.tableOperations, 'instance-detail-pnl-underlying-table')}>
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
                        <td className="tabular-nums">
                          <PnlExplainKpi>{fmtUsd(row.lineUsd)}</PnlExplainKpi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        <PnlExplainKpi>Total underlying cost</PnlExplainKpi>
                      </td>
                      <td className="tabular-nums">
                        <PnlExplainKpi>{fmtUsd(underlyingCostUsd)}</PnlExplainKpi>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {netPnlPerDayUsd != null && holdInfo != null && displayNetPnl != null && Number.isFinite(displayNetPnl) ? (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <PnlExplainKpi>Net PnL/day</PnlExplainKpi>: <PnlExplainKpi>{fmtUsd(displayNetPnl)}</PnlExplainKpi> ÷{' '}
                <PnlExplainKpi>{holdInfo.daysForAnnual.toFixed(4)}</PnlExplainKpi> <PnlExplainKpi>hold days used</PnlExplainKpi> ={' '}
                <PnlExplainKpi>
                  {fmtUsd(netPnlPerDayUsd)}
                  /day
                </PnlExplainKpi>
                .
              </p>
            ) : null}
            <h4 className="instance-detail-pnl-explain-sub">Capital at risk (return denominator)</h4>
            <p style={{ marginBottom: 'var(--space-2)' }}>
              <PnlExplainKpi>{capitalAtRisk.methodLabel}</PnlExplainKpi> = <PnlExplainKpi>{fmtUsd(capitalAtRisk.value)}</PnlExplainKpi>
            </p>
            <p className="muted" style={{ marginBottom: 'var(--space-3)', borderLeft: '3px solid var(--color-border)', paddingLeft: '0.75rem' }}>
              {explainHighlightText(capitalAtRisk.methodHint)}
            </p>

            {costPerDayUsd != null && holdInfo != null ? (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <PnlExplainKpi>Cost / day</PnlExplainKpi>: <PnlExplainKpi>{fmtUsd(capitalAtRisk.value)}</PnlExplainKpi> ÷{' '}
                <PnlExplainKpi>{holdInfo.daysForAnnual.toFixed(4)}</PnlExplainKpi> <PnlExplainKpi>hold days used</PnlExplainKpi> (
                <code>max(report_date span, 1)</code>, same as <PnlExplainKpi>Annual return</PnlExplainKpi> divisor) ={' '}
                <PnlExplainKpi>
                  {fmtUsd(costPerDayUsd)}
                  /day
                </PnlExplainKpi>
                .
              </p>
            ) : capitalAtRisk.value > 0 ? (
              <p className="muted" style={{ marginBottom: 'var(--space-2)' }}>
                {explainHighlightText('Cost / day needs a report_date span on executions (hold time).')}
              </p>
            ) : null}

            {returnPct != null && (
              <p style={{ marginBottom: 'var(--space-2)' }}>
                <PnlExplainKpi>Return %</PnlExplainKpi>: <PnlExplainKpi>{fmtUsd(displayNetPnl)}</PnlExplainKpi> ÷{' '}
                <PnlExplainKpi>{fmtUsd(capitalAtRisk.value)}</PnlExplainKpi> × 100 ={' '}
                <PnlExplainKpi>
                  {returnPct >= 0 ? '+' : ''}
                  {returnPct.toFixed(1)}%
                </PnlExplainKpi>
                .
              </p>
            )}

            <h4 className="instance-detail-pnl-explain-sub">Hold time &amp; scale factor</h4>
            {holdInfo != null && holdSpanDays != null && holdDaysRoundedDisplay != null ? (
              <dl className="info-dl instance-detail-ann-lin-explain-dl">
                <dt>Hold span (calendar days)</dt>
                <dd>
                  {positionStatus === 'open' ? (
                    <>
                      <PnlExplainKpi>Open</PnlExplainKpi>: earliest <code>report_date</code> → latest OPT expiry among <PnlExplainKpi>open</PnlExplainKpi>{' '}
                      legs ≈ <PnlExplainKpi>{holdDaysRoundedDisplay}</PnlExplainKpi> days (rounded; same as Hold time label).
                    </>
                  ) : (
                    <>
                      <PnlExplainKpi>Closed / no open legs</PnlExplainKpi>: max − min <code>report_date</code> ={' '}
                      <PnlExplainKpi>{holdDaysRoundedDisplay}</PnlExplainKpi> calendar days (rounded).
                    </>
                  )}
                </dd>
                <dt>Hold days used (divisor)</dt>
                <dd>
                  <code>max(hold span days, 1)</code> = <PnlExplainKpi>{holdInfo.daysForAnnual.toFixed(4)}</PnlExplainKpi>
                </dd>
                <dt>Scale factor</dt>
                <dd>
                  <code>365.25 ÷ hold days used</code> ={' '}
                  <PnlExplainKpi>{(365.25 / holdInfo.daysForAnnual).toFixed(6)}</PnlExplainKpi>
                </dd>
              </dl>
            ) : (
              <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
                {explainHighlightText(
                  'No hold span (needs min report_date; open rows also need a parseable latest OPT expiry). Annual return cannot be computed.',
                )}
              </p>
            )}

            <h4 className="instance-detail-pnl-explain-sub">Annual return (%)</h4>
            <dl className="info-dl instance-detail-ann-lin-explain-dl">
              <dt>Formula</dt>
              <dd>
                <code>(Net PnL/day ÷ Cost/day) × (365.25 ÷ hold days used) × 100</code>
                <span className="muted"> — same as </span>
                <code>(net PnL × scale factor ÷ capital at risk) × 100</code>
                <span className="muted"> with scale = 365.25 ÷ hold days used.</span>
              </dd>
              <dt>Net PnL (for annual %)</dt>
              <dd>
                <PnlExplainKpi>{fmtUsd(displayNetPnl)}</PnlExplainKpi>
                {execDerivedNetPnl != null ? (
                  <span className="muted"> — execution-derived (same as strip above)</span>
                ) : summary != null ? (
                  <>
                    {' '}
                    <span className="muted">
                      (
                      <PnlExplainKpi>{fmtUsd(Number(summary.net_pnl))}</PnlExplainKpi> summary
                      {optionStockSlippageAdjustment !== 0 ? (
                        <>
                          {' '}
                          + <PnlExplainKpi>{fmtUsd(optionStockSlippageAdjustment)}</PnlExplainKpi> linked stock
                        </>
                      ) : null}
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
                    <PnlExplainKpi>
                      {annualDetail.annualReturnPct >= 0 ? '+' : ''}
                      {annualDetail.annualReturnPct.toFixed(1)}%
                    </PnlExplainKpi>
                  </>
                ) : (
                  <span className="muted">
                    {explainHighlightText('— (needs report dates, underlying cost > 0, and valid Net PnL)')}
                  </span>
                )}
              </dd>
            </dl>
          </DraggableModal>

          <DraggableModal
            open={returnExplainOpen}
            onBackdropClick={() => {}}
            backdropLocked
            title={`Return — Instance #${strategyInstanceId}`}
            titleId={returnExplainTitleId}
            maxWidth="min(820px, calc(100vw - 40px))"
            panelClassName="instance-detail-risk-cost-explain-modal"
            footer={
              <div className={w9.dataResetModalActions}>
                <Button type="button" onClick={() => setReturnExplainOpen(false)}>
                  Close
                </Button>
              </div>
            }
          >
            <InstanceReturnExplainBody
              strategyInstanceId={strategyInstanceId}
              structureDisplayName={structureDisplayName ?? null}
              structureTypeRaw={structureType}
              structureTypeDisplay={structureTypeDisplay}
              capitalAtRisk={capitalAtRisk}
              displayNetPnl={displayNetPnl}
              returnPct={returnPct}
              annualDetail={annualDetail}
              costPerDayUsd={costPerDayUsd}
              netPnlPerDayUsd={netPnlPerDayUsd}
              holdDaysUsed={holdInfo?.daysForAnnual ?? null}
              holdLabel={holdInfo?.label ?? null}
              executionDerivedNetPnl={execDerivedNetPnl != null}
            />
          </DraggableModal>

          <DraggableModal
            open={riskCostExplainOpen}
            onBackdropClick={() => {}}
            backdropLocked
            title={`Risk & cost — Instance #${strategyInstanceId}`}
            titleId={riskCostExplainTitleId}
            maxWidth="min(820px, calc(100vw - 40px))"
            panelClassName="instance-detail-risk-cost-explain-modal"
            footer={
              <div className={w9.dataResetModalActions}>
                <Button type="button" onClick={() => setRiskCostExplainOpen(false)}>
                  Close
                </Button>
              </div>
            }
          >
            <InstanceRiskCostExplainBody
              strategyInstanceId={strategyInstanceId}
              structureTypeRaw={structureType}
              structureTypeDisplay={structureTypeDisplay}
              riskCostDiagnostics={riskCostDiagnostics}
              riskProfile={riskProfile}
              underlyingCostUsd={underlyingCostUsd}
              displayNetPnl={displayNetPnl}
              returnPct={returnPct}
              annualDetail={annualDetail}
              costPerDayUsd={costPerDayUsd}
              holdDaysUsed={holdInfo?.daysForAnnual ?? null}
              holdLabel={holdInfo?.label ?? null}
              tradeCount={summary.trade_count ?? 0}
              commission={
              summary.total_commission != null && Number.isFinite(Number(summary.total_commission))
                ? Number(summary.total_commission)
                : null
            }
              netPnlPerDayUsd={netPnlPerDayUsd}
            />
          </DraggableModal>
        </>
      )}
    </>
  )
}
