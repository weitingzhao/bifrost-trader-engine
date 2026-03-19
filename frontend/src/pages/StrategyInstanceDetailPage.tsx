import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StrategyInstance, StatusResponse } from '../types'
import type { Execution } from '../types'
import type { PerformanceResponse } from '../types'
import type { StrategyStructure } from '../api'
import { fetchStrategyInstance, fetchPerformance, fetchExecutions, updateStrategyInstance, fetchStructure } from '../api'
import { fmtTs, fmtTsShort, fmtUsd, unixToDatetimeLocal, parseOptionContractKey } from '../utils/format'
import { RiskProfileDl } from '../components/RiskProfileDl'
import { summarizeLegs, summarizeConstraints, getStructureTypeLabel } from './strategy/strategyFormUtils'
import { computeRiskProfile, formatRiskHedgedBreakdown } from '../utils/riskProfile'
import type { RiskPosition, RiskProfile } from '../utils/riskProfile'

export interface StrategyInstanceDetailPageProps {
  strategyInstanceId: number
  status?: StatusResponse | null
}

export function StrategyInstanceDetailPage({
  strategyInstanceId,
  status,
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
  const [structure, setStructure] = useState<StrategyStructure | null>(null)
  const [structureLoading, setStructureLoading] = useState(false)
  const [structureError, setStructureError] = useState<string | null>(null)

  const loadInstance = useCallback((): Promise<void> => {
    setInstanceLoading(true)
    setInstanceError(null)
    return fetchStrategyInstance(strategyInstanceId)
      .then(setInstance)
      .catch((e) => setInstanceError(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstanceLoading(false))
      .then(() => undefined)
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
      summary_only: true,
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

  const loadStructure = useCallback((strategy_structure_id: number) => {
    setStructureLoading(true)
    setStructureError(null)
    fetchStructure(strategy_structure_id)
      .then(setStructure)
      .catch((e) => setStructureError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStructureLoading(false))
  }, [])

  useEffect(() => {
    let cancelled = false
    loadInstance().then(() => {
      if (cancelled) return
      loadPerformance()
      loadExecutions()
    })
    return () => {
      cancelled = true
    }
  }, [strategyInstanceId, loadInstance, loadPerformance, loadExecutions])

  useEffect(() => {
    const sid = instance?.strategy_structure_id
    if (sid != null && Number.isFinite(sid)) {
      loadStructure(sid)
    } else {
      setStructure(null)
      setStructureLoading(false)
      setStructureError(null)
    }
  }, [instance?.strategy_structure_id, loadStructure])

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

  const riskProfile = useMemo(() => {
    if (!executions.length) return null
    const hasUnderlying = structure?.legs?.some(l => (l.role ?? '').toLowerCase() === 'underlying')
    const byAcct = new Map<string, Execution[]>()
    for (const e of executions) {
      if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
      const aid = (e.account_id ?? '').trim()
      if (!byAcct.has(aid)) byAcct.set(aid, [])
      byAcct.get(aid)!.push(e)
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
    let merged: RiskProfile | null = null
    for (const exs of byAcct.values()) {
      const netByKey = new Map<string, { strike: number; right: 'C' | 'P'; qty: number; totalCost: number }>()
      for (const e of exs) {
        const parsed = parseOptionContractKey(e.contract_key)
        const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
        if (!r) continue
        const strike = Number(parsed.strike) || 0
        if (strike <= 0) continue
        const key = `${strike}|${r}`
        const side = (e.side ?? '').toUpperCase()
        const qty = Math.abs(Number(e.quantity) || 0)
        const price = Number(e.price) || 0
        const signedQty = (side === 'BUY' || side === 'BOT' || side === 'B') ? qty : -qty
        const prev = netByKey.get(key) ?? { strike, right: r, qty: 0, totalCost: 0 }
        prev.qty += signedQty
        prev.totalCost += price * qty * (signedQty > 0 ? 1 : -1)
        netByKey.set(key, prev)
      }
      const positions: RiskPosition[] = []
      for (const [, v] of netByKey) {
        if (v.qty === 0) continue
        const avgCost = Math.abs(v.totalCost / v.qty)
        positions.push({ strike: v.strike, right: v.right, qty: v.qty, avg_cost: avgCost })
      }
      if (positions.length === 0) continue
      let covShares = 0
      let covAvgCost: number | null = null
      if (hasUnderlying && status?.accounts) {
        const sym = (exs[0]?.symbol ?? '').toUpperCase()
        const acct = (exs[0]?.account_id ?? '').trim()
        if (sym && acct) {
          const accRow = status.accounts.find(a => (a.account_id ?? '').trim() === acct)
          const stk = accRow?.positions?.find(
            p => (p.secType ?? '').toUpperCase() !== 'OPT' && (p.symbol ?? '').toUpperCase() === sym,
          )
          if (stk) {
            covShares = Math.abs(Number(stk.position) || 0)
            covAvgCost = stk.avgCost != null ? Number(stk.avgCost) : null
          }
        }
      }
      const rp = computeRiskProfile(positions, covShares, covAvgCost)
      merged = merged == null ? rp : pickWorse(merged, rp)
    }
    return merged
  }, [executions, structure, status?.accounts])

  return (
    <div className="card process-section">
      <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
        Instance {strategyInstanceId}
      </h2>

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
              <dd>
                {instance.strategy_opportunity_id != null && Number.isFinite(Number(instance.strategy_opportunity_id)) ? (
                  <a
                    href={`#/strategies/opportunities/${instance.strategy_opportunity_id}`}
                    className="instance-sheet-inst-link"
                  >
                    {instance.strategy_opportunity_name ?? `Opportunity #${instance.strategy_opportunity_id}`}
                  </a>
                ) : (
                  <span>{instance.strategy_opportunity_name ?? instance.strategy_opportunity_id ?? '—'}</span>
                )}
              </dd>
              <dt>Structure</dt>
              <dd>
                {instance.strategy_structure_name != null || instance.strategy_structure_id != null ? (
                  <span>{instance.strategy_structure_name ?? `Structure ${instance.strategy_structure_id}`}</span>
                ) : (
                  '—'
                )}
                {instance.strategy_structure_id != null && instance.strategy_structure_name != null && (
                  <span className="muted" style={{ marginLeft: '0.25rem' }}>({instance.strategy_structure_id})</span>
                )}
              </dd>
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

          {/* 1b. Strategy Structure block (from opportunity → strategy_structure_id) */}
          {instance.strategy_structure_id != null && (
            <section className="detail-block" style={{ marginTop: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem' }}>Strategy Structure</h3>
              {structureLoading ? (
                <p>Loading structure…</p>
              ) : structureError != null ? (
                <p className="error-message">{structureError}</p>
              ) : structure != null ? (
                <>
                  <dl className="info-dl" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0 }}>
                    <dt>Name</dt>
                    <dd>
                      {structure.name}
                      <span className="muted" style={{ marginLeft: '0.25rem' }}>({structure.strategy_structure_id})</span>
                    </dd>
                    <dt>Type</dt>
                    <dd>{getStructureTypeLabel(structure.structure_type)}</dd>
                    {structure.structure_subtype != null && structure.structure_subtype !== '' && (
                      <>
                        <dt>Subtype</dt>
                        <dd>{structure.structure_subtype_label ?? structure.structure_subtype}</dd>
                      </>
                    )}
                    {structure.template_display_name != null && structure.template_display_name !== '' && (
                      <>
                        <dt>Template</dt>
                        <dd>{structure.template_display_name}</dd>
                      </>
                    )}
                    <dt>Legs</dt>
                    <dd title={summarizeLegs(structure.legs)}>{summarizeLegs(structure.legs)}</dd>
                    <dt>Constraints</dt>
                    <dd title={summarizeConstraints(structure.constraints)}>{summarizeConstraints(structure.constraints)}</dd>
                  </dl>
                </>
              ) : (
                <p className="muted">Structure not found.</p>
              )}
            </section>
          )}

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
          </section>

          {riskProfile && (
            <section className="detail-block risk-profile-section" style={{ marginTop: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem' }}>Risk Profile (at expiration)</h3>
              <RiskProfileDl profile={riskProfile} fmtUsd={fmtUsd} />
              {riskProfile.naked_short_call_contracts > 0 && (
                <ul className="risk-hedged-breakdown" style={{ margin: '0.75rem 0 0', paddingLeft: '1.25rem' }}>
                  {formatRiskHedgedBreakdown(riskProfile).map((line, i) => (
                    <li key={i} className="risk-unlimited-warning">{line}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="detail-block" style={{ marginTop: '1.5rem' }}>
            <h4 style={{ marginTop: '0', marginBottom: '0.5rem' }}>Executions</h4>
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
