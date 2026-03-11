import { useEffect, useState } from 'react'
import type { Execution } from '../../types'
import { createExecution } from '../../api'
import { datetimeLocalToUnix, unixToDatetimeLocal } from '../../utils/format'

interface QuickCloseModalProps {
  exec: Execution | null
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

export function QuickCloseModal({ exec, onClose, onSuccess }: QuickCloseModalProps) {
  const [closeForm, setCloseForm] = useState({ time: '', commission: '', price: '' })
  const [closeError, setCloseError] = useState<string | null>(null)

  useEffect(() => {
    if (exec) {
      setCloseForm({
        time: unixToDatetimeLocal(Date.now() / 1000),
        commission: '',
        price: '',
      })
      setCloseError(null)
    }
  }, [exec])

  if (!exec) return null

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        onClose()
        setCloseError(null)
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-trade-modal-title"
    >
      <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
        <h3 id="close-trade-modal-title">Quick Trade (Close) — Pool=Off only</h3>
        {closeError && <p className="section-hint replay-form-error">{closeError}</p>}
        <form
          className="replay-exec-form"
          onSubmit={async e => {
            e.preventDefault()
            setCloseError(null)
            const sideUpper = (exec.side ?? '').toUpperCase()
            const isBuy = sideUpper === 'BUY' || sideUpper === 'BOT' || sideUpper === 'B'
            const closeSide = isBuy ? 'SELL' : 'BUY'
            const timeUnix = datetimeLocalToUnix(closeForm.time)
            const q = Number(exec.quantity)
            const contract_key = exec.contract_key ?? undefined
            const body: Record<string, unknown> = {
              account_id: (exec.account_id ?? '').trim(),
              time: timeUnix,
              symbol: (exec.symbol ?? '').trim(),
              sec_type: (exec.sec_type ?? 'OPT').toUpperCase(),
              side: closeSide,
              quantity: Number.isFinite(q) ? q : 0,
              price: closeForm.price.trim() !== '' && Number.isFinite(Number(closeForm.price)) ? Number(closeForm.price) : 0,
              source: 'manual',
              expiry: (exec.expiry ?? '').trim() || undefined,
              strike: exec.strike,
              option_right: (exec.option_right ?? 'C').toUpperCase().slice(0, 1),
              contract_key,
              commission: closeForm.commission.trim() !== '' && Number.isFinite(Number(closeForm.commission)) ? Number(closeForm.commission) : undefined,
              currency: 'USD',
            }
            const res = await createExecution(body)
            if (res.ok) {
              onClose()
              await onSuccess()
            } else {
              setCloseError(res.error ?? 'Close trade failed')
            }
          }}
        >
          <div className="replay-exec-form-row">
            <label>Account</label>
            <input type="text" value={exec.account_id ?? ''} readOnly className="replay-exec-readonly" />
          </div>
          <div className="replay-exec-form-row">
            <label>Symbol</label>
            <input type="text" value={exec.symbol ?? ''} readOnly className="replay-exec-readonly" />
          </div>
          <div className="replay-exec-form-row">
            <label>Quantity</label>
            <input type="text" value={exec.quantity ?? ''} readOnly className="replay-exec-readonly" />
          </div>
          <div className="replay-exec-form-row">
            <label>Expiry</label>
            <input type="text" value={exec.expiry ?? ''} readOnly className="replay-exec-readonly" />
          </div>
          <div className="replay-exec-form-row">
            <label>Strike</label>
            <input type="text" value={exec.strike ?? ''} readOnly className="replay-exec-readonly" />
          </div>
          <div className="replay-exec-form-row">
            <label>Side (close)</label>
            <input
              type="text"
              value={(exec.side ?? '').toUpperCase().startsWith('B') ? 'Sell' : 'Buy'}
              readOnly
              className="replay-exec-readonly"
            />
          </div>
          <div className="replay-exec-form-row">
            <label>Time</label>
            <input type="datetime-local" value={closeForm.time} onChange={e => setCloseForm(f => ({ ...f, time: e.target.value }))} required />
          </div>
          <div className="replay-exec-form-row">
            <label>Price (optional)</label>
            <input type="number" step="any" value={closeForm.price} onChange={e => setCloseForm(f => ({ ...f, price: e.target.value }))} placeholder="Leave empty for 0" />
          </div>
          <div className="replay-exec-form-row">
            <label>Commission (optional)</label>
            <input type="number" step="any" value={closeForm.commission} onChange={e => setCloseForm(f => ({ ...f, commission: e.target.value }))} placeholder="Leave empty" />
          </div>
          <div className="replay-exec-form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { onClose(); setCloseError(null) }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Add Close Trade
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
