import { useCallback, useEffect, useState } from 'react'
import type { WinRateStructureRow } from '../api/strategy/strategyInstances'
import { fetchStrategyWinRate } from '../api'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fmtUsd } from '../utils/format'

interface StrategyWinRatePageProps {
  onGoToInstances?: () => void
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v.toFixed(2)}%`
}

function fmtUsdOrDash(v: number | null | undefined): string {
  if (v == null) return '—'
  return fmtUsd(v)
}

function winPctLabel(total: number, wins: number): string {
  return total > 0 ? `${((wins / total) * 100).toFixed(1)}%` : '—'
}

/** Win % color: strictly >50% green, strictly <50% red; 50% or no trades neutral (dim). */
function winPctValueClassName(total: number, wins: number): string {
  const base = 'strategy-win-rate-kpi__value strategy-win-rate-kpi__value--winpct'
  if (total <= 0) return `${base} strategy-win-rate-kpi__value--winpct-dim`
  const pct = (wins / total) * 100
  if (pct > 50) return `${base} pnl-positive`
  if (pct < 50) return `${base} pnl-negative`
  return `${base} strategy-win-rate-kpi__value--winpct-dim`
}

function WinRateStructureCard({ row }: { row: WinRateStructureRow }) {
  const winPct = winPctLabel(row.total_instances, row.profit_trades)

  return (
    <article className="strategy-win-rate-card">
      <h3 className="strategy-win-rate-card__title">{row.structure_name}</h3>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">Trades</div>
        <div className="strategy-win-rate-kpis">
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Profit</span>
            <span className="strategy-win-rate-kpi__value pnl-positive">{row.profit_trades}</span>
          </div>
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Loss</span>
            <span className="strategy-win-rate-kpi__value pnl-negative">{row.loss_trades}</span>
          </div>
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Total</span>
            <span className="strategy-win-rate-kpi__value strategy-win-rate-kpi__value--neutral">{row.total_instances}</span>
          </div>
          <div className="strategy-win-rate-kpi strategy-win-rate-kpi--highlight">
            <span className="strategy-win-rate-kpi__label">Win %</span>
            <span className={winPctValueClassName(row.total_instances, row.profit_trades)}>{winPct}</span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">P&amp;L</div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--2 strategy-win-rate-metrics--pnl">
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Total profit</span>
            <span
              className={`strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl ${(row.total_profit ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}
            >
              {fmtUsdOrDash(row.total_profit)}
            </span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Max loss $</span>
            <span className="strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl pnl-negative">
              {fmtUsdOrDash(row.single_max_loss)}
            </span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">Investment (OPT cost)</div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--3">
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Profit inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(row.profit_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Loss inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(row.loss_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Total inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(row.total_investment)}</span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">Averages</div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--wrap">
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Profit avg %</span>
            <span className="strategy-win-rate-metric__value pnl-positive">{fmtPct(row.profit_avg_pct)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Loss avg %</span>
            <span className="strategy-win-rate-metric__value pnl-negative">{fmtPct(row.loss_avg_pct)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Max loss %</span>
            <span className="strategy-win-rate-metric__value pnl-negative">{fmtPct(row.single_max_loss_pct)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Profit avg $</span>
            <span className="strategy-win-rate-metric__value pnl-positive">{fmtUsdOrDash(row.profit_avg_usd)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Loss avg $</span>
            <span className="strategy-win-rate-metric__value pnl-negative">{fmtUsdOrDash(row.loss_avg_usd)}</span>
          </div>
        </div>
      </div>
    </article>
  )
}

type WinRateTotals = {
  profit_trades: number
  loss_trades: number
  total_instances: number
  total_profit: number
  total_investment: number
  profit_investment: number
  loss_investment: number
}

function WinRateTotalsCard({ totals }: { totals: WinRateTotals }) {
  const winPct = winPctLabel(totals.total_instances, totals.profit_trades)

  return (
    <article className="strategy-win-rate-card strategy-win-rate-card--total">
      <h3 className="strategy-win-rate-card__title">All structures</h3>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">Trades</div>
        <div className="strategy-win-rate-kpis">
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Profit</span>
            <span className="strategy-win-rate-kpi__value pnl-positive">{totals.profit_trades}</span>
          </div>
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Loss</span>
            <span className="strategy-win-rate-kpi__value pnl-negative">{totals.loss_trades}</span>
          </div>
          <div className="strategy-win-rate-kpi">
            <span className="strategy-win-rate-kpi__label">Total</span>
            <span className="strategy-win-rate-kpi__value strategy-win-rate-kpi__value--neutral">{totals.total_instances}</span>
          </div>
          <div className="strategy-win-rate-kpi strategy-win-rate-kpi--highlight">
            <span className="strategy-win-rate-kpi__label">Win %</span>
            <span className={winPctValueClassName(totals.total_instances, totals.profit_trades)}>{winPct}</span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">P&amp;L</div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--2 strategy-win-rate-metrics--pnl">
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Total profit</span>
            <span
              className={`strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl ${(totals.total_profit ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}
            >
              {fmtUsdOrDash(totals.total_profit)}
            </span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Max loss $</span>
            <span className="strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl strategy-win-rate-metric__value--muted">—</span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div className="strategy-win-rate-card__section-label">Investment (OPT cost)</div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--3">
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Profit inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(totals.profit_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Loss inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(totals.loss_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric">
            <span className="strategy-win-rate-metric__label">Total inv.</span>
            <span className="strategy-win-rate-metric__value">{fmtUsdOrDash(totals.total_investment)}</span>
          </div>
        </div>
      </div>
    </article>
  )
}

export function StrategyWinRatePage({ onGoToInstances }: StrategyWinRatePageProps = {}) {
  const [structures, setStructures] = useState<WinRateStructureRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchStrategyWinRate()
      setStructures(res.structures ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load win-rate data')
      setStructures([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const totals: WinRateTotals | null =
    structures.length > 0
      ? structures.reduce(
          (acc, r) => ({
            profit_trades: acc.profit_trades + r.profit_trades,
            loss_trades: acc.loss_trades + r.loss_trades,
            total_instances: acc.total_instances + r.total_instances,
            total_profit: (acc.total_profit ?? 0) + (r.total_profit ?? 0),
            total_investment: (acc.total_investment ?? 0) + (r.total_investment ?? 0),
            profit_investment: (acc.profit_investment ?? 0) + (r.profit_investment ?? 0),
            loss_investment: (acc.loss_investment ?? 0) + (r.loss_investment ?? 0),
          }),
          { profit_trades: 0, loss_trades: 0, total_instances: 0, total_profit: 0, total_investment: 0, profit_investment: 0, loss_investment: 0 },
        )
      : null

  return (
    <div className="card process-section strategy-win-rate-page">
      <div className="strategy-win-rate-page__head">
        <div className="strategy-win-rate-page__head-main">
          <SectionPageTitle
            menu="Strategy"
            pageTitle="Win Rate"
            onMenuClick={onGoToInstances}
            menuNavigateAriaLabel="Strategy home"
            infoText="Per-structure win-rate from instances with executions. Profit Inv. = sum of each winning instance’s attributed SELL OPT premium (underlying cost); Loss Inv. = same for losing instances (net PnL ≤ 0); Total Inv. = Profit Inv. + Loss Inv. Attribution matches instance PnL (allocation splits by quantity when present)."
          />
          <p className="section-hint strategy-win-rate-page__hint">
            Aggregated results per Strategy Structure. Each closed instance counts as one Profit Trade or Loss Trade based on its net PnL.
          </p>
        </div>
        <div className="strategy-win-rate-page__head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {loading ? <span className="section-hint strategy-win-rate-page__loading">Loading…</span> : null}
        </div>
      </div>

      {error && (
        <p className="msg-error" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          {error}
        </p>
      )}

      {!loading && !error && structures.length === 0 && (
        <p className="section-hint">No closed strategy instances found. Run some strategies and close them to see win-rate statistics.</p>
      )}

      {structures.length > 0 && (
        <div className="strategy-win-rate-list">
          <div className="strategy-win-rate-grid">
            {structures.map(row => (
              <WinRateStructureCard key={row.structure_name} row={row} />
            ))}
          </div>
          {totals && structures.length > 1 ? (
            <div className="strategy-win-rate-totals">
              <WinRateTotalsCard totals={totals} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
