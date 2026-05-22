import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Execution } from '../../types'
import type { StrategyOpportunity } from '../../api'
import type { StrategyInstance } from '../../types'
import { createStrategyInstance, fetchOpportunities, fetchStrategyInstances, updateExecution } from '../../api'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { fmtDate, fmtUsd, getContractLabelParts } from '../../utils/format'
import type { PeerInstancePick } from './ledgerOptHelpers'

export interface LinkExecutionContext {
  account_executions_id: number
  /** Current row values for prefill and summary line */
  execution?: Execution | null
  /** Other fills on this option contract that already have instance(s); enables a one-click shortcut in the modal. */
  peer_instance_picks?: PeerInstancePick[]
}

interface LinkExecutionRecordModalProps {
  open: boolean
  context: LinkExecutionContext | null
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

/** Extract underlying symbol for opportunity matching: "RKLB 260320C00077000" → "RKLB", or from contract_key. */
function getUnderlyingSymbolFromExecution(ex?: Execution | null): string {
  const sym = (ex?.symbol ?? '').trim()
  if (sym) {
    const beforeSpace = sym.split(/\s+/)[0]?.trim()
    if (beforeSpace) return beforeSpace.toUpperCase()
  }
  const ck = (ex?.contract_key ?? '').trim()
  if (ck) {
    const s = getContractLabelParts(ck).symbol.trim()
    if (s) return s.toUpperCase()
  }
  return ''
}

/** Default Opened at: trade_date (YYYY-MM-DD) if present, else calendar date from execution time, else today. */
function defaultOpenedAtFromExecution(ex?: Execution | null): string {
  const td = ex?.trade_date?.trim()
  if (td && /^\d{4}-\d{2}-\d{2}$/.test(td)) return td
  const ts = ex?.time != null ? Number(ex.time) : null
  if (ts != null && Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return todayDateStr()
}

/** Filter opportunities by execution symbol using scope_type logic. */
function filterOpportunitiesBySymbol(
  opps: StrategyOpportunity[],
  execSymbol: string | null | undefined,
): StrategyOpportunity[] {
  const sym = (execSymbol ?? '').trim().toUpperCase()
  if (!sym) return opps
  return opps.filter((o) => {
    const scopeType = (o.scope_type ?? '').trim()
    if (!scopeType) return true
    if (scopeType === 'explicit_symbols') {
      const syms = (o.symbols ?? []).map((s) => s.trim().toUpperCase())
      return syms.includes(sym)
    }
    if (scopeType === 'watchlist_stk') {
      const syms = o.symbols ?? []
      if (syms.length === 0) return true
      return syms.map((s) => s.trim().toUpperCase()).includes(sym)
    }
    return true
  })
}

export function LinkExecutionRecordModal({ open, context, onClose, onSuccess }: LinkExecutionRecordModalProps) {
  const [strategyOpportunityId, setStrategyOpportunityId] = useState('')
  const [instanceMode, setInstanceMode] = useState<'existing' | 'new'>('existing')
  const [strategyInstanceId, setStrategyInstanceId] = useState('')
  // Create new instance fields
  const [newOpenedAt, setNewOpenedAt] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [peerShortcut, setPeerShortcut] = useState('')
  const firstFieldRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || !context) return
    setFormError(null)
    const ex = context.execution
    const picks = context.peer_instance_picks
    const oppId = ex?.strategy_opportunity_id != null ? String(ex.strategy_opportunity_id) : ''
    const instId = ex?.strategy_instance_id != null ? String(ex.strategy_instance_id) : ''
    setStrategyOpportunityId(oppId)
    setStrategyInstanceId(instId)
    setInstanceMode('existing')
    setNewOpenedAt(defaultOpenedAtFromExecution(ex))
    setNewLabel('')
    if (picks?.length && oppId && instId) {
      const hit = picks.find(
        p => String(p.strategy_opportunity_id) === oppId && String(p.strategy_instance_id) === instId,
      )
      setPeerShortcut(hit ? `${hit.strategy_opportunity_id}::${hit.strategy_instance_id}` : '')
    } else {
      setPeerShortcut('')
    }
    fetchOpportunities(true)
      .then(r => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
    setTimeout(() => firstFieldRef.current?.focus(), 80)
  }, [open, context]) // intentionally not including status to avoid re-running on every poll

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

  const execId = context.account_executions_id
  const ex = context.execution
  const peerPicks = context.peer_instance_picks
  const executionAccountId = (ex?.account_id ?? '').trim()
  const execSymbol = getUnderlyingSymbolFromExecution(ex)
  const filteredOpportunities = filterOpportunitiesBySymbol(opportunities, execSymbol)
  const symbolFiltered = !!execSymbol && filteredOpportunities.length < opportunities.length

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
      const accountId = (ex?.account_id ?? '').trim()
      if (!accountId) {
        setFormError('This execution has no account; create instance is not available.')
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
          account_id: accountId,
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

    const res = await updateExecution(execId, {
      strategy_opportunity_id: opp,
      strategy_instance_id: instId,
    })
    setSaving(false)
    if (res.ok) {
      onClose()
      await onSuccess()
    } else {
      setFormError(res.error ?? 'Update failed')
    }
  }

  const eTs = ex?.time != null ? Number(ex.time) : null

  return (
    <div
      className="modal-overlay"
      onClick={() => !saving && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-exec-modal-title"
    >
      <div className="modal-panel replay-exec-modal link-exec-modal" onClick={ev => ev.stopPropagation()}>
        <h3 id="link-exec-modal-title">Assign strategy</h3>
        <p className="section-hint" style={{ marginTop: 0 }}>
          Set strategy opportunity and instance for execution #{execId}. No new execution row is created.
        </p>
        {ex ? (
          <p className="section-hint replay-muted" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            {eTs != null && Number.isFinite(eTs) ? `${fmtDate(eTs)} · ` : ''}
            {ex.side ?? '—'} {ex.quantity ?? '—'} @ {ex.price != null ? fmtUsd(Number(ex.price)) : '—'} · <ExecSourceBadge source={ex.source} />
          </p>
        ) : null}
        {formError ? <p className="section-hint replay-form-error">{formError}</p> : null}
        <form onSubmit={onSubmit} className="replay-exec-form">
          {peerPicks && peerPicks.length > 0 ? (
            <div className="link-exec-peer-quick">
              <div className="link-exec-inline-bubbles-block">
                <div className="link-exec-inline-bubbles-head" id="link-peer-shortcut-label">
                  Reuse from this contract
                </div>
                <div
                  className="replay-bubble-switch link-exec-inline-bubble-group"
                  role="radiogroup"
                  aria-labelledby="link-peer-shortcut-label"
                >
                  {peerPicks.map((p, idx) => {
                    const key = `${p.strategy_opportunity_id}::${p.strategy_instance_id}`
                    const isActive = peerShortcut === key
                    const hasOppRow = filteredOpportunities.length > 0
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        ref={!hasOppRow && idx === 0 ? firstFieldRef : undefined}
                        className={`replay-bubble-switch-btn${isActive ? ' active' : ''}`}
                        title={p.label}
                        onClick={() => {
                          setPeerShortcut(key)
                          setStrategyOpportunityId(String(p.strategy_opportunity_id))
                          setStrategyInstanceId(String(p.strategy_instance_id))
                          setInstanceMode('existing')
                        }}
                      >
                        {p.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <p className="section-hint replay-muted link-exec-peer-quick-hint">
                Optional: apply strategy opportunity and instance already used on another fill for this contract. You can still set them manually below.
              </p>
            </div>
          ) : null}
          <div className="replay-exec-form-row link-exec-opp-field-row link-exec-bubbles-field-col">
            <label id="link-strategy-opp-label">
              Strategy opportunity
              {symbolFiltered && (
                <span className="link-exec-symbol-filter-badge" title={`Showing opportunities matching symbol ${execSymbol}`}>
                  {execSymbol}
                </span>
              )}
            </label>
            {filteredOpportunities.length > 0 ? (
              <div
                className="replay-bubble-switch link-exec-inline-bubble-group link-exec-opp-inline-group"
                role="radiogroup"
                aria-labelledby="link-strategy-opp-label"
              >
                {filteredOpportunities.map((o, idx) => {
                  const idStr = String(o.strategy_opportunity_id)
                  const isActive = strategyOpportunityId === idStr
                  const label = o.name?.trim() || `#${o.strategy_opportunity_id}`
                  return (
                    <button
                      key={o.strategy_opportunity_id}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      ref={idx === 0 ? firstFieldRef : undefined}
                      className={`replay-bubble-switch-btn${isActive ? ' active' : ''}`}
                      title={label}
                      onClick={() => {
                        setStrategyOpportunityId(idStr)
                        setStrategyInstanceId('')
                        setPeerShortcut('')
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="section-hint replay-muted link-exec-no-match-hint">
                {symbolFiltered
                  ? `No opportunities match symbol ${execSymbol}. Check scope settings in Strategy / Opportunity.`
                  : 'No strategy opportunities loaded.'}
              </p>
            )}
          </div>

          {/* Instance section — only show after opportunity is selected */}
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
                  title={!executionAccountId ? 'This execution has no account ID.' : undefined}
                  onClick={() => {
                    setInstanceMode('new')
                    setPeerShortcut('')
                  }}
                >
                  + Create new
                </button>
              </div>

              {instanceMode === 'existing' ? (
                <div className="replay-exec-form-row link-exec-instance-row">
                  <label htmlFor="link-strategy-inst">Strategy instance</label>
                  <select
                    id="link-strategy-inst"
                    value={strategyInstanceId}
                    onChange={e => {
                      setStrategyInstanceId(e.target.value)
                      setPeerShortcut('')
                    }}
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
                      No instances yet for this opportunity. Switch to "Create new" to add one.
                    </p>
                  )}
                </div>
              ) : (
                <div className="link-exec-new-instance-fields">
                  <div className="replay-exec-form-row">
                    <label htmlFor="link-new-inst-date">Opened at</label>
                    <input
                      id="link-new-inst-date"
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
                      Uses this execution&apos;s account; not editable.
                    </p>
                  </div>
                  <div className="replay-exec-form-row">
                    <label htmlFor="link-new-inst-label">Label <span className="replay-muted">(optional)</span></label>
                    <input
                      id="link-new-inst-label"
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
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !strategyOpportunityId || (instanceMode === 'new' && !executionAccountId)}
            >
              {saving
                ? instanceMode === 'new' ? 'Creating…' : 'Saving…'
                : instanceMode === 'new' ? 'Create & assign' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
