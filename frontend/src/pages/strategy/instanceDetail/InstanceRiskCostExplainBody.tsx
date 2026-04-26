import type { ReactNode } from 'react'
import type { RiskProfile } from '../../../utils/riskProfile'
import { fmtUsd } from '../../../utils/format'
import {
  RISK_COST_EXPLICIT_STRUCTURE_COUNT,
  RISK_COST_EXPLICIT_STRUCTURE_KEYS,
} from './instanceDetailPnlMetrics'
import type { AnnualReturnDetailFromExecutions, CapitalAtRiskDiagnostics } from './instanceDetailPnlMetrics'
import { explainHighlightText } from './explainTextHighlight'

function Kpi({ children }: { children: ReactNode }) {
  return <strong className="instance-detail-modal-explain-kpi">{children}</strong>
}

function candidateCell(value: number | null, requirePositive: boolean, unavailable: string | null): ReactNode {
  if (value != null && Number.isFinite(value) && (!requirePositive || value > 0)) {
    return <Kpi>{fmtUsd(value)}</Kpi>
  }
  const note =
    unavailable != null && unavailable.length > 0
      ? unavailable.length > 90
        ? `${unavailable.slice(0, 87)}…`
        : unavailable
      : null
  return (
    <span className="muted">
      —{note != null ? <span title={unavailable ?? undefined}> ({note})</span> : null}
    </span>
  )
}

export function InstanceRiskCostExplainBody({
  strategyInstanceId,
  structureTypeRaw,
  structureTypeDisplay,
  riskCostDiagnostics,
  riskProfile,
  underlyingCostUsd,
  displayNetPnl,
  returnPct,
  annualDetail,
  costPerDayUsd,
  holdDaysUsed,
  holdLabel,
  tradeCount,
  commission,
  netPnlPerDayUsd,
}: {
  strategyInstanceId: number
  structureTypeRaw: string | null
  structureTypeDisplay: string
  riskCostDiagnostics: CapitalAtRiskDiagnostics
  riskProfile: RiskProfile | null
  underlyingCostUsd: number
  displayNetPnl: number | null
  returnPct: number | null
  annualDetail: AnnualReturnDetailFromExecutions | null
  costPerDayUsd: number | null
  holdDaysUsed: number | null
  holdLabel: string | null
  tradeCount: number
  commission: number | null
  netPnlPerDayUsd: number | null
}) {
  const capitalAtRisk = riskCostDiagnostics.result
  const { candidates, mindFlowSteps, ruleTraceLines, chosenLetter, selectionWhy } = riskCostDiagnostics

  const stRaw = (structureTypeRaw ?? '').trim() || '—'
  const hasProfile = riskProfile != null
  const maxLossUsd =
    riskProfile?.max_loss != null && Number.isFinite(riskProfile.max_loss) ? Math.abs(riskProfile.max_loss) : null
  const stockShares = riskProfile?.calc_context?.covered_shares ?? 0
  const stockAvg = riskProfile?.calc_context?.underlying_avg_cost

  return (
    <div className="instance-detail-risk-cost-explain">
      <div className="instance-detail-risk-cost-mindflow" role="region" aria-label="How capital at risk is chosen">
        <div className="instance-detail-risk-cost-mindflow-title">
          {explainHighlightText('Mind flow — Risk & cost (this instance)')}
        </div>
        <ol className="instance-detail-risk-cost-mindflow-ol">
          {mindFlowSteps.map((s) => (
            <li key={s.n} className="instance-detail-risk-cost-mindflow-li">
              <span className="instance-detail-risk-cost-mindflow-step-num">{s.n}</span>
              <div className="instance-detail-risk-cost-mindflow-step-body">
                <div className="instance-detail-risk-cost-mindflow-heading">{explainHighlightText(s.heading)}</div>
                <div
                  className={
                    s.n === 2
                      ? 'instance-detail-risk-cost-mindflow-text instance-detail-risk-cost-mindflow-text--pre'
                      : 'instance-detail-risk-cost-mindflow-text'
                  }
                >
                  {explainHighlightText(s.body)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <h4 className="instance-detail-risk-cost-explain-h">
        Why this <Kpi>denominator</Kpi> for <Kpi>Instance #{strategyInstanceId}</Kpi>
      </h4>
      <p className="instance-detail-risk-cost-explain-p instance-detail-risk-cost-selection-why">
        The strip uses <Kpi>({chosenLetter})</Kpi> <Kpi>{capitalAtRisk.methodLabel}</Kpi> = <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> as{' '}
        <Kpi>Capital at risk</Kpi>. {explainHighlightText(selectionWhy)}
      </p>
      <p className="muted instance-detail-risk-cost-explain-p">{explainHighlightText(capitalAtRisk.methodHint)}</p>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Reference amounts (A–E)</Kpi> — this instance
      </h4>
      <div className="instance-detail-risk-cost-candidate-table-wrap">
        <table className="instance-detail-risk-cost-candidate-table">
          <thead>
            <tr>
              <th scope="col"> </th>
              <th scope="col">
                <Kpi>Measure</Kpi>
              </th>
              <th scope="col">
                <Kpi>Value</Kpi>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className={chosenLetter === 'A' ? 'instance-detail-risk-cost-candidate-row--chosen' : undefined}>
              <td>
                <Kpi>A</Kpi>
              </td>
              <td>
                <Kpi>Stock cost basis</Kpi> <span className="muted">(shares × avg cost)</span>
              </td>
              <td>
                {candidateCell(candidates.aStockCostBasisUsd, true, candidates.aUnavailableReason)}
                {chosenLetter === 'A' ? <span className="instance-detail-risk-cost-chosen-tag">Chosen</span> : null}
              </td>
            </tr>
            <tr className={chosenLetter === 'B' ? 'instance-detail-risk-cost-candidate-row--chosen' : undefined}>
              <td>
                <Kpi>B</Kpi>
              </td>
              <td>
                <Kpi>Cash secured</Kpi> <span className="muted">(Σ short put strike × |qty| × 100)</span>
              </td>
              <td>
                {candidateCell(candidates.bCashSecuredUsd, false, null)}
                {chosenLetter === 'B' ? <span className="instance-detail-risk-cost-chosen-tag">Chosen</span> : null}
              </td>
            </tr>
            <tr className={chosenLetter === 'C' ? 'instance-detail-risk-cost-candidate-row--chosen' : undefined}>
              <td>
                <Kpi>C</Kpi>
              </td>
              <td>
                <Kpi>Max loss at expiration</Kpi> <span className="muted">(risk profile)</span>
              </td>
              <td>
                {candidateCell(candidates.cMaxLossAtExpUsd, true, candidates.cUnavailableReason)}
                {chosenLetter === 'C' ? <span className="instance-detail-risk-cost-chosen-tag">Chosen</span> : null}
              </td>
            </tr>
            <tr className={chosenLetter === 'D' ? 'instance-detail-risk-cost-candidate-row--chosen' : undefined}>
              <td>
                <Kpi>D</Kpi>
              </td>
              <td>
                <Kpi>Underlying notional</Kpi> <span className="muted">(sell-side OPT)</span>
              </td>
              <td>
                {candidateCell(candidates.dUnderlyingNotionalUsd, false, null)}
                {chosenLetter === 'D' ? <span className="instance-detail-risk-cost-chosen-tag">Chosen</span> : null}
              </td>
            </tr>
            <tr>
              <td>
                <Kpi>E</Kpi>
              </td>
              <td>
                <Kpi>Reg-T</Kpi> / <Kpi>portfolio margin</Kpi>
              </td>
              <td>
                <span className="muted">
                  <Kpi>Not modeled</Kpi> — no value.
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Decision log</Kpi> (engine order)
      </h4>
      <ol className="instance-detail-risk-cost-ruletrace">
        {ruleTraceLines.map((line, i) => (
          <li key={i} className="instance-detail-risk-cost-ruletrace-li">
            {explainHighlightText(line)}
          </li>
        ))}
      </ol>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>This instance</Kpi>
      </h4>
      <p className="instance-detail-risk-cost-explain-p">
        Instance <Kpi>#{strategyInstanceId}</Kpi> uses linked <Kpi>structure_type</Kpi> <Kpi>{stRaw}</Kpi> ({structureTypeDisplay}
        ).{' '}
        {explainHighlightText(
          "The numbers below are taken from this instance's performance summary and execution slice on this page.",
        )}
      </p>

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Capital at risk</Kpi> → <Kpi>Risk & cost</Kpi> metrics
      </h4>
      <p className="instance-detail-risk-cost-explain-p">
        <Kpi>Cost / day</Kpi> = <Kpi>Capital at risk</Kpi> ÷ <Kpi>hold days used</Kpi>. <Kpi>Return %</Kpi> = <Kpi>Net PnL</Kpi> ÷{' '}
        <Kpi>Capital at risk</Kpi> × 100. <Kpi>Annual return</Kpi> uses the same denominator per day as <Kpi>Cost / day</Kpi> (see worked
        example).
      </p>

      {maxLossUsd != null && (
        <p className="instance-detail-risk-cost-explain-p">
          <Kpi>Risk profile</Kpi> <Kpi>max loss at expiration</Kpi> (options + modeled stock): <Kpi>{fmtUsd(maxLossUsd)}</Kpi>
          {capitalAtRisk.source === 'max_loss_at_exp' ? (
            <span className="muted"> {explainHighlightText('— aligns with (C) when (C) drives the denominator.')}</span>
          ) : (
            <span className="muted">
              {' '}
              {explainHighlightText(
                '— reference only; your denominator may be (A), (B), or (D) depending on structure and data.',
              )}
            </span>
          )}
        </p>
      )}

      {underlyingCostUsd > 0 && (
        <p className="instance-detail-risk-cost-explain-p">
          <Kpi>sell-side OPT</Kpi> <Kpi>Underlying notional</Kpi> (Σ strike × |qty| × 100 on this instance slice):{' '}
          <Kpi>{fmtUsd(underlyingCostUsd)}</Kpi>
          {capitalAtRisk.source === 'underlying_notional' ? (
            <span className="muted"> {explainHighlightText('— same as (D); used as denominator when (C) is unavailable.')}</span>
          ) : (
            <span className="muted">
              {' '}
              {explainHighlightText(
                '— same quantity as (D); may differ from Capital at risk when (A), (B), or (C) is chosen.',
              )}
            </span>
          )}
        </p>
      )}

      {stockShares > 0 && stockAvg != null && Number.isFinite(stockAvg) && stockAvg > 0 && (
        <p className="instance-detail-risk-cost-explain-p">
          Modeled stock leg for <Kpi>risk profile</Kpi>: <Kpi>{stockShares}</Kpi> shares @ avg <Kpi>{fmtUsd(stockAvg)}</Kpi> →{' '}
          <Kpi>Stock cost basis</Kpi> <Kpi>{fmtUsd(stockShares * stockAvg)}</Kpi> (feeds <Kpi>(A)</Kpi>)
        </p>
      )}
      {stockShares > 0 && riskProfile?.stock_avg_cost_known === false && (
        <p className="muted instance-detail-risk-cost-explain-p">
          {explainHighlightText(
            'Stock average cost is missing in the risk model — the stock leg may be omitted in the expiration grid.',
          )}
        </p>
      )}

      <h4 className="instance-detail-risk-cost-explain-h">
        <Kpi>Worked example</Kpi> (this instance)
      </h4>
      <ul className="instance-detail-risk-cost-explain-ul">
        <li>
          <Kpi>Net PnL</Kpi>:{' '}
          {displayNetPnl != null && Number.isFinite(displayNetPnl) ? <Kpi>{fmtUsd(displayNetPnl)}</Kpi> : <span className="muted">—</span>}
        </li>
        <li>
          <Kpi>Commission</Kpi> (<Kpi>performance summary</Kpi>):{' '}
          {commission != null && Number.isFinite(commission) ? <Kpi>{fmtUsd(commission)}</Kpi> : <span className="muted">—</span>}
        </li>
        <li>
          <Kpi>Trades</Kpi>: <Kpi>{tradeCount}</Kpi>
        </li>
        <li>
          <Kpi>Hold time</Kpi>:{' '}
          {holdLabel != null ? (
            <>
              <Kpi>{holdLabel}</Kpi>
              {holdDaysUsed != null && (
                <span className="muted">
                  {' '}
                  (<Kpi>hold days used</Kpi> in formulas = <Kpi>{holdDaysUsed.toFixed(4)}</Kpi>,{' '}
                  <code>max(report_date span, 1)</code>)
                </span>
              )}
            </>
          ) : (
            <span className="muted">{explainHighlightText('— (needs report_date span on executions)')}</span>
          )}
        </li>
        {netPnlPerDayUsd != null && holdDaysUsed != null && displayNetPnl != null && Number.isFinite(displayNetPnl) && (
          <li>
            <Kpi>Net PnL/day</Kpi>: <Kpi>{fmtUsd(displayNetPnl)}</Kpi> ÷ <Kpi>{holdDaysUsed.toFixed(4)}</Kpi> = <Kpi>{fmtUsd(netPnlPerDayUsd)}</Kpi>
            /day
          </li>
        )}
        {costPerDayUsd != null && holdDaysUsed != null && (
          <li>
            <Kpi>Cost / day</Kpi>: <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> ÷ <Kpi>{holdDaysUsed.toFixed(4)}</Kpi> = <Kpi>{fmtUsd(costPerDayUsd)}</Kpi>
            /day
          </li>
        )}
        {returnPct != null && displayNetPnl != null && Number.isFinite(displayNetPnl) && (
          <li>
            <Kpi>Return %</Kpi>: <Kpi>{fmtUsd(displayNetPnl)}</Kpi> ÷ <Kpi>{fmtUsd(capitalAtRisk.value)}</Kpi> × 100 ≈{' '}
            <Kpi>
              {returnPct >= 0 ? '+' : ''}
              {returnPct.toFixed(1)}%
            </Kpi>
          </li>
        )}
        {annualDetail != null && Number.isFinite(annualDetail.annualReturnPct) && (
          <li>
            <Kpi>Annual return</Kpi>:{' '}
            <span className="muted">
              (<Kpi>{annualDetail.netPnlPerDayUsd.toFixed(4)}</Kpi> ÷ <Kpi>{annualDetail.denominatorPerDayUsd.toFixed(4)}</Kpi>) ×{' '}
              <Kpi>{annualDetail.factor.toFixed(4)}</Kpi> × 100 ≈{' '}
            </span>
            <Kpi>
              {annualDetail.annualReturnPct >= 0 ? '+' : ''}
              {annualDetail.annualReturnPct.toFixed(1)}%
            </Kpi>
          </li>
        )}
      </ul>

      <h4 className="instance-detail-risk-cost-explain-h">
        What the labels <Kpi>A–E</Kpi> mean
      </h4>
      <ul className="instance-detail-risk-cost-explain-ul instance-detail-risk-cost-explain-ul--glossary">
        <li>
          <Kpi>(A)</Kpi> <Kpi>Stock cost basis</Kpi> — long equity at average cost (covered-call style ROC).
        </li>
        <li>
          <Kpi>(B)</Kpi> <Kpi>Cash secured</Kpi> — short-put strike × contracts × 100 on this instance slice.
        </li>
        <li>
          <Kpi>(C)</Kpi> <Kpi>Max loss at expiration</Kpi> — from the <Kpi>risk profile</Kpi> when legs + optional stock hedge are modeled.
        </li>
        <li>
          <Kpi>(D)</Kpi> <Kpi>Underlying notional</Kpi> — <Kpi>sell-side OPT</Kpi> Σ(strike×|qty|×100) as a fallback proxy.
        </li>
        <li>
          <Kpi>(E)</Kpi> <Kpi>Reg-T</Kpi> / <Kpi>portfolio margin</Kpi> — not modeled in this panel.
        </li>
      </ul>

      <h4 className="instance-detail-risk-cost-explain-h">Structure rules in this panel</h4>
      <p className="instance-detail-risk-cost-explain-p muted">
        <Kpi>{RISK_COST_EXPLICIT_STRUCTURE_COUNT}</Kpi> explicit <Kpi>structure_type</Kpi> mappings:{' '}
        <Kpi>{RISK_COST_EXPLICIT_STRUCTURE_KEYS.join(', ')}</Kpi>. Any other type uses a generic cascade: prefer <Kpi>(C)</Kpi>, else{' '}
        <Kpi>(D)</Kpi>. <Kpi>Risk profile</Kpi> loaded: <Kpi>{hasProfile ? 'yes' : 'no'}</Kpi>.
      </p>
    </div>
  )
}
