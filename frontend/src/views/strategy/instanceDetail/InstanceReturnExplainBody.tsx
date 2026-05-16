import type { ReactNode } from 'react'
import { fmtUsd } from '../../../utils/format'
import type { AnnualReturnDetailFromExecutions, CapitalAtRiskResult } from './instanceDetailPnlMetrics'
import { explainHighlightText } from './explainTextHighlight'

function Kpi({ children }: { children: ReactNode }) {
  return <strong className="instance-detail-modal-explain-kpi">{children}</strong>
}

export function InstanceReturnExplainBody({
  strategyInstanceId,
  structureDisplayName,
  structureTypeRaw,
  structureTypeDisplay,
  capitalAtRisk,
  displayNetPnl,
  returnPct,
  annualDetail,
  costPerDayUsd,
  netPnlPerDayUsd,
  holdDaysUsed,
  holdLabel,
  executionDerivedNetPnl,
}: {
  strategyInstanceId: number
  structureDisplayName: string | null
  structureTypeRaw: string | null
  structureTypeDisplay: string
  capitalAtRisk: CapitalAtRiskResult
  displayNetPnl: number | null
  returnPct: number | null
  annualDetail: AnnualReturnDetailFromExecutions | null
  costPerDayUsd: number | null
  netPnlPerDayUsd: number | null
  holdDaysUsed: number | null
  holdLabel: string | null
  /** True when Net PnL on the strip comes from execution-group sums (not summary-only fallback). */
  executionDerivedNetPnl: boolean
}) {
  const st = (structureTypeRaw ?? '').trim().toLowerCase()
  const templateName = (structureDisplayName ?? '').trim()
  const isCoveredCall = st === 'covered_call'
  const templateMentionsOtm = /\botm\b|%\s*otm|otm\b|%/i.test(templateName)

  return (
    <div className="instance-detail-risk-cost-explain">
      <div className="instance-detail-risk-cost-mindflow" role="region" aria-label="How Return metrics are computed">
        <div className="instance-detail-risk-cost-mindflow-title">
          {explainHighlightText('Mind flow — Return % & Annual return (this instance)')}
        </div>
        <ol className="instance-detail-risk-cost-mindflow-ol">
          <li className="instance-detail-risk-cost-mindflow-li">
            <span className="instance-detail-risk-cost-mindflow-step-num">1</span>
            <div className="instance-detail-risk-cost-mindflow-step-body">
              <div className="instance-detail-risk-cost-mindflow-heading">Template name vs formula inputs</div>
              <div className="instance-detail-risk-cost-mindflow-text">
                {templateName ? (
                  <>
                    Your linked structure is named <Kpi>{templateName}</Kpi>.
                    {templateMentionsOtm ? (
                      <>
                        {' '}
                        Phrases such as <Kpi>10% OTM</Kpi> in that title describe <em>target call moneyness</em> in the playbook — they are{' '}
                        <strong>not</strong> a separate input into <Kpi>Return %</Kpi> or <Kpi>Annual return</Kpi> on this screen.
                      </>
                    ) : (
                      <>
                        {' '}
                        That title reflects how the library labels strike distance or entry rules — it is <strong>not</strong> fed as a
                        separate variable into <Kpi>Return %</Kpi> or <Kpi>Annual return</Kpi> here.
                      </>
                    )}
                  </>
                ) : (
                  <>
                    This screen does not show a structure display name; it uses <Kpi>structure_type</Kpi>{' '}
                    <Kpi>{structureTypeDisplay}</Kpi> (<Kpi>{(structureTypeRaw ?? '').trim() || '—'}</Kpi>) only.
                  </>
                )}{' '}
                Both return metrics use <Kpi>booked Net PnL</Kpi> on this instance and <Kpi>Capital at risk</Kpi> from the Risk &amp;
                cost rules (e.g. <Kpi>Stock cost basis</Kpi> for covered calls when shares × avg cost exist).
              </div>
            </div>
          </li>
          <li className="instance-detail-risk-cost-mindflow-li">
            <span className="instance-detail-risk-cost-mindflow-step-num">2</span>
            <div className="instance-detail-risk-cost-mindflow-step-body">
              <div className="instance-detail-risk-cost-mindflow-heading">
                <Kpi>Net PnL</Kpi> (numerator)
              </div>
              <div className="instance-detail-risk-cost-mindflow-text">
                {executionDerivedNetPnl ? (
                  <>
                    <Kpi>Net PnL</Kpi> is the sum of per-contract group P&amp;L from this instance&apos;s execution slice (premiums ±
                    commissions per fill, plus attributed linked-stock slippage when present).
                  </>
                ) : (
                  <>
                    <Kpi>Net PnL</Kpi> uses the performance-summary path (no execution slice in the final book for this instance), plus
                    prorated option–stock link slippage when applicable.
                  </>
                )}{' '}
                On the strip:{' '}
                {displayNetPnl != null && Number.isFinite(displayNetPnl) ? <Kpi>{fmtUsd(displayNetPnl)}</Kpi> : <span className="muted">—</span>}
              </div>
            </div>
          </li>
          <li className="instance-detail-risk-cost-mindflow-li">
            <span className="instance-detail-risk-cost-mindflow-step-num">3</span>
            <div className="instance-detail-risk-cost-mindflow-step-body">
              <div className="instance-detail-risk-cost-mindflow-heading">
                <Kpi>Capital at risk</Kpi> (denominator)
              </div>
              <div className="instance-detail-risk-cost-mindflow-text">
                {isCoveredCall ? (
                  <>
                    For <Kpi>covered_call</Kpi>, the panel prefers <Kpi>Stock cost basis</Kpi> (long shares × average cost from the risk
                    model). If that is missing, it may fall back to <Kpi>max loss at expiration</Kpi> or <Kpi>Underlying notional</Kpi> — see
                    the Risk &amp; cost help (?) dialog for the exact branch for Instance <Kpi>#{strategyInstanceId}</Kpi>.
                  </>
                ) : (
                  <>
                    Denominator follows <Kpi>structure_type</Kpi> rules (cash secured, spreads, generic cascade, etc.). Open Risk &amp;
                    cost help (?) for the decision log.
                  </>
                )}{' '}
                Current denominator: <Kpi>{capitalAtRisk.methodLabel}</Kpi> = <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> (
                <Kpi>{capitalAtRisk.source}</Kpi>).
              </div>
            </div>
          </li>
          <li className="instance-detail-risk-cost-mindflow-li">
            <span className="instance-detail-risk-cost-mindflow-step-num">4</span>
            <div className="instance-detail-risk-cost-mindflow-step-body">
              <div className="instance-detail-risk-cost-mindflow-heading">
                <Kpi>Return %</Kpi> and <Kpi>Annual return</Kpi>
              </div>
              <div className="instance-detail-risk-cost-mindflow-text">
                <Kpi>Return %</Kpi> = <Kpi>Net PnL</Kpi> ÷ <Kpi>Capital at risk</Kpi> × 100 (same denominator as Risk on the strip).{' '}
                <Kpi>Annual return</Kpi> = (<Kpi>Net PnL/day</Kpi> ÷ <Kpi>Cost/day</Kpi>) × (<Kpi>365.25</Kpi> ÷ <Kpi>hold days used</Kpi>) × 100,
                algebraically the same as scaling <Kpi>Return %</Kpi> by trading days per year on the same capital base.
              </div>
            </div>
          </li>
        </ol>
      </div>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Return %</Kpi> — worked example (Instance <Kpi>#{strategyInstanceId}</Kpi>)
      </h4>
      <p className="instance-detail-risk-cost-explain-p">
        <Kpi>Return %</Kpi> = <Kpi>Net PnL</Kpi> ÷ <Kpi>Capital at risk</Kpi> × 100.
      </p>
      <ul className="instance-detail-risk-cost-explain-ul">
        <li>
          <Kpi>Net PnL</Kpi>:{' '}
          {displayNetPnl != null && Number.isFinite(displayNetPnl) ? <Kpi>{fmtUsd(displayNetPnl)}</Kpi> : <span className="muted">—</span>}
        </li>
        <li>
          <Kpi>Capital at risk</Kpi> ({capitalAtRisk.methodLabel}): <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi>
        </li>
        {returnPct != null && displayNetPnl != null && Number.isFinite(displayNetPnl) ? (
          <li>
            <Kpi>Return %</Kpi>: <Kpi>{fmtUsd(displayNetPnl)}</Kpi> ÷ <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> × 100 ≈{' '}
            <Kpi>
              {returnPct >= 0 ? '+' : ''}
              {returnPct.toFixed(1)}%
            </Kpi>
          </li>
        ) : (
          <li className="muted">Return % needs valid Net PnL and a positive Capital at risk.</li>
        )}
      </ul>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Annual return</Kpi> — same capital, hold-time scale
      </h4>
      <p className="instance-detail-risk-cost-explain-p">
        <Kpi>Hold span</Kpi> on this page: <Kpi>Open</Kpi> — min <Kpi>report_date</Kpi> to latest OPT expiry among open legs;{' '}
        <Kpi>Closed</Kpi> — max minus min <Kpi>report_date</Kpi>. <Kpi>hold days used</Kpi> = <code>max(span calendar days, 1)</code>.{' '}
        <Kpi>Cost/day</Kpi> = <Kpi>Capital at risk</Kpi> ÷ hold days used; <Kpi>Net PnL/day</Kpi> = <Kpi>Net PnL</Kpi> ÷ hold days used.
      </p>
      <ul className="instance-detail-risk-cost-explain-ul">
        <li>
          <Kpi>Hold time</Kpi> (label):{' '}
          {holdLabel != null ? <Kpi>{holdLabel}</Kpi> : <span className="muted">—</span>}
          {holdDaysUsed != null ? (
            <span className="muted">
              {' '}
              — divisor in formulas: <Kpi>{holdDaysUsed.toFixed(4)}</Kpi> days
            </span>
          ) : null}
        </li>
        {netPnlPerDayUsd != null && holdDaysUsed != null && displayNetPnl != null && Number.isFinite(displayNetPnl) ? (
          <li>
            <Kpi>Net PnL/day</Kpi>: <Kpi>{fmtUsd(displayNetPnl)}</Kpi> ÷ <Kpi>{holdDaysUsed.toFixed(4)}</Kpi> = <Kpi>{fmtUsd(netPnlPerDayUsd)}</Kpi>/day
          </li>
        ) : null}
        {costPerDayUsd != null && holdDaysUsed != null ? (
          <li>
            <Kpi>Cost/day</Kpi>: <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> ÷ <Kpi>{holdDaysUsed.toFixed(4)}</Kpi> = <Kpi>{fmtUsd(costPerDayUsd)}</Kpi>/day
          </li>
        ) : null}
        {annualDetail != null && Number.isFinite(annualDetail.annualReturnPct) ? (
          <li>
            <Kpi>Annual return</Kpi>: (<Kpi>{annualDetail.netPnlPerDayUsd.toFixed(4)}</Kpi> ÷ <Kpi>{annualDetail.denominatorPerDayUsd.toFixed(4)}</Kpi>) ×{' '}
            <Kpi>{annualDetail.factor.toFixed(4)}</Kpi> × 100 ≈{' '}
            <Kpi>
              {annualDetail.annualReturnPct >= 0 ? '+' : ''}
              {annualDetail.annualReturnPct.toFixed(1)}%
            </Kpi>
          </li>
        ) : (
          <li className="muted">Annual return needs report_date span, positive capital denominator, and valid Net PnL.</li>
        )}
      </ul>

      <p className="muted instance-detail-risk-cost-explain-p">{explainHighlightText(capitalAtRisk.methodHint)}</p>
    </div>
  )
}
