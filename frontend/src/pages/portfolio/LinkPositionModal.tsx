import { useEffect, useRef, useState } from 'react'
import type { StrategyOpportunity } from '../../api'
import type { StrategyInstance } from '../../types'
import { createStrategyInstance, fetchOpportunities, fetchStrategyInstances, patchExecutionStrategyAttribution } from '../../api'
import { fmtUsd } from '../../utils/format'

export interface LinkPositionContext {
  account_id: string
  contract_key: string
  symbol?: string
  /** Current values for prefill */
  strategy_opportunity_id?: number | null
  strategy_instance_id?: number | null
  /** For summary display */
  position?: number
  avgCost?: number | null
  price?: number | null
}

interface LinkPositionModalProps {
  open: boolean
  context: LinkPositionContext | null
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

/** e.g. Mar 18, 2026 — for strategy instance dropdown (#id + opened_at). */
function formatInstanceOpenedDate(si: StrategyInstance): string {
  let ms: number | null = null
  if (si.opened_at_epoch != null && Number.isFinite(si.opened_at_epoch)) {
    ms = si.opened_at_epoch * 1000
  } else if (si.opened_at?.trim()) {
    const t = Date.parse(si.opened_at)
    if (!Number.isNaN(t)) ms = t
  }
  const id = si.strategy_instance_id
  const dateStr =
    ms != null
      ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : ''
  const num = `#${id}`
  const label = si.label?.trim()
  if (dateStr) {
    if (label) return `${label} · ${num} ${dateStr}`
    return `${num} ${dateStr}`
  }
  return label ? `${label} · ${num}` : num
}

function todayDateStr(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Filter opportunities by symbol using scope_type logic. */
function filterOpportunitiesBySymbol(
  opps: StrategyOpportunity[],
  sym: string | null | undefined,
): StrategyOpportunity[] {
  const symbol = (sym ?? '').trim().toUpperCase()
  if (!symbol) return opps
  return opps.filter((o) => {
    const scopeType = (o.scope_type ?? '').trim()
    if (!scopeType) return true
    if (scopeType === 'explicit_symbols') {
      const syms = (o.symbols ?? []).map((s) => s.trim().toUpperCase())
      return syms.includes(symbol)
    }
    if (scopeType === 'watchlist_stk') {
      const syms = o.symbols ?? []
      if (syms.length === 0) return true
      return syms.map((s) => s.trim().toUpperCase()).includes(symbol)
    }
    return true
  })
}

export function LinkPositionModal({ open, context, onClose, onSuccess }: LinkPositionModalProps) {
  const [strategyOpportunityId, setStrategyOpportunityId] = useState('')
  const [instanceMode, setInstanceMode] = useState<'existing' | 'new'>('existing')
  const [strategyInstanceId, setStrategyInstanceId] = useState('')
  const [newOpenedAt, setNewOpenedAt] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (!open || !context) return
    setFormError(null)
    const oppId = context.strategy_opportunity_id != null ? String(context.strategy_opportunity_id) : ''
    const instId = context.strategy_instance_id != null ? String(context.strategy_instance_id) : ''
    setStrategyOpportunityId(oppId)
    setStrategyInstanceId(instId)
    setInstanceMode('existing')
    setNewOpenedAt(todayDateStr())
    setNewLabel('')
    fetchOpportunities(true)
      .then(r => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
    setTimeout(() => firstFieldRef.current?.focus(), 80)
  }, [open, context])

  const oppIdNum = strategyOpportunityId.trim() ? Number(strategyOpportunityId) : null
  useEffect(() => {
    if (!open) {
      setInstances([])
      return
    }
    const params =
      oppIdNum != null && Number.isFinite(oppIdNum) ? { strategy_opportunity_id: oppIdNum } : undefined
    fetchStrategyInstances(params)
      .then(r => setInstances(r.items ?? []))
      .catch(() => setInstances([]))
  }, [open, oppIdNum])

  if (!open || !context) return null

  const symbol = (context.symbol ?? '').trim().toUpperCase()
  const filteredOpportunities = filterOpportunitiesBySymbol(opportunities, symbol)
  const symbolFiltered = !!symbol && filteredOpportunities.length < opportunities.length
  const executionAccountId = (context.account_id ?? '').trim()

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (!strategyOpportunityId.trim() || !Number.isFinite(Number(strategyOpportunityId))) {
      setFormError('Select a strategy opportunity.')
      return
    }
    const opp = Number(strategyOpportunityId)

    let instId: number | null = null

    if (instanceMode === 'new') {
      if (!executionAccountId) {
        setFormError('This position has no account; create instance is not available.')
        return
      }
      const dateStr = newOpenedAt.trim()
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        setFormError('Opened at (date) is required.')
        return
      }
      setSaving(true)
      try {
        const created = await createStrategyInstance({
          strategy_opportunity_id: opp,
          account_id: executionAccountId,
          opened_at: `${dateStr}T12:00:00.000Z`,
          label: newLabel.trim() || undefined,
        })
        instId = created.strategy_instance_id
      } catch (err) {
        setSaving(false)
        setFormError(err instanceof Error ? err.message : 'Failed to create instance.')
        return
      }
    } else {
      const instRaw = strategyInstanceId.trim()
      instId = instRaw && Number.isFinite(Number(instRaw)) ? Number(instRaw) : null
    }

    const res = await patchExecutionStrategyAttribution({
      account_id: context.account_id,
      contract_key: context.contract_key,
      strategy_opportunity_id: opp,
      strategy_instance_id: instId,
    })
    setSaving(false)
    if (res.ok) {
      onClose()
      await onSuccess()
    } else {
      setFormError(res.error ?? 'No matching executions found or update failed.')
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={() => !saving && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-position-modal-title"
    >
      <div className="modal-panel replay-exec-modal link-exec-modal" onClick={ev => ev.stopPropagation()}>
        <h3 id="link-position-modal-title">Tag executions with strategy</h3>
        <p className="section-hint" style={{ marginTop: 0 }}>
          Assign strategy opportunity and instance to all executions for this contract. One position can have multiple strategies.
        </p>
        <p className="section-hint replay-muted" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          {context.symbol ?? '—'} · {context.account_id ?? '—'} · {context.position != null ? `${context.position > 0 ? 'Long' : 'Short'} ${Math.abs(context.position)}` : '—'}
          {context.avgCost != null ? ` @ ${fmtUsd(context.avgCost)}` : ''}
        </p>
        {formError ? <p className="section-hint replay-form-error">{formError}</p> : null}
        <form onSubmit={onSubmit} className="replay-exec-form">
          <div className="replay-exec-form-row">
            <label htmlFor="link-pos-strategy-opp">
              Strategy opportunity
              {symbolFiltered && (
                <span className="link-exec-symbol-filter-badge" title={`Showing opportunities matching symbol ${symbol}`}>
                  {symbol}
                </span>
              )}
            </label>
            <select
              id="link-pos-strategy-opp"
              ref={firstFieldRef}
              value={strategyOpportunityId}
              onChange={e => {
                setStrategyOpportunityId(e.target.value)
                setStrategyInstanceId('')
              }}
              required
            >
              <option value="">— Select —</option>
              {filteredOpportunities.map(o => (
                <option key={o.strategy_opportunity_id} value={String(o.strategy_opportunity_id)}>
                  {o.name ?? `#${o.strategy_opportunity_id}`}
                </option>
              ))}
            </select>
            {symbolFiltered && filteredOpportunities.length === 0 && (
              <p className="section-hint replay-muted link-exec-no-match-hint">
                No opportunities match symbol {symbol}. Check scope settings in Strategy / Opportunity.
              </p>
            )}
          </div>

          {strategyOpportunityId ? (
            <div className="link-exec-instance-section">
              <div className="link-exec-instance-toggle" role="group" aria-label="Instance mode">
                <button
                  type="button"
                  className={`link-exec-toggle-btn${instanceMode === 'existing' ? ' active' : ''}`}
                  onClick={() => setInstanceMode('existing')}
                >
                  Use existing
                </button>
                <button
                  type="button"
                  className={`link-exec-toggle-btn${instanceMode === 'new' ? ' active' : ''}`}
                  disabled={!executionAccountId}
                  title={!executionAccountId ? 'This position has no account ID.' : undefined}
                  onClick={() => setInstanceMode('new')}
                >
                  + Create new
                </button>
              </div>

              {instanceMode === 'existing' ? (
                <div className="replay-exec-form-row link-exec-instance-row">
                  <label htmlFor="link-pos-strategy-inst">Strategy instance</label>
                  <select
                    id="link-pos-strategy-inst"
                    value={strategyInstanceId}
                    onChange={e => setStrategyInstanceId(e.target.value)}
                  >
                    <option value="">— None —</option>
                    {instances.map(i => (
                      <option key={i.strategy_instance_id} value={String(i.strategy_instance_id)}>
                        {formatInstanceOpenedDate(i)}
                      </option>
                    ))}
                  </select>
                  {instances.length === 0 && (
                    <p className="section-hint replay-muted link-exec-no-instances">
                      No instances yet for this opportunity. Switch to &quot;Create new&quot; to add one.
                    </p>
                  )}
                </div>
              ) : (
                <div className="link-exec-new-instance-fields">
                  <div className="replay-exec-form-row">
                    <label htmlFor="link-pos-new-inst-date">Opened at</label>
                    <input
                      id="link-pos-new-inst-date"
                      type="date"
                      value={newOpenedAt}
                      onChange={e => setNewOpenedAt(e.target.value)}
                      required
                    />
                  </div>
                  <div className="replay-exec-form-row link-exec-account-row">
                    <span className="link-exec-account-label">Account</span>
                    <span className="link-exec-account-readonly" title={executionAccountId || undefined}>
                      {executionAccountId || '—'}
                    </span>
                    <p className="section-hint replay-muted link-exec-account-hint">
                      Uses this position&apos;s account; not editable.
                    </p>
                  </div>
                  <div className="replay-exec-form-row">
                    <label htmlFor="link-pos-new-inst-label">Label <span className="replay-muted">(optional)</span></label>
                    <input
                      id="link-pos-new-inst-label"
                      type="text"
                      value={newLabel}
                      onChange={e => setNewLabel(e.target.value)}
                      placeholder="e.g. Mar trade"
                      maxLength={80}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              disabled={saving || !strategyOpportunityId || (instanceMode === 'new' && !executionAccountId)}
            >
              {saving
                ? instanceMode === 'new' ? 'Creating…' : 'Saving…'
                : instanceMode === 'new' ? 'Create & assign' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
