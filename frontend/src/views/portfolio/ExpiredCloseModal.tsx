import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { OptExecutionGroup } from '../../types'
import { createExecution } from '../../api'
import { fmtExpiry, fmtUsd, getContractLabelParts } from '../../utils/format'

interface ExpiredCloseModalProps {
  group: OptExecutionGroup | null
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

export function ExpiredCloseModal({ group, onClose, onSuccess }: ExpiredCloseModalProps) {
  const [form, setForm] = useState({ quantity: '', price: '', commission: '' })
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!group) return null

  const baseExec = group.trades?.[0] ?? null
  const netQty = group.net_qty ?? 0
  const expiredCloseSide = netQty > 0 ? 'SELL' : 'BUY'

  const handleClose = () => {
    onClose()
    setError(null)
    setForm({ quantity: '', price: '', commission: '' })
  }

  return (
    <div
      className="modal-overlay"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="expired-close-modal-title"
    >
      <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
        <h3 id="expired-close-modal-title">Close expired option</h3>
        {error && <p className="section-hint replay-form-error">{error}</p>}
        <p className="section-hint execution-flex-manual-warning" role="alert">
          <strong>Warning:</strong> If Flex sync is working normally, the missing closing fill will usually appear
          automatically after the next Flex refresh, which completes the position without a manual journal line.
          Only use this when you have confirmed Flex will not supply the trade and you need a manual{' '}
          <code className="performance-inline-code">journal_closed</code> entry to reconcile.
        </p>
        <p className="section-hint">
          This will add a closing execution with source <code className="performance-inline-code">journal_closed</code>{' '}
          (stored in the journal execution store) for this expired option group.
        </p>
        <div className="replay-expired-close-summary">
          <div>
            <strong>Contract:</strong>{' '}
            {(() => {
              const p = getContractLabelParts(group.contract_key)
              const strikeStr = group.strike != null ? ` ${group.strike}` : ''
              return p.symbol ? (
                <>
                  <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                </>
              ) : (
                group.contract_key
              )
            })()}
          </div>
          <div>
            <strong>Expiry:</strong> {fmtExpiry(group.expiry)} &nbsp;|&nbsp; <strong>STRIKE:</strong> {fmtUsd(group.strike)} &nbsp;|&nbsp; <strong>Net qty:</strong> {group.net_qty}
          </div>
          <div>
            <strong>Side:</strong> {expiredCloseSide}
          </div>
        </div>
        <form
          className="replay-expired-close-form"
          onSubmit={async e => {
            e.preventDefault()
            setError(null)
            if (!baseExec) {
              setError('Cannot determine base execution for this group.')
              return
            }
            const qRaw = Number(form.quantity)
            const q = Math.abs(qRaw)
            const priceNum = Number(form.price)
            if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(priceNum)) {
              setError('Fill quantity (> 0) and price.')
              return
            }
            const accountId = (baseExec.account_id ?? '').trim()
            if (!accountId) {
              setError('Account is missing for this group; cannot create closing trade.')
              return
            }
            const quantityForDb = expiredCloseSide === 'SELL' ? -q : q
            const nowUnix = Math.floor(Date.now() / 1000)
            const body: Record<string, unknown> = {
              account_id: accountId,
              time: nowUnix,
              symbol: (baseExec.symbol ?? '').trim() || getContractLabelParts(group.contract_key).symbol || undefined,
              sec_type: (baseExec.sec_type || 'OPT').toUpperCase(),
              side: expiredCloseSide,
              quantity: quantityForDb,
              price: priceNum,
              source: 'journal_closed',
              expiry: group.expiry,
              strike: group.strike,
              option_right: baseExec.option_right || undefined,
              contract_key: group.contract_key,
              commission: form.commission ? Number(form.commission) : undefined,
              currency: baseExec.currency || undefined,
            }
            try {
              setSubmitting(true)
              const res = await createExecution(body)
              if (res.ok) {
                handleClose()
                await onSuccess()
              } else {
                setError(res.error ?? 'Add failed')
              }
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <div className="replay-expired-close-row">
            <label>
              Qty
              <input type="number" step="1" min="0" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} required />
            </label>
            <label>
              Price
              <input type="number" step="any" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} required />
            </label>
            <label>
              Commission
              <input type="number" step="any" value={form.commission} onChange={e => setForm(f => ({ ...f, commission: e.target.value }))} />
            </label>
          </div>
          <div className="replay-expired-close-actions">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
