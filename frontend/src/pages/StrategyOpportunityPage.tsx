import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchStructures,
  fetchOpportunities,
  fetchOpportunity,
  createOpportunity,
  updateOpportunity,
  fetchGateSafetySets,
  type StrategyStructure,
  type StrategyOpportunity,
  type OpportunityPayload,
  type EntryConditionItem,
  type GateSafetySet,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  SCOPE_TYPES,
  CONDITION_TYPES,
  DEFAULT_OPPORTUNITY_PAYLOAD,
  opportunityToPayload,
} from './strategy/strategyFormUtils'

export interface StrategyOpportunityPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  breadcrumbLabel?: string
}

export function StrategyOpportunityPage({
  loadStatus,
  breadcrumbLabel = 'Opportunity',
}: StrategyOpportunityPageProps) {
  const [structures, setStructures] = useState<StrategyStructure[]>([])
  const [gateSafetySets, setGateSafetySets] = useState<GateSafetySet[]>([])
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [_structuresLoading, setStructuresLoading] = useState(true)
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(true)
  const [_gateSafetyLoading, setGateSafetyLoading] = useState(true)
  const [_structuresError, setStructuresError] = useState<string | null>(null)
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null)
  const [_gateSafetyError, setGateSafetyError] = useState<string | null>(null)
  const [oppFormOpen, setOppFormOpen] = useState<'create' | number | null>(null)
  const [oppFormPayload, setOppFormPayload] = useState<OpportunityPayload>(DEFAULT_OPPORTUNITY_PAYLOAD)
  const [oppFormSymbols, setOppFormSymbols] = useState<string[]>([])
  const [oppFormEntryConditions, setOppFormEntryConditions] = useState<EntryConditionItem[]>([])
  const [oppFormLoading, setOppFormLoading] = useState(false)
  const [oppFormError, setOppFormError] = useState<string | null>(null)

  const loadStructures = useCallback(() => {
    setStructuresLoading(true)
    setStructuresError(null)
    fetchStructures(false)
      .then((res) => setStructures(res.items ?? []))
      .catch((e) => setStructuresError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStructuresLoading(false))
  }, [])

  const loadOpportunities = useCallback(() => {
    setOpportunitiesLoading(true)
    setOpportunitiesError(null)
    fetchOpportunities(false)
      .then((res) => setOpportunities(res.items ?? []))
      .catch((e) => setOpportunitiesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setOpportunitiesLoading(false))
  }, [])

  useEffect(() => {
    loadStructures()
  }, [loadStructures])

  useEffect(() => {
    loadOpportunities()
  }, [loadOpportunities])

  useEffect(() => {
    let cancelled = false
    setGateSafetyLoading(true)
    setGateSafetyError(null)
    fetchGateSafetySets()
      .then((res) => {
        if (!cancelled) setGateSafetySets(res.items ?? [])
      })
      .catch((e) => {
        if (!cancelled) setGateSafetyError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setGateSafetyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openOppCreate = () => {
    setOppFormPayload({
      ...DEFAULT_OPPORTUNITY_PAYLOAD,
      strategy_structure_id: structures[0]?.strategy_structure_id ?? 0,
    })
    setOppFormSymbols([])
    setOppFormEntryConditions([])
    setOppFormError(null)
    setOppFormOpen('create')
  }

  const openOppEdit = (id: number) => {
    setOppFormLoading(true)
    setOppFormError(null)
    fetchOpportunity(id)
      .then((row) => {
        const payload = opportunityToPayload(row)
        setOppFormPayload(payload)
        setOppFormSymbols(payload.symbols ?? [])
        setOppFormEntryConditions(payload.entry_conditions ?? [])
        setOppFormOpen(id)
      })
      .catch((e) => setOppFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setOppFormLoading(false))
  }

  const closeOppForm = () => {
    setOppFormOpen(null)
    setOppFormError(null)
  }

  const submitOppForm = async () => {
    const name = oppFormPayload.name.trim()
    if (!name) {
      setOppFormError('Name is required')
      return
    }
    if (!oppFormPayload.strategy_structure_id) {
      setOppFormError('Structure is required')
      return
    }
    setOppFormError(null)
    setOppFormLoading(true)
    const scopeType = (oppFormPayload.scope_type || '').trim() || null
    const symbols = scopeType === 'explicit_symbols' ? oppFormSymbols.filter((s) => s.trim()) : []
    const entryConditions = oppFormEntryConditions
      .filter((c) => c.condition_type?.trim())
      .map((c) => ({
        condition_type: c.condition_type.trim(),
        value_text: c.value_text?.trim() || null,
        value_numeric: c.value_numeric ?? null,
      }))
    const payload: OpportunityPayload = {
      name,
      strategy_structure_id: oppFormPayload.strategy_structure_id,
      default_gate_safety_strategy_id: oppFormPayload.default_gate_safety_strategy_id ?? null,
      scope_type: scopeType,
      symbols,
      entry_conditions: entryConditions,
      is_active: oppFormPayload.is_active ?? true,
    }
    try {
      if (oppFormOpen === 'create') {
        await createOpportunity(payload)
      } else {
        await updateOpportunity(oppFormOpen as number, payload)
      }
      closeOppForm()
      loadOpportunities()
      loadStatus()
    } catch (e) {
      setOppFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setOppFormLoading(false)
    }
  }

  const addOppSymbol = () => setOppFormSymbols((prev) => [...prev, ''])
  const updateOppSymbol = (index: number, value: string) =>
    setOppFormSymbols((prev) => prev.map((s, i) => (i === index ? value : s)))
  const removeOppSymbol = (index: number) => setOppFormSymbols((prev) => prev.filter((_, i) => i !== index))

  const addOppCondition = () =>
    setOppFormEntryConditions((prev) => [...prev, { condition_type: 'iv_min', value_text: null, value_numeric: null }])
  const updateOppCondition = (index: number, patch: Partial<EntryConditionItem>) =>
    setOppFormEntryConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  const removeOppCondition = (index: number) =>
    setOppFormEntryConditions((prev) => prev.filter((_, i) => i !== index))

  return (
    <div className="card process-section">
      <h2 id="strategy-opportunity-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
        <InfoTooltip text="Define opportunity strategies linked to a structure; scope and entry conditions." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-subtitle" style={{ margin: 0 }}>Opportunity strategies</h3>
          <button type="button" className="btn-primary" onClick={openOppCreate}>
            Create opportunity
          </button>
        </div>
        {opportunitiesLoading && <p className="section-hint">Loading…</p>}
        {opportunitiesError && <p className="msg-error">{opportunitiesError}</p>}
        {!opportunitiesLoading && !opportunitiesError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Structure</th>
                  <th>Scope</th>
                  <th>Default gate safety</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((row) => (
                  <tr key={row.strategy_opportunity_id}>
                    <td>{row.name}</td>
                    <td>{row.structure_name ?? row.strategy_structure_id}</td>
                    <td>{row.scope_type ?? '—'}</td>
                    <td>{row.gate_safety_name ?? row.default_gate_safety_strategy_id ?? '—'}</td>
                    <td>{row.is_active ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-manage"
                        onClick={() => openOppEdit(row.strategy_opportunity_id)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!opportunitiesLoading && !opportunitiesError && opportunities.length === 0 && (
          <p className="section-hint">No opportunity strategies in database.</p>
        )}
      </section>

      {oppFormOpen !== null && (
        <section className="strategy-section gates-form-section" style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <h3 className="section-subtitle">
            {oppFormOpen === 'create' ? 'New opportunity' : `Edit opportunity ${oppFormOpen}`}
          </h3>
          {oppFormLoading && !oppFormPayload.name && <p className="section-hint">Loading…</p>}
          {oppFormError && <p className="msg-error">{oppFormError}</p>}

          <div className="gates-form">
            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Metadata</h4>
              <div className="gates-form-row">
                <label>Name</label>
                <input
                  type="text"
                  value={oppFormPayload.name}
                  onChange={(e) => setOppFormPayload((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Opportunity name"
                />
              </div>
              <div className="gates-form-row">
                <label>Structure</label>
                <select
                  value={oppFormPayload.strategy_structure_id || ''}
                  onChange={(e) => setOppFormPayload((p) => ({ ...p, strategy_structure_id: Number(e.target.value) }))}
                >
                  <option value="">Select structure</option>
                  {structures.map((s) => (
                    <option key={s.strategy_structure_id} value={s.strategy_structure_id}>
                      {s.name} ({s.strategy_structure_id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="gates-form-row">
                <label>Default gate safety</label>
                <select
                  value={oppFormPayload.default_gate_safety_strategy_id ?? ''}
                  onChange={(e) =>
                    setOppFormPayload((p) => ({
                      ...p,
                      default_gate_safety_strategy_id: e.target.value === '' ? null : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">— None</option>
                  {gateSafetySets.map((g) => (
                    <option key={g.gate_safety_strategy_id} value={g.gate_safety_strategy_id}>
                      {g.name} ({g.gate_safety_strategy_id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="gates-form-row">
                <label>
                  <input
                    type="checkbox"
                    checked={oppFormPayload.is_active ?? true}
                    onChange={(e) => setOppFormPayload((p) => ({ ...p, is_active: e.target.checked }))}
                  />
                  {' '}Active
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Symbol scope</h4>
              <div className="gates-form-row">
                <label>Scope type</label>
                <select
                  value={oppFormPayload.scope_type ?? ''}
                  onChange={(e) => setOppFormPayload((p) => ({ ...p, scope_type: e.target.value || null }))}
                >
                  {SCOPE_TYPES.map((t) => (
                    <option key={t || '_none'} value={t}>
                      {t || '— None'}
                    </option>
                  ))}
                </select>
              </div>
              {oppFormPayload.scope_type === 'explicit_symbols' && (
                <>
                  <div className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                    {oppFormSymbols.map((sym, i) => (
                      <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <input
                          type="text"
                          value={sym}
                          onChange={(e) => updateOppSymbol(i, e.target.value)}
                          placeholder="Symbol"
                          style={{ width: '100px' }}
                        />
                        <button type="button" className="btn-secondary" onClick={() => removeOppSymbol(i)}>
                          Remove
                        </button>
                      </span>
                    ))}
                  </div>
                  <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addOppSymbol}>
                    Add symbol
                  </button>
                </>
              )}
              {oppFormPayload.scope_type === 'watchlist_stk' && (
                <p className="section-hint">Symbols from Watchlist STK.</p>
              )}
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Entry conditions</h4>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Value (text)</th>
                      <th>Value (numeric)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {oppFormEntryConditions.map((c, i) => (
                      <tr key={i}>
                        <td>
                          <select
                            value={c.condition_type}
                            onChange={(e) => updateOppCondition(i, { condition_type: e.target.value })}
                          >
                            {CONDITION_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={c.value_text ?? ''}
                            onChange={(e) => updateOppCondition(i, { value_text: e.target.value || null })}
                            placeholder="—"
                            style={{ width: '120px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            step="any"
                            value={c.value_numeric ?? ''}
                            onChange={(e) =>
                              updateOppCondition(i, {
                                value_numeric: e.target.value === '' ? null : parseFloat(e.target.value),
                              })
                            }
                            placeholder="—"
                            style={{ width: '100px' }}
                          />
                        </td>
                        <td>
                          <button type="button" className="btn-secondary" onClick={() => removeOppCondition(i)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addOppCondition}>
                Add condition
              </button>
            </div>

            <div className="gates-form-actions">
              <button type="button" className="btn-primary" onClick={submitOppForm} disabled={oppFormLoading}>
                {oppFormOpen === 'create' ? 'Create' : 'Save'}
              </button>
              <button type="button" className="btn-secondary" onClick={closeOppForm}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
