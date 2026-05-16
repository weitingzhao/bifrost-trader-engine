import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchOpportunities,
  fetchAllocations,
  fetchAllocation,
  createAllocation,
  updateAllocation,
  fetchGateSafetySets,
  postActiveStrategy,
  type StrategyOpportunity,
  type StrategyAllocation,
  type GateSafetySet,
} from '../api'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { AppSelect } from '../components/AppSelect'

export interface StrategyAllocationPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  breadcrumbLabel?: string
  onNavigateToStrategy?: () => void
}

export function StrategyAllocationPage({
  status,
  loadStatus,
  breadcrumbLabel = 'Allocations',
  onNavigateToStrategy,
}: StrategyAllocationPageProps) {
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [gateSafetySets, setGateSafetySets] = useState<GateSafetySet[]>([])
  const [allocations, setAllocations] = useState<StrategyAllocation[]>([])
  const [_opportunitiesLoading, setOpportunitiesLoading] = useState(true)
  const [allocationsLoading, setAllocationsLoading] = useState(true)
  const [_gateSafetyLoading, setGateSafetyLoading] = useState(true)
  const [_opportunitiesError, setOpportunitiesError] = useState<string | null>(null)
  const [allocationsError, setAllocationsError] = useState<string | null>(null)
  const [_gateSafetyError, setGateSafetyError] = useState<string | null>(null)
  const [setActiveMsg, setSetActiveMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [allocationFormOpen, setAllocationFormOpen] = useState<'create' | number | null>(null)
  const [allocationFormName, setAllocationFormName] = useState('')
  const [allocationFormOpportunityIds, setAllocationFormOpportunityIds] = useState<number[]>([])
  const [allocationFormGateSafetyId, setAllocationFormGateSafetyId] = useState<number | ''>('')
  const [allocationFormMaxPositions, setAllocationFormMaxPositions] = useState<number | ''>('')
  const [allocationFormMaxBpPct, setAllocationFormMaxBpPct] = useState<number | ''>('')
  const [allocationFormActive, setAllocationFormActive] = useState(true)
  const [allocationFormLoading, setAllocationFormLoading] = useState(false)
  const [allocationFormError, setAllocationFormError] = useState<string | null>(null)

  const loadOpportunities = useCallback(() => {
    setOpportunitiesLoading(true)
    setOpportunitiesError(null)
    fetchOpportunities(false)
      .then((res) => setOpportunities(res.items ?? []))
      .catch((e) => setOpportunitiesError(e instanceof Error ? e.message : String(e)))
      .finally(() => setOpportunitiesLoading(false))
  }, [])

  const loadAllocations = useCallback(() => {
    setAllocationsLoading(true)
    setAllocationsError(null)
    fetchAllocations(false)
      .then((res) => setAllocations(res.items ?? []))
      .catch((e) => setAllocationsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAllocationsLoading(false))
  }, [])

  useEffect(() => {
    loadOpportunities()
  }, [loadOpportunities])

  useEffect(() => {
    loadAllocations()
  }, [loadAllocations])

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

  const handleSetActiveAllocation = async (allocationId: number) => {
    const res = await postActiveStrategy(
      status?.strategy?.active?.structure?.id ?? null,
      status?.strategy?.active?.gate_safety?.id ?? null,
      allocationId
    )
    if (res.ok) {
      setSetActiveMsg({ text: 'Active allocation updated. Daemon uses it on next start.', isErr: false })
      loadStatus()
    } else {
      setSetActiveMsg({ text: res.error ?? 'Failed to set active allocation', isErr: true })
    }
    setTimeout(() => setSetActiveMsg({ text: '', isErr: false }), 5000)
  }

  const openAllocationCreate = () => {
    setAllocationFormName('')
    setAllocationFormOpportunityIds([])
    setAllocationFormGateSafetyId('')
    setAllocationFormMaxPositions('')
    setAllocationFormMaxBpPct('')
    setAllocationFormActive(true)
    setAllocationFormError(null)
    setAllocationFormOpen('create')
  }

  const openAllocationEdit = (id: number) => {
    setAllocationFormLoading(true)
    setAllocationFormError(null)
    setAllocationFormOpen(id)
    fetchAllocation(id)
      .then((row) => {
        setAllocationFormName(row.name)
        setAllocationFormOpportunityIds(Array.isArray(row.strategy_opportunity_ids) ? row.strategy_opportunity_ids : [])
        setAllocationFormGateSafetyId(row.gate_safety_strategy_id ?? '')
        const limits = row.allocation_limits as Record<string, unknown> | null | undefined
        const maxPos =
          row.max_positions != null
            ? Number(row.max_positions)
            : limits?.max_positions != null
              ? Number(limits.max_positions)
              : ''
        const maxBp =
          row.max_bp_pct != null
            ? Number(row.max_bp_pct)
            : limits?.max_bp_pct != null
              ? Number(limits.max_bp_pct)
              : ''
        setAllocationFormMaxPositions(maxPos)
        setAllocationFormMaxBpPct(maxBp)
        setAllocationFormActive(row.is_active)
      })
      .catch((e) => setAllocationFormError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAllocationFormLoading(false))
  }

  const closeAllocationForm = () => {
    setAllocationFormOpen(null)
    setAllocationFormError(null)
  }

  const toggleAllocationOpportunity = (opportunityId: number) => {
    setAllocationFormOpportunityIds((prev) =>
      prev.includes(opportunityId) ? prev.filter((id) => id !== opportunityId) : [...prev, opportunityId]
    )
  }

  const submitAllocationForm = async () => {
    const name = allocationFormName.trim()
    if (!name) {
      setAllocationFormError('Name is required')
      return
    }
    setAllocationFormError(null)
    setAllocationFormLoading(true)
    const allocation_limits: Record<string, number> = {}
    if (allocationFormMaxPositions !== '') allocation_limits.max_positions = Number(allocationFormMaxPositions)
    if (allocationFormMaxBpPct !== '') allocation_limits.max_bp_pct = Number(allocationFormMaxBpPct)
    const payload = {
      name,
      strategy_opportunity_ids: allocationFormOpportunityIds,
      gate_safety_strategy_id: allocationFormGateSafetyId === '' ? null : allocationFormGateSafetyId,
      allocation_limits: Object.keys(allocation_limits).length > 0 ? allocation_limits : undefined,
      is_active: allocationFormActive,
    }
    try {
      if (allocationFormOpen === 'create') {
        await createAllocation(payload)
      } else {
        await updateAllocation(allocationFormOpen as number, payload)
      }
      closeAllocationForm()
      loadAllocations()
      loadStatus()
    } catch (e) {
      setAllocationFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setAllocationFormLoading(false)
    }
  }

  return (
    <div className="card process-section">
      <SectionPageTitle
        id="strategy-allocation-head"
        menu="Strategy"
        pageTitle={breadcrumbLabel}
        onMenuClick={onNavigateToStrategy}
        menuNavigateAriaLabel="Strategy home"
        infoText="Combine multiple opportunity strategies into an allocation; optional gate safety and limits."
        style={{ marginBottom: 'var(--space-2)' }}
      />

      <section className="strategy-section" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="section-subtitle">Current active</h3>
        <div className="statusSummary">
          <div>
            <strong>Allocation:</strong> {status?.strategy?.active?.allocation?.name ?? '—'}
            {status?.strategy?.active?.allocation?.id != null && ` (${status?.strategy?.active?.allocation?.id})`}
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
          <h3 className="section-subtitle" style={{ margin: 0 }}>Allocations</h3>
          <button type="button" className="btn-primary" onClick={openAllocationCreate}>
            Create allocation
          </button>
        </div>
        {allocationsLoading && <p className="section-hint">Loading…</p>}
        {allocationsError && <p className="msg-error">{allocationsError}</p>}
        {!allocationsLoading && !allocationsError && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Opportunities</th>
                  <th>Gate safety</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((row) => (
                  <tr key={row.strategy_allocation_id}>
                    <td>{row.name}</td>
                    <td>
                      {Array.isArray(row.strategy_opportunity_ids)
                        ? row.strategy_opportunity_ids.length === 0
                          ? '—'
                          : row.strategy_opportunity_ids.join(', ')
                        : '—'}
                    </td>
                    <td>{row.gate_safety_name ?? row.gate_safety_strategy_id ?? '—'}</td>
                    <td>{row.is_active ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-manage"
                        onClick={() => openAllocationEdit(row.strategy_allocation_id)}
                      >
                        Edit
                      </button>
                      {' '}
                      <button
                        type="button"
                        className="btn-set-active"
                        onClick={() => handleSetActiveAllocation(row.strategy_allocation_id)}
                      >
                        Set active
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!allocationsLoading && !allocationsError && allocations.length === 0 && (
          <p className="section-hint">No allocations in database.</p>
        )}
      </section>

      {allocationFormOpen !== null && (
        <section className="strategy-section gates-form-section" style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--color-surface-elevated)', borderRadius: '8px' }}>
          <h3 className="section-subtitle">
            {allocationFormOpen === 'create' ? 'New allocation' : `Edit allocation ${allocationFormOpen}`}
          </h3>
          {allocationFormLoading && !allocationFormName && <p className="section-hint">Loading…</p>}
          {allocationFormError && <p className="msg-error">{allocationFormError}</p>}

          <div className="gates-form">
            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Metadata</h4>
              <div className="gates-form-row">
                <label>Name</label>
                <input
                  type="text"
                  value={allocationFormName}
                  onChange={(e) => setAllocationFormName(e.target.value)}
                  placeholder="Allocation name"
                />
              </div>
              <div className="gates-form-row">
                <label>
                  <input
                    type="checkbox"
                    checked={allocationFormActive}
                    onChange={(e) => setAllocationFormActive(e.target.checked)}
                  />
                  {' '}Active
                </label>
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Opportunities</h4>
              <p className="section-hint">Select one or more opportunity strategies to include in this allocation.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', maxHeight: '200px', overflowY: 'auto' }}>
                {opportunities.map((opp) => (
                  <label key={opp.strategy_opportunity_id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <input
                      type="checkbox"
                      checked={allocationFormOpportunityIds.includes(opp.strategy_opportunity_id)}
                      onChange={() => toggleAllocationOpportunity(opp.strategy_opportunity_id)}
                    />
                    <span>{opp.name} (ID {opp.strategy_opportunity_id})</span>
                  </label>
                ))}
              </div>
              {opportunities.length === 0 && (
                <p className="section-hint">No opportunity strategies. Create opportunities first.</p>
              )}
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Gate safety</h4>
              <div className="gates-form-row">
                <label>Default gate safety set</label>
                <AppSelect
                  value={allocationFormGateSafetyId === '' ? '' : String(allocationFormGateSafetyId)}
                  onChange={(v) => setAllocationFormGateSafetyId(v === '' ? '' : Number(v))}
                  placeholder="— None"
                  options={gateSafetySets.map((g) => ({ value: String(g.gate_safety_strategy_id), label: `${g.name} (${g.gate_safety_strategy_id})` }))}
                />
              </div>
            </div>

            <div className="gates-form-group">
              <h4 className="gates-form-group-title">Allocation limits (optional)</h4>
              <div className="gates-form-row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
                <label>Max positions</label>
                <input
                  type="number"
                  min={0}
                  value={allocationFormMaxPositions === '' ? '' : allocationFormMaxPositions}
                  onChange={(e) =>
                    setAllocationFormMaxPositions(e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0)
                  }
                  placeholder="—"
                  style={{ width: '100px' }}
                />
                <label>Max BP %</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={allocationFormMaxBpPct === '' ? '' : allocationFormMaxBpPct}
                  onChange={(e) =>
                    setAllocationFormMaxBpPct(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)
                  }
                  placeholder="—"
                  style={{ width: '100px' }}
                />
              </div>
            </div>

            <div className="gates-form-actions">
              <button type="button" className="btn-primary" onClick={submitAllocationForm} disabled={allocationFormLoading}>
                {allocationFormOpen === 'create' ? 'Create' : 'Save'}
              </button>
              <button type="button" className="btn-secondary" onClick={closeAllocationForm}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
