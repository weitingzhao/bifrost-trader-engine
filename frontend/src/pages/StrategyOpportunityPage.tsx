import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchStructures,
  fetchOpportunities,
  fetchOpportunity,
  createOpportunity,
  updateOpportunity,
  fetchGateSafetySets,
  fetchWatchlist,
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
  getScopeDisplay,
  getScopeTypeLabel,
  getStructureDisplayLabel,
  buildSuggestedOpportunityName,
  opportunityToPayload,
} from './strategy/strategyFormUtils'

export interface StrategyOpportunityPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  breadcrumbLabel?: string
  /** From hash #/strategies/opportunities/:id — open edit drawer for this opportunity. */
  urlFocusOpportunityId?: number | null
}

export function StrategyOpportunityPage({
  loadStatus,
  breadcrumbLabel = 'Opportunity',
  urlFocusOpportunityId = null,
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
  const [watchlistItems, setWatchlistItems] = useState<Awaited<ReturnType<typeof fetchWatchlist>>['items']>([])
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  /** After user edits Name on create form, stop auto-overwriting. */
  const oppCreateNameUserEdited = useRef(false)

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

  const needWatchlist = Boolean(oppFormOpen && oppFormPayload.scope_type === 'watchlist_stk')
  useEffect(() => {
    if (!needWatchlist) return
    let cancelled = false
    setWatchlistLoading(true)
    fetchWatchlist()
      .then((res) => {
        if (!cancelled) setWatchlistItems(res.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setWatchlistItems([])
      })
      .finally(() => {
        if (!cancelled) setWatchlistLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [needWatchlist])

  const watchlistStkSymbols = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const w of watchlistItems) {
      if ((w.sec_type || 'STK').toUpperCase() === 'OPT') continue
      if (w.optionable !== true) continue
      const sym = (w.symbol || w.contract_key || '').trim()
      if (sym && !seen.has(sym)) {
        seen.add(sym)
        out.push(sym)
      }
    }
    return out.sort((a, b) => a.localeCompare(b))
  }, [watchlistItems])

  const activeGateSafetySets = useMemo(
    () => gateSafetySets.filter((g) => g.is_active === true),
    [gateSafetySets]
  )

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
    oppCreateNameUserEdited.current = false
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

  const lastUrlFocusOppRef = useRef<number | null>(null)
  useEffect(() => {
    const id = urlFocusOpportunityId
    if (id == null || !Number.isFinite(id)) {
      lastUrlFocusOppRef.current = null
      return
    }
    if (lastUrlFocusOppRef.current === id) return
    lastUrlFocusOppRef.current = id
    openOppEdit(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per hash id; openOppEdit stable enough
  }, [urlFocusOpportunityId])

  const closeOppForm = () => {
    setOppFormOpen(null)
    setOppFormIsCopy(false)
    setOppFormError(null)
    try {
      const raw = window.location.hash
      const h = raw.startsWith('#') ? raw.slice(1) : raw
      if (/^\/strategies\/opportunities\/\d+\/?$/.test(h)) {
        window.location.hash = '#/strategies/opportunities'
      }
    } catch {
      /* ignore */
    }
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
    const symbols =
      scopeType === 'explicit_symbols'
        ? oppFormSymbols.filter((s) => s.trim())
        : scopeType === 'watchlist_stk'
          ? oppFormSymbols
          : []
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

  const suggestedOppCreateName = useMemo(() => {
    const st = structures.find((s) => s.strategy_structure_id === oppFormPayload.strategy_structure_id)
    const structureName = st?.name ?? ''
    return buildSuggestedOpportunityName({
      structureName,
      scopeType: oppFormPayload.scope_type,
      symbols: oppFormSymbols,
      entryConditions: oppFormEntryConditions,
    })
  }, [
    structures,
    oppFormPayload.strategy_structure_id,
    oppFormPayload.scope_type,
    oppFormSymbols,
    oppFormEntryConditions,
  ])

  useEffect(() => {
    if (oppFormOpen !== 'create' || oppFormIsCopy || oppCreateNameUserEdited.current) return
    setOppFormPayload((p) => ({ ...p, name: suggestedOppCreateName }))
  }, [suggestedOppCreateName, oppFormOpen, oppFormIsCopy])

  const isFormCreate = oppFormOpen === 'create'
  const formTitle = isFormCreate
    ? (oppFormIsCopy ? 'New opportunity (copy)' : 'New opportunity')
    : `Edit opportunity #${oppFormOpen}`

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
              <button type="button" className="btn btn-primary" onClick={() => setAvailabilityError(null)}>
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

      {/* ── List section ── */}
      <section className="opp-list-section">
        <div className="opp-list-toolbar">
          <h3 className="opp-list-title">Opportunity strategies</h3>
          <div className="opp-list-actions">
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
            <button type="button" className="btn-primary opp-create-btn" onClick={openOppCreate}>
              + Create opportunity
            </button>
          </div>
        </div>

        {opportunitiesLoading && <p className="section-hint">Loading…</p>}
        {opportunitiesError && <p className="msg-error">{opportunitiesError}</p>}
        {!opportunitiesLoading && !opportunitiesError && (
          <div className="opp-table-wrap">
            <table className="table-operations opp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Structure</th>
                  <th>Scope</th>
                  <th>Gate safety</th>
                  <th style={{ width: '5.5rem', textAlign: 'center' }}>Available</th>
                  <th style={{ width: '9rem' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredOpportunities.map((row) => {
                  const availabilityUpdating = availabilityInProgress === row.strategy_opportunity_id
                  const scopeDisplay = getScopeDisplay(row.scope_type, row.symbols)
                  return (
                    <tr key={row.strategy_opportunity_id}>
                      <td className="opp-table-name-cell">{row.name}</td>
                      <td>{row.structure_name ?? row.strategy_structure_id}</td>
                      <td className="opp-table-scope-cell">
                        <span className="opp-table-scope-text" title={scopeDisplay.title || undefined}>
                          {scopeDisplay.text}
                        </span>
                      </td>
                      <td>{row.gate_safety_name ?? <span className="opp-table-none">—</span>}</td>
                      <td style={{ textAlign: 'center' }}>
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
                        <span className="opp-table-row-actions">
                          <button type="button" className="opp-row-btn opp-row-btn--edit" onClick={() => openOppEdit(row.strategy_opportunity_id)}>
                            Edit
                          </button>
                          <button type="button" className="opp-row-btn opp-row-btn--copy" onClick={() => openOppCopy(row.strategy_opportunity_id)}>
                            Copy
                          </button>
                        </span>
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

      {/* ── Create / Edit form panel ── */}
      {oppFormOpen !== null && (
        <section className="opp-form-panel">
          <div className="opp-form-header">
            <h3 className="opp-form-title">{formTitle}</h3>
            <button type="button" className="opp-form-close" onClick={closeOppForm} aria-label="Close form">×</button>
          </div>

          {oppFormLoading && !oppFormPayload.name && <div className="opp-form-loading">Loading…</div>}
          {oppFormError && (
            <div className="opp-form-error">
              <span className="opp-form-error-icon">!</span>
              {oppFormError}
            </div>
          )}

          <div className="opp-form-body">
            {/* ── Row 1: Name + Availability ── */}
            <div className="opp-field-row opp-field-row--identity">
              <div className="opp-field opp-field--name">
                <label className="opp-field-label" htmlFor="opp-name">Name</label>
                <input
                  id="opp-name"
                  type="text"
                  className="opp-input"
                  value={oppFormPayload.name}
                  onChange={(e) => {
                    if (isFormCreate && !oppFormIsCopy) oppCreateNameUserEdited.current = true
                    setOppFormPayload((p) => ({ ...p, name: e.target.value }))
                  }}
                  placeholder="e.g. AAPL Premium Harvest"
                  aria-describedby={isFormCreate && !oppFormIsCopy ? 'opp-name-hint' : undefined}
                />
                {isFormCreate && !oppFormIsCopy && (
                  <p id="opp-name-hint" className="opp-field-hint" style={{ marginTop: 'var(--space-1)' }}>
                    Name fills from symbol scope, structure, and entry conditions; you can edit it anytime.
                  </p>
                )}
              </div>
              <div className="opp-field opp-field--toggle">
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

            {/* ── Structure picker ── */}
            <div className="opp-field">
              <span className="opp-field-label">Structure</span>
              <div className="opp-structure-cards" role="radiogroup" aria-label="Structure (required)" aria-required>
                {structures.length === 0 ? (
                  <p className="opp-field-hint">No structures. Create one in Structure first.</p>
                ) : (
                  structures.map((s) => {
                    const selected = oppFormPayload.strategy_structure_id === s.strategy_structure_id
                    return (
                      <label key={s.strategy_structure_id} className={`opp-structure-card ${selected ? 'opp-structure-card--selected' : ''}`}>
                        <input
                          type="radio"
                          name="opp_structure"
                          value={s.strategy_structure_id}
                          checked={selected}
                          onChange={() => setOppFormPayload((p) => ({ ...p, strategy_structure_id: s.strategy_structure_id }))}
                          aria-label={`Structure: ${s.name}`}
                        />
                        <span className="opp-structure-card-title">{s.name}</span>
                        {(s.version != null && s.version !== '') ||
                        (s.template_display_name != null && s.template_display_name !== '') ||
                        (s.structure_type != null && s.structure_type !== '') ? (
                          <span className="opp-structure-card-meta">
                            {s.version != null && s.version !== '' ? `v${s.version}` : ''}
                            {(s.version != null && s.version !== '') && (s.template_display_name || s.structure_type) ? ' · ' : ''}
                            {getStructureDisplayLabel(s)}
                          </span>
                        ) : null}
                      </label>
                    )
                  })
                )}
              </div>
            </div>

            {/* ── Gate safety picker ── */}
            <div className="opp-field">
              <span className="opp-field-label">Default gate safety</span>
              <div className="opp-gate-pills" role="radiogroup" aria-label="Default gate safety">
                <label className={`opp-gate-pill ${(oppFormPayload.default_gate_safety_strategy_id ?? null) === null ? 'opp-gate-pill--selected' : ''}`}>
                  <input
                    type="radio"
                    name="opp_gate_safety"
                    value=""
                    checked={(oppFormPayload.default_gate_safety_strategy_id ?? null) === null}
                    onChange={() => setOppFormPayload((p) => ({ ...p, default_gate_safety_strategy_id: null }))}
                    aria-label="None"
                  />
                  <span>None</span>
                </label>
                {activeGateSafetySets.map((g) => (
                  <label
                    key={g.gate_safety_strategy_id}
                    className={`opp-gate-pill ${oppFormPayload.default_gate_safety_strategy_id === g.gate_safety_strategy_id ? 'opp-gate-pill--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="opp_gate_safety"
                      value={g.gate_safety_strategy_id}
                      checked={oppFormPayload.default_gate_safety_strategy_id === g.gate_safety_strategy_id}
                      onChange={() => setOppFormPayload((p) => ({ ...p, default_gate_safety_strategy_id: g.gate_safety_strategy_id }))}
                      aria-label={g.name}
                    />
                    <span>{g.name}</span>
                    {g.version != null && g.version !== '' && (
                      <span className="opp-gate-pill-version">v{g.version}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>

            {/* ── Two-column: Scope + Conditions ── */}
            <div className="opp-form-columns">
              {/* Scope column */}
              <div className="opp-form-col">
                <div className="opp-col-header">
                  <h4 className="opp-col-title">Symbol scope</h4>
                </div>
                <div className="opp-col-body">
                  <div className="opp-scope-type-row">
                    <div className="structure-active-filter-pills" role="radiogroup" aria-label="Scope type">
                      {SCOPE_TYPES.map((t) => {
                        const value = t || ''
                        const isActive = (oppFormPayload.scope_type ?? '') === value
                        return (
                          <button
                            key={t || '_none'}
                            type="button"
                            role="radio"
                            aria-checked={isActive}
                            aria-label={getScopeTypeLabel(t)}
                            className={`structure-active-filter-pill ${isActive ? 'active' : ''}`}
                            onClick={() => setOppFormPayload((p) => ({ ...p, scope_type: value || null }))}
                          >
                            {getScopeTypeLabel(t)}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {oppFormPayload.scope_type === 'explicit_symbols' && (
                    <div className="opp-symbols-explicit">
                      <div className="opp-symbol-tags">
                        {oppFormSymbols.map((sym, i) => (
                          <span key={i} className="opp-symbol-tag">
                            <input
                              type="text"
                              className="opp-symbol-tag-input"
                              value={sym}
                              onChange={(e) => updateOppSymbol(i, e.target.value.toUpperCase())}
                              placeholder="SYM"
                            />
                            <button type="button" className="opp-symbol-tag-remove" onClick={() => removeOppSymbol(i)} aria-label={`Remove ${sym || 'symbol'}`}>×</button>
                          </span>
                        ))}
                      </div>
                      <button type="button" className="opp-add-btn" onClick={addOppSymbol}>
                        + Add symbol
                      </button>
                    </div>
                  )}

                  {oppFormPayload.scope_type === 'watchlist_stk' && (
                    <div className="opp-watchlist-stk-list">
                      {watchlistLoading ? (
                        <p className="opp-field-hint">Loading watchlist…</p>
                      ) : watchlistStkSymbols.length === 0 ? (
                        <p className="opp-field-hint">
                          No watchlist stocks with Option? on. Turn Option? on in Watchlist, or use Explicit symbols.
                        </p>
                      ) : (
                        <>
                          <div className="opp-watchlist-stk-actions">
                            <button type="button" className="opp-add-btn" onClick={() => setOppFormSymbols([...watchlistStkSymbols])}>
                              Select all
                            </button>
                            <button type="button" className="opp-add-btn" onClick={() => setOppFormSymbols([])}>
                              Clear
                            </button>
                            <span className="opp-field-hint" style={{ marginLeft: 'auto' }}>
                              {oppFormSymbols.length === 0 ? 'All symbols (empty = all)' : `${oppFormSymbols.length} selected`}
                            </span>
                          </div>
                          <ul className="opp-watchlist-stk-symbols" role="group" aria-label="Select symbols from Watchlist STK">
                            {watchlistStkSymbols.map((sym) => {
                              const checked = oppFormSymbols.includes(sym)
                              return (
                                <li key={sym}>
                                  <label className="opp-watchlist-stk-check">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        setOppFormSymbols((prev) =>
                                          checked ? prev.filter((s) => s !== sym) : [...prev, sym].sort((a, b) => a.localeCompare(b))
                                        )
                                      }}
                                      aria-label={`Include ${sym}`}
                                    />
                                    <span>{sym}</span>
                                  </label>
                                </li>
                              )
                            })}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Conditions column */}
              <div className="opp-form-col">
                <div className="opp-col-header">
                  <h4 className="opp-col-title">Entry conditions</h4>
                </div>
                <div className="opp-col-body">
                  {oppFormEntryConditions.length === 0 && (
                    <p className="opp-field-hint">No entry conditions yet.</p>
                  )}
                  <div className="opp-conditions-list">
                    {oppFormEntryConditions.map((c, i) => (
                      <div key={i} className="opp-condition-row">
                        <select
                          className="opp-condition-select"
                          value={c.condition_type}
                          onChange={(e) => updateOppCondition(i, { condition_type: e.target.value })}
                        >
                          {CONDITION_TYPES.map((t) => (
                            <option key={t} value={t}>{getConditionTypeLabel(t)}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          className="opp-condition-input"
                          value={c.value_text ?? ''}
                          onChange={(e) => updateOppCondition(i, { value_text: e.target.value || null })}
                          placeholder="text"
                        />
                        <input
                          type="number"
                          step="any"
                          className="opp-condition-input opp-condition-input--num"
                          value={c.value_numeric ?? ''}
                          onChange={(e) =>
                            updateOppCondition(i, { value_numeric: e.target.value === '' ? null : parseFloat(e.target.value) })
                          }
                          placeholder="numeric"
                        />
                        <button type="button" className="opp-condition-remove" onClick={() => removeOppCondition(i)} aria-label="Remove condition">×</button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="opp-add-btn" onClick={addOppCondition}>
                    + Add condition
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Form footer ── */}
          <div className="opp-form-footer">
            <button type="button" className="btn-secondary" onClick={closeOppForm}>Cancel</button>
            <button type="button" className="btn-primary" onClick={submitOppForm} disabled={oppFormLoading}>
              {isFormCreate ? 'Create' : 'Save changes'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
