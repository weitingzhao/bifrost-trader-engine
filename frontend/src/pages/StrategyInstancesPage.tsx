import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IbPositionRow, StatusResponse } from '../types'
import type { StrategyInstance } from '../types'
import type { StrategyOpportunity, StrategyStructure } from '../api'
import {
  fetchStrategyInstances,
  fetchOpportunities,
  fetchStructures,
  createStrategyInstance,
  deleteStrategyInstance,
} from '../api'
import { StrategyInstanceDetailPage } from './StrategyInstanceDetailPage'
import { fmtTsShort, fmtDate, parseOptionContractKey } from '../utils/format'
import { computeRiskProfile, formatRiskLabel } from '../utils/riskProfile'
import type { RiskProfile, RiskPosition } from '../utils/riskProfile'

export interface StrategyInstancesPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  /** Instance id from URL hash #/strategies/instances/:id; when set, detail view is shown. */
  urlStrategyInstanceId?: number | null
  onNavigateToStrategy?: () => void
  breadcrumbLabel?: string
}

export function StrategyInstancesPage({
  status,
  loadStatus: _loadStatus,
  urlStrategyInstanceId = null,
  onNavigateToStrategy,
  breadcrumbLabel = 'Instances',
}: StrategyInstancesPageProps) {
  const [items, setItems] = useState<StrategyInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [accountIdFilter, setAccountIdFilter] = useState<string>('')
  const [opportunityIdFilter, setOpportunityIdFilter] = useState<number | ''>('')
  const [instanceIdFilter, setInstanceIdFilter] = useState('')
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createOpportunityId, setCreateOpportunityId] = useState<number | ''>('')
  const [createAccountId, setCreateAccountId] = useState('')
  const [createOpenedAt, setCreateOpenedAt] = useState('')
  const [createLabel, setCreateLabel] = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; instanceId: number | null; label: string; deleting: boolean; error: string | null }>({
    open: false, instanceId: null, label: '', deleting: false, error: null,
  })
  /** Symbol group key → collapsed (rows hidden). Default expanded when key absent. */
  const [collapsedSymbolGroups, setCollapsedSymbolGroups] = useState<Record<string, boolean>>({})
  /** Accordion: only one symbol group expanded at a time. Multi: several may stay open (same as Portfolio Open → Detail view). */
  const [symbolGroupAccordionMode, setSymbolGroupAccordionMode] = useState<boolean>(true)

  /** Detail view is shown when URL has an instance id or user picked one in-page (e.g. after create). */
  const effectiveDetailId = urlStrategyInstanceId ?? selectedInstanceId

  const accounts = status?.portfolio?.accounts ?? []

  /** Event Account options for Create instance: Host and Secondary from Settings → IB Connection. */
  const eventAccounts = (() => {
    const cfg = status?.config?.ib_client
    if (!cfg) return []
    const list: { account_id: string; label: string }[] = []
    const host = (cfg.account?.event_host ?? '').toString().trim()
    if (host) list.push({ account_id: host, label: 'Host' })
    const secondary = (cfg.account?.event_secondary ?? '').toString().trim()
    if (secondary) list.push({ account_id: secondary, label: 'Secondary' })
    return list
  })()

  const [structures, setStructures] = useState<StrategyStructure[]>([])

  const loadOpportunities = useCallback(() => {
    fetchOpportunities(false)
      .then((r) => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])

  useEffect(() => {
    loadOpportunities()
    fetchStructures(false).then(r => setStructures(r.items ?? [])).catch(() => {})
  }, [loadOpportunities])

  const loadInstances = useCallback(() => {
    setLoading(true)
    setError(null)
    const params: { account_id?: string; strategy_opportunity_id?: number; strategy_instance_ids?: number[] } = {}
    if (accountIdFilter.trim()) params.account_id = accountIdFilter.trim()
    if (opportunityIdFilter !== '' && Number.isFinite(Number(opportunityIdFilter))) {
      params.strategy_opportunity_id = Number(opportunityIdFilter)
    }
    const instanceIds: number[] = []
    const seen = new Set<number>()
    for (const part of instanceIdFilter.split(',')) {
      const p = part.trim()
      if (!p) continue
      const n = Number(p)
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) continue
      const id = Math.floor(n)
      if (seen.has(id)) continue
      seen.add(id)
      instanceIds.push(id)
    }
    if (instanceIds.length > 0) params.strategy_instance_ids = instanceIds
    fetchStrategyInstances(params)
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [accountIdFilter, opportunityIdFilter, instanceIdFilter])

  useEffect(() => {
    loadInstances()
  }, [loadInstances])

  const opportunitiesById = useMemo(() => {
    const m = new Map<number, StrategyOpportunity>()
    for (const o of opportunities) {
      m.set(o.strategy_opportunity_id, o)
    }
    return m
  }, [opportunities])

  const structuresById = useMemo(() => {
    const m = new Map<number, StrategyStructure>()
    for (const s of structures) m.set(s.strategy_structure_id, s)
    return m
  }, [structures])

  const instanceRiskMap = useMemo(() => {
    const map = new Map<number, RiskProfile>()
    type OptRow = IbPositionRow & { account_id: string }
    const allPositions: OptRow[] = []
    for (const acc of status?.portfolio?.accounts ?? []) {
      const aid = (acc.account_id ?? '').trim()
      for (const p of acc.positions ?? []) {
        if ((p.secType ?? '').toUpperCase() !== 'OPT' || !(p.strategy_links ?? []).length) continue
        allPositions.push({ ...p, account_id: aid })
      }
    }
    const byInstance = new Map<number, OptRow[]>()
    for (const pos of allPositions) {
      for (const link of pos.strategy_links ?? []) {
        const instId = link.strategy_instance_id
        if (instId == null || !Number.isFinite(instId)) continue
        const arr = byInstance.get(instId)
        if (arr) arr.push(pos)
        else byInstance.set(instId, [pos])
      }
    }
    const pickWorse = (a: RiskProfile, b: RiskProfile) => {
      if (a.naked_short_call_contracts !== b.naked_short_call_contracts) {
        return a.naked_short_call_contracts > b.naked_short_call_contracts ? a : b
      }
      if (a.max_loss == null && b.max_loss != null) return a
      if (a.max_loss != null && b.max_loss == null) return b
      if (a.max_loss != null && b.max_loss != null && a.max_loss !== b.max_loss) {
        return a.max_loss < b.max_loss ? a : b
      }
      return a
    }
    for (const [instId, opts] of byInstance) {
      const inst = items.find(i => i.strategy_instance_id === instId)
      if (!inst) continue
      const opp = opportunitiesById.get(inst.strategy_opportunity_id)
      const str = opp ? structuresById.get(opp.strategy_structure_id) : undefined
      const hasUnderlying = str?.legs?.some(l => (l.role ?? '').toLowerCase() === 'underlying')
      const byAcct = new Map<string, OptRow[]>()
      for (const p of opts) {
        const aid = p.account_id
        if (!byAcct.has(aid)) byAcct.set(aid, [])
        byAcct.get(aid)!.push(p)
      }
      let merged: RiskProfile | null = null
      for (const [acct, optsA] of byAcct) {
        const riskPos: RiskPosition[] = []
        for (const p of optsA) {
          const parsed = parseOptionContractKey(p.contract_key)
          const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
          const strike = Number(p.strike) || 0
          const avgRaw = p.avgCost != null ? Number(p.avgCost) : null
          const avgCost = avgRaw != null && avgRaw >= 10 ? avgRaw / 100 : avgRaw
          const qty = Number(p.position) || 0
          if (r && avgCost != null && strike > 0 && qty !== 0) {
            riskPos.push({ strike, right: r, qty, avg_cost: avgCost })
          }
        }
        if (riskPos.length === 0) continue
        let covShares = 0
        let covAvgCost: number | null = null
        if (hasUnderlying) {
          const sym = (optsA[0]?.symbol ?? '').toUpperCase()
          if (sym) {
            const accRow = (status?.portfolio?.accounts ?? []).find(a => (a.account_id ?? '').trim() === acct)
            const held = accRow?.positions?.find(
              s => (s.secType ?? '').toUpperCase() !== 'OPT' && (s.symbol ?? '').toUpperCase() === sym,
            )
            if (held) {
              covShares = Math.abs(Number(held.position) || 0)
              covAvgCost = held.avgCost != null ? Number(held.avgCost) : null
            }
          }
        }
        const rp = computeRiskProfile(riskPos, covShares, covAvgCost)
        merged = merged == null ? rp : pickWorse(merged, rp)
      }
      if (merged != null) map.set(instId, merged)
    }
    return map
  }, [status?.portfolio?.accounts, items, opportunitiesById, structuresById])

  const groupedItems = useMemo(() => {
    const groups: Array<{ key: string; label: string; rows: StrategyInstance[] }> = []
    const groupIndexByKey = new Map<string, number>()
    const getScopeSymbol = (row: StrategyInstance): string => {
      const opp = opportunitiesById.get(row.strategy_opportunity_id)
      if (opp == null) return '—'
      const scopeType = (opp.scope_type ?? '').trim()
      if (scopeType !== 'explicit_symbols' && scopeType !== 'watchlist_stk') return '—'
      const symbols = (opp.symbols ?? [])
        .map((s) => String(s ?? '').trim().toUpperCase())
        .filter((s) => s.length > 0)
      if (symbols.length === 0) return '—'
      return symbols[0]
    }
    for (const row of items) {
      const symbolKey = getScopeSymbol(row)
      const idx = groupIndexByKey.get(symbolKey)
      if (idx == null) {
        groupIndexByKey.set(symbolKey, groups.length)
        groups.push({ key: symbolKey, label: symbolKey, rows: [row] })
      } else {
        groups[idx].rows.push(row)
      }
    }
    return groups
  }, [items, opportunitiesById])

  const toggleSymbolGroup = useCallback((key: string) => {
    setCollapsedSymbolGroups((prev) => {
      const wasCollapsed = Boolean(prev[key])
      if (symbolGroupAccordionMode) {
        if (wasCollapsed) {
          const next: Record<string, boolean> = {}
          for (const g of groupedItems) next[g.key] = true
          delete next[key]
          return next
        }
        return { ...prev, [key]: true }
      }
      return { ...prev, [key]: !prev[key] }
    })
  }, [symbolGroupAccordionMode, groupedItems])

  const expandAllSymbolGroups = useCallback(() => {
    if (symbolGroupAccordionMode && groupedItems.length > 0) {
      const next: Record<string, boolean> = {}
      for (const g of groupedItems) next[g.key] = true
      delete next[groupedItems[0].key]
      setCollapsedSymbolGroups(next)
    } else {
      setCollapsedSymbolGroups({})
    }
  }, [symbolGroupAccordionMode, groupedItems])

  const collapseAllSymbolGroups = useCallback(() => {
    setCollapsedSymbolGroups((prev) => {
      const next = { ...prev }
      for (const g of groupedItems) next[g.key] = true
      return next
    })
  }, [groupedItems])

  const openDeleteConfirm = useCallback((row: StrategyInstance) => {
    const displayLabel = row.label ?? row.strategy_opportunity_name ?? `#${row.strategy_instance_id}`
    setConfirmDelete({ open: true, instanceId: row.strategy_instance_id, label: displayLabel, deleting: false, error: null })
  }, [])

  const instanceListTableBody = useMemo(() => {
    if (items.length === 0) {
      return (
        <tr>
          <td colSpan={11}>No strategy instances found.</td>
        </tr>
      )
    }
    return (
      <>
        {groupedItems.flatMap((group) => {
          const collapsed = Boolean(collapsedSymbolGroups[group.key])
          const headerRow = (
            <tr key={`group-${group.key}`} className="strategy-instance-symbol-group-row">
              <td
                colSpan={11}
                style={{
                  fontWeight: 600,
                  background: 'var(--color-surface-elevated, rgba(255,255,255,0.03))',
                  padding: 0,
                }}
              >
                <button
                  type="button"
                  className="strategy-instance-symbol-group-toggle"
                  onClick={() => toggleSymbolGroup(group.key)}
                  aria-expanded={!collapsed}
                  id={`symbol-group-head-${group.key}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <span className={`replay-opt-expand-icon ${collapsed ? '' : 'expanded'}`} aria-hidden>
                    {collapsed ? '▶' : '▼'}
                  </span>
                  <span>
                    Symbol group: {group.label}
                    <span className="replay-muted" style={{ fontWeight: 400, marginLeft: '0.35rem' }}>
                      ({group.rows.length} instance{group.rows.length !== 1 ? 's' : ''})
                    </span>
                  </span>
                </button>
              </td>
            </tr>
          )
          if (collapsed) return [headerRow]
          const dataRows = group.rows.map((row) => {
            const rp = instanceRiskMap.get(row.strategy_instance_id)
            const riskCells = !rp ? (
              <><td className="replay-muted">—</td><td className="replay-muted">—</td><td className="replay-muted">—</td></>
            ) : (() => {
              const rl = formatRiskLabel(rp)
              return <>
                <td><span className="risk-value-gain">{rl.gainLabel}</span></td>
                <td><span className={rp.max_loss == null ? 'risk-value-loss risk-value-unlimited' : 'risk-value-loss'}>{rl.lossLabel}</span></td>
                <td><span className={`coverage-status-badge ${rp.risk_type === 'defined' ? 'risk-badge-defined' : 'risk-badge-unlimited'}`}>{rl.riskBadge}</span></td>
              </>
            })()
            return (
              <tr key={row.strategy_instance_id}>
                <td>{row.strategy_instance_id}</td>
                <td>{row.strategy_opportunity_name ?? row.strategy_opportunity_id ?? '—'}</td>
                <td>{row.account_id}</td>
                <td>
                  {row.opened_at_epoch != null
                    ? fmtDate(row.opened_at_epoch)
                    : row.opened_at && row.opened_at.length >= 10
                      ? row.opened_at.slice(0, 10)
                      : row.opened_at ?? '—'}
                </td>
                <td>
                  {row.created_at_epoch != null
                    ? fmtTsShort(row.created_at_epoch)
                    : row.created_at ?? '—'}
                </td>
                <td>{row.executions_count != null ? row.executions_count : '—'}</td>
                {riskCells}
                <td>{row.label ?? '—'}</td>
                <td style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <a
                    href={`#/strategies/instances/${row.strategy_instance_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-icon-small"
                    title="View instance"
                    aria-label="View instance"
                  >
                    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </a>
                  <button
                    type="button"
                    className="btn btn-icon-small btn-icon-danger"
                    title="Delete instance"
                    aria-label="Delete instance"
                    onClick={() => openDeleteConfirm(row)}
                  >
                    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4h6v2" />
                    </svg>
                  </button>
                </td>
              </tr>
            )
          })
          return [headerRow, ...dataRows]
        })}
      </>
    )
  }, [items, groupedItems, collapsedSymbolGroups, instanceRiskMap, toggleSymbolGroup, openDeleteConfirm])

  if (effectiveDetailId != null) {
    return (
      <StrategyInstanceDetailPage
        strategyInstanceId={effectiveDetailId}
        status={status}
      />
    )
  }

  const openCreateModal = () => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setCreateOpenedAt(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    setCreateOpportunityId('')
    const hostId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
    setCreateAccountId(hostId)
    setCreateLabel('')
    setCreateNotes('')
    setCreateError(null)
    setCreateModalOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (confirmDelete.instanceId == null) return
    setConfirmDelete((s) => ({ ...s, deleting: true, error: null }))
    try {
      await deleteStrategyInstance(confirmDelete.instanceId)
      setConfirmDelete({ open: false, instanceId: null, label: '', deleting: false, error: null })
      loadInstances()
    } catch (err) {
      setConfirmDelete((s) => ({ ...s, deleting: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError(null)
    const oppId = createOpportunityId === '' ? null : Number(createOpportunityId)
    const accountId = createAccountId.trim()
    if (oppId == null || !Number.isFinite(oppId) || !accountId) {
      setCreateError('Opportunity and Account are required.')
      return
    }
    const dateStr = createOpenedAt.trim()
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      setCreateError('Opened at (date) is required.')
      return
    }
    const openedAtIso = `${dateStr}T12:00:00.000Z`
    setCreateLoading(true)
    try {
      const res = await createStrategyInstance({
        strategy_opportunity_id: oppId,
        account_id: accountId,
        opened_at: openedAtIso,
        label: createLabel.trim() || undefined,
        notes: createNotes.trim() || undefined,
      })
      setCreateModalOpen(false)
      loadInstances()
      setSelectedInstanceId(res.strategy_instance_id)
      window.location.hash = `#/strategies/instances/${res.strategy_instance_id}`
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateLoading(false)
    }
  }

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={onNavigateToStrategy}
          >
            Strategy
          </button>
          {' / '}
          {breadcrumbLabel}
        </h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={openCreateModal}
          aria-label="Create strategy instance"
        >
          Create instance
        </button>
      </div>

      <div className="filter-row" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
        <label>
          <span className="filter-label">Account</span>
          <select
            value={accountIdFilter}
            onChange={(e) => setAccountIdFilter(e.target.value)}
            aria-label="Filter by account"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.account_id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Opportunity</span>
          <select
            value={opportunityIdFilter === '' ? '' : String(opportunityIdFilter)}
            onChange={(e) => setOpportunityIdFilter(e.target.value === '' ? '' : Number(e.target.value))}
            aria-label="Filter by opportunity"
          >
            <option value="">All opportunities</option>
            {opportunities.map((o) => (
              <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                {o.name ?? `ID ${o.strategy_opportunity_id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Instance</span>
          <input
            type="text"
            inputMode="numeric"
            value={instanceIdFilter}
            onChange={(e) => setInstanceIdFilter(e.target.value)}
            placeholder="e.g. 1, 2, 3"
            title="Comma-separated instance IDs"
            aria-label="Filter by instance IDs (comma-separated)"
            style={{ minWidth: '11rem' }}
          />
        </label>
      </div>

      {error != null && (
        <p className="error-message" style={{ marginTop: '0.5rem' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ marginTop: '1rem' }}>Loading…</p>
      ) : (
        <div className="table-wrapper" style={{ overflowX: 'auto', marginTop: '1rem' }}>
          {items.length > 0 && groupedItems.length > 0 && (
            <div className="instance-list-symbol-toolbar">
              <div className="instance-sheet-filter-bubble-row">
                <span className="instance-sheet-filter-bubble-label" id="instance-list-detail-view-label">
                  Detail view
                </span>
                <div
                  className="replay-bubble-switch"
                  role="radiogroup"
                  aria-labelledby="instance-list-detail-view-label"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={symbolGroupAccordionMode}
                    className={`replay-bubble-switch-btn ${symbolGroupAccordionMode ? 'active' : ''}`}
                    onClick={() => setSymbolGroupAccordionMode(true)}
                  >
                    Accordion
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!symbolGroupAccordionMode}
                    className={`replay-bubble-switch-btn ${!symbolGroupAccordionMode ? 'active' : ''}`}
                    onClick={() => setSymbolGroupAccordionMode(false)}
                  >
                    Multi
                  </button>
                </div>
              </div>
              <div className="instance-sheet-filter-bubble-row">
                <span className="instance-sheet-filter-bubble-label" id="instance-list-symbol-groups-label">
                  Symbol groups
                </span>
                <div
                  className="replay-bubble-switch"
                  role="group"
                  aria-labelledby="instance-list-symbol-groups-label"
                >
                  <button
                    type="button"
                    className="replay-bubble-switch-btn"
                    onClick={expandAllSymbolGroups}
                    aria-label="Expand all symbol groups"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className="replay-bubble-switch-btn"
                    onClick={collapseAllSymbolGroups}
                    aria-label="Collapse all symbol groups"
                  >
                    Collapse all
                  </button>
                </div>
              </div>
              <p className="section-hint instance-list-symbol-toolbar-hint">
                {symbolGroupAccordionMode
                  ? 'Accordion: only one symbol group expanded at a time. Expand all keeps the first group open.'
                  : 'Multi: several symbol groups may stay expanded.'}
              </p>
            </div>
          )}
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Opportunity</th>
                <th>Account</th>
                <th>Opened at</th>
                <th>Created at</th>
                <th>Executions count</th>
                <th>Max Gain</th>
                <th>Max Loss</th>
                <th>Risk</th>
                <th>Label</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {instanceListTableBody}
            </tbody>
          </table>
        </div>
      )}

      {confirmDelete.open && (
        <div
          className="modal-overlay"
          onClick={() => { if (!confirmDelete.deleting) setConfirmDelete((s) => ({ ...s, open: false })) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-instance-modal-title"
        >
          <div className="modal-panel" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 id="delete-instance-modal-title" style={{ marginTop: 0 }}>Delete instance</h3>
            <p style={{ margin: '0.5rem 0 1rem' }}>
              Delete instance <strong>{confirmDelete.label}</strong>? This cannot be undone.
              It will fail if any executions are linked to this instance.
            </p>
            {confirmDelete.error != null && (
              <p className="section-hint replay-form-error" style={{ marginBottom: '0.75rem' }}>{confirmDelete.error}</p>
            )}
            <div className="replay-exec-form-actions" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDelete((s) => ({ ...s, open: false }))}
                disabled={confirmDelete.deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteConfirm}
                disabled={confirmDelete.deleting}
              >
                {confirmDelete.deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {createModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => { setCreateModalOpen(false); setCreateError(null) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-instance-modal-title"
        >
          <div className="modal-panel replay-exec-modal create-instance-modal" onClick={e => e.stopPropagation()}>
            <h3 id="create-instance-modal-title" className="create-instance-modal-title">Create strategy instance</h3>
            {createError != null && (
              <p className="section-hint replay-form-error create-instance-modal-error">{createError}</p>
            )}
            <form className="replay-exec-form create-instance-form" onSubmit={handleCreateSubmit}>
              <section className="create-instance-section">
                <div className="replay-exec-form-row">
                  <label>Opportunity</label>
                  <select
                    value={createOpportunityId === '' ? '' : String(createOpportunityId)}
                    onChange={e => setCreateOpportunityId(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                    aria-required="true"
                    className="create-instance-input"
                  >
                    <option value="">— Select opportunity —</option>
                    {opportunities.map(o => (
                      <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                        {o.name ?? `#${o.strategy_opportunity_id}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="replay-exec-form-row create-instance-account-row">
                  <label>Account</label>
                  <div className="create-instance-account-wrap">
                    {eventAccounts.length === 0 ? (
                      <p className="create-instance-account-empty">
                        Configure Event Account in Settings → IB Connection
                      </p>
                    ) : (
                      <div className="structure-active-filter-pills" role="radiogroup" aria-label="Event Account" aria-required="true">
                        {eventAccounts.map(({ account_id }) => (
                          <button
                            key={account_id}
                            type="button"
                            role="radio"
                            aria-checked={createAccountId === account_id}
                            className={`structure-active-filter-pill ${createAccountId === account_id ? 'active' : ''}`}
                            onClick={() => setCreateAccountId(account_id)}
                          >
                            {account_id}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="replay-exec-form-row">
                  <label>Opened at</label>
                  <input
                    type="date"
                    value={createOpenedAt}
                    onChange={e => setCreateOpenedAt(e.target.value)}
                    required
                    aria-required="true"
                    className="create-instance-input"
                  />
                </div>
              </section>
              <section className="create-instance-section create-instance-section-optional">
                <div className="replay-exec-form-row">
                  <label>Label (optional)</label>
                  <input
                    type="text"
                    value={createLabel}
                    onChange={e => setCreateLabel(e.target.value)}
                    placeholder="e.g. Straddle 2025-03"
                    className="create-instance-input"
                  />
                </div>
                <div className="replay-exec-form-row">
                  <label>Notes (optional)</label>
                  <input
                    type="text"
                    value={createNotes}
                    onChange={e => setCreateNotes(e.target.value)}
                    placeholder="Optional notes"
                    className="create-instance-input"
                  />
                </div>
              </section>
              <div className="replay-exec-form-actions create-instance-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setCreateModalOpen(false); setCreateError(null) }}
                  disabled={createLoading}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={createLoading || eventAccounts.length === 0}>
                  {createLoading ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
