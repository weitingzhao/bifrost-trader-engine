import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StrategyInstance, StatusResponse, Execution, PerformanceResponse, OptionStockLinkSummary } from '../types'
import type { StrategyStructure } from '../api'
import { fetchStrategyInstance, fetchPerformance, fetchExecutions, fetchStructure } from '../api'
import { fetchOptionStockLinkMapForExecutions } from './performance/fetchOptionStockLinkMap'
import { fmtUsd, parseOptionContractKey } from '../utils/format'
import { RiskProfileDl } from '../components/RiskProfileDl'
import { computeRiskProfile, formatRiskHedgedBreakdown } from '../utils/riskProfile'
import type { RiskPosition, RiskProfile } from '../utils/riskProfile'
import {
  buildInstanceLinkedStockPnlRows,
  describeInstanceAllocationSplitForDisplay,
  instanceOptionStockSlippageAdjustment,
  sliceExecutionForInstanceOptView,
} from './portfolio/ledgerOptHelpers'
import { InstanceDetailHeader } from './strategy/instanceDetail/InstanceDetailHeader'
import { InstanceOverviewCard } from './strategy/instanceDetail/InstanceOverviewCard'
import { InstanceStructureCard } from './strategy/instanceDetail/InstanceStructureCard'
import { InstancePnLStrip } from './strategy/instanceDetail/InstancePnLStrip'
import { InstanceExecutionsPanel } from './strategy/instanceDetail/InstanceExecutionsPanel'
import { computeInstanceExecDerivedNetPnl } from './strategy/instanceDetail/instanceDetailPnlMetrics'

export interface StrategyInstanceDetailPageProps {
  strategyInstanceId: number
  status?: StatusResponse | null
  embedded?: boolean
}

export function StrategyInstanceDetailPage({
  strategyInstanceId,
  status,
  embedded = false,
}: StrategyInstanceDetailPageProps) {
  const [instance, setInstance] = useState<StrategyInstance | null>(null)
  const [instanceLoading, setInstanceLoading] = useState(true)
  const [instanceError, setInstanceError] = useState<string | null>(null)
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null)
  const [performanceLoading, setPerformanceLoading] = useState(true)
  const [executionsFinal, setExecutionsFinal] = useState<Execution[]>([])
  const [executionsTwsRaw, setExecutionsTwsRaw] = useState<Execution[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(true)
  const [structure, setStructure] = useState<StrategyStructure | null>(null)
  const [structureLoading, setStructureLoading] = useState(false)
  const [structureError, setStructureError] = useState<string | null>(null)
  /** Bulk option id → linked stock legs + slippage (same POST as Trade Ledger). */
  const [optionStockLinkByOptionId, setOptionStockLinkByOptionId] = useState<
    Record<number, OptionStockLinkSummary>
  >({})

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
    Promise.all([
      fetchExecutions(undefined, undefined, 500, false, undefined, strategyInstanceId, 'performance_book')
        .then((res) => res.executions ?? [])
        .catch(() => []),
      fetchExecutions(undefined, undefined, 500, false, undefined, strategyInstanceId, 'tws_raw')
        .then((res) => res.executions ?? [])
        .catch(() => []),
    ])
      .then(([final, tws]) => {
        setExecutionsFinal(final)
        setExecutionsTwsRaw(tws)
      })
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

  const executionsFinalForInstance = useMemo(() => {
    return executionsFinal
      .map((ex) => sliceExecutionForInstanceOptView(ex, strategyInstanceId))
      .filter((row): row is Execution => row != null)
  }, [executionsFinal, strategyInstanceId])

  const executionsTwsForInstance = useMemo(() => {
    return executionsTwsRaw
      .map((ex) => sliceExecutionForInstanceOptView(ex, strategyInstanceId))
      .filter((row): row is Execution => row != null)
  }, [executionsTwsRaw, strategyInstanceId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const combined = [...executionsFinalForInstance, ...executionsTwsForInstance]
      if (combined.length === 0) {
        if (!cancelled) setOptionStockLinkByOptionId({})
        return
      }
      const map = await fetchOptionStockLinkMapForExecutions(combined)
      if (!cancelled) setOptionStockLinkByOptionId(map)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [executionsFinalForInstance, executionsTwsForInstance])

  /** Parent |qty| per OPT account_executions_id (final + TWS raw) for prorating linked-stock slippage on instance slices. */
  const parentOptQtyByExecId = useMemo(() => {
    const m = new Map<number, number>()
    const ingest = (list: Execution[]) => {
      for (const ex of list) {
        if ((ex.sec_type ?? '').toUpperCase() !== 'OPT') continue
        const id = ex.account_executions_id
        if (id == null) continue
        m.set(Number(id), Math.abs(Number(ex.quantity) || 0))
      }
    }
    ingest(executionsFinal)
    ingest(executionsTwsRaw)
    return m
  }, [executionsFinal, executionsTwsRaw])

  const optionStockSlippageAdjustmentForInstance = useMemo(
    () =>
      instanceOptionStockSlippageAdjustment(executionsFinal, strategyInstanceId, optionStockLinkByOptionId),
    [executionsFinal, strategyInstanceId, optionStockLinkByOptionId],
  )

  const linkedStockPnlRows = useMemo(
    () => buildInstanceLinkedStockPnlRows(executionsFinal, strategyInstanceId, optionStockLinkByOptionId),
    [executionsFinal, strategyInstanceId, optionStockLinkByOptionId],
  )

  /** Net PnL from execution slice + prorated option–stock slippage (authoritative vs broker summary). */
  const execDerivedNetPnl = useMemo(
    () => computeInstanceExecDerivedNetPnl(executionsFinalForInstance, optionStockSlippageAdjustmentForInstance),
    [executionsFinalForInstance, optionStockSlippageAdjustmentForInstance],
  )

  const executionsFinalSplitMetaByExecId = useMemo(() => {
    const m = new Map<number, { ratioLabel: string; tooltip: string }>()
    for (const ex of executionsFinal) {
      const d = describeInstanceAllocationSplitForDisplay(ex, strategyInstanceId)
      if (d != null && ex.account_executions_id != null) {
        try {
          m.set(Number(ex.account_executions_id), d)
        } catch {
          /* ignore */
        }
      }
    }
    return m
  }, [executionsFinal, strategyInstanceId])

  const riskProfile = useMemo(() => {
    if (!executionsFinalForInstance.length) return null
    const hasUnderlying = structure?.legs?.some((l) => (l.role ?? '').toLowerCase() === 'underlying')
    const byAcct = new Map<string, Execution[]>()
    for (const e of executionsFinalForInstance) {
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
        const signedQty = side === 'BUY' || side === 'BOT' || side === 'B' ? qty : -qty
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
      const portfolioAccounts = status?.portfolio?.accounts
      if (hasUnderlying && portfolioAccounts) {
        const sym = (exs[0]?.symbol ?? '').toUpperCase()
        const acct = (exs[0]?.account_id ?? '').trim()
        if (sym && acct) {
          const accRow = portfolioAccounts.find(
            (a: { account_id?: string | null }) => (a.account_id ?? '').trim() === acct,
          )
          const stk = accRow?.positions?.find(
            (p: { secType?: string | null; symbol?: string | null; position?: number | null; avgCost?: number | null }) =>
              (p.secType ?? '').toUpperCase() !== 'OPT' && (p.symbol ?? '').toUpperCase() === sym,
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
  }, [executionsFinalForInstance, structure, status?.portfolio?.accounts])

  return (
    <div className={`${embedded ? '' : 'card process-section '}instance-detail-page${embedded ? ' instance-detail-page-embedded' : ''}`}>
      {instanceLoading ? (
        <p>Loading instance…</p>
      ) : instance == null ? (
        <p className="error-message">{instanceError ?? 'Instance not found.'}</p>
      ) : (
        <>
          {!embedded && <InstanceDetailHeader strategyInstanceId={strategyInstanceId} instance={instance} />}

          {instanceError != null && <p className="error-message">{instanceError}</p>}

          <div className="instance-detail-main-grid">
            <InstanceOverviewCard
              instance={instance}
              executionsForPosition={executionsFinalForInstance}
              executionsLoading={executionsLoading}
            />
            <InstanceStructureCard
              instance={instance}
              structure={structure}
              structureLoading={structureLoading}
              structureError={structureError}
            />
            <div className="instance-detail-pnl-column">
              <InstancePnLStrip
                loading={performanceLoading}
                performance={performance}
                executionsForNotional={executionsFinalForInstance}
                optionStockSlippageAdjustment={optionStockSlippageAdjustmentForInstance}
                linkedStockPnlRows={linkedStockPnlRows}
                execDerivedNetPnl={execDerivedNetPnl}
                riskProfile={riskProfile}
              />
            </div>
          </div>

          {riskProfile && (
            <section className="detail-block risk-profile-section instance-detail-risk">
              <h3 className="instance-detail-section-title">Risk profile (at expiration)</h3>
              <RiskProfileDl profile={riskProfile} fmtUsd={fmtUsd} />
              {riskProfile.naked_short_call_contracts > 0 && (
                <ul className="risk-hedged-breakdown" style={{ margin: '0.75rem 0 0', paddingLeft: '1.25rem' }}>
                  {formatRiskHedgedBreakdown(riskProfile).map((line, i) => (
                    <li key={i} className="risk-unlimited-warning">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <InstanceExecutionsPanel
            loading={executionsLoading}
            executionsFinal={executionsFinalForInstance}
            executionsTws={executionsTwsForInstance}
            splitMetaByExecId={executionsFinalSplitMetaByExecId}
            optionStockLinkByOptionId={optionStockLinkByOptionId}
            parentOptQtyByExecId={parentOptQtyByExecId}
          />

          <section className="detail-block placeholder-block instance-detail-future-card">
            <h3 className="instance-detail-section-title">Coming soon</h3>
            <ul>
              <li>Backtest for this instance</li>
              <li>Capital usage for this instance</li>
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
