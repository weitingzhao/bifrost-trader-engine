import { useCallback, useEffect, useState } from 'react'
import type { WinRateStructureRow, WinRateResponse } from '../api/strategy/strategyInstances'
import { fetchStrategyWinRate } from '../api'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fmtUsd, fmtUsdRound0 } from '../utils/format'

export type StrategyWinRateGoToInstancesOptions = {
  /** When set, opens Strategy → Instances with this Structure bubble filter (matches instance `strategy_structure_name`). */
  structureFilter?: string
}

interface StrategyWinRatePageProps {
  /** Opens Instances; pass `structureFilter` to pre-apply the Structure panel filter. */
  onGoToInstances?: (options?: StrategyWinRateGoToInstancesOptions) => void
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

function WinRateStructureCard({
  row,
  onOpenInstancesForStructure,
}: {
  row: WinRateStructureRow
  onOpenInstancesForStructure?: (structureName: string) => void
}) {
  const winPct = winPctLabel(row.total_instances, row.profit_trades)
  const canDrill = onOpenInstancesForStructure != null && (row.structure_name ?? '').trim() !== ''

  return (
    <button
      type="button"
      className={`strategy-win-rate-card${canDrill ? ' strategy-win-rate-card--clickable' : ''}`}
      disabled={!canDrill}
      onClick={() => {
        if (canDrill) onOpenInstancesForStructure(row.structure_name.trim())
      }}
      title={canDrill ? `Open Instances filtered by structure: ${row.structure_name}` : undefined}
      aria-label={canDrill ? `Open Instances for structure ${row.structure_name}` : undefined}
    >
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
            <span
              className="strategy-win-rate-metric__label"
              title="Sum of each instance's worst losing trade (realized), same as Instance PnL Total Loss."
            >
              Total loss
            </span>
            <span className="strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl pnl-negative">
              {fmtUsdOrDash(row.total_loss)}
            </span>
          </div>
        </div>
      </div>

      <div className="strategy-win-rate-card__section">
        <div
          className="strategy-win-rate-card__section-label"
          title="Same as Instance detail: sum of sell OPT strike × |qty| × 100 per instance. Buckets follow net PnL > 0 vs ≤ 0 (same idea as Trades Profit/Loss counts). Amounts shown rounded to whole dollars."
        >
          Underlying cost
        </div>
        <div className="strategy-win-rate-metrics strategy-win-rate-metrics--underlying-cost">
          <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
            <span className="strategy-win-rate-metric__label" title="Instances with net PnL > 0">
              On wins
            </span>
            <span className="strategy-win-rate-metric__value">{fmtUsdRound0(row.profit_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
            <span className="strategy-win-rate-metric__label" title="Instances with net PnL ≤ 0">
              On losses
            </span>
            <span className="strategy-win-rate-metric__value">{fmtUsdRound0(row.loss_investment)}</span>
          </div>
          <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
            <span className="strategy-win-rate-metric__label" title="On wins + on losses (all instances in this structure)">
              Total
            </span>
            <span className="strategy-win-rate-metric__value">{fmtUsdRound0(row.total_investment)}</span>
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
    </button>
  )
}

function fallbackTotalsAllFromStructures(structures: WinRateStructureRow[]): WinRateStructureRow {
  const acc = structures.reduce(
    (a, r) => {
      const tl = r.total_loss
      const tlNum = tl != null && Number.isFinite(tl) ? tl : null
      return {
        profit_trades: a.profit_trades + r.profit_trades,
        loss_trades: a.loss_trades + r.loss_trades,
        total_instances: a.total_instances + r.total_instances,
        total_profit: (a.total_profit ?? 0) + (r.total_profit ?? 0),
        profit_investment: (a.profit_investment ?? 0) + (r.profit_investment ?? 0),
        loss_investment: (a.loss_investment ?? 0) + (r.loss_investment ?? 0),
        total_loss_sum: tlNum != null ? a.total_loss_sum + tlNum : a.total_loss_sum,
        total_loss_any: tlNum != null ? true : a.total_loss_any,
        w_profit_pct: r.profit_avg_pct != null && r.profit_trades > 0 ? a.w_profit_pct + r.profit_avg_pct * r.profit_trades : a.w_profit_pct,
        n_profit_pct: r.profit_avg_pct != null && r.profit_trades > 0 ? a.n_profit_pct + r.profit_trades : a.n_profit_pct,
        w_loss_pct: r.loss_avg_pct != null && r.loss_trades > 0 ? a.w_loss_pct + r.loss_avg_pct * r.loss_trades : a.w_loss_pct,
        n_loss_pct: r.loss_avg_pct != null && r.loss_trades > 0 ? a.n_loss_pct + r.loss_trades : a.n_loss_pct,
        w_profit_usd:
          r.profit_avg_usd != null && Number.isFinite(r.profit_avg_usd) && r.profit_trades > 0
            ? a.w_profit_usd + r.profit_avg_usd * r.profit_trades
            : a.w_profit_usd,
        n_profit_usd: r.profit_avg_usd != null && Number.isFinite(r.profit_avg_usd) && r.profit_trades > 0 ? a.n_profit_usd + r.profit_trades : a.n_profit_usd,
        w_loss_usd:
          r.loss_avg_usd != null && Number.isFinite(r.loss_avg_usd) && r.loss_trades > 0
            ? a.w_loss_usd + r.loss_avg_usd * r.loss_trades
            : a.w_loss_usd,
        n_loss_usd: r.loss_avg_usd != null && Number.isFinite(r.loss_avg_usd) && r.loss_trades > 0 ? a.n_loss_usd + r.loss_trades : a.n_loss_usd,
        min_loss_pct:
          r.single_max_loss_pct != null && Number.isFinite(r.single_max_loss_pct)
            ? (a.min_loss_pct == null ? r.single_max_loss_pct : Math.min(a.min_loss_pct, r.single_max_loss_pct))
            : a.min_loss_pct,
      }
    },
    {
      profit_trades: 0,
      loss_trades: 0,
      total_instances: 0,
      total_profit: 0,
      profit_investment: 0,
      loss_investment: 0,
      total_loss_sum: 0,
      total_loss_any: false,
      w_profit_pct: 0,
      n_profit_pct: 0,
      w_loss_pct: 0,
      n_loss_pct: 0,
      w_profit_usd: 0,
      n_profit_usd: 0,
      w_loss_usd: 0,
      n_loss_usd: 0,
      min_loss_pct: null as number | null,
    },
  )
  const pi = Math.round((acc.profit_investment ?? 0) * 100) / 100
  const li = Math.round((acc.loss_investment ?? 0) * 100) / 100
  const profit_avg_pct = acc.n_profit_pct > 0 ? Math.round((acc.w_profit_pct / acc.n_profit_pct) * 100) / 100 : null
  const loss_avg_pct = acc.n_loss_pct > 0 ? Math.round((acc.w_loss_pct / acc.n_loss_pct) * 100) / 100 : null
  const profit_avg_usd = acc.n_profit_usd > 0 ? Math.round((acc.w_profit_usd / acc.n_profit_usd) * 100) / 100 : null
  const loss_avg_usd = acc.n_loss_usd > 0 ? Math.round((acc.w_loss_usd / acc.n_loss_usd) * 100) / 100 : null
  return {
    structure_name: 'All structures',
    total_instances: acc.total_instances,
    profit_trades: acc.profit_trades,
    loss_trades: acc.loss_trades,
    total_profit: Math.round((acc.total_profit ?? 0) * 100) / 100,
    total_loss: acc.total_loss_any ? Math.round(acc.total_loss_sum * 100) / 100 : null,
    profit_investment: pi,
    loss_investment: li,
    total_investment: Math.round((pi + li) * 100) / 100,
    profit_avg_pct,
    loss_avg_pct,
    single_max_loss_pct: acc.min_loss_pct,
    profit_avg_usd,
    loss_avg_usd,
  }
}

function WinRateTotalsCard({ totals }: { totals: WinRateStructureRow }) {
  const winPct = winPctLabel(totals.total_instances, totals.profit_trades)

  return (
    <article className="strategy-win-rate-card strategy-win-rate-card--total">
      <h3 className="strategy-win-rate-card__title">All structures</h3>

      <div className="strategy-win-rate-card--total-panel">
        <div className="strategy-win-rate-card--total-row">
          <div className="strategy-win-rate-card__section strategy-win-rate-card__section--total-band">
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

          <div className="strategy-win-rate-card__section strategy-win-rate-card__section--total-band">
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
                <span
                  className="strategy-win-rate-metric__label"
                  title="Sum of each instance's worst losing trade (realized), over all structures."
                >
                  Total loss
                </span>
                {totals.total_loss != null ? (
                  <span className="strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl pnl-negative">
                    {fmtUsdOrDash(totals.total_loss)}
                  </span>
                ) : (
                  <span className="strategy-win-rate-metric__value strategy-win-rate-metric__value--pnl strategy-win-rate-metric__value--muted">
                    —
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="strategy-win-rate-card__section strategy-win-rate-card__section--total-band">
            <div
              className="strategy-win-rate-card__section-label"
              title="Same as Instance detail Underlying cost; summed across structures. Whole dollars (rounded)."
            >
              Underlying cost
            </div>
            <div className="strategy-win-rate-metrics strategy-win-rate-metrics--underlying-cost">
              <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
                <span className="strategy-win-rate-metric__label" title="Instances with net PnL > 0">
                  On wins
                </span>
                <span className="strategy-win-rate-metric__value">{fmtUsdRound0(totals.profit_investment)}</span>
              </div>
              <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
                <span className="strategy-win-rate-metric__label" title="Instances with net PnL ≤ 0">
                  On losses
                </span>
                <span className="strategy-win-rate-metric__value">{fmtUsdRound0(totals.loss_investment)}</span>
              </div>
              <div className="strategy-win-rate-metric strategy-win-rate-metric--row">
                <span className="strategy-win-rate-metric__label" title="On wins + on losses">
                  Total
                </span>
                <span className="strategy-win-rate-metric__value">{fmtUsdRound0(totals.total_investment)}</span>
              </div>
            </div>
          </div>

          <div className="strategy-win-rate-card__section strategy-win-rate-card__section--total-band">
            <div className="strategy-win-rate-card__section-label">Averages</div>
            <div className="strategy-win-rate-card--total-averages-kpis">
              <div className="strategy-win-rate-kpi">
                <span className="strategy-win-rate-kpi__label">Profit avg %</span>
                <span className="strategy-win-rate-kpi__value pnl-positive">{fmtPct(totals.profit_avg_pct)}</span>
              </div>
              <div className="strategy-win-rate-kpi">
                <span className="strategy-win-rate-kpi__label">Loss avg %</span>
                <span className="strategy-win-rate-kpi__value pnl-negative">{fmtPct(totals.loss_avg_pct)}</span>
              </div>
              <div className="strategy-win-rate-kpi">
                <span className="strategy-win-rate-kpi__label">Max loss %</span>
                <span className="strategy-win-rate-kpi__value pnl-negative">{fmtPct(totals.single_max_loss_pct)}</span>
              </div>
              <div className="strategy-win-rate-kpi">
                <span className="strategy-win-rate-kpi__label">Profit avg $</span>
                <span className="strategy-win-rate-kpi__value pnl-positive">{fmtUsdOrDash(totals.profit_avg_usd)}</span>
              </div>
              <div className="strategy-win-rate-kpi">
                <span className="strategy-win-rate-kpi__label">Loss avg $</span>
                <span className="strategy-win-rate-kpi__value pnl-negative">{fmtUsdOrDash(totals.loss_avg_usd)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}

export function StrategyWinRatePage({ onGoToInstances }: StrategyWinRatePageProps = {}) {
  const [structures, setStructures] = useState<WinRateStructureRow[]>([])
  const [totalsAll, setTotalsAll] = useState<WinRateStructureRow | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res: WinRateResponse = await fetchStrategyWinRate()
      setStructures(res.structures ?? [])
      setTotalsAll(res.totals_all ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load win-rate data')
      setStructures([])
      setTotalsAll(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const totalsForAllStructures: WinRateStructureRow | null =
    totalsAll ?? (structures.length > 1 ? fallbackTotalsAllFromStructures(structures) : null)

  return (
    <div className="card process-section strategy-win-rate-page">
      <div className="strategy-win-rate-page__head">
        <div className="strategy-win-rate-page__head-main">
          <SectionPageTitle
            menu="Strategy"
            pageTitle="Win Rate"
            onMenuClick={() => onGoToInstances?.()}
            menuNavigateAriaLabel="Strategy home"
            infoText="Per-structure win-rate from instances with executions. Underlying cost matches Instance detail (sell OPT: strike × |qty| × 100 per instance; allocation splits qty when present). On wins / On losses = sums for net PnL > 0 vs ≤ 0. Total = both sums."
          />
          <p className="section-hint strategy-win-rate-page__hint">
            Aggregated results per Strategy Structure. Each closed instance counts as one Profit Trade or Loss Trade based on its net PnL. Click a structure card to open Instances with that structure filter.
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
          {totalsForAllStructures && structures.length > 1 ? (
            <div className="strategy-win-rate-totals">
              <WinRateTotalsCard totals={totalsForAllStructures} />
            </div>
          ) : null}
          <div className="strategy-win-rate-grid">
            {structures.map(row => (
              <WinRateStructureCard
                key={row.structure_name}
                row={row}
                onOpenInstancesForStructure={(name) => onGoToInstances?.({ structureFilter: name })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
