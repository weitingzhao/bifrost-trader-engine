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
  getConditionTypeLabel,
  getScopeTypeLabel,
  getStructureTypeLabel,
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
  const [oppFormIsCopy, setOppFormIsCopy] = useState(false)
  const [oppFormPayload, setOppFormPayload] = useState<OpportunityPayload>(DEFAULT_OPPORTUNITY_PAYLOAD)
  const [oppFormSymbols, setOppFormSymbols] = useState<string[]>([])
  const [oppFormEntryConditions, setOppFormEntryConditions] = useState<EntryConditionItem[]>([])
  const [oppFormLoading, setOppFormLoading] = useState(false)
  const [oppFormError, setOppFormError] = useState<string | null>(null)
  /** Filter list: 'all' | 'active' | 'inactive'. */
  const [opportunityActiveFilter, setOpportunityActiveFilter] = useState<'all' | 'active' | 'inactive'>('active')
  const [availabilityInProgress, setAvailabilityInProgress] = useState<number | null>(null)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)

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

  const filteredOpportunities = opportunities.filter((row) => {
    if (opportunityActiveFilter === 'all') return true
    if (opportunityActiveFilter === 'active') return row.is_active === true
    return row.is_active !== true
  })

  const handleToggleOpportunityActive = async (row: StrategyOpportunity) => {
    const id = row.strategy_opportunity_id
    setAvailabilityInProgress(id)
    setAvailabilityError(null)
    try {
      const full = await fetchOpportunity(id)
      const payload = opportunityToPayload(full)
      await updateOpportunity(id, { ...payload, is_active: !row.is_active })
      loadOpportunities()
      loadStatus()
    } catch (e) {
      setAvailabilityError(e instanceof Error ? e.message : String(e))
    } finally {
      setAvailabilityInProgress(null)
    }
  }

  const openOppCreate = () => {
    setOppFormIsCopy(false)
    setOppFormPayload({
      ...DEFAULT_OPPORTUNITY_PAYLOAD,
      strategy_structure_id: structures[0]?.strategy_structure_id ?? 0,
    })
    setOppFormSymbols([])
    setOppFormEntryConditions([])
    setOppFormError(null)
    setOppFormOpen('create')
  }

  const openOppCopy = (id: number) => {
    setOppFormIsCopy(true)
    setOppFormLoading(true)
    setOppFormError(null)
    setOppFormOpen('create')
    fetchOpportunity(id)
      .then((row) => {
        const payload = opportunityToPayload(row)
        setOppFormPayload({ ...payload, name: `${row.name} (copy)` })
        setOppFormSymbols(payload.symbols ?? [])
        setOppFormEntryConditions(payload.entry_conditions ?? [])
      })
      .catch((e) => setOppFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setOppFormLoading(false))
  }

  const openOppEdit = (id: number) => {
    setOppFormIsCopy(false)
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
    setOppFormIsCopy(false)
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
      {availabilityError != null && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => setAvailabilityError(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="opportunity-availability-error-modal-title"
        >
          <div className="data-reset-modal" onClick={(e) => e.stopPropagation()}>
            <h3 id="opportunity-availability-error-modal-title">Cannot change availability</h3>
            <p style={{ whiteSpace: 'pre-wrap', marginBottom: 'var(--space-3)' }}>{availabilityError}</p>
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAvailabilityError(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 id="strategy-opportunity-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
        <InfoTooltip text="Define opportunity strategies linked to a structure; scope and entry conditions." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-subtitle" style={{ margin: 0 }}>Opportunity strategies</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <div className="structure-active-filter-pills" role="group" aria-label="Filter by availability">
              {(['all', 'active', 'inactive'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`structure-active-filter-pill ${opportunityActiveFilter === value ? 'active' : ''}`}
                  onClick={() => setOpportunityActiveFilter(value)}
                >
                  {value === 'all' ? 'All' : value === 'active' ? 'Available' : 'Unavailable'}
                </button>
              ))}
            </div>
            <button type="button" className="btn-primary" onClick={openOppCreate}>
              Create opportunity
            </button>
          </div>
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
                  <th>Available</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredOpportunities.map((row) => {
                  const availabilityUpdating = availabilityInProgress === row.strategy_opportunity_id
                  return (
                    <tr key={row.strategy_opportunity_id}>
                      <td>{row.name}</td>
                      <td>{row.structure_name ?? row.strategy_structure_id}</td>
                      <td>{getScopeTypeLabel(row.scope_type)}</td>
                      <td>{row.gate_safety_name ?? row.default_gate_safety_strategy_id ?? '—'}</td>
                      <td>
                        <label className="toggle-switch" style={{ cursor: availabilityUpdating ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={row.is_active}
                            disabled={!!availabilityInProgress}
                            onChange={() => void handleToggleOpportunityActive(row)}
                            aria-label={`Mark "${row.name}" as ${row.is_active ? 'unavailable' : 'available'}`}
                          />
                        </label>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-manage"
                          onClick={() => openOppEdit(row.strategy_opportunity_id)}
                        >
                          Edit
                        </button>
                        {' '}
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => openOppCopy(row.strategy_opportunity_id)}
                        >
                          Copy
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!opportunitiesLoading && !opportunitiesError && opportunities.length === 0 && (
          <p className="section-hint">No opportunity strategies in database.</p>
        )}
        {!opportunitiesLoading && !opportunitiesError && opportunities.length > 0 && filteredOpportunities.length === 0 && (
          <p className="section-hint">No opportunities match the current filter.</p>
        )}
      </section>

      {oppFormOpen !== null && (
        <section className="strategy-section gates-form-section" style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <h3 className="section-subtitle">
            {oppFormOpen === 'create' ? (oppFormIsCopy ? 'New opportunity (copy)' : 'New opportunity') : `Edit opportunity (ID: ${oppFormOpen})`}
          </h3>
          {oppFormLoading && !oppFormPayload.name && <p className="section-hint">Loading…</p>}
          {oppFormError && (
            <div className="msg-error" style={{ marginBottom: 'var(--space-2)' }}>
              <p>{oppFormError}</p>
            </div>
          )}

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
              <div className="gates-form-row opp-structure-row">
                <span className="gates-form-row-label">Structure</span>
                <div
                  className="opp-structure-cards"
                  role="radiogroup"
                  aria-label="Structure (required)"
                  aria-required
                >
                  {structures.length === 0 ? (
                    <p className="form-hint" style={{ margin: 0 }}>No structures. Create one in Structure first.</p>
                  ) : (
                    structures.map((s) => {
                      const selected = oppFormPayload.strategy_structure_id === s.strategy_structure_id
                      return (
                        <label
                          key={s.strategy_structure_id}
                          className={`opp-structure-card ${selected ? 'opp-structure-card--selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="opp_structure"
                            value={s.strategy_structure_id}
                            checked={selected}
                            onChange={() => setOppFormPayload((p) => ({ ...p, strategy_structure_id: s.strategy_structure_id }))}
                            aria-label={`Structure: ${s.name}`}
                          />
                          <span className="opp-structure-card-title">{s.name}</span>
                          {(s.version != null && s.version !== '') || (s.structure_type != null && s.structure_type !== '') ? (
                            <span className="opp-structure-card-meta">
                              {s.version != null && s.version !== '' ? `v${s.version}` : ''}
                              {s.version != null && s.version !== '' && s.structure_type ? ' · ' : ''}
                              {s.structure_type ? getStructureTypeLabel(s.structure_type) : ''}
                            </span>
                          ) : null}
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
              <div className="gates-form-row gates-form-row--structure-type">
                <span className="gates-form-row-label">Default gate safety</span>
                <div className="structure-type-picker" role="radiogroup" aria-label="Default gate safety">
                  <label
                    className={`structure-type-option ${(oppFormPayload.default_gate_safety_strategy_id ?? null) === null ? 'structure-type-option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="opp_gate_safety"
                      value=""
                      checked={(oppFormPayload.default_gate_safety_strategy_id ?? null) === null}
                      onChange={() => setOppFormPayload((p) => ({ ...p, default_gate_safety_strategy_id: null }))}
                      aria-label="None"
                    />
                    <span>— None</span>
                  </label>
                  {gateSafetySets.map((g) => (
                    <label
                      key={g.gate_safety_strategy_id}
                      className={`structure-type-option ${oppFormPayload.default_gate_safety_strategy_id === g.gate_safety_strategy_id ? 'structure-type-option--selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="opp_gate_safety"
                        value={g.gate_safety_strategy_id}
                        checked={oppFormPayload.default_gate_safety_strategy_id === g.gate_safety_strategy_id}
                        onChange={() =>
                          setOppFormPayload((p) => ({ ...p, default_gate_safety_strategy_id: g.gate_safety_strategy_id }))
                        }
                        aria-label={g.name}
                      />
                      <span>{g.name}</span>
                      {g.version != null && g.version !== '' && (
                        <span className="structure-sheet-version" aria-hidden> v{g.version}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
              <div className="gates-form-row">
                <label className="toggle-switch" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={oppFormPayload.is_active ?? true}
                    onChange={(e) => setOppFormPayload((p) => ({ ...p, is_active: e.target.checked }))}
                    aria-label="Available"
                  />
                  <span className="toggle-switch-caption">Available</span>
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Symbol scope</h4>
              <div className="gates-form-row scope-type-switches-row">
                <span className="gates-form-row-label">Scope type</span>
                <div className="scope-type-switches" role="radiogroup" aria-label="Scope type">
                  {SCOPE_TYPES.map((t) => {
                    const value = t || ''
                    const checked = (oppFormPayload.scope_type ?? '') === value
                    return (
                      <label
                        key={t || '_none'}
                        className="toggle-switch scope-type-switch-option"
                        style={{ cursor: 'pointer' }}
                      >
                        <input
                          type="radio"
                          name="opp_scope_type"
                          value={value}
                          checked={checked}
                          onChange={() => setOppFormPayload((p) => ({ ...p, scope_type: value || null }))}
                          aria-label={getScopeTypeLabel(t)}
                        />
                        <span className="toggle-switch-caption">{getScopeTypeLabel(t)}</span>
                      </label>
                    )
                  })}
                </div>
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
                <p className="form-hint">Symbols from Watchlist STK.</p>
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
                                {getConditionTypeLabel(t)}
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

            <div className="gates-form-actions" style={{ marginTop: 'var(--space-4)' }}>
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
