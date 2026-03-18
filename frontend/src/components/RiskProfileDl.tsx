import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RiskProfile, RiskPosition, RiskScenarioBreakdown } from '../utils/riskProfile'
import {
  formatApproxUsd,
  formatRiskLabel,
  formatRiskUsd,
  getRiskGridRows,
  legContributionAtS,
  netCallShareBalance,
  payoffOptionsAtPrice,
  stripNakedShortCalls,
} from '../utils/riskProfile'

function RiskFieldHelp({
  helpKey,
  openKey,
  onSetOpen,
  label,
  children,
}: {
  helpKey: string
  openKey: string | null
  onSetOpen: (key: string | null) => void
  label: string
  children: ReactNode
}) {
  const open = openKey === helpKey
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef({
    active: false,
    sx: 0,
    sy: 0,
    ox: 0,
    oy: 0,
  })
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 640px)').matches : false,
  )

  useEffect(() => {
    if (!open) {
      setDragOffset({ x: 0, y: 0 })
      return
    }
    const mq = window.matchMedia('(max-width: 640px)')
    setNarrow(mq.matches)
    const onMq = () => setNarrow(mq.matches)
    mq.addEventListener('change', onMq)

    const move = (clientX: number, clientY: number) => {
      if (!dragRef.current.active) return
      const { sx, sy, ox, oy } = dragRef.current
      setDragOffset({ x: ox + clientX - sx, y: oy + clientY - sy })
    }
    const onMm = (e: MouseEvent) => move(e.clientX, e.clientY)
    const onMu = () => {
      dragRef.current.active = false
    }
    const onTm = (e: TouchEvent) => {
      if (e.touches.length > 0) move(e.touches[0].clientX, e.touches[0].clientY)
    }
    const onTe = () => {
      dragRef.current.active = false
    }
    window.addEventListener('mousemove', onMm)
    window.addEventListener('mouseup', onMu)
    window.addEventListener('touchmove', onTm, { passive: true })
    window.addEventListener('touchend', onTe)
    window.addEventListener('touchcancel', onTe)
    return () => {
      dragRef.current.active = false
      mq.removeEventListener('change', onMq)
      window.removeEventListener('mousemove', onMm)
      window.removeEventListener('mouseup', onMu)
      window.removeEventListener('touchmove', onTm)
      window.removeEventListener('touchend', onTe)
      window.removeEventListener('touchcancel', onTe)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSetOpen(null)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, onSetOpen])

  const startDrag = (clientX: number, clientY: number) => {
    dragRef.current = {
      active: true,
      sx: clientX,
      sy: clientY,
      ox: dragOffset.x,
      oy: dragOffset.y,
    }
  }

  const onHeadMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.risk-field-help-portal-close')) return
    e.preventDefault()
    startDrag(e.clientX, e.clientY)
  }

  const onHeadTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('.risk-field-help-portal-close')) return
    const t = e.touches[0]
    if (!t) return
    startDrag(t.clientX, t.clientY)
  }

  const panelTransform = narrow
    ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
    : `translate(${dragOffset.x}px, calc(-50% + ${dragOffset.y}px))`

  return (
    <>
      <button
        type="button"
        className={`risk-field-help-trigger${open ? ' risk-field-help-trigger-active' : ''}`}
        aria-expanded={open}
        aria-controls={open ? `risk-help-${helpKey}` : undefined}
        aria-label={`Help: ${label}`}
        onClick={e => {
          e.stopPropagation()
          onSetOpen(open ? null : helpKey)
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            className="risk-field-help-portal-root"
            role="presentation"
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
          >
            <div
              className="risk-field-help-portal-backdrop"
              aria-hidden
              onMouseDown={e => e.stopPropagation()}
              onClick={() => onSetOpen(null)}
            />
            <div
              id={`risk-help-${helpKey}`}
              className="risk-field-help-portal-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`risk-help-title-${helpKey}`}
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              style={{ transform: panelTransform }}
            >
              <div
                className="risk-field-help-portal-head"
                onMouseDown={onHeadMouseDown}
                onTouchStart={onHeadTouchStart}
              >
                <span id={`risk-help-title-${helpKey}`} className="risk-field-help-portal-title">
                  {label}
                </span>
                <button
                  type="button"
                  className="risk-field-help-portal-close"
                  onClick={e => {
                    e.stopPropagation()
                    onSetOpen(null)
                  }}
                >
                  Close
                </button>
              </div>
              <div className="risk-field-help-portal-body">{children}</div>
              <p className="risk-field-help-portal-foot">
                Drag the title bar to move. Stays open until you close: <strong>Close</strong>, <strong>Esc</strong>,
                click the dimmed area, or click <strong>?</strong> again.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function HelpP({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`risk-field-help-p${className ? ` ${className}` : ''}`}>{children}</p>
}

function HelpCode({ children }: { children: ReactNode }) {
  return <pre className="risk-field-help-code">{children}</pre>
}

type MatrixExplainSelection = {
  row: 'gain' | 'loss' | 'hedged'
  field: 'option' | 'stk'
  scenario: RiskScenarioBreakdown
}

function matrixExplainKey(s: MatrixExplainSelection): string {
  return `${s.row}-${s.field}-${s.scenario.underlying_price}`
}

function ClickablePnlCell({
  v,
  onClick,
  active,
}: {
  v: number
  onClick: () => void
  active: boolean
}) {
  return (
    <td className="risk-scenario-matrix-click-wrap">
      <button
        type="button"
        className={`risk-scenario-matrix-cell-btn ${v >= 0 ? 'pnl-positive' : 'pnl-negative'}${active ? ' risk-scenario-matrix-cell-btn-active' : ''}`}
        onClick={e => {
          e.stopPropagation()
          onClick()
        }}
        aria-pressed={active}
        aria-label="Show how this value is calculated"
      >
        {formatRiskUsd(v)}
      </button>
    </td>
  )
}

function ScenarioMatrixExplainPanel({
  selection,
  profile,
  onDismiss,
}: {
  selection: MatrixExplainSelection
  profile: RiskProfile
  onDismiss: () => void
}) {
  const ctx = profile.calc_context
  if (!ctx) return null

  const rowTitle =
    selection.row === 'gain' ? 'Max gain' : selection.row === 'loss' ? 'Max loss' : 'Hedged worst'
  const S = selection.scenario.underlying_price
  const positionsForOption: RiskPosition[] =
    selection.row === 'hedged'
      ? stripNakedShortCalls(ctx.positions, profile.naked_short_call_contracts)
      : ctx.positions

  if (selection.field === 'option') {
    const legs = positionsForOption.map(p => legContributionAtS(p, S))
    const sumOpt = payoffOptionsAtPrice(positionsForOption, S)
    const lines = legs.map(l => `${l.summary}\n  ${l.detail}`).join('\n\n')
    return (
      <div
        className="risk-scenario-matrix-explain"
        role="region"
        aria-label={`${rowTitle} option P and L`}
        onClick={e => e.stopPropagation()}
      >
        <div className="risk-scenario-matrix-explain-head">
          <strong>
            {rowTitle} — Option ({formatRiskUsd(selection.scenario.options_pnl)})
          </strong>
          <button type="button" className="risk-scenario-matrix-explain-close" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
        <p className="risk-scenario-matrix-explain-principle">
          <strong>Principle:</strong> Expiration snapshot at hypothetical spot <strong>S = {S.toFixed(2)}</strong>.
          Each leg uses <strong>intrinsic only</strong> vs your average cost (per-share premium). Multiply by{' '}
          <code>|contracts| × 100</code> shares per contract.
        </p>
        <ul className="risk-scenario-matrix-explain-rules">
          <li>
            <strong>Long</strong> call/put: P&amp;L = (intrinsic − avg) × |qty| × 100
          </li>
          <li>
            <strong>Short</strong> call/put: P&amp;L = (avg − intrinsic) × |qty| × 100
          </li>
          <li>
            Call intrinsic = max(S − K, 0); Put intrinsic = max(K − S, 0)
          </li>
        </ul>
        {selection.row === 'hedged' && (
          <p className="risk-scenario-matrix-explain-note">
            This row uses the <strong>hedged book</strong> (naked short calls removed from highest strikes first),
            so fewer legs than the full instance.
          </p>
        )}
        <pre className="risk-scenario-matrix-explain-code">{lines || '(no option legs)'}</pre>
        <p className="risk-scenario-matrix-explain-sum">
          Sum of legs = <strong>{formatRiskUsd(sumOpt)}</strong> — matches the Option cell.
        </p>
      </div>
    )
  }

  /* Stk */
  const { covered_shares, underlying_avg_cost: avg } = ctx
  const stk = selection.scenario.stock_pnl
  if (covered_shares <= 0) {
    return (
      <div
        className="risk-scenario-matrix-explain"
        role="region"
        aria-label={`${rowTitle} stock P and L`}
        onClick={e => e.stopPropagation()}
      >
        <div className="risk-scenario-matrix-explain-head">
          <strong>{rowTitle} — Stk ({formatRiskUsd(stk)})</strong>
          <button type="button" className="risk-scenario-matrix-explain-close" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
        <p className="risk-scenario-matrix-explain-principle">
          No covered shares in this model → Stk column is <strong>0</strong> at every spot.
        </p>
      </div>
    )
  }
  if (avg == null) {
    return (
      <div
        className="risk-scenario-matrix-explain"
        role="region"
        aria-label={`${rowTitle} stock P and L`}
        onClick={e => e.stopPropagation()}
      >
        <div className="risk-scenario-matrix-explain-head">
          <strong>{rowTitle} — Stk ({formatRiskUsd(stk)})</strong>
          <button type="button" className="risk-scenario-matrix-explain-close" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
        <p className="risk-scenario-matrix-explain-principle">
          Covered shares ({covered_shares}) are modeled, but <strong>average stock cost is missing</strong> → Stk is
          treated as <strong>0</strong>.
        </p>
      </div>
    )
  }

  return (
    <div
      className="risk-scenario-matrix-explain"
      role="region"
      aria-label={`${rowTitle} stock P and L`}
      onClick={e => e.stopPropagation()}
    >
      <div className="risk-scenario-matrix-explain-head">
        <strong>
          {rowTitle} — Stk ({formatRiskUsd(stk)})
        </strong>
        <button type="button" className="risk-scenario-matrix-explain-close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
      <p className="risk-scenario-matrix-explain-principle">
        <strong>Principle:</strong> Mark-to-spot on the <strong>{covered_shares}</strong> share(s) counted as
        coverage for this opportunity (not a closed stock trade). Same formula at every scenario row; only{' '}
        <strong>S</strong> changes.
      </p>
      <pre className="risk-scenario-matrix-explain-code">
        {`(S − avgCost) × shares\n= (${S.toFixed(2)} − ${avg}) × ${covered_shares}\n= ${stk.toFixed(2)}`}
      </pre>
      <p className="risk-scenario-matrix-explain-sum">
        Matches the <strong>Stk</strong> cell at spot <strong>{S.toFixed(2)}</strong>. After options expire you may
        still hold these shares for another opportunity.
      </p>
    </div>
  )
}

/** Single table: rows = Max gain / Max loss / Hedged; cols = Spot, Option, Stk, Total. */
function ScenarioPnLMatrix({
  profile,
  explainSelection,
  onExplain,
  scenarioMaxGainHelp,
  scenarioMaxLossHelp,
  openRiskHelpKey,
  onSetRiskHelpOpen,
}: {
  profile: RiskProfile
  explainSelection: MatrixExplainSelection | null
  onExplain: (s: MatrixExplainSelection | null) => void
  scenarioMaxGainHelp: ReactNode
  scenarioMaxLossHelp: ReactNode
  openRiskHelpKey: string | null
  onSetRiskHelpOpen: (key: string | null) => void
}) {
  const g = profile.max_gain_sample_scenario
  const l = profile.max_loss_scenario
  const h = profile.hedged_max_loss_scenario
  const lossUnlimited = profile.max_loss == null

  const pick = (row: MatrixExplainSelection['row'], field: 'option' | 'stk', scenario: RiskScenarioBreakdown) => {
    const next: MatrixExplainSelection = { row, field, scenario }
    onExplain(
      explainSelection && matrixExplainKey(explainSelection) === matrixExplainKey(next) ? null : next,
    )
  }

  const isActive = (row: MatrixExplainSelection['row'], field: 'option' | 'stk', scenario: RiskScenarioBreakdown) =>
    explainSelection != null &&
    matrixExplainKey(explainSelection) === matrixExplainKey({ row, field, scenario })

  return (
    <table className="risk-scenario-matrix">
      <thead>
        <tr>
          <th scope="col" className="risk-scenario-matrix-scenario">
            Scenario
          </th>
          <th scope="col" className="risk-scenario-matrix-num">
            Spot
          </th>
          <th scope="col" className="risk-scenario-matrix-num" title="Click value for calculation">
            Option
          </th>
          <th scope="col" className="risk-scenario-matrix-num" title="Click value for calculation">
            Stk
          </th>
          <th scope="col" className="risk-scenario-matrix-num">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        <tr className="risk-scenario-matrix-row-gain">
          <th scope="row" className="risk-scenario-matrix-scenario-cell">
            <span className="risk-scenario-matrix-scenario-label">Max gain</span>
            <RiskFieldHelp
              helpKey="scenario-max-gain"
              openKey={openRiskHelpKey}
              onSetOpen={onSetRiskHelpOpen}
              label="Max gain"
            >
              {scenarioMaxGainHelp}
            </RiskFieldHelp>
          </th>
          {g ? (
            <>
              <td className="risk-scenario-matrix-num">{g.underlying_price.toFixed(2)}</td>
              <ClickablePnlCell
                v={g.options_pnl}
                active={isActive('gain', 'option', g)}
                onClick={() => pick('gain', 'option', g)}
              />
              <ClickablePnlCell
                v={g.stock_pnl}
                active={isActive('gain', 'stk', g)}
                onClick={() => pick('gain', 'stk', g)}
              />
              <td className="risk-scenario-matrix-num risk-value-gain">
                {formatRiskUsd(g.options_pnl + g.stock_pnl)}
              </td>
            </>
          ) : (
            <>
              <td colSpan={4} className="risk-scenario-matrix-na">
                No sample — see ?
              </td>
            </>
          )}
        </tr>
        <tr className="risk-scenario-matrix-row-loss">
          <th scope="row" className="risk-scenario-matrix-scenario-cell">
            <span className="risk-scenario-matrix-scenario-label">Max loss</span>
            <RiskFieldHelp
              helpKey="scenario-max-loss"
              openKey={openRiskHelpKey}
              onSetOpen={onSetRiskHelpOpen}
              label="Max loss"
            >
              {scenarioMaxLossHelp}
            </RiskFieldHelp>
          </th>
          {lossUnlimited && !l ? (
            <>
              <td className="risk-scenario-matrix-num risk-scenario-matrix-na">—</td>
              <td colSpan={2} className="risk-scenario-matrix-na">
                Naked short call tail
              </td>
              <td className="risk-scenario-matrix-num risk-value-loss risk-value-unlimited">
                Unlimited
              </td>
            </>
          ) : l ? (
            <>
              <td className="risk-scenario-matrix-num">{l.underlying_price.toFixed(2)}</td>
              <ClickablePnlCell
                v={l.options_pnl}
                active={isActive('loss', 'option', l)}
                onClick={() => pick('loss', 'option', l)}
              />
              <ClickablePnlCell
                v={l.stock_pnl}
                active={isActive('loss', 'stk', l)}
                onClick={() => pick('loss', 'stk', l)}
              />
              <td className="risk-scenario-matrix-num risk-value-loss">
                {formatRiskUsd(l.options_pnl + l.stock_pnl)}
              </td>
            </>
          ) : (
            <td colSpan={4} className="risk-scenario-matrix-na">
              —
            </td>
          )}
        </tr>
        {lossUnlimited && h ? (
          <tr className="risk-scenario-matrix-row-hedged">
            <th scope="row">Hedged worst</th>
            <td className="risk-scenario-matrix-num">{h.underlying_price.toFixed(2)}</td>
            <ClickablePnlCell
              v={h.options_pnl}
              active={isActive('hedged', 'option', h)}
              onClick={() => pick('hedged', 'option', h)}
            />
            <ClickablePnlCell
              v={h.stock_pnl}
              active={isActive('hedged', 'stk', h)}
              onClick={() => pick('hedged', 'stk', h)}
            />
            <td className="risk-scenario-matrix-num risk-value-loss">
              {formatRiskUsd(h.options_pnl + h.stock_pnl)}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}

function scenarioWorksheet(
  profile: RiskProfile,
  scenario: RiskScenarioBreakdown | null,
  label: string,
): ReactNode {
  const ctx = profile.calc_context
  if (!ctx || !scenario) return null
  const S = scenario.underlying_price
  const legs = ctx.positions.map(p => legContributionAtS(p, S))
  const optSum = legs.reduce((a, x) => a + x.pnl, 0)
  let stockBlock: ReactNode = null
  if (ctx.covered_shares > 0 && ctx.underlying_avg_cost != null) {
    const stk = scenario.stock_pnl
    stockBlock = (
      <>
        <HelpP>
          <strong>Stock ({ctx.covered_shares} sh, coverage)</strong> — not closed at option expiry; shown at
          this hypothetical spot:
        </HelpP>
        <HelpCode>
          {`(S − avgCost) × shares\n= (${S.toFixed(2)} − ${ctx.underlying_avg_cost}) × ${ctx.covered_shares}\n= ${stk.toFixed(2)}`}
        </HelpCode>
      </>
    )
  } else if (ctx.covered_shares > 0) {
    stockBlock = (
      <HelpP className="risk-profile-warn">
        Stock coverage {ctx.covered_shares} sh but avg cost missing → stock P&amp;L treated as 0 in model.
      </HelpP>
    )
  }
  return (
    <>
      <HelpP>
        <strong>{label}</strong> uses spot <strong>S = {S.toFixed(2)}</strong> (one of the sample points below).
        Options at expiry: intrinsic only vs your avg cost. That options leg is a closed settlement at this
        snapshot; stock leg is mark-to-spot on shares still held.
      </HelpP>
      <HelpP>
        <strong>Option legs</strong> (sum should match Options P&amp;L ≈ {formatRiskUsd(scenario.options_pnl)}):
      </HelpP>
      <HelpCode>
        {legs.map(l => `${l.summary}\n  ${l.detail}`).join('\n\n')}
        {`\n\nSum options → ${optSum.toFixed(2)}`}
      </HelpCode>
      {stockBlock}
      <HelpP>
        <strong>Combined</strong> = {formatRiskUsd(scenario.options_pnl)} (options) +{' '}
        {formatRiskUsd(scenario.stock_pnl)} (stock) ={' '}
        <strong>{formatRiskUsd(scenario.options_pnl + scenario.stock_pnl)}</strong>
      </HelpP>
    </>
  )
}

function gridTable(
  rows: ReturnType<typeof getRiskGridRows>,
  highlightPrice: number | null,
  mode: 'max' | 'min',
): ReactNode {
  const totals = rows.map(r => r.total)
  const target = mode === 'max' ? Math.max(...totals) : Math.min(...totals)
  return (
    <table className="risk-field-help-grid">
      <thead>
        <tr>
          <th>S (sample)</th>
          <th>Options</th>
          <th>Stock</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const hi =
            highlightPrice != null
              ? Math.abs(r.price - highlightPrice) < 1e-6
              : Math.abs(r.total - target) < 1e-6
          return (
            <tr key={r.price} className={hi ? 'risk-field-help-grid-hi' : undefined}>
              <td>{r.price.toFixed(2)}</td>
              <td>{formatRiskUsd(r.options_pnl)}</td>
              <td>{formatRiskUsd(r.stock_pnl)}</td>
              <td>{formatRiskUsd(r.total)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function buildBreakevenExplanations(
  profile: RiskProfile,
): Array<{ be: number; text: string }> {
  const ctx = profile.calc_context
  if (!ctx || profile.breakeven_prices.length === 0) return []
  const rows = getRiskGridRows(ctx.positions, ctx.covered_shares, ctx.underlying_avg_cost)
  const out: Array<{ be: number; text: string }> = []
  for (const be of profile.breakeven_prices) {
    let found = ''
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]
      const b = rows[i + 1]
      if (a.price === b.price) continue
      const cross =
        (a.total >= 0 && b.total < 0) || (a.total < 0 && b.total >= 0) || a.total === 0 || b.total === 0
      if (!cross) continue
      const t = a.total / (a.total - b.total)
      const root = a.price + t * (b.price - a.price)
      if (Math.abs(root - be) < 0.15 || Math.abs(a.price - be) < 0.05 || Math.abs(b.price - be) < 0.05) {
        found =
          `Between S=${a.price.toFixed(2)} (P=${a.total.toFixed(2)}) and S=${b.price.toFixed(2)} (P=${b.total.toFixed(2)}): ` +
          `0 = P_a + (P_b−P_a)/(S_b−S_a)×(S−S_a) → S ≈ ${root.toFixed(2)} (matches Breakeven ${be.toFixed(2)}).`
        break
      }
    }
    if (!found) {
      found = `Breakeven ${be.toFixed(2)} from grid crossing (linear segment between adjacent sample spots).`
    }
    out.push({ be, text: found })
  }
  return out
}

export function RiskProfileDl({
  profile,
  fmtUsd,
}: {
  profile: RiskProfile
  fmtUsd: (n: number) => string
}) {
  const ctx = profile.calc_context
  const rows = ctx
    ? getRiskGridRows(ctx.positions, ctx.covered_shares, ctx.underlying_avg_cost)
    : []
  const callBal = ctx ? netCallShareBalance(ctx.positions, ctx.covered_shares) : null
  const rl = formatRiskLabel(profile)

  const [matrixExplain, setMatrixExplain] = useState<MatrixExplainSelection | null>(null)
  const [openRiskHelpKey, setOpenRiskHelpKey] = useState<string | null>(null)

  const showScenarioSummary =
    ctx &&
    (profile.max_gain_sample_scenario ||
      profile.max_loss_scenario ||
      profile.hedged_max_loss_scenario ||
      profile.max_gain == null ||
      profile.max_loss == null)

  const Dt = ({
    helpKey,
    label,
    help,
  }: {
    helpKey: string
    label: string
    help: ReactNode
  }) => (
    <dt className="risk-profile-dt-with-help">
      <span>{label}</span>
      <RiskFieldHelp
        helpKey={helpKey}
        openKey={openRiskHelpKey}
        onSetOpen={setOpenRiskHelpKey}
        label={label}
      >
        {help}
      </RiskFieldHelp>
    </dt>
  )

  const scenarioMaxGainHelp: ReactNode =
    ctx && rows.length > 0 ? (
      <>
        <HelpP>
          Evaluate total P&amp;L (options + stock) at each sample S. Take the <strong>maximum</strong> over:{' '}
          <strong>0</strong>, each strike, and <strong>2× highest strike</strong>.
        </HelpP>
        {gridTable(rows, profile.max_gain_sample_scenario?.underlying_price ?? null, 'max')}
        {profile.max_gain != null && profile.max_gain_scenario ? (
          <>
            <HelpP>
              Best sample total = <strong>{formatRiskUsd(profile.max_gain)}</strong> (same as <strong>Total</strong>{' '}
              in the Max gain row when defined).
            </HelpP>
            {scenarioWorksheet(profile, profile.max_gain_scenario, 'This Max Gain')}
          </>
        ) : profile.max_gain_sample_scenario ? (
          <>
            <HelpP>
              Best <em>among samples</em> at S = {profile.max_gain_sample_scenario.underlying_price.toFixed(2)}:{' '}
              <strong>
                {formatRiskUsd(
                  profile.max_gain_sample_scenario.options_pnl + profile.max_gain_sample_scenario.stock_pnl,
                )}
              </strong>
              . <strong>Unlimited</strong> means combined P&amp;L can exceed that past the last grid point.
            </HelpP>
            {scenarioWorksheet(profile, profile.max_gain_sample_scenario, 'Best sampled row')}
          </>
        ) : (
          <HelpP>No sample rows.</HelpP>
        )}
      </>
    ) : (
      <HelpP>No data.</HelpP>
    )

  const scenarioMaxLossHelp: ReactNode =
    ctx && rows.length > 0 ? (
      <>
        <HelpP>
          Same sample grid as Max gain. Take the <strong>minimum</strong> total. If naked short calls remain,
          loss is unbounded as S increases — the table shows <strong>Unlimited</strong> plus hedged subset.
        </HelpP>
        {gridTable(rows, profile.max_loss_scenario?.underlying_price ?? null, 'min')}
        {profile.max_loss != null && profile.max_loss_scenario ? (
          <>
            <HelpP>
              Worst sample total = <strong>{formatRiskUsd(profile.max_loss)}</strong> ({rl.lossLabel}).
            </HelpP>
            {scenarioWorksheet(profile, profile.max_loss_scenario, 'This Max Loss')}
          </>
        ) : (
          <>
            <HelpP>
              Uncovered short call exposure → loss grows without bound as S→∞. Hedged-book worst (if shown in
              table) uses the same grid after stripping naked contracts.
            </HelpP>
            {ctx && profile.hedged_max_loss_scenario && (
              scenarioWorksheet(
                {
                  ...profile,
                  calc_context: {
                    ...ctx,
                    positions: stripNakedShortCalls(ctx.positions, profile.naked_short_call_contracts),
                  },
                },
                profile.hedged_max_loss_scenario,
                'Hedged worst (stripped book)',
              )
            )}
          </>
        )}
      </>
    ) : (
      <HelpP>No data.</HelpP>
    )

  const riskTypeHelpContent: ReactNode =
    ctx && callBal ? (
      <>
        <HelpP>
          <strong>Defined</strong> here means: net short call share exposure is fully offset by long calls + stock
          coverage — worst loss on the sampled grid is finite.
        </HelpP>
        <HelpCode>
          {`netShortCallShares = ${callBal.net_short_call_shares}\nnetLongCallShares  = ${callBal.net_long_call_shares}\nstock coverage sh  = ${ctx.covered_shares}\nuncovered short sh = max(0, ${callBal.net_short_call_shares} − ${callBal.net_long_call_shares} − ${ctx.covered_shares}) = ${callBal.uncovered_short_call_shares}`}
        </HelpCode>
        <HelpP>
          {profile.risk_type === 'unlimited' ? (
            <>
              uncovered &gt; 0 → short calls beyond hedge → loss unbounded as S→∞ → Risk Type{' '}
              <strong>Unlimited</strong>.
            </>
          ) : (
            <>
              uncovered = 0 → Risk Type <strong>Defined</strong> (for this call-hedge rule).
            </>
          )}
        </HelpP>
      </>
    ) : (
      <HelpP>No option legs — profile is trivial.</HelpP>
    )

  const netPremiumHelpContent: ReactNode = ctx ? (
    <>
      <HelpP>
        Cash-style premium at entry: for each short leg add <code>avg × |qty| × 100</code>, for each long leg
        subtract (premium paid).
      </HelpP>
      <HelpCode>
        {ctx.positions
          .map(p => {
            const n = Math.abs(p.qty) * 100
            if (p.qty < 0) {
              const v = p.avg_cost * n
              return `Short ${p.qty} ${p.right} K=${p.strike}: + ${p.avg_cost} × ${Math.abs(p.qty)} × 100 = +${v.toFixed(2)}`
            }
            const v = p.avg_cost * n
            return `Long ${p.qty} ${p.right} K=${p.strike}: − ${p.avg_cost} × ${Math.abs(p.qty)} × 100 = −${v.toFixed(2)}`
          })
          .join('\n')}
        {`\n\nNet Premium = ${profile.net_premium.toFixed(2)} (${fmtUsd(profile.net_premium)})`}
      </HelpCode>
    </>
  ) : (
    <HelpP>No option legs.</HelpP>
  )

  const breakevenHelpContent: ReactNode =
    profile.breakeven_prices.length > 0 ? (
      <>
        <HelpP>
          Spot where total expiration P&amp;L (options + stock) crosses zero, found by linear interpolation
          between adjacent sample points where payoff changes sign.
        </HelpP>
        {buildBreakevenExplanations(profile).map(({ be, text }, i) => (
          <HelpCode key={i}>
            {`Breakeven ≈ ${fmtUsd(be)}\n${text}`}
          </HelpCode>
        ))}
      </>
    ) : (
      <HelpP>
        No breakeven in the sampled grid (0, strikes, 2× top strike): payoff does not cross zero between
        adjacent sample points.
      </HelpP>
    )

  const hasSecondaryDl =
    profile.naked_short_call_contracts > 0 && profile.hedged_max_loss != null

  return (
    <>
      <div className="risk-profile-top-line" onClick={e => e.stopPropagation()}>
        <div className="risk-profile-top-segment">
          <span className="risk-profile-top-label">Risk Type</span>
          <RiskFieldHelp
            helpKey="risk-type"
            openKey={openRiskHelpKey}
            onSetOpen={setOpenRiskHelpKey}
            label="Risk Type"
          >
            {riskTypeHelpContent}
          </RiskFieldHelp>
          <span
            className={`coverage-status-badge ${profile.risk_type === 'defined' ? 'risk-badge-defined' : 'risk-badge-unlimited'}`}
          >
            {profile.risk_type === 'defined' ? 'Defined' : 'Unlimited'}
          </span>
        </div>
        <span className="risk-profile-top-divider" aria-hidden>
          |
        </span>
        <div className="risk-profile-top-segment">
          <span className="risk-profile-top-label">Net Premium</span>
          <RiskFieldHelp
            helpKey="net-premium"
            openKey={openRiskHelpKey}
            onSetOpen={setOpenRiskHelpKey}
            label="Net Premium"
          >
            {netPremiumHelpContent}
          </RiskFieldHelp>
          <span className="risk-profile-top-value">{fmtUsd(profile.net_premium)}</span>
        </div>
        <span className="risk-profile-top-divider" aria-hidden>
          |
        </span>
        <div className="risk-profile-top-segment">
          <span className="risk-profile-top-label">Breakeven</span>
          <RiskFieldHelp
            helpKey="breakeven"
            openKey={openRiskHelpKey}
            onSetOpen={setOpenRiskHelpKey}
            label="Breakeven"
          >
            {breakevenHelpContent}
          </RiskFieldHelp>
          <span className="risk-profile-top-value">
            {profile.breakeven_prices.length > 0
              ? profile.breakeven_prices.map(p => fmtUsd(p)).join(', ')
              : '—'}
          </span>
        </div>
      </div>

      {showScenarioSummary && (
        <div className="risk-profile-scenario-summary" onClick={e => e.stopPropagation()}>
          <div className="risk-profile-scenario-summary-head">
            <span className="risk-profile-scenario-summary-label">Scenario P&amp;L (expiration, sampled)</span>
            <span className="risk-profile-scenario-summary-hint">
              · Click <strong>Option</strong> or <strong>Stk</strong> for calculation breakdown.
            </span>
          </div>
          {profile.max_gain == null && profile.max_gain_sample_scenario ? (
            <p className="risk-profile-scenario-note">
              Max gain row = <strong>best total among sampled S</strong>; headline may still read{' '}
              <strong>Unlimited</strong> past last sample — use <strong>?</strong> next to Max gain.
            </p>
          ) : null}
          <ScenarioPnLMatrix
            profile={profile}
            explainSelection={matrixExplain}
            onExplain={setMatrixExplain}
            scenarioMaxGainHelp={scenarioMaxGainHelp}
            scenarioMaxLossHelp={scenarioMaxLossHelp}
            openRiskHelpKey={openRiskHelpKey}
            onSetRiskHelpOpen={setOpenRiskHelpKey}
          />
          {matrixExplain ? (
            <ScenarioMatrixExplainPanel
              selection={matrixExplain}
              profile={profile}
              onDismiss={() => setMatrixExplain(null)}
            />
          ) : null}
        </div>
      )}

      {hasSecondaryDl ? (
        <dl className="risk-profile-dl risk-profile-dl-with-help">
          <Dt
            helpKey="hedged-max-loss"
            label="Hedged book max loss"
            help={
              ctx ? (
                <>
                  <HelpP>
                    Remove the <strong>{profile.naked_short_call_contracts}</strong> naked short call contract
                    (highest strikes first). Re-run worst sample on the remaining book.
                  </HelpP>
                  <HelpCode>
                    {(() => {
                      const hedged = stripNakedShortCalls(
                        ctx.positions,
                        profile.naked_short_call_contracts,
                      )
                      const orig = ctx.positions
                        .filter(p => p.right === 'C' && p.qty < 0)
                        .map(p => `${p.qty} C ${p.strike}`)
                        .join('; ')
                      const after = hedged
                        .filter(p => p.right === 'C' && p.qty < 0)
                        .map(p => `${p.qty} C ${p.strike}`)
                        .join('; ') || '(no short calls)'
                      return `Short calls before: ${orig || '—'}\nAfter strip: ${after}`
                    })()}
                  </HelpCode>
                  {profile.hedged_max_loss_scenario && (
                    scenarioWorksheet(
                      {
                        ...profile,
                        calc_context: {
                          ...ctx,
                          positions: stripNakedShortCalls(
                            ctx.positions,
                            profile.naked_short_call_contracts,
                          ),
                        },
                      },
                      profile.hedged_max_loss_scenario,
                      'Hedged worst case',
                    )
                  )}
                  <HelpP>
                    Worst combined on hedged grid ≈{' '}
                    <strong>{formatRiskUsd(profile.hedged_max_loss ?? 0)}</strong>. Remaining naked shorts still
                    add unlimited loss if S rises.
                  </HelpP>
                </>
              ) : (
                <HelpP>No context.</HelpP>
              )
            }
          />
          <dd>
            <span className="risk-value-loss">{formatApproxUsd(profile.hedged_max_loss ?? 0)}</span>
          </dd>
          <Dt
            helpKey="naked-short-calls"
            label="Naked short calls"
            help={
              callBal ? (
                <>
                  <HelpP>
                    Contracts with unhedged short call risk (ceil of uncovered share exposure ÷ 100):
                  </HelpP>
                  <HelpCode>
                    {`ceil(${callBal.uncovered_short_call_shares} / 100) = ${profile.naked_short_call_contracts}`}
                  </HelpCode>
                </>
              ) : (
                <HelpP>See Risk Type for share netting.</HelpP>
              )
            }
          />
          <dd>
            {profile.naked_short_call_contracts} contract
            {profile.naked_short_call_contracts !== 1 ? 's' : ''}
          </dd>
    </dl>
      ) : null}
    </>
  )
}
