import { useCallback, useEffect, useState } from 'react'
import type { Execution, OptionStockLinkRow } from '../../types'
import {
  createOptionStockLink,
  deleteOptionStockLink,
  fetchOptionStockLinks,
  fetchStockLinkCandidates,
} from '../../api/trading/executions'
import { fmtTradeDate, fmtUsd } from '../../utils/format'

export interface LinkOptionStockContext {
  execution: Execution
}

interface LinkOptionStockModalProps {
  open: boolean
  context: LinkOptionStockContext | null
  onClose: () => void
  onSuccess: () => void | Promise<void>
}

export function LinkOptionStockModal({ open, context, onClose, onSuccess }: LinkOptionStockModalProps) {
  const [loading, setLoading] = useState(false)
  const [links, setLinks] = useState<OptionStockLinkRow[]>([])
  const [slippageTotal, setSlippageTotal] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<Execution[]>([])
  const [underlyingHint, setUnderlyingHint] = useState<string | null>(null)
  const [dateWindow, setDateWindow] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [selectedStockIds, setSelectedStockIds] = useState<Set<number>>(new Set())
  const [linkRole, setLinkRole] = useState<'' | 'exercise' | 'assignment'>('')
  const [linking, setLinking] = useState(false)
  const [unlinkConfirm, setUnlinkConfirm] = useState<{
    open: boolean
    linkId: number | null
    confirming: boolean
  }>({ open: false, linkId: null, confirming: false })

  const ex = context?.execution
  const accountId = (ex?.account_id ?? '').trim()
  const optId = ex?.account_executions_id

  const refresh = useCallback(async () => {
    if (!accountId || optId == null) return
    setLoading(true)
    setFormError(null)
    try {
      const [linksRes, candRes] = await Promise.all([
        fetchOptionStockLinks(accountId, optId),
        fetchStockLinkCandidates({
          account_id: accountId,
          option_account_executions_id: optId,
          limit: 200,
        }),
      ])
      setLinks(linksRes.links)
      setSlippageTotal(linksRes.slippage_total ?? null)
      setCandidates(candRes.executions)
      setUnderlyingHint(candRes.underlying_symbol ?? null)
      if (candRes.trade_date_from && candRes.trade_date_to) {
        setDateWindow(`${candRes.trade_date_from} — ${candRes.trade_date_to}`)
      } else {
        setDateWindow(null)
      }
      const err = linksRes.error || candRes.error
      if (err) setFormError(err)
      setSelectedStockIds(new Set())
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [accountId, optId])

  useEffect(() => {
    if (!open || !ex || optId == null) {
      setLinks([])
      setCandidates([])
      setFormError(null)
      setSelectedStockIds(new Set())
      setLinkRole('')
      setUnlinkConfirm({ open: false, linkId: null, confirming: false })
      return
    }
    void refresh()
  }, [open, ex, optId, refresh])

  const toggleSelect = (stockId: number) => {
    setSelectedStockIds(prev => {
      const n = new Set(prev)
      if (n.has(stockId)) n.delete(stockId)
      else n.add(stockId)
      return n
    })
  }

  const handleLinkSelected = async () => {
    if (!accountId || optId == null || selectedStockIds.size === 0) return
    setLinking(true)
    setFormError(null)
    const warnings: string[] = []
    try {
      for (const sid of selectedStockIds) {
        const res = await createOptionStockLink({
          account_id: accountId,
          option_account_executions_id: optId,
          stock_account_executions_id: sid,
          role: linkRole || undefined,
        })
        if (!res.ok) {
          setFormError(res.error ?? 'Link failed')
          setLinking(false)
          return
        }
        if (res.warning) warnings.push(res.warning)
      }
      if (warnings.length > 0) {
        setFormError(warnings.join(' '))
      }
      await refresh()
      await onSuccess()
    } finally {
      setLinking(false)
    }
  }

  const requestUnlink = (linkId: number) => {
    setUnlinkConfirm({ open: true, linkId, confirming: false })
  }

  const confirmUnlink = async () => {
    const lid = unlinkConfirm.linkId
    if (lid == null || !accountId) {
      setUnlinkConfirm({ open: false, linkId: null, confirming: false })
      return
    }
    setUnlinkConfirm(prev => ({ ...prev, confirming: true }))
    const res = await deleteOptionStockLink(lid, accountId)
    if (!res.ok) {
      setFormError(res.error ?? 'Remove link failed')
    } else {
      await refresh()
      await onSuccess()
    }
    setUnlinkConfirm({ open: false, linkId: null, confirming: false })
  }

  if (!open || !ex) return null

  const symLabel = (ex.symbol ?? ex.contract_key ?? 'Option').trim() || 'Option'

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-opt-stock-title"
      onClick={() => {
        if (unlinkConfirm.open || linking) return
        onClose()
      }}
    >
      <div className="modal-panel replay-exec-modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
        <h3 id="link-opt-stock-title" className="section-subtitle" style={{ marginTop: 0 }}>
          Link stock fills
        </h3>
        <p className="section-hint" style={{ marginBottom: 'var(--space-3)' }}>
          Option: <strong>{symLabel}</strong>
          {optId != null ? (
            <span className="replay-contract-exec-id"> #{optId}</span>
          ) : null}
          {underlyingHint ? (
            <>
              {' '}
              · Underlying <strong>{underlyingHint}</strong>
            </>
          ) : null}
          {dateWindow ? <> · Date window: {dateWindow}</> : null}
        </p>
        <p className="section-hint" style={{ marginBottom: 'var(--space-4)' }}>
          Tie underlying stock execution rows (performance book) to this option fill for exercise or assignment. Slippage vs
          Flex close is signed quantity × (price − close).
        </p>

        {formError && (
          <p className="section-hint replay-form-error" style={{ marginBottom: 'var(--space-2)' }}>
            {formError}
          </p>
        )}

        <div style={{ marginBottom: 'var(--space-3)' }}>
          <strong>Linked stock executions</strong>
          {slippageTotal != null && (
            <span style={{ marginLeft: 'var(--space-3)' }}>
              Total slippage vs close: <strong>{fmtUsd(slippageTotal)}</strong>
            </span>
          )}
        </div>
        {loading ? (
          <p className="section-hint">Loading…</p>
        ) : links.length === 0 ? (
          <p className="section-hint">No stock legs linked yet.</p>
        ) : (
          <div className="replay-portfolio-table-wrap" style={{ marginBottom: 'var(--space-4)' }}>
            <table className="table-operations table-compact">
              <thead>
                <tr>
                  <th>Stock id</th>
                  <th>Symbol</th>
                  <th>Trade date</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Close</th>
                  <th>Slippage</th>
                  <th>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map(row => (
                  <tr key={row.link_id}>
                    <td>#{row.stock_account_executions_id}</td>
                    <td>{row.stock_symbol ?? '—'}</td>
                    <td>{row.stock_trade_date ? fmtTradeDate(row.stock_trade_date) : '—'}</td>
                    <td>{row.stock_quantity != null ? Number(row.stock_quantity) : '—'}</td>
                    <td>{fmtUsd(row.stock_price)}</td>
                    <td>{fmtUsd(row.stock_close_price)}</td>
                    <td>{row.slippage_vs_close != null ? fmtUsd(row.slippage_vs_close) : '—'}</td>
                    <td>{row.role ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => requestUnlink(row.link_id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <label className="replay-form-label" htmlFor="link-opt-stock-role">
            Role for new links
          </label>
          <select
            id="link-opt-stock-role"
            className="replay-form-input"
            value={linkRole}
            onChange={e => setLinkRole(e.target.value as '' | 'exercise' | 'assignment')}
          >
            <option value="">(unspecified)</option>
            <option value="exercise">exercise</option>
            <option value="assignment">assignment</option>
          </select>
        </div>

        <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>Candidates (not yet linked)</strong>
        {loading ? null : candidates.length === 0 ? (
          <p className="section-hint">No matching STK rows in this window (check Flex sync).</p>
        ) : (
          <div className="replay-portfolio-table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="table-operations table-compact">
              <thead>
                <tr>
                  <th className="replay-th-narrow" />
                  <th>Id</th>
                  <th>Symbol</th>
                  <th>Trade date</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Close</th>
                  <th>Slippage</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(c => {
                  const sid = c.account_executions_id
                  if (sid == null) return null
                  const slip = (c as Execution & { slippage_vs_close?: number | null }).slippage_vs_close
                  return (
                    <tr key={sid}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedStockIds.has(sid)}
                          onChange={() => toggleSelect(sid)}
                          aria-label={`Select stock execution ${sid}`}
                        />
                      </td>
                      <td>#{sid}</td>
                      <td>{c.symbol ?? '—'}</td>
                      <td>{c.trade_date ? fmtTradeDate(c.trade_date) : '—'}</td>
                      <td>{c.quantity != null ? Number(c.quantity) : '—'}</td>
                      <td>{fmtUsd(c.price)}</td>
                      <td>{fmtUsd(c.close_price)}</td>
                      <td>{slip != null ? fmtUsd(slip) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={linking}>
            Close
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void handleLinkSelected()}
            disabled={linking || selectedStockIds.size === 0 || loading}
          >
            {linking ? 'Linking…' : 'Link selected'}
          </button>
        </div>
      </div>

      {unlinkConfirm.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unlink-stock-link-title"
          style={{ zIndex: 60 }}
          onClick={() => {
            if (!unlinkConfirm.confirming) setUnlinkConfirm({ open: false, linkId: null, confirming: false })
          }}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="unlink-stock-link-title" className="section-subtitle" style={{ marginTop: 0 }}>
              Remove stock link
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              This removes the association between this option fill and the selected stock execution. It does not delete any
              execution rows.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setUnlinkConfirm({ open: false, linkId: null, confirming: false })}
                disabled={unlinkConfirm.confirming}
              >
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={() => void confirmUnlink()} disabled={unlinkConfirm.confirming}>
                {unlinkConfirm.confirming ? 'Removing…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
