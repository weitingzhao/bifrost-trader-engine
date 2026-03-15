import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchStructures,
  fetchStructure,
  fetchStrategyHistory,
  postActiveStrategy,
  createStructure,
  updateStructure,
  type StrategyStructure,
  type StructurePayload,
  type StructureLeg,
  type StructureConstraint,
  type StructureMetaEntry,
  type StrategyHistoryRow,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  STRUCTURE_TYPES,
  DEFAULT_STRUCTURE_PAYLOAD,
  structureToPayload,
  formatHistoryTs,
  summarizeStateSummary,
} from './strategy/strategyFormUtils'

export interface StrategyStructurePageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  breadcrumbLabel?: string
}

export function StrategyStructurePage({
  status,
  loadStatus,
  breadcrumbLabel = 'Structure',
}: StrategyStructurePageProps) {
  const [structures, setStructures] = useState<StrategyStructure[]>([])
  const [history, setHistory] = useState<StrategyHistoryRow[]>([])
  const [historyStructureFilter, setHistoryStructureFilter] = useState<number | ''>('')
  const [structuresLoading, setStructuresLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [structuresError, setStructuresError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [setActiveMsg, setSetActiveMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [formOpen, setFormOpen] = useState<'create' | number | null>(null)
  const [formPayload, setFormPayload] = useState<StructurePayload>(DEFAULT_STRUCTURE_PAYLOAD)
  const [formLegs, setFormLegs] = useState<StructureLeg[]>([])
  const [formConstraints, setFormConstraints] = useState<StructureConstraint[]>([])
  const [formNotes, setFormNotes] = useState('')
  const [formMeta, setFormMeta] = useState<StructureMetaEntry[]>([])
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formIsCopy, setFormIsCopy] = useState(false)

  const loadStructures = useCallback(() => {
    setStructuresLoading(true)
    setStructuresError(null)
    fetchStructures(false)
      .then((res) => setStructures(res.items ?? []))
      .catch((e) => setStructuresError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStructuresLoading(false))
  }, [])

  useEffect(() => {
    loadStructures()
  }, [loadStructures])

  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    fetchStrategyHistory({
      limit: 100,
      strategy_structure_id: historyStructureFilter === '' ? undefined : historyStructureFilter,
    })
      .then((res) => {
        if (!cancelled) setHistory(res.items ?? [])
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [historyStructureFilter])

  const handleSetActiveStructure = async (structureId: number) => {
    const res = await postActiveStrategy(structureId, status?.active_gate_safety_strategy_id ?? null)
    if (res.ok) {
      setSetActiveMsg({ text: 'Active structure updated. Daemon uses it on next start.', isErr: false })
      loadStatus()
    } else {
      setSetActiveMsg({ text: res.error ?? 'Failed to set active structure', isErr: true })
    }
    setTimeout(() => setSetActiveMsg({ text: '', isErr: false }), 5000)
  }

  const openCreate = () => {
    setFormIsCopy(false)
    setFormPayload({ ...DEFAULT_STRUCTURE_PAYLOAD, name: 'New structure', legs: [] })
    setFormLegs([])
    setFormConstraints([])
    setFormNotes('')
    setFormMeta([])
    setFormError(null)
    setFormOpen('create')
  }

  const openEdit = (id: number) => {
    setFormIsCopy(false)
    setFormLoading(true)
    setFormError(null)
    setFormOpen(id)
    fetchStructure(id)
      .then((row) => {
        const p = structureToPayload(row)
        setFormPayload(p)
        setFormLegs(p.legs)
        setFormConstraints(p.constraints ?? [])
        setFormNotes(p.notes ?? '')
        setFormMeta(p.meta ?? [])
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const openCopy = (id: number) => {
    setFormIsCopy(true)
    setFormLoading(true)
    setFormError(null)
    setFormOpen('create')
    fetchStructure(id)
      .then((row) => {
        const p = structureToPayload(row)
        p.name = `${row.name} (copy)`
        setFormPayload(p)
        setFormLegs(p.legs)
        setFormConstraints(p.constraints ?? [])
        setFormNotes(p.notes ?? '')
        setFormMeta(p.meta ?? [])
      })
      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFormLoading(false))
  }

  const closeForm = () => {
    setFormOpen(null)
    setFormError(null)
  }

  const updateForm = (patch: Partial<StructurePayload>) => {
    setFormPayload((prev) => ({ ...prev, ...patch }))
  }

  const submitForm = async () => {
    const name = (formPayload.name || '').trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    const structure_type = (formPayload.structure_type || '').trim()
    if (!structure_type) {
      setFormError('Structure type is required')
      return
    }
    setFormError(null)
    setFormLoading(true)
    const payload: StructurePayload = {
      name,
      structure_type,
      legs: formLegs,
      constraints: formConstraints.length ? formConstraints : undefined,
      version: formPayload.version ?? 1,
      is_active: formPayload.is_active ?? true,
      notes: formNotes.trim() || undefined,
      meta: formMeta.length ? formMeta : undefined,
    }
    try {
      if (formOpen === 'create') {
        await createStructure(payload)
      } else {
        await updateStructure(formOpen as number, payload)
      }
      closeForm()
      loadStructures()
      loadStatus()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setFormLoading(false)
    }
  }

  const updateLeg = (index: number, patch: Partial<StructureLeg>) => {
    setFormLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)))
  }
  const addLeg = () => {
    setFormLegs((prev) => [...prev, { role: '', direction: '', option_right: 'C', quantity: 1, strike: undefined, expiration: '' }])
  }
  const removeLeg = (index: number) => {
    setFormLegs((prev) => prev.filter((_, i) => i !== index))
  }
  const updateConstraint = (index: number, patch: Partial<StructureConstraint>) => {
    setFormConstraints((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }
  const addConstraint = () => {
    setFormConstraints((prev) => [...prev, { constraint_type: '', constraint_value_text: '', constraint_value_int: undefined }])
  }
  const removeConstraint = (index: number) => {
    setFormConstraints((prev) => prev.filter((_, i) => i !== index))
  }
  const updateMeta = (index: number, patch: Partial<StructureMetaEntry>) => {
    setFormMeta((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }
  const addMeta = () => {
    setFormMeta((prev) => [...prev, { meta_key: '', meta_value_text: '' }])
  }
  const removeMeta = (index: number) => {
    setFormMeta((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="card process-section">
      <h2 id="strategy-structure-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Strategy / {breadcrumbLabel}
        <InfoTooltip text="View and set active strategy structure and gate safety set; daemon uses these on next start." />
      </h2>

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="section-subtitle">Current active</h3>
        <div className="statusSummary">
          <div>
            <strong>Structure:</strong> {status?.active_strategy_structure_name ?? '—'}
            {status?.active_strategy_structure_id != null && ` (${status.active_strategy_structure_id})`}
          </div>
          <div>
            <strong>Gate safety:</strong> {status?.active_gate_safety_strategy_name ?? '—'}
            {status?.active_gate_safety_strategy_id != null && ` (${status.active_gate_safety_strategy_id})`}
          </div>
        </div>
        <p className="section-hint">Daemon uses these on next start.</p>
      </section>

      {setActiveMsg.text && (
        <p className={setActiveMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: 'var(--space-2)' }}>
          {setActiveMsg.text}
        </p>
      )}

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-subtitle" style={{ margin: 0 }}>Structure strategies</h3>
          <button type="button" className="btn-primary" onClick={openCreate}>
            Create structure
          </button>
        </div>
        {structuresLoading && <p className="section-hint">Loading…</p>}
        {structuresError && <p className="msg-error">{structuresError}</p>}
        {!structuresLoading && !structuresError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Version</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {structures.map((row) => (
                  <tr key={row.strategy_structure_id}>
                    <td>{row.name}</td>
                    <td>{row.structure_type ?? '—'}</td>
                    <td>{row.version ?? '—'}</td>
                    <td>{row.is_active ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-manage"
                        onClick={() => openEdit(row.strategy_structure_id)}
                      >
                        Edit
                      </button>
                      {' '}
                      <button
                        type="button"
                        className="btn-set-active"
                        onClick={() => handleSetActiveStructure(row.strategy_structure_id)}
                      >
                        Set active
                      </button>
                      {' '}
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => openCopy(row.strategy_structure_id)}
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!structuresLoading && !structuresError && structures.length === 0 && (
          <p className="section-hint">No structure strategies in database.</p>
        )}
      </section>

      {formOpen !== null && (
        <section className="strategy-section gates-form-section" style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <h3 className="section-subtitle">
            {formOpen === 'create' ? (formIsCopy ? 'New structure (copy)' : 'New structure') : `Edit structure ${formOpen}`}
          </h3>
          {formLoading && !formPayload.name && <p className="section-hint">Loading…</p>}
          {formError && <p className="msg-error">{formError}</p>}

          <div className="gates-form">
            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Metadata</h4>
              <div className="gates-form-row">
                <label>Name</label>
                <input
                  type="text"
                  value={formPayload.name}
                  onChange={(e) => updateForm({ name: e.target.value })}
                  placeholder="Structure name"
                />
              </div>
              <div className="gates-form-row">
                <label>Structure type</label>
                <select
                  value={formPayload.structure_type}
                  onChange={(e) => updateForm({ structure_type: e.target.value })}
                >
                  {STRUCTURE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
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
                <label>
                  <input
                    type="checkbox"
                    checked={formPayload.is_active ?? true}
                    onChange={(e) => updateForm({ is_active: e.target.checked })}
                  />
                  {' '}Active
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Legs</h4>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Direction</th>
                      <th>Right</th>
                      <th>Qty</th>
                      <th>Strike</th>
                      <th>Expiration</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formLegs.map((leg, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="text"
                            value={leg.role ?? ''}
                            onChange={(e) => updateLeg(i, { role: e.target.value })}
                            placeholder="role"
                            style={{ width: '100%', minWidth: '60px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={leg.direction ?? ''}
                            onChange={(e) => updateLeg(i, { direction: e.target.value })}
                            placeholder="long/short"
                            style={{ width: '100%', minWidth: '60px' }}
                          />
                        </td>
                        <td>
                          <select
                            value={leg.option_right ?? 'C'}
                            onChange={(e) => updateLeg(i, { option_right: e.target.value })}
                          >
                            <option value="C">C</option>
                            <option value="P">P</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={leg.quantity ?? 1}
                            onChange={(e) => updateLeg(i, { quantity: parseInt(e.target.value, 10) || 0 })}
                            min={0}
                            style={{ width: '4em' }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            step="0.01"
                            value={leg.strike ?? ''}
                            onChange={(e) => updateLeg(i, { strike: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                            placeholder="—"
                            style={{ width: '5em' }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={leg.expiration ?? ''}
                            onChange={(e) => updateLeg(i, { expiration: e.target.value })}
                            placeholder="YYYYMMDD"
                            style={{ width: '100%', minWidth: '70px' }}
                          />
                        </td>
                        <td>
                          <button type="button" className="btn-secondary" onClick={() => removeLeg(i)}>Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addLeg}>Add leg</button>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Constraints</h4>
              {formConstraints.map((c, i) => (
                <div key={i} className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={c.constraint_type ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_type: e.target.value })}
                    placeholder="constraint_type"
                    style={{ width: '160px' }}
                  />
                  <input
                    type="text"
                    value={c.constraint_value_text ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_value_text: e.target.value })}
                    placeholder="value (text)"
                    style={{ width: '120px' }}
                  />
                  <input
                    type="number"
                    value={c.constraint_value_int ?? ''}
                    onChange={(e) => updateConstraint(i, { constraint_value_int: e.target.value === '' ? undefined : parseInt(e.target.value, 10) })}
                    placeholder="value (int)"
                    style={{ width: '80px' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => removeConstraint(i)}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addConstraint}>Add constraint</button>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Notes</h4>
              <div className="gates-form-row">
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  placeholder="Optional notes"
                  style={{ width: '100%', maxWidth: '600px' }}
                />
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Meta (key-value)</h4>
              {formMeta.map((m, i) => (
                <div key={i} className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={m.meta_key ?? ''}
                    onChange={(e) => updateMeta(i, { meta_key: e.target.value })}
                    placeholder="key"
                    style={{ width: '140px' }}
                  />
                  <input
                    type="text"
                    value={m.meta_value_text ?? ''}
                    onChange={(e) => updateMeta(i, { meta_value_text: e.target.value })}
                    placeholder="value"
                    style={{ width: '180px' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => removeMeta(i)}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={addMeta}>Add meta</button>
            </div>

            <div className="gates-form-actions">
              <button type="button" className="btn-primary" onClick={submitForm} disabled={formLoading}>
                {formOpen === 'create' ? 'Create' : 'Save'}
              </button>
              <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
            </div>
          </div>
        </section>
      )}

      <section className="strategy-section">
        <h3 className="section-subtitle">Strategy history</h3>
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <label htmlFor="strategy-history-filter">Filter by structure: </label>
          <select
            id="strategy-history-filter"
            value={historyStructureFilter}
            onChange={(e) => setHistoryStructureFilter(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">All</option>
            {structures.map((s) => (
              <option key={s.strategy_structure_id} value={s.strategy_structure_id}>
                {s.name} ({s.strategy_structure_id})
              </option>
            ))}
          </select>
        </div>
        {historyLoading && <p className="section-hint">Loading…</p>}
        {historyError && <p className="msg-error">{historyError}</p>}
        {!historyLoading && !historyError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Structure ID</th>
                  <th>State summary</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.strategy_history_id}>
                    <td>{formatHistoryTs(row.ts)}</td>
                    <td>{row.strategy_structure_id}</td>
                    <td title={summarizeStateSummary(row.state_summary)}>
                      {summarizeStateSummary(row.state_summary)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!historyLoading && !historyError && history.length === 0 && (
          <p className="section-hint">No strategy history.</p>
        )}
      </section>
    </div>
  )
}
