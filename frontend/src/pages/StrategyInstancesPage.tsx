import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import type { StrategyInstance } from '../types'
import type { StrategyOpportunity } from '../api'
import {
  fetchStrategyInstances,
  fetchOpportunities,
  createStrategyInstance,
} from '../api'
import { StrategyInstanceDetailPage } from './StrategyInstanceDetailPage'
import { fmtTsShort, fmtDate } from '../utils/format'

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
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createOpportunityId, setCreateOpportunityId] = useState<number | ''>('')
  const [createAccountId, setCreateAccountId] = useState('')
  const [createOpenedAt, setCreateOpenedAt] = useState('')
  const [createLabel, setCreateLabel] = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  /** Detail view is shown when URL has an instance id or user picked one in-page (e.g. after create). */
  const effectiveDetailId = urlStrategyInstanceId ?? selectedInstanceId

  const accounts = status?.accounts ?? []

  /** Event Account options for Create instance: Host and Secondary from Settings → IB Connection. */
  const eventAccounts = (() => {
    const cfg = status?.ib_config
    if (!cfg) return []
    const list: { account_id: string; label: string }[] = []
    const host = (cfg.stream_host_account_id ?? '').toString().trim()
    if (host) list.push({ account_id: host, label: 'Host' })
    const secondary = (cfg.stream_secondary_account_id ?? '').toString().trim()
    if (secondary) list.push({ account_id: secondary, label: 'Secondary' })
    return list
  })()

  const loadOpportunities = useCallback(() => {
    fetchOpportunities(false)
      .then((r) => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])

  useEffect(() => {
    loadOpportunities()
  }, [loadOpportunities])

  const loadInstances = useCallback(() => {
    setLoading(true)
    setError(null)
    const params: { account_id?: string; strategy_opportunity_id?: number } = {}
    if (accountIdFilter.trim()) params.account_id = accountIdFilter.trim()
    if (opportunityIdFilter !== '' && Number.isFinite(Number(opportunityIdFilter))) {
      params.strategy_opportunity_id = Number(opportunityIdFilter)
    }
    fetchStrategyInstances(params)
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [accountIdFilter, opportunityIdFilter])

  useEffect(() => {
    loadInstances()
  }, [loadInstances])

  const goBackToList = useCallback(() => {
    setSelectedInstanceId(null)
    window.location.hash = '#/strategies/instances'
  }, [])

  if (effectiveDetailId != null) {
    return (
      <StrategyInstanceDetailPage
        strategyInstanceId={effectiveDetailId}
        onBackToList={goBackToList}
        onNavigateToStrategy={onNavigateToStrategy}
        breadcrumbLabel={breadcrumbLabel}
      />
    )
  }

  const openCreateModal = () => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    setCreateOpenedAt(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    setCreateOpportunityId('')
    const hostId = (status?.ib_config?.stream_host_account_id ?? '').toString().trim()
    setCreateAccountId(hostId)
    setCreateLabel('')
    setCreateNotes('')
    setCreateError(null)
    setCreateModalOpen(true)
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
      </div>

      {error != null && (
        <p className="error-message" style={{ marginTop: '0.5rem' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ marginTop: '1rem' }}>Loading…</p>
      ) : (
        <div className="table-wrapper" style={{ overflowX: 'auto', marginTop: '1rem' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Opportunity</th>
                <th>Account</th>
                <th>Opened at</th>
                <th>Created at</th>
                <th>Executions count</th>
                <th>Label</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8}>No strategy instances found.</td>
                </tr>
              ) : (
                items.map((row) => (
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
                    <td>{row.label ?? '—'}</td>
                    <td>
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
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
