import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatusResponse, IbAccountSnapshot } from '../types'
import { getPortfolioApiBaseForBrowser, joinServiceBase } from '../api/shared/apiRouting'
import { fmtUsd } from '../utils/format'
import {
  CAR_SECTION_INTRO,
  STRESS_METHODOLOGY_SECTIONS,
  carExplainCodeBody,
  carExplainCodeTitle,
  carLegTypeDescription,
} from './modelAnalysisExplain'

interface Props {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

interface ScenarioBreakdown {
  underlying_price: number
  options_pnl: number
  stock_pnl: number
}

interface StressScenario {
  spot_shock: number
  iv_shock: number
  new_spot?: number
  options_pnl?: number
  stock_pnl?: number
  total_pnl: number
  method?: string
}

interface GreeksLeg {
  strike: number
  right: string
  qty: number
  iv: number | null
  delta: number | null
}

interface GreeksInfo {
  delta: number | null
  delta_dollars: number | null
  degraded: boolean
  degraded_leg_count?: number
  per_leg?: GreeksLeg[]
}

interface CarLegDetail {
  strike: number
  right: string
  qty: number
  car: number | null
  type: string
}

interface CarInfo {
  effective: number | null
  explain: string
  has_unbounded: boolean
  leg_details?: CarLegDetail[]
}

interface UnderlyingEntry {
  symbol: string
  spot: number | null
  dte_days: number | null
  farthest_expiry: string | null
  stock_qty: number
  stock_avg_cost: number | null
  max_gain: number | null
  max_loss: number | null
  risk_type: string
  breakeven_prices: number[]
  net_premium: number
  naked_short_call_contracts: number
  hedged_max_loss: number | null
  max_gain_scenario: ScenarioBreakdown | null
  max_gain_sample_scenario: ScenarioBreakdown | null
  max_loss_scenario: ScenarioBreakdown | null
  capital_at_risk: CarInfo
  annualized_return_on_car: number | null
  annualized_loss_on_car: number | null
  greeks: GreeksInfo
  stress: { available: boolean; iv_stress_available?: boolean; scenarios?: StressScenario[] }
}

interface ModelAnalysisResponse {
  account_id: string
  account_summary: { net_liquidation: number | null; total_cash: number | null; buying_power: number | null }
  per_underlying: UnderlyingEntry[]
  account_rollups: {
    total_car: number | null
    car_has_unbounded: boolean
    weighted_annualized_return: number | null
    total_delta: number | null
    total_delta_dollars: number | null
  }
  account_stress: { available: boolean; iv_stress_available?: boolean; scenarios?: StressScenario[] }
  disclaimer: string
  method: string
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${(v * 100).toFixed(2)}%`
}

function fmtDelta(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toFixed(2)
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function riskBadge(t: string): string {
  return t === 'unlimited' ? 'Unlimited' : 'Defined'
}

export function ModelAnalysisPage({ status }: Props) {
  const accounts: IbAccountSnapshot[] = useMemo(() => status?.portfolio?.accounts ?? [], [status])

  const { hostId, secondaryId, hostSelectable, secondarySelectable } = useMemo(() => {
    const ib = status?.config?.ib_client
    const acct = ib?.account
    const host = (acct?.event_host ?? acct?.trading ?? '').trim()
    const sec = (acct?.event_secondary ?? '').trim()
    const ids = new Set(accounts.map((a) => (a.account_id ?? '').trim()).filter(Boolean))
    return {
      hostId: host,
      secondaryId: sec,
      hostSelectable: Boolean(host && ids.has(host)),
      secondarySelectable: Boolean(sec && ids.has(sec)),
    }
  }, [status?.config?.ib_client, accounts])

  const [selectedAccount, setSelectedAccount] = useState<string>('')
  const [data, setData] = useState<ModelAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null)

  useEffect(() => {
    if (selectedAccount) return
    if (hostSelectable) setSelectedAccount(hostId)
    else if (secondarySelectable) setSelectedAccount(secondaryId)
  }, [selectedAccount, hostSelectable, secondarySelectable, hostId, secondaryId])

  const fetchAnalysis = useCallback(async (accountId: string) => {
    if (!accountId) return
    setLoading(true)
    setError(null)
    try {
      const url = joinServiceBase(
        getPortfolioApiBaseForBrowser(),
        `/portfolio/model-analysis?account_id=${encodeURIComponent(accountId)}`,
      )
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d: ModelAnalysisResponse = await r.json()
      setData(d)
    } catch (e: any) {
      const m = e?.message ?? 'Failed to fetch'
      setError(
        m === 'Failed to fetch'
          ? 'Failed to fetch (check Portfolio API is running, e.g. python scripts/run_server_portfolio.py, and same host/LAN as this UI)'
          : m,
      )
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedAccount) fetchAnalysis(selectedAccount)
  }, [selectedAccount, fetchAnalysis])

  const hasEntries = (data?.per_underlying?.length ?? 0) > 0

  return (
    <div className="bifrost-model-analysis">
      <div className="model-analysis-header">
        <h2 className="model-analysis-title">Model Analysis</h2>
        <span className="model-analysis-hypothetical-badge" title="Hypothetical — not actual performance">
          ⚠ Hypothetical
        </span>
        <div className="model-analysis-header-tools">
          <div
            className="model-analysis-account-pills"
            role="group"
            aria-label="IB account for model analysis"
          >
            <button
              type="button"
              className={`replay-filter-pill ${selectedAccount === hostId ? 'active' : ''}`}
              disabled={!hostSelectable}
              onClick={() => hostSelectable && setSelectedAccount(hostId)}
              title={
                hostId
                  ? `Host: ${hostId}${hostSelectable ? '' : ' (not in current account list)'}`
                  : 'Host account ID not configured (Settings → IB / Event account)'
              }
              aria-pressed={selectedAccount === hostId}
            >
              Host
            </button>
            <button
              type="button"
              className={`replay-filter-pill ${selectedAccount === secondaryId ? 'active' : ''}`}
              disabled={!secondarySelectable}
              onClick={() => secondarySelectable && setSelectedAccount(secondaryId)}
              title={
                secondaryId
                  ? `Secondary: ${secondaryId}${secondarySelectable ? '' : ' (not in current account list)'}`
                  : 'Secondary account ID not configured (Settings → IB / Event account)'
              }
              aria-pressed={selectedAccount === secondaryId}
            >
              Secondary
            </button>
          </div>
          <button
            type="button"
            className="btn btn-small model-analysis-refresh"
            onClick={() => selectedAccount && fetchAnalysis(selectedAccount)}
            disabled={loading || !selectedAccount}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="model-analysis-disclaimer">
        {data?.disclaimer ?? 'This analysis is hypothetical and based on model assumptions. It does not represent actual performance and is not investment advice. Options involve risk and may result in substantial losses.'}
      </div>

      {!hostSelectable && !secondarySelectable && accounts.length > 0 && (
        <div className="model-analysis-config-hint">
          Host / Secondary account IDs from settings do not match any account in the current snapshot. Check{' '}
          <strong>event_host</strong>, <strong>trading</strong>, or <strong>event_secondary</strong> in{' '}
          GET /status <code>config.ib_client.account</code> (Settings IB / Event account).
        </div>
      )}

      {error && <div className="model-analysis-error">{error}</div>}

      {/* Account Summary */}
      {data && (
        <div className="model-analysis-summary">
          <div><span className="model-analysis-summary-label">Net Liquidation</span><br /><strong>{fmtUsd(data.account_summary.net_liquidation)}</strong></div>
          <div><span className="model-analysis-summary-label">Cash</span><br /><strong>{fmtUsd(data.account_summary.total_cash)}</strong></div>
          <div><span className="model-analysis-summary-label">Buying Power</span><br /><strong>{fmtUsd(data.account_summary.buying_power)}</strong></div>
          <div><span className="model-analysis-summary-label">Total CAR</span><br /><strong>{data.account_rollups.car_has_unbounded ? 'Unbounded' : fmtUsd(data.account_rollups.total_car)}</strong></div>
          <div><span className="model-analysis-summary-label">Wtd Annual Return</span><br /><strong>{fmtPct(data.account_rollups.weighted_annualized_return)}</strong></div>
          <div><span className="model-analysis-summary-label">Portfolio Delta</span><br /><strong>{fmtDelta(data.account_rollups.total_delta)}</strong></div>
          <div><span className="model-analysis-summary-label">Delta $</span><br /><strong>{fmtUsd(data.account_rollups.total_delta_dollars)}</strong></div>
        </div>
      )}

      {/* Account-level stress */}
      {data?.account_stress?.available && (data.account_stress.scenarios?.length ?? 0) > 0 && (
        <details className="model-analysis-stress-details">
          <summary className="model-analysis-stress-summary">Account Stress Matrix</summary>
          <p className="model-analysis-account-stress-note">
            Values are the <strong>sum</strong> of per-symbol stress totals for the same (spot shock, IV shock) key.
            Open any <strong>symbol</strong> row below for full CAR and stress methodology (formulas, Black–Scholes assumptions).
          </p>
          <table className="table-operations model-analysis-table table-sm">
            <thead>
              <tr><th>Spot shock</th><th>IV shock</th><th>P&amp;L</th></tr>
            </thead>
            <tbody>
              {data.account_stress.scenarios!.map((sc, i) => (
                <tr key={i}>
                  <td>{(sc.spot_shock * 100).toFixed(0)}%</td>
                  <td>{sc.iv_shock === 0 ? '0 (base σ)' : `${sc.iv_shock > 0 ? '+' : ''}${(sc.iv_shock * 100).toFixed(0)} abs vol`}</td>
                  <td className={sc.total_pnl >= 0 ? 'model-analysis-pnl-pos' : 'model-analysis-pnl-neg'}>{fmtUsd(sc.total_pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {/* Per underlying table */}
      {hasEntries && (
        <div className="table-wrap model-analysis-table-wrap">
        <table className="table-operations model-analysis-main-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Spot</th>
              <th>DTE</th>
              <th>Max Gain</th>
              <th>Max Loss</th>
              <th>Risk</th>
              <th>CAR</th>
              <th>Annual %</th>
              <th>Delta</th>
              <th>Delta $</th>
            </tr>
          </thead>
          <tbody>
            {data!.per_underlying.map((u) => {
              const expanded = expandedSymbol === u.symbol
              return [
                <tr key={u.symbol} onClick={() => setExpandedSymbol(expanded ? null : u.symbol)} style={{ cursor: 'pointer' }}>
                  <td><strong>{u.symbol}</strong></td>
                  <td>{fmtNum(u.spot)}</td>
                  <td>{u.dte_days ?? '—'}</td>
                  <td className="model-analysis-pnl-pos">{u.max_gain == null ? 'Unbounded' : fmtUsd(u.max_gain)}</td>
                  <td className="model-analysis-pnl-neg">{u.max_loss == null ? 'Unbounded' : fmtUsd(u.max_loss)}</td>
                  <td>
                    <span
                      className={
                        u.risk_type === 'defined'
                          ? 'model-analysis-risk-badge model-analysis-risk-badge--defined'
                          : 'model-analysis-risk-badge model-analysis-risk-badge--unlimited'
                      }
                    >
                      {riskBadge(u.risk_type)}
                    </span>
                  </td>
                  <td>{u.capital_at_risk.has_unbounded ? 'N/A' : fmtUsd(u.capital_at_risk.effective)}</td>
                  <td>{fmtPct(u.annualized_return_on_car)}</td>
                  <td>{fmtDelta(u.greeks.delta)}{u.greeks.degraded ? ' *' : ''}</td>
                  <td>{fmtUsd(u.greeks.delta_dollars)}</td>
                </tr>,
                expanded && (
                  <tr key={`${u.symbol}-detail`} className="model-analysis-detail-row">
                    <td colSpan={10} className="model-analysis-detail-cell">
                      <UnderlyingDetail entry={u} />
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
        </div>
      )}

      {data && !hasEntries && !loading && selectedAccount && (
        <div className="model-analysis-empty">No positions found for {selectedAccount}</div>
      )}

      {accounts.length === 0 && !loading && (
        <div className="model-analysis-empty">No accounts in status. Ensure GET /status returns accounts (e.g. open Live or refresh).</div>
      )}
    </div>
  )
}


function StressMethodologyIntro({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p className="model-analysis-methodology-lead">
        Stress P&amp;L is a <strong>what-if</strong> grid, not a forecast. Theory:
      </p>
      <ul className="model-analysis-methodology-list">
        {STRESS_METHODOLOGY_SECTIONS.map((s) => (
          <li key={s.title}>
            <strong>{s.title}.</strong> {s.body}
          </li>
        ))}
      </ul>
    </div>
  )
}

function UnderlyingDetail({ entry: u }: { entry: UnderlyingEntry }) {
  const car = u.capital_at_risk
  const explainTitle = carExplainCodeTitle(car.explain)
  const explainBody = carExplainCodeBody(car.explain)

  return (
    <div className="model-analysis-detail-inner">
      <div className="model-analysis-detail-meta">
        <div>
          <span className="model-analysis-muted">Net premium:</span> {fmtUsd(u.net_premium)}
        </div>
        <div>
          <span className="model-analysis-muted">Breakeven:</span>{' '}
          {u.breakeven_prices.length > 0 ? u.breakeven_prices.map((b) => `$${b.toFixed(2)}`).join(', ') : '—'}
        </div>
        {u.naked_short_call_contracts > 0 && (
          <div>
            <span className="model-analysis-muted">Naked short calls:</span> {u.naked_short_call_contracts} contract{u.naked_short_call_contracts > 1 ? 's' : ''}
            {u.hedged_max_loss != null && <> (hedged max loss: {fmtUsd(u.hedged_max_loss)})</>}
          </div>
        )}
        <div>
          <span className="model-analysis-muted">Stock:</span> {u.stock_qty} shares
          {u.stock_avg_cost != null && <> @ ${u.stock_avg_cost.toFixed(2)}</>}
        </div>
        {u.annualized_loss_on_car != null && (
          <div>
            <span className="model-analysis-muted">Annualized loss/CAR:</span> {fmtPct(u.annualized_loss_on_car)}
          </div>
        )}
      </div>

      <section className="model-analysis-car-section" aria-labelledby={`car-heading-${u.symbol}`}>
        <h4 id={`car-heading-${u.symbol}`} className="model-analysis-subheading">
          Capital at risk (CAR)
        </h4>
        <p className="model-analysis-prose">{CAR_SECTION_INTRO}</p>
        <div className="model-analysis-car-effective">
          <span className="model-analysis-muted">Effective CAR:</span>{' '}
          <strong>{car.has_unbounded ? 'N/A (unbounded leg)' : fmtUsd(car.effective)}</strong>
        </div>
        <div className="model-analysis-car-explain-block">
          <div className="model-analysis-car-explain-title">{explainTitle}</div>
          <p className="model-analysis-prose model-analysis-car-explain-body">{explainBody}</p>
          <div className="model-analysis-muted model-analysis-code-ref">API code: {car.explain}</div>
        </div>
        {car.leg_details && car.leg_details.length > 0 && (
          <div className="model-analysis-car-legs-wrap">
            <div className="model-analysis-muted model-analysis-car-legs-caption">Per-leg heuristic (not additive when Explain = net portfolio max loss)</div>
            <table className="table-operations model-analysis-nested-table model-analysis-car-legs-table">
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>R</th>
                  <th>Qty</th>
                  <th>CAR</th>
                  <th>Rule</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {car.leg_details.map((leg, i) => (
                  <tr key={i}>
                    <td>{leg.strike}</td>
                    <td>{leg.right}</td>
                    <td>{leg.qty}</td>
                    <td>{leg.car == null ? '∞' : fmtUsd(leg.car)}</td>
                    <td><code className="model-analysis-leg-type">{leg.type}</code></td>
                    <td className="model-analysis-car-desc-cell">{carLegTypeDescription(leg.type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Scenarios */}
      {u.max_gain_sample_scenario && (
        <div className="model-analysis-scenario-line">
          <strong>Best sample scenario</strong> (S={fmtNum(u.max_gain_sample_scenario.underlying_price)}):
          Options {fmtUsd(u.max_gain_sample_scenario.options_pnl)}, Stock {fmtUsd(u.max_gain_sample_scenario.stock_pnl)}
        </div>
      )}
      {u.max_loss_scenario && (
        <div className="model-analysis-scenario-line">
          <strong>Worst scenario</strong> (S={fmtNum(u.max_loss_scenario.underlying_price)}):
          Options {fmtUsd(u.max_loss_scenario.options_pnl)}, Stock {fmtUsd(u.max_loss_scenario.stock_pnl)}
        </div>
      )}

      {/* Greeks per leg */}
      {u.greeks.per_leg && u.greeks.per_leg.length > 0 && (
        <div className="model-analysis-detail-section">
          <strong className="model-analysis-detail-section-title">Option legs</strong>
          <table className="table-operations model-analysis-nested-table">
            <thead><tr><th>Strike</th><th>R</th><th>Qty</th><th>IV</th><th>Delta</th></tr></thead>
            <tbody>
              {u.greeks.per_leg!.map((leg, i) => (
                <tr key={i}>
                  <td>{leg.strike}</td>
                  <td>{leg.right}</td>
                  <td>{leg.qty}</td>
                  <td>{leg.iv != null ? `${(leg.iv * 100).toFixed(1)}%` : '—'}</td>
                  <td>{leg.delta != null ? leg.delta.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stress */}
      {u.stress.available && (u.stress.scenarios?.length ?? 0) > 0 && (
        <div className="model-analysis-detail-section">
          <strong className="model-analysis-detail-section-title">Stress test</strong>
          {!u.stress.iv_stress_available && (
            <span className="model-analysis-muted model-analysis-iv-note"> (IV stress unavailable for this symbol — intrinsic-only rows)</span>
          )}
          <StressMethodologyIntro className="model-analysis-methodology-block model-analysis-methodology-block--nested" />
          <table className="table-operations model-analysis-nested-table model-analysis-stress-table">
            <thead>
              <tr>
                <th>Spot Δ</th>
                <th>IV Δ</th>
                <th>Opt P&amp;L</th>
                <th>Stock P&amp;L</th>
                <th>Total</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {u.stress.scenarios!.map((sc, i) => (
                <tr key={i}>
                  <td>{(sc.spot_shock * 100).toFixed(0)}%</td>
                  <td>
                    {sc.iv_shock === 0
                      ? '0 (base σ)'
                      : `${sc.iv_shock > 0 ? '+' : ''}${(sc.iv_shock * 100).toFixed(0)} abs vol`}
                  </td>
                  <td>{fmtUsd(sc.options_pnl)}</td>
                  <td>{fmtUsd(sc.stock_pnl)}</td>
                  <td className={`model-analysis-stress-total ${sc.total_pnl >= 0 ? 'model-analysis-pnl-pos' : 'model-analysis-pnl-neg'}`}>
                    {fmtUsd(sc.total_pnl)}
                  </td>
                  <td><code className="model-analysis-method-code">{sc.method ?? '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
