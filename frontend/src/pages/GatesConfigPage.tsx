import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchGateSafetySets,
  fetchGateSafetyFull,
  createGateSafety,
  updateGateSafety,
  postActiveStrategy,
  type GateSafetySet,
  type GateSafetyFull,
  type GateSafetyPayload,
  type GateSafetyGates,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

export interface GatesConfigPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  onGoToStrategy?: () => void
  breadcrumbLabel?: string
}

const DEFAULT_GATES: GateSafetyGates = {
  strategy: {
    structure: { min_dte: 21, max_dte: 35, atm_band_pct: 0.03 },
    earnings: { blackout_days_before: 3, blackout_days_after: 1, dates: [] },
    trading_hours_only: true,
  },
  state: {
    delta: { epsilon_band: 10, threshold_hedge_shares: 25, max_delta_limit: 500 },
    market: { vol_window_min: 5, stale_ts_threshold_ms: 5000 },
    liquidity: { wide_spread_pct: 0.1, extreme_spread_pct: 0.5 },
    system: { data_lag_threshold_ms: 1000 },
  },
  intent: {
    hedge: {
      min_hedge_shares: 10,
      cooldown_seconds: 60,
      max_hedge_shares_per_order: 500,
      min_price_move_pct: 0.2,
    },
  },
  guard: {
    risk: {
      max_daily_hedge_count: 50,
      max_position_shares: 2000,
      max_daily_loss_usd: 5000,
      max_net_delta_shares: 100,
      max_spread_pct: 0.05,
      paper_trade: true,
    },
  },
}

function fullToPayload(full: GateSafetyFull): GateSafetyPayload {
  return {
    name: full.name,
    version: full.version,
    structure_type: full.structure_type ?? null,
    is_active: full.is_active,
    gates: full.gates ?? DEFAULT_GATES,
    earnings_dates: full.earnings_dates ?? [],
  }
}

export function GatesConfigPage({
  status,
  loadStatus,
  onGoToStrategy,
  breadcrumbLabel = 'Gates',
}: GatesConfigPageProps) {
  const [sets, setSets] = useState<GateSafetySet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [setActiveMsg, setSetActiveMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [formOpen, setFormOpen] = useState<'create' | number | null>(null)
  const [formPayload, setFormPayload] = useState<GateSafetyPayload>({
    name: '',
    version: 1,
    structure_type: null,
    is_active: true,
    gates: DEFAULT_GATES,
    earnings_dates: [],
  })
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const loadSets = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchGateSafetySets()
      .then((res) => setSets(res.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadSets()
  }, [loadSets])

  const handleSetActive = async (gateSafetyId: number) => {
    const res = await postActiveStrategy(status?.active_strategy_structure_id ?? null, gateSafetyId, status?.active_strategy_allocation_id ?? null)
    if (res.ok) {
      setSetActiveMsg({ text: 'Active gate safety updated. Daemon uses it on next start.', isErr: false })
      loadStatus()
    } else {
      setSetActiveMsg({ text: res.error ?? 'Failed to set active', isErr: true })
    }
    setTimeout(() => setSetActiveMsg({ text: '', isErr: false }), 5000)
  }

  const openCreate = () => {
    setFormPayload({
      name: 'New gate set',
      version: 1,
      structure_type: null,
      is_active: true,
      gates: JSON.parse(JSON.stringify(DEFAULT_GATES)),
      earnings_dates: [],
    })
    setFormError(null)
    setFormOpen('create')
  }

  const openEdit = (id: number) => {
    setFormLoading(true)
    setFormError(null)
    setFormOpen(id)
    fetchGateSafetyFull(id)
      .then((full) => setFormPayload(fullToPayload(full)))
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const openCopy = (id: number) => {
    setFormLoading(true)
    setFormError(null)
    setFormOpen('create')
    fetchGateSafetyFull(id)
      .then((full) => {
        const p = fullToPayload(full)
        p.name = `${full.name} (copy)`
        setFormPayload(p)
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const closeForm = () => {
    setFormOpen(null)
    setFormError(null)
  }

  const updateForm = (patch: Partial<GateSafetyPayload>) => {
    setFormPayload((prev) => ({ ...prev, ...patch }))
  }

  const updateGates = (path: string, value: unknown) => {
    const parts = path.split('.')
    setFormPayload((prev) => {
      const gates = JSON.parse(JSON.stringify(prev.gates || DEFAULT_GATES)) as GateSafetyGates
      if (parts.length === 3) {
        const [layer, sub, key] = parts
        const layerObj = (gates as Record<string, unknown>)[layer] as Record<string, unknown>
        const subObj = (layerObj?.[sub] as Record<string, unknown>) ?? {}
        ;(gates as Record<string, unknown>)[layer] = { ...layerObj, [sub]: { ...subObj, [key]: value } }
      } else if (parts.length === 2) {
        const [layer, key] = parts
        const layerObj = (gates as Record<string, unknown>)[layer] as Record<string, unknown>
        ;(gates as Record<string, unknown>)[layer] = { ...layerObj, [key]: value }
      }
      return { ...prev, gates }
    })
  }

  const setEarningsDate = (index: number, value: string) => {
    setFormPayload((prev) => {
      const dates = [...(prev.earnings_dates ?? [])]
      dates[index] = value
      return { ...prev, earnings_dates: dates }
    })
  }

  const addEarningsDate = () => {
    setFormPayload((prev) => ({
      ...prev,
      earnings_dates: [...(prev.earnings_dates ?? []), ''],
    }))
  }

  const removeEarningsDate = (index: number) => {
    setFormPayload((prev) => ({
      ...prev,
      earnings_dates: (prev.earnings_dates ?? []).filter((_, i) => i !== index),
    }))
  }

  const submitForm = async () => {
    if (!formPayload.name.trim()) {
      setFormError('Name is required')
      return
    }
    const payload: GateSafetyPayload = {
      ...formPayload,
      name: formPayload.name.trim(),
      earnings_dates: (formPayload.earnings_dates ?? []).filter((d) => d && d.trim().length >= 10),
    }
    setFormLoading(true)
    setFormError(null)
    try {
      if (formOpen === 'create') {
        await createGateSafety(payload)
        loadSets()
        closeForm()
      } else if (typeof formOpen === 'number') {
        await updateGateSafety(formOpen, payload)
        loadSets()
        closeForm()
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setFormLoading(false)
    }
  }

  const g = formPayload.gates ?? DEFAULT_GATES
  const strat = g.strategy ?? {}
  const st = strat.structure ?? {}
  const earn = strat.earnings ?? {}
  const state = g.state ?? {}
  const delta = state.delta ?? {}
  const market = state.market ?? {}
  const liquidity = state.liquidity ?? {}
  const system = state.system ?? {}
  const intentHedge = g.intent?.hedge ?? {}
  const guardRisk = g.guard?.risk ?? {}
  const earningsDates = formPayload.earnings_dates ?? []

  return (
    <div className="card process-section">
      <h2 id="gates-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        {onGoToStrategy ? (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={onGoToStrategy}
              aria-label="Go to Strategy"
            >
              Strategy
            </button>
            {' / '}
            {breadcrumbLabel}
          </>
        ) : (
          breadcrumbLabel
        )}
        <InfoTooltip text="Create and edit gate safety boundary sets; set which set is active for the daemon." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="section-subtitle">Current active</h3>
        <div className="statusSummary">
          <div>
            <strong>Gate safety:</strong> {status?.active_gate_safety_strategy_name ?? '—'}
            {status?.active_gate_safety_strategy_id != null && ` (${status.active_gate_safety_strategy_id})`}
          </div>
          <div>
            <strong>Allocation:</strong> {status?.active_strategy_allocation_name ?? '—'}
            {status?.active_strategy_allocation_id != null && ` (${status.active_strategy_allocation_id})`}
          </div>
        </div>
        <p className="section-hint">Daemon uses this on next start.</p>
      </section>

      {setActiveMsg.text && (
        <p className={setActiveMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: 'var(--space-2)' }}>
          {setActiveMsg.text}
        </p>
      )}

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-subtitle" style={{ margin: 0 }}>Gate safety sets</h3>
          <button type="button" className="btn-primary" onClick={openCreate}>
            Create gate set
          </button>
        </div>
        {loading && <p className="section-hint">Loading…</p>}
        {error && <p className="msg-error">{error}</p>}
        {!loading && !error && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Type</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sets.map((row) => (
                  <tr key={row.gate_safety_strategy_id}>
                    <td>{row.name}</td>
                    <td>{row.version ?? '—'}</td>
                    <td>{row.structure_type ?? '—'}</td>
                    <td>{row.is_active ? 'Yes' : 'No'}</td>
                    <td>
                      <button type="button" className="btn-manage" onClick={() => openEdit(row.gate_safety_strategy_id)}>
                        Edit
                      </button>
                      {' '}
                      <button type="button" className="btn-set-active" onClick={() => handleSetActive(row.gate_safety_strategy_id)}>
                        Set active
                      </button>
                      {' '}
                      <button type="button" className="btn-secondary" onClick={() => openCopy(row.gate_safety_strategy_id)}>
                        Copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && sets.length === 0 && (
          <p className="section-hint">No gate safety sets. Create one to get started.</p>
        )}
      </section>

      {formOpen !== null && (
        <section className="strategy-section gates-form-section gates-form-section--gates-page" style={{ marginTop: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <div className="gates-form-sticky-header">
            <h3 className="section-subtitle" style={{ marginBottom: 0 }}>
              {formOpen === 'create' ? 'New gate set' : `Edit gate set ${formOpen}`}
            </h3>
            {formLoading && !formPayload.name && <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>Loading…</p>}
            {formError && <p className="msg-error" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>{formError}</p>}
          </div>

          <div className="gates-form">
            <div className="gates-form-group gates-form-group--metadata-root">
              <h4 className="gates-form-group-title">Metadata</h4>
              <div className="gates-form-row">
                <label>Name</label>
                <input
                  type="text"
                  value={formPayload.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  placeholder="Gate set name"
                />
              </div>
              <div className="gates-form-row">
                <label>Version</label>
                <input
                  type="number"
                  min={1}
                  value={formPayload.version ?? 1}
                  onChange={(e) => updateForm({ version: parseInt(e.target.value, 10) || 1 })}
                />
              </div>
              <div className="gates-form-row">
                <label>Structure type</label>
                <input
                  type="text"
                  value={formPayload.structure_type ?? ''}
                  onChange={(e) => updateForm({ structure_type: e.target.value.trim() || null })}
                  placeholder="e.g. straddle_strangle"
                />
              </div>
              <div className="gates-form-row gates-form-row--full">
                <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={formPayload.is_active ?? true}
                    onChange={(e) => updateForm({ is_active: e.target.checked })}
                    aria-label="Active"
                  />
                  <span className="toggle-switch-caption">Active</span>
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Strategy (structure &amp; earnings)</h4>
              <div className="gates-form-row">
                <label>min_dte</label>
                <input type="number" value={st.min_dte ?? 21} onChange={(e) => updateGates('strategy.structure.min_dte', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_dte</label>
                <input type="number" value={st.max_dte ?? 35} onChange={(e) => updateGates('strategy.structure.max_dte', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>atm_band_pct</label>
                <input type="number" step="0.01" value={st.atm_band_pct ?? 0.03} onChange={(e) => updateGates('strategy.structure.atm_band_pct', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>blackout_days_before</label>
                <input type="number" value={earn.blackout_days_before ?? 3} onChange={(e) => updateGates('strategy.earnings.blackout_days_before', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>blackout_days_after</label>
                <input type="number" value={earn.blackout_days_after ?? 1} onChange={(e) => updateGates('strategy.earnings.blackout_days_after', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row gates-form-row--full">
                <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={strat.trading_hours_only ?? true}
                    onChange={(e) => updateGates('strategy.trading_hours_only', e.target.checked)}
                    aria-label="Trading hours only"
                  />
                  <span className="toggle-switch-caption">trading_hours_only</span>
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">State (delta, market, liquidity, system)</h4>
              <div className="gates-form-row">
                <label>epsilon_band</label>
                <input type="number" value={delta.epsilon_band ?? 10} onChange={(e) => updateGates('state.delta.epsilon_band', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>threshold_hedge_shares</label>
                <input type="number" value={delta.threshold_hedge_shares ?? 25} onChange={(e) => updateGates('state.delta.threshold_hedge_shares', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_delta_limit</label>
                <input type="number" value={delta.max_delta_limit ?? 500} onChange={(e) => updateGates('state.delta.max_delta_limit', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>vol_window_min</label>
                <input type="number" value={market.vol_window_min ?? 5} onChange={(e) => updateGates('state.market.vol_window_min', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>stale_ts_threshold_ms</label>
                <input type="number" value={market.stale_ts_threshold_ms ?? 5000} onChange={(e) => updateGates('state.market.stale_ts_threshold_ms', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>wide_spread_pct</label>
                <input type="number" step="0.01" value={liquidity.wide_spread_pct ?? 0.1} onChange={(e) => updateGates('state.liquidity.wide_spread_pct', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>extreme_spread_pct</label>
                <input type="number" step="0.01" value={liquidity.extreme_spread_pct ?? 0.5} onChange={(e) => updateGates('state.liquidity.extreme_spread_pct', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>data_lag_threshold_ms</label>
                <input type="number" value={system.data_lag_threshold_ms ?? 1000} onChange={(e) => updateGates('state.system.data_lag_threshold_ms', parseInt(e.target.value, 10) || 0)} />
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Intent (hedge)</h4>
              <div className="gates-form-row">
                <label>min_hedge_shares</label>
                <input type="number" value={intentHedge.min_hedge_shares ?? 10} onChange={(e) => updateGates('intent.hedge.min_hedge_shares', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>cooldown_seconds</label>
                <input type="number" value={intentHedge.cooldown_seconds ?? 60} onChange={(e) => updateGates('intent.hedge.cooldown_seconds', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_hedge_shares_per_order</label>
                <input type="number" value={intentHedge.max_hedge_shares_per_order ?? 500} onChange={(e) => updateGates('intent.hedge.max_hedge_shares_per_order', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>min_price_move_pct</label>
                <input type="number" step="0.01" value={intentHedge.min_price_move_pct ?? 0.2} onChange={(e) => updateGates('intent.hedge.min_price_move_pct', parseFloat(e.target.value) || 0)} />
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Guard (risk)</h4>
              <div className="gates-form-row">
                <label>max_daily_hedge_count</label>
                <input type="number" value={guardRisk.max_daily_hedge_count ?? 50} onChange={(e) => updateGates('guard.risk.max_daily_hedge_count', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_position_shares</label>
                <input type="number" value={guardRisk.max_position_shares ?? 2000} onChange={(e) => updateGates('guard.risk.max_position_shares', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_daily_loss_usd</label>
                <input type="number" value={guardRisk.max_daily_loss_usd ?? 5000} onChange={(e) => updateGates('guard.risk.max_daily_loss_usd', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_net_delta_shares</label>
                <input type="number" value={guardRisk.max_net_delta_shares ?? 100} onChange={(e) => updateGates('guard.risk.max_net_delta_shares', parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="gates-form-row">
                <label>max_spread_pct</label>
                <input type="number" step="0.01" value={guardRisk.max_spread_pct ?? 0.05} onChange={(e) => updateGates('guard.risk.max_spread_pct', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="gates-form-row gates-form-row--full">
                <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={guardRisk.paper_trade ?? true}
                    onChange={(e) => updateGates('guard.risk.paper_trade', e.target.checked)}
                    aria-label="Paper trade"
                  />
                  <span className="toggle-switch-caption">paper_trade</span>
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Earnings dates (blacklist YYYY-MM-DD)</h4>
              {earningsDates.map((d, i) => (
                <div key={i} className="gates-form-row gates-form-row--inline">
                  <input
                    type="date"
                    value={d}
                    onChange={(e) => setEarningsDate(i, e.target.value)}
                  />
                  <button type="button" className="btn-secondary" onClick={() => removeEarningsDate(i)}>Remove</button>
                </div>
              ))}
              <div className="gates-form-row gates-form-row--full">
                <button type="button" className="btn-secondary" onClick={addEarningsDate}>Add date</button>
              </div>
            </div>

            <div className="gates-form-actions">
              <button type="button" className="btn-primary" onClick={submitForm} disabled={formLoading}>
                {formOpen === 'create' ? 'Create' : 'Update'}
              </button>
              <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
