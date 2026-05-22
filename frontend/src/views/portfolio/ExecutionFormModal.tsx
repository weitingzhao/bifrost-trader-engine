import { rl, bubbleSwitchBtn } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Execution } from '../../types'
import type { StrategyOpportunity } from '../../api'
import type { StrategyInstance } from '../../types'
import { createExecution, updateExecution, fetchOpportunities, fetchStrategyInstances } from '../../api'
import { unixToDatetimeLocal } from '../../utils/format'
import { AppSelect } from '../../components/AppSelect'

export interface ExecutionFormState {
  account_id: string
  time: string
  symbol: string
  sec_type: string
  side: string
  quantity: string
  price: string
  expiry: string
  strike: string
  option_right: string
  commission: string
  realized_pnl: string
  currency: string
  strategy_opportunity_id: string
  strategy_instance_id: string
}

const defaultForm: ExecutionFormState = {
  account_id: '',
  time: '',
  symbol: '',
  sec_type: 'STK',
  side: 'BUY',
  quantity: '',
  price: '',
  expiry: '',
  strike: '',
  option_right: 'C',
  commission: '',
  realized_pnl: '',
  currency: 'USD',
  strategy_opportunity_id: '',
  strategy_instance_id: '',
}

function datetimeLocalToUnix(value: string): number {
  if (!value || !value.trim()) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(value).getTime() / 1000)
}

interface ExecutionFormModalProps {
  open: boolean
  editExec: Execution | null
  accountOptions: string[]
  /** When opening Add (no editExec), merge into form after defaults. Cleared when modal closes. */
  initialDraft?: Partial<ExecutionFormState> | null
  /** When true (e.g. quick Add journal from Stocks position group), Account / STK / Symbol cannot be changed. */
  lockContractContext?: boolean
  /** Create payload source; journal_closed is stored in executions_raw_journal (Trade ledger manual journal). */
  createExecutionSource?: 'journal_closed' | 'manual'
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

export function ExecutionFormModal({
  open,
  editExec,
  accountOptions,
  initialDraft = null,
  lockContractContext = false,
  createExecutionSource = 'manual',
  onClose,
  onSuccess,
}: ExecutionFormModalProps) {
  const [execForm, setExecForm] = useState<ExecutionFormState>(defaultForm)
  const [execFormError, setExecFormError] = useState<string | null>(null)
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])
  const [allInstancesForAccount, setAllInstancesForAccount] = useState<StrategyInstance[]>([])
  const [useInstanceSplits, setUseInstanceSplits] = useState(false)
  const [splitRows, setSplitRows] = useState<Array<{ uid: string; strategy_instance_id: string; allocated_quantity: string }>>([])
  const splitSectionId = useId()

  useEffect(() => {
    if (open) {
      fetchOpportunities(true)
        .then(r => setOpportunities(r.items ?? []))
        .catch(() => setOpportunities([]))
    }
  }, [open])

  useEffect(() => {
    const acc = execForm.account_id.trim()
    if (!open || !acc) {
      setAllInstancesForAccount([])
      return
    }
    fetchStrategyInstances({ account_id: acc })
      .then(r => setAllInstancesForAccount(r.items ?? []))
      .catch(() => setAllInstancesForAccount([]))
  }, [open, execForm.account_id])

  const oppIdForm = execForm.strategy_opportunity_id.trim() ? Number(execForm.strategy_opportunity_id) : null
  useEffect(() => {
    if (!open) {
      setInstances([])
      return
    }
    const params = oppIdForm != null && Number.isFinite(oppIdForm)
      ? { strategy_opportunity_id: oppIdForm }
      : undefined
    fetchStrategyInstances(params)
      .then(r => setInstances(r.items ?? []))
      .catch(() => setInstances([]))
  }, [open, oppIdForm])

  useEffect(() => {
    if (open && !editExec) {
      const defaultAcc = accountOptions.length > 0 ? accountOptions[0] ?? '' : ''
      const base: ExecutionFormState = {
        ...defaultForm,
        account_id: defaultAcc,
        time: unixToDatetimeLocal(Date.now() / 1000),
      }
      if (initialDraft && Object.keys(initialDraft).length > 0) {
        setExecForm({
          ...base,
          ...initialDraft,
          account_id: (initialDraft.account_id ?? '').trim() || base.account_id,
          sec_type: lockContractContext ? 'STK' : (initialDraft.sec_type ?? base.sec_type),
        })
      } else {
        setExecForm(lockContractContext ? { ...base, sec_type: 'STK' } : base)
      }
      setUseInstanceSplits(false)
      setSplitRows([])
    }
  }, [open, accountOptions, editExec, initialDraft, lockContractContext])

  useEffect(() => {
    if (editExec) {
      setExecForm({
        account_id: editExec.account_id ?? '',
        time: unixToDatetimeLocal(editExec.time),
        symbol: editExec.symbol ?? '',
        sec_type: (editExec.sec_type ?? 'STK').toUpperCase(),
        side: (editExec.side ?? 'BUY').toUpperCase(),
        quantity: editExec.quantity != null ? String(Math.abs(Number(editExec.quantity))) : '',
        price: String(editExec.price ?? ''),
        expiry: editExec.expiry ?? '',
        strike: String(editExec.strike ?? ''),
        option_right: (editExec.option_right ?? 'C').toUpperCase().slice(0, 1),
        commission: String(editExec.commission ?? ''),
        realized_pnl: String(editExec.realized_pnl ?? ''),
        currency: editExec.currency ?? 'USD',
        strategy_opportunity_id: editExec.strategy_opportunity_id != null ? String(editExec.strategy_opportunity_id) : '',
        strategy_instance_id: editExec.strategy_instance_id != null ? String(editExec.strategy_instance_id) : '',
      })
      const ia = editExec.instance_allocations
      if (ia && ia.length > 0) {
        setUseInstanceSplits(true)
        setSplitRows(
          ia.map((a, i) => ({
            uid: `split-${editExec.account_executions_id ?? 'x'}-${i}`,
            strategy_instance_id: String(a.strategy_instance_id),
            allocated_quantity: String(a.allocated_quantity),
          })),
        )
      } else {
        setUseInstanceSplits(false)
        setSplitRows([])
      }
    }
  }, [editExec])

  if (!open && !editExec) return null

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        onClose()
        setExecFormError(null)
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="exec-modal-title"
    >
      <div className={rl.execModal} onClick={e => e.stopPropagation()}>
        <h3 id="exec-modal-title">
          {editExec ? 'Edit execution' : createExecutionSource === 'journal_closed' ? 'Add journal' : 'Add history'}
        </h3>
        {!editExec && createExecutionSource === 'journal_closed' && (
          <p className={cn(w9.sectionHint, 'execution-flex-manual-warning')} role="alert">
            Manual journal entry: stored as <code className="performance-inline-code">journal_closed</code> in the journal
            execution store. Use only when IB / Flex cannot supply the fill (e.g. reconciliation or expired exercise).
          </p>
        )}
        {execFormError && <p className={rl.formError}>{execFormError}</p>}
        <form
          className={rl.execForm}
          onSubmit={async e => {
            e.preventDefault()
            setExecFormError(null)
            const sym = execForm.symbol.trim()
            const qRaw = Number(execForm.quantity)
            const q = Math.abs(qRaw)
            const p = Number(execForm.price)
            if (!sym || !Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) {
              setExecFormError('Fill symbol, quantity (> 0), and price.')
              return
            }
            const timeUnix = datetimeLocalToUnix(execForm.time)
            const isOpt = (execForm.sec_type || 'STK').toUpperCase() === 'OPT'
            if (isOpt) {
              const strikeNum = execForm.strike != null && execForm.strike !== '' ? Number(execForm.strike) : NaN
              if (!Number.isFinite(strikeNum) || strikeNum <= 0) {
                setExecFormError('Option strike is required and must be > 0.')
                return
              }
            }
            let contract_key: string | undefined
            if (isOpt && sym) {
              const rawStrike = execForm.strike ? Number(execForm.strike) : 0
              const strikeStr = Number.isFinite(rawStrike) ? rawStrike.toFixed(1) : '0.0'
              contract_key = `${sym}|OPT|${execForm.expiry || ''}|${strikeStr}|${(execForm.option_right || 'C').toUpperCase().slice(0, 1)}`
            } else {
              contract_key = undefined
            }
            const sideUpper = (execForm.side || 'BUY').toUpperCase()
            const quantityForDb = sideUpper === 'SELL' ? -q : q
            if (editExec?.account_executions_id != null) {
              const body: Record<string, unknown> = {
                exec_time: timeUnix,
                symbol: sym,
                sec_type: execForm.sec_type || 'STK',
                side: sideUpper,
                quantity: quantityForDb,
                price: p,
                account_id: execForm.account_id.trim(),
                strike: execForm.strike ? Number(execForm.strike) : undefined,
                option_right: execForm.option_right || undefined,
                contract_key: contract_key || undefined,
                commission: execForm.commission ? Number(execForm.commission) : undefined,
                realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                currency: execForm.currency.trim() || undefined,
                strategy_opportunity_id: execForm.strategy_opportunity_id && Number.isFinite(Number(execForm.strategy_opportunity_id)) ? Number(execForm.strategy_opportunity_id) : undefined,
                strategy_instance_id: execForm.strategy_instance_id && Number.isFinite(Number(execForm.strategy_instance_id)) ? Number(execForm.strategy_instance_id) : undefined,
              }
              if (useInstanceSplits) {
                if (splitRows.length === 0) {
                  body.instance_allocations = []
                } else {
                  const allocs: { strategy_instance_id: number; allocated_quantity: number }[] = []
                  for (const row of splitRows) {
                    const si = Number(row.strategy_instance_id)
                    const aq = Number(row.allocated_quantity)
                    if (!Number.isFinite(si) || !Number.isFinite(aq)) {
                      setExecFormError('Each split row needs a valid instance and allocated quantity.')
                      return
                    }
                    allocs.push({ strategy_instance_id: si, allocated_quantity: aq })
                  }
                  const sum = allocs.reduce((s, x) => s + x.allocated_quantity, 0)
                  if (Math.abs(sum - quantityForDb) > 1e-4 * Math.max(1, Math.abs(quantityForDb))) {
                    setExecFormError(
                      `Split quantities must sum to the execution quantity (${quantityForDb}).`,
                    )
                    return
                  }
                  body.instance_allocations = allocs
                  delete body.strategy_opportunity_id
                  delete body.strategy_instance_id
                }
              }
              const expiryTrimmed = execForm.expiry.trim()
              if (isOpt && expiryTrimmed && /^\d{6,8}$/.test(expiryTrimmed)) {
                body.expiry = expiryTrimmed
              }
              const res = await updateExecution(editExec.account_executions_id, body)
              if (res.ok) {
                onClose()
                await onSuccess()
              } else {
                setExecFormError(res.error ?? 'Update failed')
              }
            } else {
              const body: Record<string, unknown> = {
                account_id: execForm.account_id.trim(),
                time: timeUnix,
                symbol: sym,
                sec_type: execForm.sec_type || 'STK',
                side: sideUpper,
                quantity: quantityForDb,
                price: p,
                source: createExecutionSource === 'journal_closed' ? 'journal_closed' : 'manual',
                expiry: execForm.expiry.trim() || undefined,
                strike: execForm.strike ? Number(execForm.strike) : undefined,
                option_right: execForm.option_right || undefined,
                contract_key: contract_key || undefined,
                commission: execForm.commission ? Number(execForm.commission) : undefined,
                realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                currency: execForm.currency.trim() || undefined,
                strategy_opportunity_id: execForm.strategy_opportunity_id && Number.isFinite(Number(execForm.strategy_opportunity_id)) ? Number(execForm.strategy_opportunity_id) : undefined,
                strategy_instance_id: execForm.strategy_instance_id && Number.isFinite(Number(execForm.strategy_instance_id)) ? Number(execForm.strategy_instance_id) : undefined,
              }
              if (useInstanceSplits) {
                if (splitRows.length === 0) {
                  body.instance_allocations = []
                } else {
                  const allocs: { strategy_instance_id: number; allocated_quantity: number }[] = []
                  for (const row of splitRows) {
                    const si = Number(row.strategy_instance_id)
                    const aq = Number(row.allocated_quantity)
                    if (!Number.isFinite(si) || !Number.isFinite(aq)) {
                      setExecFormError('Each split row needs a valid instance and allocated quantity.')
                      return
                    }
                    allocs.push({ strategy_instance_id: si, allocated_quantity: aq })
                  }
                  const sum = allocs.reduce((s, x) => s + x.allocated_quantity, 0)
                  if (Math.abs(sum - quantityForDb) > 1e-4 * Math.max(1, Math.abs(quantityForDb))) {
                    setExecFormError(
                      `Split quantities must sum to the execution quantity (${quantityForDb}).`,
                    )
                    return
                  }
                  body.instance_allocations = allocs
                  delete body.strategy_opportunity_id
                  delete body.strategy_instance_id
                }
              }
              const res = await createExecution(body)
              if (res.ok) {
                onClose()
                await onSuccess()
              } else {
                setExecFormError(res.error ?? 'Add failed')
              }
            }
          }}
        >
          <div className={rl.execFormRow}>
            <label>Account</label>
            {lockContractContext && !editExec ? (
              <input
                type="text"
                className={rl.execReadonly}
                readOnly
                value={execForm.account_id}
                aria-readonly="true"
              />
            ) : (
              <AppSelect
                value={execForm.account_id}
                onChange={(v) => setExecForm(f => ({ ...f, account_id: v }))}
                options={accountOptions.map(accId => ({ value: accId, label: accId }))}
              />
            )}
          </div>
          <div className={rl.execFormRow}>
            <label>Strategy (optional)</label>
            <AppSelect
              value={execForm.strategy_opportunity_id}
              onChange={(v) => setExecForm(f => ({ ...f, strategy_opportunity_id: v, strategy_instance_id: '' }))}
              placeholder="—"
              options={opportunities.map(o => ({ value: String(o.strategy_opportunity_id), label: o.name ?? `#${o.strategy_opportunity_id}` }))}
            />
          </div>
          <div className={rl.execFormRow}>
            <label>Instance (optional)</label>
            <AppSelect
              value={execForm.strategy_instance_id}
              onChange={(instanceId) => {
                const instance = instanceId ? instances.find(si => String(si.strategy_instance_id) === instanceId) : null
                setExecForm(f => ({
                  ...f,
                  strategy_instance_id: instanceId,
                  strategy_opportunity_id: instance && !f.strategy_opportunity_id?.trim()
                    ? String(instance.strategy_opportunity_id)
                    : f.strategy_opportunity_id,
                }))
              }}
              placeholder="—"
              options={instances.map(si => ({
                value: String(si.strategy_instance_id),
                label: si.label?.trim() || `#${si.strategy_instance_id} ${si.opened_at && si.opened_at.length >= 10 ? si.opened_at.slice(0, 10) : si.opened_at ?? ''}`,
              }))}
            />
          </div>
          <div className={rl.execSplitsSection}>
            <div className={cn(rl.execFormRow, rl.execSplitsSectionHeader)}>
              <label id={splitSectionId}>Multi-instance split</label>
              <div className={rl.execSplitsControls}>
                <label className={rl.execCheckboxLabel}>
                  <input
                    type="checkbox"
                    checked={useInstanceSplits}
                    onChange={e => {
                      const on = e.target.checked
                      setUseInstanceSplits(on)
                      if (on && splitRows.length === 0) {
                        setSplitRows([{ uid: `new-${Date.now()}`, strategy_instance_id: '', allocated_quantity: '' }])
                      }
                    }}
                    aria-describedby={splitSectionId}
                  />
                  Split quantity across instances
                </label>
                {useInstanceSplits && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setSplitRows(rows => [
                        ...rows,
                        { uid: `new-${Date.now()}-${rows.length}`, strategy_instance_id: '', allocated_quantity: '' },
                      ])
                    }
                  >
                    Add row
                  </Button>
                )}
              </div>
            </div>
            {useInstanceSplits && (
              <p className={rl.execSplitsHint}>
                Signed quantities must sum to the execution quantity. Saving with splits enabled and no rows clears
                allocation rows. Single Strategy / Instance fields are ignored when splits are saved.
              </p>
            )}
            {useInstanceSplits && (
              <div className={rl.execSplitsRows}>
                {splitRows.map(row => (
                  <div key={row.uid} className={rl.execSplitRow}>
                    <AppSelect
                      value={row.strategy_instance_id}
                      onChange={(v) =>
                        setSplitRows(rows =>
                          rows.map(r => (r.uid === row.uid ? { ...r, strategy_instance_id: v } : r)),
                        )
                      }
                      aria-label="Instance for split"
                      options={[
                        { value: '', label: '— Instance —' },
                        ...allInstancesForAccount.map(si => ({
                          value: String(si.strategy_instance_id),
                          label: si.label?.trim() || `#${si.strategy_instance_id} ${si.opened_at && si.opened_at.length >= 10 ? si.opened_at.slice(0, 10) : si.opened_at ?? ''}`,
                        })),
                      ]}
                    />
                    <input
                      type="number"
                      step="any"
                      className={rl.execSplitQty}
                      value={row.allocated_quantity}
                      onChange={e =>
                        setSplitRows(rows =>
                          rows.map(r => (r.uid === row.uid ? { ...r, allocated_quantity: e.target.value } : r)),
                        )
                      }
                      placeholder="Signed qty"
                      aria-label="Allocated quantity"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={rl.execSplitRemove}
                      onClick={() => setSplitRows(rows => rows.filter(r => r.uid !== row.uid))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={rl.execFormRow}>
            <label>Time</label>
            <input type="datetime-local" value={execForm.time} onChange={e => setExecForm(f => ({ ...f, time: e.target.value }))} required />
          </div>
          <div className={rl.execFormRow}>
            <label>Symbol</label>
            {lockContractContext && !editExec ? (
              <input
                type="text"
                className={rl.execReadonly}
                readOnly
                value={execForm.symbol}
                aria-readonly="true"
              />
            ) : (
              <input
                type="text"
                value={execForm.symbol}
                onChange={e => setExecForm(f => ({ ...f, symbol: e.target.value.trim().toUpperCase() }))}
                placeholder="e.g. NVDA"
                required
              />
            )}
          </div>
          <div className={rl.execFormRow}>
            <label>Type</label>
            {lockContractContext && !editExec ? (
              <div className={rl.execSegBubbles} role="group" aria-label="Security type">
                <span className={bubbleSwitchBtn(true)} aria-current="true">
                  STK
                </span>
              </div>
            ) : (
              <div className={rl.execSegBubbles} role="radiogroup" aria-label="Security type">
                <button
                  type="button"
                  role="radio"
                  aria-checked={(execForm.sec_type || 'STK').toUpperCase() === 'STK'}
                  className={bubbleSwitchBtn((execForm.sec_type || 'STK').toUpperCase() === 'STK')}
                  onClick={() => setExecForm(f => ({ ...f, sec_type: 'STK' }))}
                >
                  STK
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={(execForm.sec_type || 'STK').toUpperCase() === 'OPT'}
                  className={bubbleSwitchBtn((execForm.sec_type || 'STK').toUpperCase() === 'OPT')}
                  onClick={() => setExecForm(f => ({ ...f, sec_type: 'OPT' }))}
                >
                  OPT
                </button>
              </div>
            )}
          </div>
          <div className={rl.execFormRow}>
            <label>Side</label>
            <div className={rl.execSegBubbles} role="radiogroup" aria-label="Side">
              <button
                type="button"
                role="radio"
                aria-checked={(execForm.side || 'BUY').toUpperCase() === 'BUY'}
                className={bubbleSwitchBtn((execForm.side || 'BUY').toUpperCase() === 'BUY')}
                onClick={() => setExecForm(f => ({ ...f, side: 'BUY' }))}
              >
                Buy
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={(execForm.side || 'BUY').toUpperCase() === 'SELL'}
                className={bubbleSwitchBtn((execForm.side || 'BUY').toUpperCase() === 'SELL')}
                onClick={() => setExecForm(f => ({ ...f, side: 'SELL' }))}
              >
                Sell
              </button>
            </div>
          </div>
          <div className={cn(rl.execFormRow, rl.execFormRowMetrics)}>
            <div className={rl.execMetricField}>
              <label htmlFor="exec-qty">Quantity</label>
              <input
                id="exec-qty"
                type="number"
                step="any"
                min="0"
                value={execForm.quantity}
                onChange={e => setExecForm(f => ({ ...f, quantity: e.target.value }))}
                required
              />
            </div>
            <div className={rl.execMetricField}>
              <label htmlFor="exec-price">Price</label>
              <input
                id="exec-price"
                type="number"
                step="any"
                value={execForm.price}
                onChange={e => setExecForm(f => ({ ...f, price: e.target.value }))}
                required
              />
            </div>
            <div className={rl.execMetricField}>
              <label htmlFor="exec-comm">Commission</label>
              <input
                id="exec-comm"
                type="number"
                step="any"
                value={execForm.commission}
                onChange={e => setExecForm(f => ({ ...f, commission: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>
          {(execForm.sec_type || 'STK').toUpperCase() === 'OPT' && (
            <>
              <div className={rl.execFormRow}>
                <label>Expiry (YYYYMMDD)</label>
                <input type="text" value={execForm.expiry} onChange={e => setExecForm(f => ({ ...f, expiry: e.target.value }))} placeholder="20251219" />
              </div>
              <div className={rl.execFormRow}>
                <label>STRIKE</label>
                <input type="number" step="0.1" min="0.1" value={execForm.strike} onChange={e => setExecForm(f => ({ ...f, strike: e.target.value }))} required placeholder="Required, > 0" />
              </div>
              <div className={rl.execFormRow}>
                <label>Right</label>
                <div className={rl.execTypeRadios}>
                  <label>
                    <input type="radio" name="exec-option-right" value="C" checked={(execForm.option_right || 'C').toUpperCase() === 'C'} onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))} />
                    Call
                  </label>
                  <label>
                    <input type="radio" name="exec-option-right" value="P" checked={(execForm.option_right || 'C').toUpperCase() === 'P'} onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))} />
                    Put
                  </label>
                </div>
              </div>
            </>
          )}
          <div className={cn(rl.execFormRow, rl.execFormRowMetrics, rl.execFormRowMetricsPnl)}>
            <div className={rl.execMetricField}>
              <label htmlFor="exec-realized">Realized PnL</label>
              <input
                id="exec-realized"
                type="number"
                step="any"
                value={execForm.realized_pnl}
                onChange={e => setExecForm(f => ({ ...f, realized_pnl: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            <div className={rl.execMetricField}>
              <label htmlFor="exec-ccy">Currency</label>
              <input
                id="exec-ccy"
                type="text"
                value={execForm.currency}
                onChange={e => setExecForm(f => ({ ...f, currency: e.target.value }))}
                placeholder="USD"
              />
            </div>
          </div>
          <div className={rl.execFormActions}>
            <Button type="button" variant="secondary" onClick={() => { onClose(); setExecFormError(null) }}>
              Cancel
            </Button>
            <Button type="submit">
              {editExec ? 'Save' : createExecutionSource === 'journal_closed' ? 'Add journal' : 'Add'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
