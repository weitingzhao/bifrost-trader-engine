import { useCallback, useEffect, useState } from 'react'
import type { StrategyInstance } from '../types'
import type { Execution } from '../types'
import type { PerformanceResponse } from '../types'
import { fetchStrategyInstance, fetchPerformance, fetchExecutions, updateStrategyInstance } from '../api'
import { fmtTs, fmtTsShort, fmtUsd, unixToDatetimeLocal } from '../utils/format'

export interface StrategyInstanceDetailPageProps {
  strategyInstanceId: number
  onBackToList: () => void
  onNavigateToStrategy?: () => void
  /** Navigate to Strategy Structure tab (optionally to view a specific structure). */
  onNavigateToStructure?: (structureId?: number) => void
  breadcrumbLabel?: string
}

export function StrategyInstanceDetailPage({
  strategyInstanceId,
  onBackToList,
  onNavigateToStrategy,
  breadcrumbLabel = 'Instances',
}: StrategyInstanceDetailPageProps) {
  const [instance, setInstance] = useState<StrategyInstance | null>(null)
  const [instanceLoading, setInstanceLoading] = useState(true)
  const [instanceError, setInstanceError] = useState<string | null>(null)
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null)
  const [performanceLoading, setPerformanceLoading] = useState(true)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(true)
  const [openedAtEdit, setOpenedAtEdit] = useState<string>('')
  const [openedAtSaving, setOpenedAtSaving] = useState(false)
  const [openedAtError, setOpenedAtError] = useState<string | null>(null)

  const loadInstance = useCallback(() => {
    setInstanceLoading(true)
    setInstanceError(null)
    fetchStrategyInstance(strategyInstanceId)
      .then(setInstance)
      .catch((e) => setInstanceError(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstanceLoading(false))
  }, [strategyInstanceId])

  const loadPerformance = useCallback(() => {
    setPerformanceLoading(true)
    const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 86400
    const now = Math.floor(Date.now() / 1000)
    fetchPerformance({
      since_ts: oneYearAgo,
      until_ts: now,
      granularity: 'day',
      strategy_instance_id: strategyInstanceId,
    })
      .then(setPerformance)
      .catch(() => setPerformance(null))
      .finally(() => setPerformanceLoading(false))
  }, [strategyInstanceId])

  const loadExecutions = useCallback(() => {
    setExecutionsLoading(true)
    fetchExecutions(undefined, undefined, 500, false, undefined, strategyInstanceId)
      .then((res) => setExecutions(res.executions ?? []))
      .catch(() => setExecutions([]))
      .finally(() => setExecutionsLoading(false))
  }, [strategyInstanceId])

  useEffect(() => {
    loadInstance()
  }, [loadInstance])

  useEffect(() => {
    loadPerformance()
  }, [loadPerformance])

  useEffect(() => {
    loadExecutions()
  }, [loadExecutions])

  useEffect(() => {
    if (instance?.opened_at_epoch != null) {
      setOpenedAtEdit(unixToDatetimeLocal(instance.opened_at_epoch).slice(0, 10))
    } else if (instance?.opened_at != null && typeof instance.opened_at === 'string') {
      try {
        const ts = new Date(instance.opened_at).getTime() / 1000
        if (Number.isFinite(ts)) setOpenedAtEdit(unixToDatetimeLocal(ts).slice(0, 10))
      } catch {
        setOpenedAtEdit('')
      }
    } else {
      setOpenedAtEdit('')
    }
    setOpenedAtError(null)
  }, [instance?.opened_at_epoch, instance?.opened_at])

  const oldestExecution =
    executions.length > 0
      ? executions.reduce((a, b) => {
          const at = a.time != null && Number.isFinite(a.time) ? a.time : Infinity
          const bt = b.time != null && Number.isFinite(b.time) ? b.time : Infinity
          return at <= bt ? a : b
        })
      : null
  const canQuickSet = oldestExecution != null

  const handleQuickSetOpenedAt = useCallback(() => {
    if (!canQuickSet || oldestExecution == null) return
    const tradeDate = oldestExecution.trade_date?.trim()
    const dateStr =
      tradeDate && tradeDate.length >= 10
        ? tradeDate.slice(0, 10)
        : oldestExecution.time != null && Number.isFinite(oldestExecution.time)
          ? unixToDatetimeLocal(oldestExecution.time).slice(0, 10)
          : ''
    if (dateStr) setOpenedAtEdit(dateStr)
  }, [canQuickSet, oldestExecution])

  const handleSaveOpenedAt = useCallback(async () => {
    if (instance == null || !openedAtEdit.trim()) return
    setOpenedAtSaving(true)
    setOpenedAtError(null)
    try {
      // Send date as UTC noon so the day does not flip in any timezone when displayed
      const iso = openedAtEdit.trim() + 'T12:00:00.000Z'
      await updateStrategyInstance(instance.strategy_instance_id, { opened_at: iso })
      await loadInstance()
    } catch (e) {
      setOpenedAtError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpenedAtSaving(false)
    }
  }, [instance, openedAtEdit, loadInstance])

  const summary = performance?.summary

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          <button type="button" className="page-title-breadcrumb-link" onClick={onNavigateToStrategy}>
            Strategy
          </button>
          {' / '}
          <button type="button" className="page-title-breadcrumb-link" onClick={onBackToList}>
            {breadcrumbLabel}
          </button>
          {' / Instance '}
          {strategyInstanceId}
        </h2>
        <button type="button" className="btn btn-secondary" onClick={onBackToList}>
          Back to list
        </button>
      </div>

      {instanceError != null && (
        <p className="error-message" style={{ marginTop: '0.5rem' }}>{instanceError}</p>
      )}

      {instanceLoading ? (
        <p style={{ marginTop: '1rem' }}>Loading instance…</p>
      ) : instance == null ? (
        <p style={{ marginTop: '1rem' }}>Instance not found.</p>
      ) : (
        <>
          {/* 1. Strategy info block */}
          <section className="detail-block" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Strategy info</h3>
            <dl className="info-dl" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0 }}>
              <dt>Opportunity</dt>
              <dd>{instance.strategy_opportunity_name ?? instance.strategy_opportunity_id ?? '—'}</dd>
              <dt>Account</dt>
              <dd>{instance.account_id}</dd>
              <dt>Opened at</dt>
              <dd>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    value={openedAtEdit}
                    onChange={(e) => setOpenedAtEdit(e.target.value)}
                    className="create-instance-input"
                    style={{ maxWidth: '12rem' }}
                    aria-label="Opened at (editable)"
                  />
                  <button
                    type="button"
                    className="btn btn-small btn-secondary"
                    onClick={handleQuickSetOpenedAt}
                    disabled={!canQuickSet}
                    title="Set Opened at to the Trade date of the oldest execution below"
                  >
                    Quick Set
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={handleSaveOpenedAt}
                    disabled={openedAtSaving || !openedAtEdit.trim()}
                  >
                    {openedAtSaving ? 'Saving…' : 'Save'}
                  </button>
                  {openedAtError != null && (
                    <span className="section-hint replay-form-error" style={{ display: 'block', width: '100%' }}>
                      {openedAtError}
                    </span>
                  )}
                </span>
              </dd>
              <dt>Created at</dt>
              <dd>
                {instance.created_at_epoch != null
                  ? fmtTs(instance.created_at_epoch)
                  : instance.created_at ?? '—'}
              </dd>
              <dt>Label</dt>
              <dd>{instance.label ?? '—'}</dd>
              {instance.notes != null && instance.notes.trim() !== '' && (
                <>
                  <dt>Notes</dt>
                  <dd>{instance.notes}</dd>
                </>
              )}
            </dl>
          </section>

          {/* 2. PnL block */}
          <section className="detail-block" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>PnL (this instance)</h3>
            {performanceLoading ? (
              <p>Loading performance…</p>
            ) : summary ? (
              <dl className="info-dl" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0 }}>
                <dt>Net PnL</dt>
                <dd>{fmtUsd(summary.net_pnl)}</dd>
                <dt>Realized PnL</dt>
                <dd>{fmtUsd(summary.total_realized_pnl)}</dd>
                <dt>Commission</dt>
                <dd>{fmtUsd(summary.total_commission)}</dd>
                <dt>Trade count</dt>
                <dd>{summary.trade_count ?? 0}</dd>
                {summary.win_rate != null && (
                  <>
                    <dt>Win rate</dt>
                    <dd>{(Number(summary.win_rate) * 100).toFixed(1)}%</dd>
                  </>
                )}
              </dl>
            ) : (
              <p>No performance data for this instance.</p>
            )}

            <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Executions</h4>
            {executionsLoading ? (
              <p>Loading executions…</p>
            ) : executions.length === 0 ? (
              <p>No executions for this instance.</p>
            ) : (
              <div className="table-wrapper" style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th title="Display date: trade_date if set, otherwise exec time">Date</th>
                      <th>Trade date</th>
                      <th>Report date</th>
                      <th>Settle date target</th>
                      <th>Transaction type</th>
                      <th>Taxes</th>
                      <th>Net cash</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Realized PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executions.map((e) => (
                      <tr key={e.account_executions_id ?? e.exec_id ?? Math.random()}>
                        <td
                          title={e.account_executions_id != null ? `account_executions_id: ${e.account_executions_id}` : undefined}
                        >
                          {e.symbol ?? '—'}
                        </td>
                        <td>
                          {e.trade_date ?? (e.time != null ? fmtTsShort(e.time) : '—')}
                        </td>
                        <td>{e.trade_date ?? '—'}</td>
                        <td>{e.report_date ?? '—'}</td>
                        <td>{e.settle_date_target ?? '—'}</td>
                        <td>{e.transaction_type ?? '—'}</td>
                        <td>{e.taxes != null ? fmtUsd(e.taxes) : '—'}</td>
                        <td>{e.net_cash != null ? fmtUsd(e.net_cash) : '—'}</td>
                        <td>{e.side ?? '—'}</td>
                        <td>{e.quantity ?? '—'}</td>
                        <td>{e.price != null ? Number(e.price).toFixed(2) : '—'}</td>
                        <td>{e.realized_pnl != null ? fmtUsd(e.realized_pnl) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 3. Risk placeholder */}
          <section className="detail-block placeholder-block" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Risk</h3>
            <p className="muted">Coming soon. Link to risk view when available.</p>
          </section>

          {/* 4. Backtest placeholder */}
          <section className="detail-block placeholder-block" style={{ marginTop: '1rem' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Backtest</h3>
            <p className="muted">Coming soon. Link to backtest when available.</p>
          </section>

          {/* 5. Capital placeholder */}
          <section className="detail-block placeholder-block" style={{ marginTop: '1rem' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Capital usage</h3>
            <p className="muted">Coming soon. Capital usage for this instance.</p>
          </section>
        </>
      )}
    </div>
  )
}
