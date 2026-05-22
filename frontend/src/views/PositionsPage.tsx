import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Execution, IbPositionRow, StatusResponse } from '../types'
import { deleteExecution, updateExecution } from '../api'
import type { StrategyStructure } from '../api/strategy/strategies'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { computeRiskProfile } from '../utils/riskProfile'
import type { RiskPosition } from '../utils/riskProfile'
import {
  getContractLabelParts,
  parseOptionContractKey,
} from '../utils/format'
import { executionMatchesInstanceGroup, sliceExecutionForInstanceOptView } from './portfolio/ledgerOptHelpers'
import {
  optExecutionMatchKey, buildLiveOptExecutionMap, positionExecsForAttribution,
  mergeExecsUniqueById, splitOffTrackTradesBySource,
  optionExpiryMatchesFilter,
  accountTotalCashBuyingPower, parseIbSummaryNumber, sumStockMarketValueForAccountFilter,
  sortStockCoverageItemsByColumn,
  fmtMvAbbrev, buildMarketValueTooltip,
  openPosAccountMatchesFilter, openPosShowOffTrack, liveStockRowCovKey,
  buildOptionContractLabel, pnlClassForTone,
  optionUnderlyingFootnote, DONUT_SYMBOL_COLORS, OPTION_STOCK_MIX_COLORS,
  UNDERLYING_CATEGORY_ORDER, UNDERLYING_CATEGORY_COLORS,
} from './positions/positionUtils'
import type {
  CoveragePoolSortCol, DonutSegment, OptionDetailFootnote, UnderlyingCategoryFilter,
  OptionStockMixCategory,
} from './positions/positionUtils'
import { PositionDonutChart } from './positions/PositionDonutChart'
import { StockBucketPanel } from './positions/StockBucketPanel'
import { useStrategyMeta } from './positions/hooks/useStrategyMeta'
import { useQuotesSubscription } from './positions/hooks/useQuotesSubscription'
import { usePositionInspectors } from './positions/hooks/usePositionInspectors'
import type { OptionExecRowActions } from './positions/OptionExecutionRow'
import { PositionCoverageCharts } from './positions/PositionCoverageCharts'
import { PositionOptionsTab } from './positions/PositionOptionsTab'
import type { OpenOptSort } from './positions/PositionOptionsTab'
import { PositionInstanceTab } from './positions/PositionInstanceTab'

type OpenPositionsTab = 'instance' | 'options' | 'stocks' | 'fixed_income' | 'cash_like'

import { isLedgerCashLikeCategory, isLedgerFixedIncomeCategory } from './portfolio/ledgerStockCategoryBuckets'
import { buildOptExecutionGroups } from './portfolio/buildOptExecutionGroups'
import { ExecutionFormModal } from './portfolio/ExecutionFormModal'
import type { LinkExecutionContext } from './portfolio/LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './portfolio/LinkExecutionRecordModal'
import { QuickCloseModal } from './portfolio/QuickCloseModal'
import { OptionContractDetailFromOpenPosition } from './optionDiscovery/OptionContractDetailFromOpenPosition'
import { RightInspectorDrawer } from '../components/RightInspectorDrawer'
import { StockInspectorPanel } from '../components/StockInspectorPanel'
import { StrategyInstanceDetailPage } from './StrategyInstanceDetailPage'
import type {
  InstanceAllGroup,
  InstancePositionGroup,
  InstanceStockCoverage,
  LivePositionRow,
  OpenOptionPosition,
  PortfolioView,
  StockCoverageItem,
} from './portfolio/types'
import { findLiveStockRowForAccount } from './portfolio/positionsInspectorUtils'
import { OFF_TRACK_ACCOUNT_ID, useExecutions } from './portfolio/useExecutions'

// ─────────────────────────────────────────────────────────────────────────────

interface PositionsPageProps {
  status: StatusResponse | null
  currentView?: PortfolioView
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
  /** Switch app to Research → Option Discovery (MVP: user picks expiry/strike there). */
  onOpenOptionDiscovery?: () => void
}

export function PositionsPage({
  status,
  currentView: _currentView,
  onViewChange,
  showViewTabs: _showViewTabs = true,
  onOpenOptionDiscovery,
}: PositionsPageProps) {
  const { executionsFinal, executionsTws, executionsCanonical, loadReplayData, executionAccountOptions } = useExecutions(
    status,
    undefined,
    false,
    true,
  )
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [editExecConfirmState, setEditExecConfirmState] = useState<{
    open: boolean
    exec: Execution | null
  }>({ open: false, exec: null })
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkContext, setLinkContext] = useState<LinkExecutionContext | null>(null)
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    exec: Execution | null
  }>({ open: false, title: '', message: '', confirming: false, exec: null })
  /** Pool=Off only: execution to close against; when set, show Quick Trade (Close) modal */
  const [closeAgainstExec, setCloseAgainstExec] = useState<Execution | null>(null)
  /** Inline error for e.g. delete execution failure (not modal form errors). */
  const [pageError, setPageError] = useState<string | null>(null)
  const [syncingTwsAttributionKey, setSyncingTwsAttributionKey] = useState<string | null>(null)
  const [syncingFinalAttributionKey, setSyncingFinalAttributionKey] = useState<string | null>(null)

  const handleSyncTwsStrategyFromFinal = useCallback(async (t: Execution, f: Execution) => {
    const id = t.account_executions_id
    if (id == null) return
    setSyncingTwsAttributionKey(String(id))
    setPageError(null)
    try {
      const res = await updateExecution(id, {
        strategy_instance_id: f.strategy_instance_id ?? null,
        strategy_opportunity_id: f.strategy_opportunity_id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'Sync failed')
      await loadReplayData()
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncingTwsAttributionKey(null)
    }
  }, [loadReplayData])

  const handleSyncFinalStrategyFromTws = useCallback(async (f: Execution, t: Execution) => {
    const id = f.account_executions_id
    if (id == null) return
    setSyncingFinalAttributionKey(String(id))
    setPageError(null)
    try {
      const res = await updateExecution(id, {
        strategy_instance_id: t.strategy_instance_id ?? null,
        strategy_opportunity_id: t.strategy_opportunity_id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'Sync failed')
      await loadReplayData()
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncingFinalAttributionKey(null)
    }
  }, [loadReplayData])

  const { attributions, loadAttributions, oppMap, structureMap } = useStrategyMeta()

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  /** Open positions: which configured IB accounts to include (multi-select; no "All"). */
  const [openFilterAccounts, setOpenFilterAccounts] = useState<{ host: boolean; secondary: boolean }>({
    host: true,
    secondary: true,
  })
  /** After ~420ms hold on selected HOST/Secondary bubble: “deselect” visual hint (cancel on pointer up). */
  const acctBubbleHoldTimerRef = useRef<number | null>(null)
  const [acctBubbleHoldHint, setAcctBubbleHoldHint] = useState<'host' | 'secondary' | null>(null)
  const finishAcctBubbleHold = useCallback(() => {
    if (acctBubbleHoldTimerRef.current) {
      clearTimeout(acctBubbleHoldTimerRef.current)
      acctBubbleHoldTimerRef.current = null
    }
    setAcctBubbleHoldHint(null)
  }, [])
  const onAcctBubblePointerDown = useCallback(
    (which: 'host' | 'secondary', currentlyActive: boolean) => {
      finishAcctBubbleHold()
      if (!currentlyActive) return
      acctBubbleHoldTimerRef.current = window.setTimeout(() => setAcctBubbleHoldHint(which), 420)
    },
    [finishAcctBubbleHold],
  )
  useEffect(
    () => () => {
      if (acctBubbleHoldTimerRef.current) clearTimeout(acctBubbleHoldTimerRef.current)
    },
    [],
  )
  const [openTab, setOpenTab] = useState<OpenPositionsTab>('instance')
  const [chartTypeFilter, setChartTypeFilter] = useState<string | null>(null)
  const [activeCategoryWeightFilter, setActiveCategoryWeightFilter] = useState<UnderlyingCategoryFilter | null>(null)
  const [optionDetailActiveLabel, setOptionDetailActiveLabel] = useState<string | null>(null)
  const [optionStockMixFilter, setOptionStockMixFilter] = useState<OptionStockMixCategory | null>(null)
  /** Option Detail + Category ring legends: show slice as % of ring or as abbreviated $. */
  const [optionRingLegendMode, setOptionRingLegendMode] = useState<'pct' | 'usd'>('pct')
  /** Account Asset mix: legend columns and donut center — % of chart basis vs full $. */
  const [coverageAssetMixLegendMode, setCoverageAssetMixLegendMode] = useState<'pct' | 'usd'>('pct')
  const [underlyingCategoryFilter, setUnderlyingCategoryFilter] = useState<Record<UnderlyingCategoryFilter, boolean>>({
    Stocks: true,
    'Fixed Income': false,
    'Cash-like': false,
  })
  /** Same scope as Account / Asset mix chips: All vs one IB account for top-row portfolio donuts. */
  const [stockCoverageSectionAccount, setStockCoverageSectionAccount] = useState<string>('all')
  const { stockInspector, optionInspector, strategyInspectorInstanceId, openStockInspector, openOptionInspector, openStrategyInspector, handleNavigateOptionDiscovery, closeStockInspector, closeOptionInspector, closeStrategyInspector } = usePositionInspectors({ openTab, onOpenOptionDiscovery, onClearError: () => setPageError(null) })
  const [instanceFilterStructureType, setInstanceFilterStructureType] = useState<string>('all')
  const [instanceFilterScopeType, setInstanceFilterScopeType] = useState<string>('all')
  const [instanceFilterOppName, setInstanceFilterOppName] = useState<string>('all')
  const [instanceFilterAttributionType, setInstanceFilterAttributionType] = useState<string>('all')
  const getPositionKey = (p: OpenOptionPosition, instId: number | null | undefined) =>
    `${instId ?? 'none'}-${p.contract_key}-${p.strike}-${p.expiry}-${p.pool_label}-${p.account_id}${p.filtered_exec_lists ? '-unc' : ''}`
  /** Options tab (physical rows only): stable expand key without instance slice. */
  const getOptionsTabPositionKey = (p: OpenOptionPosition) =>
    `${p.pool_label}-${p.account_id}-${p.contract_key}-${p.expiry}-${p.strike}`
  const [expandedPositionKeys, setExpandedPositionKeys] = useState<string[]>([])
  const togglePositionExpand = (posKey: string) => {
    setExpandedPositionKeys(prev => {
      const isOpen = prev.includes(posKey)
      if (openAccordionMode) return isOpen ? [] : [posKey]
      return isOpen ? prev.filter(k => k !== posKey) : [...prev, posKey]
    })
  }
  const [openOptSort, setOpenOptSort] = useState<OpenOptSort>({
    column: 'expiry',
    dir: 'desc',
  })

  const [openAccordionMode, setOpenAccordionMode] = useState<boolean>(true)
  const quotesMap = useQuotesSubscription()

  /** OPT rows present in unified `account_executions` (canonical), keyed like optExecutionMatchKey — for TWS sync precheck. */
  const canonicalOptContractKeySet = useMemo(() => {
    const s = new Set<string>()
    for (const e of executionsCanonical) {
      if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
      if (e.account_executions_id == null) continue
      s.add(optExecutionMatchKey(e.account_id ?? '', e.contract_key ?? ''))
    }
    return s
  }, [executionsCanonical])

  const handleEditExec = useCallback((exec: Execution) => {
    setPageError(null)
    setEditExecConfirmState({ open: true, exec })
  }, [])
  const handleLinkExec = useCallback((exec: Execution) => {
    if (exec.account_executions_id == null) return
    setLinkContext({ account_executions_id: exec.account_executions_id, execution: exec })
    setLinkModalOpen(true)
    setPageError(null)
  }, [])
  const handleCloseAgainstExec = useCallback((exec: Execution) => {
    setCloseAgainstExec(exec)
    setPageError(null)
  }, [])
  const handleDeleteExec = useCallback((exec: Execution) => {
    setPageError(null)
    setDeleteConfirmState({
      open: true,
      title: 'Delete execution',
      message: 'This will permanently remove this execution from the trade ledger. This cannot be undone.',
      confirming: false,
      exec,
    })
  }, [])
  const execRowActions = useMemo((): OptionExecRowActions => ({
    onSyncTwsStrategyFromFinal: handleSyncTwsStrategyFromFinal,
    onSyncFinalStrategyFromTws: handleSyncFinalStrategyFromTws,
    onOpenStrategyInspector: openStrategyInspector,
    onEdit: handleEditExec,
    onLink: handleLinkExec,
    onCloseAgainst: handleCloseAgainstExec,
    onDelete: handleDeleteExec,
  }), [handleSyncTwsStrategyFromFinal, handleSyncFinalStrategyFromTws, openStrategyInspector, handleEditExec, handleLinkExec, handleCloseAgainstExec, handleDeleteExec])

  const openOffTrackBaseExecutions = useMemo(() => {
    let list = [...executionsFinal, ...executionsTws]
    list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expFilter = openFilterExpiryStart.trim()
    if (expFilter) {
      list = list.filter(e => optionExpiryMatchesFilter((e.expiry ?? '').trim(), expFilter))
    }
    return list
  }, [executionsFinal, executionsTws, openFilterSymbol, openFilterExpiryStart])

  const livePositions = useMemo((): LivePositionRow[] => {
    const accounts = status?.portfolio?.accounts ?? []
    const hostId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
    const secRaw = (status?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
    let rows = accounts.flatMap(account => {
      const accId = (account.account_id ?? '').trim()
      if (!openPosAccountMatchesFilter(accId, openFilterAccounts, hostId, secRaw)) return []
      return (account.positions ?? [])
        .filter(position => {
          const qty = Number(position.position)
          return Number.isFinite(qty) && qty !== 0
        })
        .map(position => ({
          ...position,
          account_id: accId,
        }))
    })

    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) {
      rows = rows.filter(position => (position.symbol ?? '').toUpperCase() === sym)
    }

    const expFilter = openFilterExpiryStart.trim()
    if (expFilter) {
      rows = rows.filter(position => {
        if ((position.secType ?? '').toUpperCase() !== 'OPT') return true
        return optionExpiryMatchesFilter(
          (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim(),
          expFilter,
        )
      })
    }

    rows.sort((a, b) => {
      const aSym = (a.symbol ?? '').toUpperCase()
      const bSym = (b.symbol ?? '').toUpperCase()
      if (aSym !== bSym) return aSym.localeCompare(bSym)
      return (a.account_id ?? '').localeCompare(b.account_id ?? '')
    })
    return rows
  }, [
    openFilterAccounts,
    openFilterExpiryStart,
    openFilterSymbol,
    status?.portfolio?.accounts,
    status?.config?.ib_client?.account?.event_host,
    status?.config?.ib_client?.account?.event_secondary,
  ])

  const liveOptionPositions = useMemo(() => {
    const rows = livePositions.filter(p => (p.secType ?? '').toUpperCase() === 'OPT')
    if (!chartTypeFilter) return rows
    return rows.filter(p => {
      const qty   = Number(p.position)
      const right = (p.right ?? '').toUpperCase()
      if (chartTypeFilter === 'Long Call')  return qty > 0 && right === 'C'
      if (chartTypeFilter === 'Short Call') return qty < 0 && right === 'C'
      if (chartTypeFilter === 'Long Put')   return qty > 0 && right === 'P'
      if (chartTypeFilter === 'Short Put')  return qty < 0 && right === 'P'
      return true
    })
  }, [livePositions, chartTypeFilter])

  const executionsFinalIdSet = useMemo(
    () => new Set(executionsFinal.map(e => e.account_executions_id).filter((id): id is number => id != null)),
    [executionsFinal],
  )
  const executionsTwsIdSet = useMemo(
    () => new Set(executionsTws.map(e => e.account_executions_id).filter((id): id is number => id != null)),
    [executionsTws],
  )

  const livePositionExecutionsFinalMap = useMemo(
    () => buildLiveOptExecutionMap(executionsFinal),
    [executionsFinal],
  )
  const livePositionExecutionsTwsMap = useMemo(
    () => buildLiveOptExecutionMap(executionsTws),
    [executionsTws],
  )

  const getPositionExecLists = useCallback(
    (pos: OpenOptionPosition): { final: Execution[]; tws: Execution[]; merged: Execution[] } => {
      if (pos.filtered_exec_lists) {
        const { final, tws } = pos.filtered_exec_lists
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      if (pos.kind === 'live' && pos.position) {
        const key = optExecutionMatchKey(pos.account_id, pos.contract_key)
        const final = livePositionExecutionsFinalMap.get(key) ?? []
        const tws = livePositionExecutionsTwsMap.get(key) ?? []
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      if (pos.kind === 'offtrack') {
        const { final, tws } = splitOffTrackTradesBySource(pos.trades, executionsFinalIdSet, executionsTwsIdSet)
        return { final, tws, merged: mergeExecsUniqueById(final, tws) }
      }
      return { final: [], tws: [], merged: [] }
    },
    [
      livePositionExecutionsFinalMap,
      livePositionExecutionsTwsMap,
      executionsFinalIdSet,
      executionsTwsIdSet,
    ],
  )

  /** Instance row: per option, abs execution qtys joined by comma; Final book when any Final matches (else TWS). Option groups separated by fullwidth | */
  const formatInstanceOptExecQtyCell = useCallback(
    (allGroup: InstanceAllGroup): string => {
      const instId = allGroup.strategy_instance_id
      const oppId = allGroup.strategy_opportunity_id
      const perOption: string[] = []
      for (const pos of allGroup.options) {
        const execMatchesInstance = (ex: Execution) => {
          if (pos.filtered_exec_lists) return true
          return executionMatchesInstanceGroup(ex, instId, oppId)
        }
        let final: Execution[] = []
        let tws: Execution[] = []
        if (pos.filtered_exec_lists) {
          final = pos.filtered_exec_lists.final.filter(execMatchesInstance)
          tws = pos.filtered_exec_lists.tws.filter(execMatchesInstance)
        } else {
          const lists = getPositionExecLists(pos)
          final = lists.final.filter(execMatchesInstance)
          tws = lists.tws.filter(execMatchesInstance)
        }
        const src = final.length > 0 ? final : tws
        const qtyStrs =
          src.length > 0
            ? src.map(ex => {
                const qRaw =
                  instId != null
                    ? sliceExecutionForInstanceOptView(ex, instId)?.quantity ?? ex.quantity
                    : ex.quantity
                return String(Math.abs(Number(qRaw) || 0))
              })
            : [String(Math.abs(pos.qty))]
        perOption.push(qtyStrs.join(', '))
      }
      return perOption.join(' ｜ ')
    },
    [getPositionExecLists],
  )

  /** Index live positions by (account_id, contract_key) for fast lookup when merging attribution data. */
  const livePositionMap = useMemo(() => {
    const m = new Map<string, LivePositionRow>()
    for (const pos of liveOptionPositions) {
      const key = `${(pos.account_id ?? '').trim()}\x00${(pos.contract_key ?? '').trim()}`
      m.set(key, pos)
    }
    return m
  }, [liveOptionPositions])

  const instanceGroups = useMemo((): InstancePositionGroup[] => {
    const hostId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
    const secRaw = (status?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
    const byInstance = new Map<string, { id: number | null; label: string | null; oppName: string | null; openedAt: number | null; positions: OpenOptionPosition[] }>()

    const addToInstance = (instId: number | null, instLabel: string | null, oppName: string | null, openedAt: number | null, pos: OpenOptionPosition) => {
      const key = instId != null ? String(instId) : '__unassigned__'
      if (!byInstance.has(key)) byInstance.set(key, { id: instId, label: instLabel, oppName, openedAt, positions: [] })
      byInstance.get(key)!.positions.push(pos)
    }

    const positionsHandledByAttribution = new Set<string>()

    for (const a of attributions) {
      if ((a.sec_type ?? '').toUpperCase() !== 'OPT') continue
      const acct = (a.account_id ?? '').trim()
      const ck = (a.contract_key ?? '').trim()
      if (!openPosAccountMatchesFilter(acct, openFilterAccounts, hostId, secRaw)) continue
      const sym = openFilterSymbol.trim().toUpperCase()
      if (sym && (a.symbol ?? '').toUpperCase() !== sym) continue
      const expFilter = openFilterExpiryStart.trim()
      if (expFilter && !optionExpiryMatchesFilter((a.expiry ?? '').trim(), expFilter)) continue

      positionsHandledByAttribution.add(`${acct}\x00${ck}`)

      const livePos = livePositionMap.get(`${acct}\x00${ck}`)
      const markPrice = livePos?.price != null && Number.isFinite(Number(livePos.price)) ? Number(livePos.price) : null
      const rawAvgCost = livePos?.avgCost != null && Number.isFinite(Number(livePos.avgCost)) ? Number(livePos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const estQty = a.open_qty_est
      const pnl = markPrice != null && avgCostPerShare != null
        ? (markPrice - avgCostPerShare) * estQty * 100
        : (a.unrealized_pnl_est ?? 0)
      const attrType: 'single' | 'mixed' | 'unassigned' =
        a.strategy_instance_id == null ? 'unassigned' : a.is_mixed ? 'mixed' : 'single'

      const pos: OpenOptionPosition = {
        kind: 'live',
        contract_key: ck,
        strike: a.strike ?? 0,
        expiry: a.expiry ?? '',
        qty: estQty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: livePos,
        attribution_type: attrType,
        attribution_ratio: a.attribution_ratio,
      }
      addToInstance(a.strategy_instance_id, a.strategy_instance_label, a.strategy_opportunity_name, a.strategy_instance_opened_at_epoch, pos)
    }

    for (const pos of liveOptionPositions) {
      const acct = (pos.account_id ?? '').trim()
      const ck = (pos.contract_key ?? '').trim()
      if (positionsHandledByAttribution.has(`${acct}\x00${ck}`)) continue

      const expiry = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
      const strike = Number(pos.strike) || 0
      const qty = Number(pos.position) || 0
      const rawAvgCost = pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) ? Number(pos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const markPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
      const pnl = markPrice != null && avgCostPerShare != null
        ? (markPrice - avgCostPerShare) * qty * 100
        : Number(pos.unrealized_pnl) || 0
      const contractKey = ck || `${pos.symbol ?? ''}|OPT|${expiry}|${strike}|${(pos.right ?? '').toUpperCase().slice(0, 1)}`
      addToInstance(null, null, null, null, {
        kind: 'live',
        contract_key: contractKey,
        strike,
        expiry,
        qty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: pos,
        attribution_type: 'unassigned',
      })
    }

    if (openPosShowOffTrack(openFilterAccounts, hostId, secRaw)) {
      const offTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions)
        .filter(g => g.status === 'unrealized')
      for (const group of offTrackGroups) {
        const pnl = group.sell_premium - group.buy_cost
        const avgPrice = group.net_qty > 0
          ? (group.buy_avg_price ?? 0)
          : (group.sell_avg_price ?? 0)
        addToInstance(null, null, null, null, {
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          qty: group.net_qty,
          avg_cost: avgPrice,
          mark_price: null,
          unrealized_pnl: pnl,
          pool_label: 'Off',
          account_id: (group.trades[0]?.account_id ?? '').trim(),
          trades: group.trades,
          attribution_type: 'unassigned',
        })
      }
    }

    const result: InstancePositionGroup[] = []
    for (const [, group] of byInstance) {
      group.positions.sort((a, b) => {
        const aSym = getContractLabelParts(a.contract_key).symbol
        const bSym = getContractLabelParts(b.contract_key).symbol
        if (aSym !== bSym) return aSym.localeCompare(bSym)
        if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry)
        return a.strike - b.strike
      })
      const totalPnl = group.positions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
      result.push({
        strategy_instance_id: group.id,
        strategy_instance_label: group.label,
        strategy_opportunity_name: group.oppName,
        strategy_instance_opened_at_epoch: group.openedAt,
        positions: group.positions,
        total_unrealized_pnl: totalPnl,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [
    attributions,
    openFilterAccounts,
    openFilterSymbol,
    openFilterExpiryStart,
    liveOptionPositions,
    livePositionMap,
    openOffTrackBaseExecutions,
    status?.config?.ib_client?.account?.event_host,
    status?.config?.ib_client?.account?.event_secondary,
  ])

  /** Options tab: one row per actual holding (IB snapshot + off-track), not per attribution / instance slice. */
  const optionsTabPositions = useMemo((): OpenOptionPosition[] => {
    const hostId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
    const secRaw = (status?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
    const rows: OpenOptionPosition[] = []
    for (const pos of liveOptionPositions) {
      const acct = (pos.account_id ?? '').trim()
      const ck = (pos.contract_key ?? '').trim()
      const expiry = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
      const strike = Number(pos.strike) || 0
      const qty = Number(pos.position) || 0
      const rawAvgCost = pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) ? Number(pos.avgCost) : null
      const avgCostPerShare = rawAvgCost != null ? (rawAvgCost >= 10 ? rawAvgCost / 100 : rawAvgCost) : null
      const markPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
      const pnl =
        markPrice != null && avgCostPerShare != null
          ? (markPrice - avgCostPerShare) * qty * 100
          : Number(pos.unrealized_pnl) || 0
      const contractKey =
        ck || `${pos.symbol ?? ''}|OPT|${expiry}|${strike}|${(pos.right ?? '').toUpperCase().slice(0, 1)}`
      const optKey = optExecutionMatchKey(acct, contractKey)
      const attrs = attributions.filter(a => {
        if ((a.sec_type ?? '').toUpperCase() !== 'OPT') return false
        if ((a.account_id ?? '').trim() !== acct) return false
        return optExecutionMatchKey(acct, a.contract_key ?? '') === optKey
      })
      let attribution_type: OpenOptionPosition['attribution_type'] = 'unassigned'
      if (attrs.length === 1) {
        const a0 = attrs[0]!
        attribution_type = a0.strategy_instance_id == null ? 'unassigned' : a0.is_mixed ? 'mixed' : 'single'
      } else if (attrs.length > 1) {
        const ids = new Set(attrs.map(a => a.strategy_instance_id))
        const anyMixed = attrs.some(a => a.is_mixed)
        attribution_type =
          anyMixed || ids.size > 1 ? 'mixed' : attrs[0]!.strategy_instance_id == null ? 'unassigned' : 'single'
      }
      rows.push({
        kind: 'live',
        contract_key: contractKey,
        strike,
        expiry,
        qty,
        avg_cost: avgCostPerShare,
        mark_price: markPrice,
        unrealized_pnl: pnl,
        pool_label: 'On',
        account_id: acct,
        position: pos,
        attribution_type,
      })
    }
    if (openPosShowOffTrack(openFilterAccounts, hostId, secRaw)) {
      const offTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions).filter(g => g.status === 'unrealized')
      for (const group of offTrackGroups) {
        const pnl = group.sell_premium - group.buy_cost
        const avgPrice = group.net_qty > 0 ? (group.buy_avg_price ?? 0) : (group.sell_avg_price ?? 0)
        rows.push({
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          qty: group.net_qty,
          avg_cost: avgPrice,
          mark_price: null,
          unrealized_pnl: pnl,
          pool_label: 'Off',
          account_id: (group.trades[0]?.account_id ?? '').trim(),
          trades: group.trades,
          attribution_type: 'unassigned',
        })
      }
    }
    return rows
  }, [
    liveOptionPositions,
    attributions,
    openFilterAccounts,
    openOffTrackBaseExecutions,
    status?.config?.ib_client?.account?.event_host,
    status?.config?.ib_client?.account?.event_secondary,
  ])

  const getPositionTime = (p: OpenOptionPosition): number | null => {
    if (p.kind === 'live' && p.position) {
      const ts = p.position.exec_time != null ? Number(p.position.exec_time) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    if (p.kind === 'offtrack' && p.trades?.length) {
      const ex = p.trades[0]
      const ts = ex.time != null ? Number(ex.time) : ex.created_at != null ? Number(ex.created_at) : null
      return ts != null && Number.isFinite(ts) ? ts : null
    }
    return null
  }

  const getPositionLast = (p: OpenOptionPosition): number | null => {
    const symbol = getContractLabelParts(p.contract_key).symbol
    if (!symbol) return null
    const q = quotesMap[symbol]
    return q?.last != null && Number.isFinite(q.last) ? q.last : null
  }

  /** Options tab: sorted physical rows. */
  const sortedOptionsTabPositions = useMemo((): OpenOptionPosition[] => {
    const list = [...optionsTabPositions]
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'contract') {
        const aParts = getContractLabelParts(a.contract_key)
        const bParts = getContractLabelParts(b.contract_key)
        const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
        if (cmp !== 0) return mult * cmp
        const cmpExp = a.expiry.localeCompare(b.expiry)
        if (cmpExp !== 0) return mult * cmpExp
        return mult * (a.strike - b.strike)
      }
      if (column === 'expiry') {
        const cmp = a.expiry.localeCompare(b.expiry)
        if (cmp !== 0) return mult * cmp
        return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
      }
      if (column === 'strike') {
        const cmp = a.strike - b.strike
        if (cmp !== 0) return mult * cmp
        return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
      }
      if (column === 'last') {
        const aLast = getPositionLast(a) ?? -Infinity
        const bLast = getPositionLast(b) ?? -Infinity
        if (aLast !== bLast) return mult * (aLast - bLast)
        return 0
      }
      if (column === 'qty') {
        return mult * (Math.abs(a.qty) - Math.abs(b.qty))
      }
      if (column === 'avg_cost') {
        return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
      }
      if (column === 'value') {
        const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
        const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
        return mult * (aVal - bVal)
      }
      if (column === 'time') {
        return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
      }
      return mult * (a.unrealized_pnl - b.unrealized_pnl)
    })
    return list
  }, [optionsTabPositions, openOptSort, quotesMap])

  const liveStockPositions = useMemo(() => {
    const rows = livePositions.filter(p => (p.secType ?? '').toUpperCase() !== 'OPT')
    if (!chartTypeFilter) return rows
    return rows.filter(p => {
      const qty = Number(p.position)
      if (chartTypeFilter === 'Long Stock')  return qty > 0
      if (chartTypeFilter === 'Short Stock') return qty < 0
      return true
    })
  }, [livePositions, chartTypeFilter])

  // Price resolution for donut charts: snapshot price → live quote → avgCost (cost basis).
  // All return values are per-share so callers can apply the OPT ×100 multiplier uniformly.
  const resolveDonutPrice = useCallback((pos: IbPositionRow): number | null => {
    if (pos.price != null && Number.isFinite(Number(pos.price)) && Number(pos.price) > 0)
      return Math.abs(Number(pos.price))
    const ck = pos.contract_key
    if (ck) {
      const q  = quotesMap[ck]
      const qp = q?.last ?? q?.mid
      if (qp != null && Number.isFinite(qp) && qp > 0) return Math.abs(qp)
    }
    if (pos.avgCost != null && Number.isFinite(Number(pos.avgCost)) && Math.abs(Number(pos.avgCost)) > 0) {
      const ac = Math.abs(Number(pos.avgCost))
      // IB avgCost for US options is per-contract (already includes ×100 multiplier);
      // normalize to per-share so the caller's `qty × price × 100` stays correct.
      if ((pos.secType ?? '').toUpperCase() === 'OPT') return ac / 100
      return ac
    }
    return null
  }, [quotesMap])

  const resolveUnderlyingCategory = useCallback((pos: IbPositionRow): UnderlyingCategoryFilter => {
    const raw = String(pos.category ?? '').trim()
    if (isLedgerFixedIncomeCategory(raw)) return 'Fixed Income'
    if (isLedgerCashLikeCategory(raw)) return 'Cash-like'
    return 'Stocks'
  }, [])

  // Donut by underlying symbol — STK only (options have their own column).
  const symbolDonutSegments = useMemo((): DonutSegment[] => {
    const all = status?.portfolio?.accounts ?? []
    const acct = stockCoverageSectionAccount
    const accounts = acct === 'all' ? all : all.filter(a => (a.account_id ?? '').trim() === acct)
    const bySymbol = new Map<string, { total: number; lines: { qty: number; price: number; mv: number }[] }>()
    for (const account of accounts) {
      for (const pos of account.positions ?? []) {
        if ((pos.secType ?? '').toUpperCase() === 'OPT') continue
        const cat = resolveUnderlyingCategory(pos)
        if (!underlyingCategoryFilter[cat]) continue
        const qty = Number(pos.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        const price = resolveDonutPrice(pos)
        if (price == null) continue
        const sym = (pos.symbol ?? '?').toUpperCase()
        const mv = Math.abs(qty) * price
        const rec = bySymbol.get(sym) ?? { total: 0, lines: [] as { qty: number; price: number; mv: number }[] }
        rec.lines.push({ qty: Math.abs(qty), price, mv })
        rec.total += mv
        bySymbol.set(sym, rec)
      }
    }
    return [...bySymbol.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([sym, agg], i) => ({
        label: sym,
        value: agg.total,
        color: DONUT_SYMBOL_COLORS[i % DONUT_SYMBOL_COLORS.length],
        marketValueTooltip: buildMarketValueTooltip(sym, agg.total, agg.lines),
      }))
  }, [
    status?.portfolio?.accounts,
    resolveDonutPrice,
    resolveUnderlyingCategory,
    underlyingCategoryFilter,
    stockCoverageSectionAccount,
  ])

  const categoryDetailLegendGroups = useMemo((): { category: UnderlyingCategoryFilter; segments: DonutSegment[] }[] => {
    const all = status?.portfolio?.accounts ?? []
    const acct = stockCoverageSectionAccount
    const accounts = acct === 'all' ? all : all.filter(a => (a.account_id ?? '').trim() === acct)
    const byCategorySymbol = new Map<UnderlyingCategoryFilter, Map<string, number>>()
    for (const account of accounts) {
      for (const pos of account.positions ?? []) {
        if ((pos.secType ?? '').toUpperCase() === 'OPT') continue
        const cat = resolveUnderlyingCategory(pos)
        if (!underlyingCategoryFilter[cat]) continue
        const qty = Number(pos.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        const price = resolveDonutPrice(pos)
        if (price == null) continue
        const sym = (pos.symbol ?? '?').toUpperCase()
        const mv = Math.abs(qty) * price
        if (!byCategorySymbol.has(cat)) byCategorySymbol.set(cat, new Map<string, number>())
        const m = byCategorySymbol.get(cat)!
        m.set(sym, (m.get(sym) ?? 0) + mv)
      }
    }
    const symbolColorMap = new Map<string, string>()
    const mvTipBySymbol = new Map<string, string | undefined>()
    for (const seg of symbolDonutSegments) {
      if (!symbolColorMap.has(seg.label)) symbolColorMap.set(seg.label, seg.color)
      mvTipBySymbol.set(seg.label, seg.marketValueTooltip)
    }
    return UNDERLYING_CATEGORY_ORDER
      .map(category => {
        const m = byCategorySymbol.get(category)
        if (!m || m.size === 0) return null
        const segments: DonutSegment[] = [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([label, value], idx): DonutSegment => ({
            label,
            value,
            color: symbolColorMap.get(label) ?? DONUT_SYMBOL_COLORS[idx % DONUT_SYMBOL_COLORS.length],
            marketValueTooltip: mvTipBySymbol.get(label),
          }))
        return { category, segments }
      })
      .filter((g): g is { category: UnderlyingCategoryFilter; segments: DonutSegment[] } => g != null)
  }, [
    status?.portfolio?.accounts,
    resolveUnderlyingCategory,
    underlyingCategoryFilter,
    resolveDonutPrice,
    symbolDonutSegments,
    stockCoverageSectionAccount,
  ])

  const underlyingCategorySegments = useMemo((): DonutSegment[] => {
    const all = status?.portfolio?.accounts ?? []
    const acct = stockCoverageSectionAccount
    const accounts = acct === 'all' ? all : all.filter(a => (a.account_id ?? '').trim() === acct)
    const byCategory = new Map<UnderlyingCategoryFilter, number>()
    for (const account of accounts) {
      for (const pos of account.positions ?? []) {
        if ((pos.secType ?? '').toUpperCase() === 'OPT') continue
        const cat = resolveUnderlyingCategory(pos)
        const qty = Number(pos.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        const price = resolveDonutPrice(pos)
        if (price == null) continue
        const mv = Math.abs(qty) * price
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + mv)
      }
    }
    return UNDERLYING_CATEGORY_ORDER
      .map(cat => ({
        label: cat,
        value: byCategory.get(cat) ?? 0,
        color: UNDERLYING_CATEGORY_COLORS[cat],
      }))
      .filter(seg => seg.value > 0)
  }, [status?.portfolio?.accounts, resolveDonutPrice, resolveUnderlyingCategory, stockCoverageSectionAccount])

  const anyUnderlyingCategoryEnabled = useMemo(
    () => UNDERLYING_CATEGORY_ORDER.some(cat => underlyingCategoryFilter[cat]),
    [underlyingCategoryFilter],
  )

  const handleCategoryWeightSelect = useCallback((label: string | null) => {
    /** Pie ring calls `onSegmentClick(null)` when re-clicking the active arc to clear selection. */
    if (label == null) {
      setActiveCategoryWeightFilter(null)
      return
    }
    const next = label as UnderlyingCategoryFilter
    if (activeCategoryWeightFilter === next) {
      setActiveCategoryWeightFilter(null)
      return
    }
    setActiveCategoryWeightFilter(next)
    if (label === 'Fixed Income') {
      setOpenTab('fixed_income')
      return
    }
    if (label === 'Cash-like') {
      setOpenTab('cash_like')
      return
    }
    if (label === 'Stocks') {
      setOpenTab('stocks')
    }
  }, [activeCategoryWeightFilter])

  useEffect(() => {
    const activeSymbol = openFilterSymbol.trim().toUpperCase()
    if (!activeSymbol) return
    const hasActiveSymbol = symbolDonutSegments.some(seg => seg.label === activeSymbol)
    if (!hasActiveSymbol) setOpenFilterSymbol('')
  }, [openFilterSymbol, symbolDonutSegments])

  const optionDetailSegments = useMemo((): DonutSegment[] => {
    const all = status?.portfolio?.accounts ?? []
    const acct = stockCoverageSectionAccount
    const accounts = acct === 'all' ? all : all.filter(a => (a.account_id ?? '').trim() === acct)
    const stkByAccount = new Map<string, IbPositionRow[]>()
    for (const account of accounts) {
      const accId = (account.account_id ?? '').trim()
      const stks = (account.positions ?? []).filter(p => (p.secType ?? '').toUpperCase() === 'STK')
      stkByAccount.set(accId, stks)
    }
    const byContract = new Map<string, { mv: number; foot: OptionDetailFootnote | null }>()
    for (const account of accounts) {
      const accId = (account.account_id ?? '').trim()
      const stocks = stkByAccount.get(accId) ?? []
      for (const pos of account.positions ?? []) {
        const qty = Number(pos.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        const price = resolveDonutPrice(pos)
        if (price == null) continue
        const secType = (pos.secType ?? '').toUpperCase()
        if (secType !== 'OPT') continue
        const contractLabel = buildOptionContractLabel(pos)
        if (!contractLabel) continue
        const mv = Math.abs(qty) * price * 100
        const foot = optionUnderlyingFootnote(pos, stocks, resolveDonutPrice)
        const prev = byContract.get(contractLabel) ?? { mv: 0, foot: null }
        prev.mv += mv
        prev.foot = foot
        byContract.set(contractLabel, prev)
      }
    }
    return [...byContract.entries()]
      .sort((a, b) => b[1].mv - a[1].mv)
      .map(([label, bucket], i) => ({
        label,
        value: bucket.mv,
        color: DONUT_SYMBOL_COLORS[i % DONUT_SYMBOL_COLORS.length],
        optionDetailFoot: bucket.foot ?? undefined,
      }))
  }, [status?.portfolio?.accounts, resolveDonutPrice, stockCoverageSectionAccount])

  const { fixedIncomeStockPositions, cashLikeStockPositions, coreStockPositions } = useMemo(() => {
    const fixedIncomeStockPositions: LivePositionRow[] = []
    const cashLikeStockPositions: LivePositionRow[] = []
    const coreStockPositions: LivePositionRow[] = []
    for (const p of liveStockPositions) {
      const cat = String(p.category ?? '').trim()
      if (isLedgerFixedIncomeCategory(cat)) fixedIncomeStockPositions.push(p)
      else if (isLedgerCashLikeCategory(cat)) cashLikeStockPositions.push(p)
      else coreStockPositions.push(p)
    }
    return { fixedIncomeStockPositions, cashLikeStockPositions, coreStockPositions }
  }, [liveStockPositions])

  const tryOpenStockFromSymbolAccount = useCallback(
    (symbol: string, accountId: string) => {
      const row = findLiveStockRowForAccount(liveStockPositions, symbol, accountId)
      if (!row) {
        const symU = (symbol ?? '').trim().toUpperCase()
        const acct = (accountId ?? '').trim() || '—'
        setPageError(`No ${symU} stock position in account ${acct} for the current filters (Open positions).`)
        return
      }
      setPageError(null)
      openStockInspector(row)
    },
    [liveStockPositions, openStockInspector],
  )

  /** Underlying spot for Option Discovery–style contract panel (BS / moneyness) when PG omits underlying_price. */
  const optionInspectorUnderlyingHint = useMemo(() => {
    if (optionInspector == null) return null
    const und = getContractLabelParts(optionInspector.contract_key).symbol.trim().toUpperCase()
    const acct = (optionInspector.account_id ?? '').trim()
    if (!und) return null
    const row = findLiveStockRowForAccount(liveStockPositions, und, acct)
    const px = row?.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null
    return px
  }, [optionInspector, liveStockPositions])


  const instanceDefaultAccountForStockInspect = useCallback((allGroup: InstanceAllGroup): string => {
    const fromOpts = allGroup.options.map(o => (o.account_id ?? '').trim()).filter(Boolean)
    const uniq = [...new Set(fromOpts)]
    if (uniq.length === 1) return uniq[0]!
    const sc = allGroup.stock_coverage[0]?.account_id?.trim()
    if (sc) return sc
    return uniq[0] ?? ''
  }, [])

  const instanceAllGroups = useMemo((): InstanceAllGroup[] => {
    type Bucket = {
      id: number | null
      label: string | null
      oppName: string | null
      oppId: number | null
      openedAt: number | null
      options: OpenOptionPosition[]
    }
    const map = new Map<string, Bucket>()
    const mergeMeta = (bucket: Bucket, patch: { label?: string | null; oppName?: string | null; oppId?: number | null; openedAt?: number | null }) => {
      if (patch.label != null && patch.label !== '' && !bucket.label) bucket.label = patch.label
      if (patch.oppName != null && patch.oppName !== '' && !bucket.oppName) bucket.oppName = patch.oppName
      if (patch.oppId != null && bucket.oppId == null) bucket.oppId = patch.oppId
      if (patch.openedAt != null && Number.isFinite(patch.openedAt) && bucket.openedAt == null) bucket.openedAt = patch.openedAt
    }
    for (const g of instanceGroups) {
      const key = g.strategy_instance_id != null ? String(g.strategy_instance_id) : '__unassigned__'
      const existing = map.get(key)
      if (existing) {
        existing.options.push(...g.positions)
        mergeMeta(existing, {
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          openedAt: g.strategy_instance_opened_at_epoch,
        })
      } else {
        map.set(key, {
          id: g.strategy_instance_id,
          label: g.strategy_instance_label,
          oppName: g.strategy_opportunity_name,
          oppId: null,
          openedAt: g.strategy_instance_opened_at_epoch,
          options: [...g.positions],
        })
      }
    }

    const resolveOppId = (bucket: Bucket): number | null => {
      /** Unassigned bucket: never infer opportunity from fills — no instance ⇒ no row-level opportunity (Uncategorized only). */
      if (bucket.id == null) return null
      if (bucket.oppId != null) return bucket.oppId
      for (const a of attributions) {
        if (a.strategy_instance_id === bucket.id && a.strategy_opportunity_id != null)
          return a.strategy_opportunity_id
      }
      for (const p of bucket.options) {
        if (p.filtered_exec_lists) continue
        const execs = positionExecsForAttribution(getPositionExecLists(p))
        for (const e of execs) {
          if (e.strategy_opportunity_id != null) return e.strategy_opportunity_id
        }
      }
      return null
    }

    /**
     * Fills that do not match this instance row → optional Uncategorized clone under Unassigned.
     * Skip positions already attributed by the backend (single or mixed) — the attribution API
     * is the source of truth; TWS raw fills lack instance tags by nature and must not cause
     * attributed positions to be duplicated under Uncategorized.
     */
    const unassignedKey = '__unassigned__'
    for (const [, b] of map) {
      if (b.id == null) continue
      const oppIdForMatch = resolveOppId(b)
      for (const p of b.options) {
        if (p.filtered_exec_lists) continue
        if (p.attribution_type === 'single' || p.attribution_type === 'mixed') continue
        const full = getPositionExecLists(p)
        const unscopedFinal = full.final.filter(
          ex => !executionMatchesInstanceGroup(ex, b.id, oppIdForMatch),
        )
        const unscopedTws = full.tws.filter(
          ex => !executionMatchesInstanceGroup(ex, b.id, oppIdForMatch),
        )
        if (unscopedFinal.length === 0 && unscopedTws.length === 0) continue
        let u = map.get(unassignedKey)
        if (!u) {
          u = { id: null, label: null, oppName: null, oppId: null, openedAt: null, options: [] }
          map.set(unassignedKey, u)
        }
        u.options.push({
          ...p,
          filtered_exec_lists: { final: unscopedFinal, tws: unscopedTws },
          attribution_type: 'unassigned',
        })
      }
    }

    const execPremiumPnl = (execs: Execution[]): number => {
      let sellPremium = 0
      let buyCost = 0
      for (const e of execs) {
        const side = (e.side ?? '').toUpperCase()
        const q = Math.abs(Number(e.quantity) || 0)
        const p = Number(e.price) || 0
        const c = Number(e.commission) || 0
        if (side === 'SELL' || side === 'SLD' || side === 'S') {
          sellPremium += p * q * 100 - c
        } else if (side === 'BUY' || side === 'BOT' || side === 'B') {
          buyCost += p * q * 100 + c
        }
      }
      return sellPremium - buyCost
    }

    const computeStockCoverage = (options: OpenOptionPosition[], str: StrategyStructure | undefined): InstanceStockCoverage[] => {
      if (!str?.legs?.length) return []
      const underlyingLeg = str.legs.find(l => (l.role ?? '').toLowerCase() === 'underlying')
      if (!underlyingLeg) return []
      const legDir = (underlyingLeg.direction ?? 'long').toLowerCase() as 'long' | 'short'
      const legQty = underlyingLeg.quantity ?? 1
      /** Same symbol may appear in multiple accounts; stock hedge is per account (no cross-margin). */
      const bySymbolAccount = new Map<string, { symbol: string; account_id: string; contracts: number }>()
      for (const p of options) {
        const sym = getContractLabelParts(p.contract_key).symbol
        if (!sym) continue
        const account_id = (p.account_id ?? '').trim()
        const k = `${sym}\x00${account_id}`
        const prev = bySymbolAccount.get(k) ?? { symbol: sym, account_id, contracts: 0 }
        prev.contracts += Math.abs(p.qty)
        bySymbolAccount.set(k, prev)
      }
      const result: InstanceStockCoverage[] = []
      for (const v of bySymbolAccount.values()) {
        result.push({
          symbol: v.symbol,
          account_id: v.account_id,
          required_shares: v.contracts * 100 * legQty,
          direction: legDir,
        })
      }
      result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
      return result
    }

    const pickWorseRiskProfile = (a: import('../utils/riskProfile').RiskProfile, b: import('../utils/riskProfile').RiskProfile) => {
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

    const result: InstanceAllGroup[] = []
    for (const [, b] of map) {
      const oppId = resolveOppId(b)
      let optPnl = 0
      for (const p of b.options) {
        if (p.filtered_exec_lists) {
          const matchedExecs = getPositionExecLists(p).merged
          if (matchedExecs.length > 0) {
            optPnl += execPremiumPnl(matchedExecs)
          } else {
            optPnl += p.unrealized_pnl
          }
          continue
        }
        const matchedExecs = positionExecsForAttribution(getPositionExecLists(p)).filter(ex =>
          executionMatchesInstanceGroup(ex, b.id, oppId),
        )
        if (matchedExecs.length > 0) {
          optPnl += execPremiumPnl(matchedExecs)
        } else {
          optPnl += p.unrealized_pnl
        }
      }
      const opp = oppId != null ? oppMap.get(oppId) : undefined
      const str = opp ? structureMap.get(opp.strategy_structure_id) : undefined
      const attrForInstance = b.id != null ? attributions.find(a => a.strategy_instance_id === b.id) : undefined
      const resolvedStructureType = str?.structure_type ?? attrForInstance?.structure_type ?? null
      const resolvedScopeType = opp?.scope_type ?? attrForInstance?.scope_type ?? null
      const optionsForRisk = b.options.filter(p => !p.filtered_exec_lists)
      const coverage = computeStockCoverage(optionsForRisk, str)

      let riskProfile = null as import('../utils/riskProfile').RiskProfile | null
      if (optionsForRisk.length > 0) {
        const byAcct = new Map<string, OpenOptionPosition[]>()
        for (const p of optionsForRisk) {
          const aid = (p.account_id ?? '').trim()
          if (!byAcct.has(aid)) byAcct.set(aid, [])
          byAcct.get(aid)!.push(p)
        }
        for (const optsInAcct of byAcct.values()) {
          const riskPositions: RiskPosition[] = []
          for (const p of optsInAcct) {
            const parsed = parseOptionContractKey(p.contract_key)
            const r = parsed.right === 'C' || parsed.right === 'P' ? parsed.right : null
            if (r && p.avg_cost != null) {
              riskPositions.push({ strike: p.strike, right: r, qty: p.qty, avg_cost: p.avg_cost })
            }
          }
          if (riskPositions.length === 0) continue
          let covShares = 0
          let covAvgCost: number | null = null
          const covRows = computeStockCoverage(optsInAcct, str)
          if (covRows.length > 0) {
            const optSym = getContractLabelParts(optsInAcct[0].contract_key).symbol?.toUpperCase() ?? ''
            const row =
              optSym && covRows.some(c => c.symbol.toUpperCase() === optSym)
                ? covRows.find(c => c.symbol.toUpperCase() === optSym)!
                : covRows[0]
            const sym = row.symbol
            const acct = row.account_id
            const heldPos = liveStockPositions.find(
              s =>
                (s.symbol ?? '').toUpperCase() === sym.toUpperCase() &&
                (s.account_id ?? '').trim() === acct,
            )
            const held = heldPos ? Math.abs(Number(heldPos.position) || 0) : 0
            covShares = Math.min(held, row.required_shares)
            covAvgCost = heldPos?.avgCost != null ? Number(heldPos.avgCost) : null
          }
          const rp = computeRiskProfile(riskPositions, covShares, covAvgCost)
          riskProfile = riskProfile == null ? rp : pickWorseRiskProfile(riskProfile, rp)
        }
      }

      result.push({
        strategy_instance_id: b.id,
        strategy_instance_label: b.label,
        strategy_opportunity_name: b.oppName ?? opp?.name ?? null,
        strategy_opportunity_id: oppId,
        strategy_instance_opened_at_epoch: b.openedAt,
        options: b.options,
        stock_coverage: coverage,
        options_unrealized_pnl: optPnl,
        structure_type: resolvedStructureType,
        scope_type: resolvedScopeType,
        risk_profile: riskProfile,
      })
    }
    result.sort((a, b) => {
      if (a.strategy_instance_id == null && b.strategy_instance_id != null) return 1
      if (a.strategy_instance_id != null && b.strategy_instance_id == null) return -1
      return (a.strategy_instance_label ?? '').localeCompare(b.strategy_instance_label ?? '')
    })
    return result
  }, [instanceGroups, oppMap, structureMap, getPositionExecLists, liveStockPositions, attributions])

  const stockCoverageItems = useMemo((): StockCoverageItem[] => {
    const covKey = (sym: string, accountId: string) =>
      `${(sym ?? '').toUpperCase().trim()}\x1f${(accountId ?? '').trim()}`
    type DemandMeta = {
      required: number
      requiredWatchlist: number
      instances: number
      oppNames: Set<string>
      watchlistScopeInstances: number
    }
    const demandMap = new Map<string, DemandMeta>()
    for (const g of instanceAllGroups) {
      const oppName = (g.strategy_opportunity_name ?? '').trim()
      const isWl = (g.scope_type ?? '').trim() === 'watchlist_stk'
      for (const sc of g.stock_coverage) {
        const sym = (sc.symbol ?? '').toUpperCase().trim()
        if (!sym) continue
        const k = covKey(sym, sc.account_id)
        const prev = demandMap.get(k) ?? {
          required: 0,
          requiredWatchlist: 0,
          instances: 0,
          oppNames: new Set<string>(),
          watchlistScopeInstances: 0,
        }
        prev.required += sc.required_shares
        if (isWl) prev.requiredWatchlist += sc.required_shares
        prev.instances += 1
        if (oppName) prev.oppNames.add(oppName)
        if (isWl) prev.watchlistScopeInstances += 1
        demandMap.set(k, prev)
      }
    }

    type HeldMeta = {
      held: number
      heldAbs: number
      costBasisAbs: number
      lastWeightedSum: number
      lastWeight: number
      dailyPnl: number
      dailyBaseAbs: number
      totalPnl: number
      optionableTrue: number
      optionableFalse: number
      optionableUnknown: number
    }
    const heldMap = new Map<string, HeldMeta>()
    for (const s of liveStockPositions) {
      const sym = (s.symbol ?? '').toUpperCase().trim()
      if (!sym) continue
      const k = covKey(sym, (s.account_id ?? '').trim())
      const qty = Number(s.position)
      if (!Number.isFinite(qty) || qty === 0) continue
      const absQty = Math.abs(qty)
      const avgCost = s.avgCost != null && Number.isFinite(Number(s.avgCost)) ? Number(s.avgCost) : null
      const lastPrice = s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
      const dailyPrevClose = s.daily_prev_close != null && Number.isFinite(Number(s.daily_prev_close))
        ? Number(s.daily_prev_close)
        : null
      const unrealizedPnl = s.unrealized_pnl != null && Number.isFinite(Number(s.unrealized_pnl))
        ? Number(s.unrealized_pnl)
        : (lastPrice != null && avgCost != null ? (lastPrice - avgCost) * qty : 0)

      const prev = heldMap.get(k) ?? {
        held: 0,
        heldAbs: 0,
        costBasisAbs: 0,
        lastWeightedSum: 0,
        lastWeight: 0,
        dailyPnl: 0,
        dailyBaseAbs: 0,
        totalPnl: 0,
        optionableTrue: 0,
        optionableFalse: 0,
        optionableUnknown: 0,
      }
      prev.held += qty
      prev.heldAbs += absQty
      if (avgCost != null) prev.costBasisAbs += absQty * avgCost
      if (lastPrice != null) {
        prev.lastWeightedSum += absQty * lastPrice
        prev.lastWeight += absQty
      }
      if (dailyPrevClose != null && lastPrice != null) {
        prev.dailyPnl += (lastPrice - dailyPrevClose) * qty
        prev.dailyBaseAbs += Math.abs(dailyPrevClose * qty)
      }
      prev.totalPnl += unrealizedPnl
      if (s.optionable === true) prev.optionableTrue += 1
      else if (s.optionable === false) prev.optionableFalse += 1
      else prev.optionableUnknown += 1
      heldMap.set(k, prev)
    }

    const allKeys = new Set([...demandMap.keys(), ...heldMap.keys()])
    const result: StockCoverageItem[] = []
    for (const key of allKeys) {
      const sep = key.indexOf('\x1f')
      const sym = sep >= 0 ? key.slice(0, sep) : key
      const account_id = sep >= 0 ? key.slice(sep + 1) : ''
      const demand = demandMap.get(key)
      const heldMeta = heldMap.get(key)
      const required = demand?.required ?? 0
      const held = heldMeta?.held ?? 0
      if (required === 0 && held === 0) continue
      const costBasis = heldMeta != null && heldMeta.costBasisAbs > 0 ? heldMeta.costBasisAbs : null
      const totalPnl = heldMeta != null && Number.isFinite(heldMeta.totalPnl) ? heldMeta.totalPnl : null
      const totalPct = costBasis != null && costBasis > 0 && totalPnl != null ? (totalPnl / costBasis) * 100 : null
      const dailyPct = heldMeta != null && heldMeta.dailyBaseAbs > 0 ? (heldMeta.dailyPnl / heldMeta.dailyBaseAbs) * 100 : null

      let optionableSupported: boolean | null = null
      if (heldMeta != null) {
        if (heldMeta.optionableTrue > 0 && heldMeta.optionableFalse === 0) optionableSupported = true
        else if (heldMeta.optionableFalse > 0 && heldMeta.optionableTrue === 0) optionableSupported = false
      }

      result.push({
        symbol: sym,
        account_id,
        required_shares: required,
        required_watchlist_shares: demand?.requiredWatchlist ?? 0,
        held_shares: held,
        surplus_or_gap: held - required,
        instances_needing: demand?.instances ?? 0,
        backing_opportunities: demand != null ? Array.from(demand.oppNames).sort() : [],
        watchlist_scope_instances: demand?.watchlistScopeInstances ?? 0,
        optionable_supported: optionableSupported,
        avg_cost_per_share: heldMeta != null && heldMeta.heldAbs > 0 ? heldMeta.costBasisAbs / heldMeta.heldAbs : null,
        live_last_price: heldMeta != null && heldMeta.lastWeight > 0 ? heldMeta.lastWeightedSum / heldMeta.lastWeight : null,
        cost_basis_total: costBasis,
        daily_pnl: heldMeta != null ? heldMeta.dailyPnl : null,
        daily_pct: dailyPct,
        total_pnl: totalPnl,
        total_pct: totalPct,
      })
    }
    result.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
    return result
  }, [instanceAllGroups, liveStockPositions])

  /** Watchlist opportunities: Required = watchlist-only hedge; Surplus vs that slice. */
  const watchlistOptionableCoverageItems = useMemo(
    () =>
      stockCoverageItems
        .filter((ci) => (ci.watchlist_scope_instances ?? 0) > 0 && ci.optionable_supported !== false)
        .map(ci => {
          const rw = ci.required_watchlist_shares ?? 0
          return { ...ci, required_shares: rw, surplus_or_gap: ci.held_shares - rw }
        }),
    [stockCoverageItems],
  )

  /**
   * Long stock left after all current opportunity hedges (watchlist + explicit); can back further options.
   */
  const optionUnderlyingPoolItems = useMemo((): StockCoverageItem[] => {
    const out: StockCoverageItem[] = []
    for (const ci of stockCoverageItems) {
      if (ci.optionable_supported === false) continue
      const held = ci.held_shares
      const req = ci.required_shares
      if (!Number.isFinite(held) || held <= 0) continue
      const avail = Math.max(0, held - req)
      if (avail <= 0) continue
      const ratio = held > 0 ? avail / held : 0
      const costSlice = ci.cost_basis_total != null ? ci.cost_basis_total * ratio : null
      const dailySlice = ci.daily_pnl != null ? ci.daily_pnl * ratio : null
      const totalSlice = ci.total_pnl != null ? ci.total_pnl * ratio : null
      const dailyPct =
        dailySlice != null && ci.daily_pnl != null && Math.abs(ci.daily_pnl) > 1e-9
          ? ci.daily_pct
          : null
      const totalPct =
        costSlice != null && costSlice > 0 && totalSlice != null ? (totalSlice / costSlice) * 100 : null
      out.push({
        ...ci,
        held_shares: avail,
        required_shares: 0,
        required_watchlist_shares: 0,
        surplus_or_gap: avail,
        cost_basis_total: costSlice,
        daily_pnl: dailySlice,
        daily_pct: dailyPct,
        total_pnl: totalSlice,
        total_pct: totalPct,
        instances_needing: 0,
        backing_opportunities: [],
        watchlist_scope_instances: 0,
      })
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.account_id.localeCompare(b.account_id))
    return out
  }, [stockCoverageItems])

  const optionUnderlyingPoolMarketTotal = useMemo(() => {
    const rows =
      stockCoverageSectionAccount === 'all'
        ? optionUnderlyingPoolItems
        : optionUnderlyingPoolItems.filter(
            ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
          )
    return rows.reduce((s, ci) => {
      const h = ci.held_shares
      const p = ci.live_last_price
      if (p == null || !Number.isFinite(p) || !Number.isFinite(h)) return s
      return s + h * p
    }, 0)
  }, [optionUnderlyingPoolItems, stockCoverageSectionAccount])

  /**
   * Option "Category" donut + header: Backing Pool (watchlist-backed shares MV), other optionable
   * stock MV excl. fixed income & cash-like (residual after backing), and cash-like STK MV.
   * Uses the same account scope as the Account asset mix column (stockCoverageSectionAccount).
   */
  const optionStockMix = useMemo(() => {
    const acct = stockCoverageSectionAccount
    const matchAcct = (accountId: string) => acct === 'all' || (accountId ?? '').trim() === acct

    let cashLikeMv = 0
    for (const p of liveStockPositions) {
      if ((p.secType ?? '').toUpperCase() !== 'STK') continue
      if (!matchAcct((p.account_id ?? '').trim())) continue
      const cat = String(p.category ?? '').trim()
      if (!isLedgerCashLikeCategory(cat)) continue
      const q = Number(p.position)
      const px = p.price != null ? Number(p.price) : NaN
      if (!Number.isFinite(q) || q === 0 || !Number.isFinite(px) || px <= 0) continue
      cashLikeMv += Math.abs(q) * px
    }

    let backingMv = 0
    for (const ci of watchlistOptionableCoverageItems) {
      if (!matchAcct((ci.account_id ?? '').trim())) continue
      const rw = ci.required_watchlist_shares ?? 0
      const backedShares = Math.min(Math.max(0, ci.held_shares), rw)
      const price = ci.live_last_price
      if (price == null || !Number.isFinite(price) || backedShares <= 0 || !Number.isFinite(backedShares)) continue
      backingMv += backedShares * price
    }

    let coreOptionableMv = 0
    for (const p of liveStockPositions) {
      if ((p.secType ?? '').toUpperCase() !== 'STK') continue
      if (!matchAcct((p.account_id ?? '').trim())) continue
      const cat = String(p.category ?? '').trim()
      if (isLedgerFixedIncomeCategory(cat)) continue
      if (isLedgerCashLikeCategory(cat)) continue
      if (p.optionable === false) continue
      const q = Number(p.position)
      const px = p.price != null ? Number(p.price) : NaN
      if (!Number.isFinite(q) || q === 0 || !Number.isFinite(px) || px <= 0) continue
      coreOptionableMv += Math.abs(q) * px
    }

    const otherMv = Math.max(0, coreOptionableMv - backingMv)
    const totalMv = backingMv + otherMv + cashLikeMv
    const pct = (v: number) => (totalMv > 0 ? (v / totalMv) * 100 : 0)

    const segments: DonutSegment[] = [
      { label: 'Backing Pool', value: backingMv, color: OPTION_STOCK_MIX_COLORS['Backing Pool'] },
      { label: 'Other Stock', value: otherMv, color: OPTION_STOCK_MIX_COLORS['Other Stock'] },
      { label: 'Cash-like', value: cashLikeMv, color: OPTION_STOCK_MIX_COLORS['Cash-like'] },
    ].filter(s => s.value > 0)

    return {
      segments,
      backingPct: pct(backingMv),
      otherPct: pct(otherMv),
      cashLikePct: pct(cashLikeMv),
    }
  }, [liveStockPositions, watchlistOptionableCoverageItems, stockCoverageSectionAccount])

  /** Row keys for Option Category → Stocks tab filter (same account scope as the ring). */
  const optionStockMixFilterKeys = useMemo(() => {
    const acct = stockCoverageSectionAccount
    const matchAcct = (accountId: string) => acct === 'all' || (accountId ?? '').trim() === acct

    const watchByKey = new Map<string, StockCoverageItem>()
    for (const ci of watchlistOptionableCoverageItems) {
      if (!matchAcct((ci.account_id ?? '').trim())) continue
      watchByKey.set(liveStockRowCovKey(ci), ci)
    }

    const backingKeys = new Set<string>()
    for (const ci of watchlistOptionableCoverageItems) {
      if (!matchAcct((ci.account_id ?? '').trim())) continue
      const rw = ci.required_watchlist_shares ?? 0
      const backed = Math.min(Math.max(0, ci.held_shares), rw)
      if (backed > 1e-9) backingKeys.add(liveStockRowCovKey(ci))
    }

    const otherKeys = new Set<string>()
    for (const p of liveStockPositions) {
      if ((p.secType ?? '').toUpperCase() !== 'STK') continue
      if (!matchAcct((p.account_id ?? '').trim())) continue
      const cat = String(p.category ?? '').trim()
      if (isLedgerFixedIncomeCategory(cat) || isLedgerCashLikeCategory(cat)) continue
      if (p.optionable === false) continue
      const q = Number(p.position)
      const px = p.price != null ? Number(p.price) : NaN
      if (!Number.isFinite(q) || q === 0 || !Number.isFinite(px) || px <= 0) continue
      const key = liveStockRowCovKey(p)
      const rowMv = Math.abs(q) * px
      const ci = watchByKey.get(key)
      const rw = ci?.required_watchlist_shares ?? 0
      const backedShares = ci ? Math.min(Math.max(0, ci.held_shares), rw) : 0
      const price = ci?.live_last_price
      const backingMv =
        price != null && Number.isFinite(price) && backedShares > 0 && Number.isFinite(backedShares)
          ? backedShares * price
          : 0
      if (rowMv - backingMv > 1e-3) otherKeys.add(key)
    }

    return { backingKeys, otherKeys }
  }, [liveStockPositions, watchlistOptionableCoverageItems, stockCoverageSectionAccount])

  const handleOptionStockMixSelect = useCallback((label: string | null) => {
    if (label == null) {
      setOptionStockMixFilter(null)
      return
    }
    const next = label as OptionStockMixCategory
    if (next !== 'Backing Pool' && next !== 'Other Stock' && next !== 'Cash-like') {
      setOptionStockMixFilter(null)
      return
    }
    if (optionStockMixFilter === next) {
      setOptionStockMixFilter(null)
      return
    }
    setOptionStockMixFilter(next)
    if (next === 'Cash-like') {
      setOpenTab('cash_like')
    } else {
      setOpenTab('stocks')
    }
  }, [optionStockMixFilter])

  useEffect(() => {
    setOptionStockMixFilter(null)
  }, [stockCoverageSectionAccount])

  const coreStockPositionsFiltered = useMemo(() => {
    if (!optionStockMixFilter || optionStockMixFilter === 'Cash-like') return coreStockPositions
    if (optionStockMixFilter === 'Backing Pool') {
      return coreStockPositions.filter(p => optionStockMixFilterKeys.backingKeys.has(liveStockRowCovKey(p)))
    }
    if (optionStockMixFilter === 'Other Stock') {
      return coreStockPositions.filter(p => optionStockMixFilterKeys.otherKeys.has(liveStockRowCovKey(p)))
    }
    return coreStockPositions
  }, [coreStockPositions, optionStockMixFilter, optionStockMixFilterKeys])

  const stocksTabEmptyHint = useMemo(() => {
    if (
      (optionStockMixFilter === 'Backing Pool' || optionStockMixFilter === 'Other Stock') &&
      coreStockPositionsFiltered.length === 0 &&
      coreStockPositions.length > 0
    ) {
      return `No positions match "${optionStockMixFilter}" for the selected chart account. Clear the category filter on the Option chart.`
    }
    return 'No open stock positions under the current filters.'
  }, [optionStockMixFilter, coreStockPositionsFiltered.length, coreStockPositions.length])

  const streamHostAccountId = (status?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (status?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()

  const hostSecondaryAccountCashBp = useMemo(() => {
    const list = status?.portfolio?.accounts ?? []
    const snap = (id: string) =>
      id ? list.find(a => (a.account_id ?? '').trim() === id) : undefined
    return {
      host: accountTotalCashBuyingPower(snap(streamHostAccountId)),
      secondary: accountTotalCashBuyingPower(snap(streamSecondaryAccountId)),
    }
  }, [status?.portfolio?.accounts, streamHostAccountId, streamSecondaryAccountId])

  const [underlyingPoolSort, setUnderlyingPoolSort] = useState<{
    col: CoveragePoolSortCol
    dir: 'asc' | 'desc'
  }>({ col: 'market_price', dir: 'desc' })

  const sortedOptionUnderlyingPoolItems = useMemo(
    () => sortStockCoverageItemsByColumn(optionUnderlyingPoolItems, underlyingPoolSort.col, underlyingPoolSort.dir),
    [optionUnderlyingPoolItems, underlyingPoolSort],
  )

  const sortedOptionUnderlyingPoolItemsForSection = useMemo(() => {
    if (stockCoverageSectionAccount === 'all') return sortedOptionUnderlyingPoolItems
    return sortedOptionUnderlyingPoolItems.filter(
      ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
    )
  }, [sortedOptionUnderlyingPoolItems, stockCoverageSectionAccount])

  const onUnderlyingPoolSortClick = useCallback((col: CoveragePoolSortCol) => {
    setUnderlyingPoolSort(prev =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    )
  }, [])

  const [backingPoolSort, setBackingPoolSort] = useState<{
    col: CoveragePoolSortCol
    dir: 'asc' | 'desc'
  }>({ col: 'market_price', dir: 'desc' })

  const sortedWatchlistOptionableCoverageItems = useMemo(
    () =>
      sortStockCoverageItemsByColumn(watchlistOptionableCoverageItems, backingPoolSort.col, backingPoolSort.dir),
    [watchlistOptionableCoverageItems, backingPoolSort],
  )

  const sortedWatchlistOptionableCoverageItemsForSection = useMemo(() => {
    if (stockCoverageSectionAccount === 'all') return sortedWatchlistOptionableCoverageItems
    return sortedWatchlistOptionableCoverageItems.filter(
      ci => (ci.account_id ?? '').trim() === stockCoverageSectionAccount,
    )
  }, [sortedWatchlistOptionableCoverageItems, stockCoverageSectionAccount])

  const onBackingPoolSortClick = useCallback((col: CoveragePoolSortCol) => {
    setBackingPoolSort(prev =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    )
  }, [])

  /** When false (default), donut compares stock vs net cash only; buying power still listed below. */
  const [coverageAssetPieIncludeBp, setCoverageAssetPieIncludeBp] = useState(false)
  /** Fixed income / cash-like STK positions: exclude from ring denominator when false (values still in legend). */
  const [coverageAssetPieIncludeFi, setCoverageAssetPieIncludeFi] = useState(false)
  const [coverageAssetPieIncludeCashLike, setCoverageAssetPieIncludeCashLike] = useState(true)

  const coverageAssetPieData = useMemo(() => {
    const accounts = status?.portfolio?.accounts ?? []
    const snap = (id: string) =>
      id ? accounts.find(a => (a.account_id ?? '').trim() === id) : undefined

    const aggregateForAccounts = (ids: string[]) => {
      let cash: number | null = null
      let bp: number | null = null
      for (const id of ids) {
        const { cash: c, bp: b } = accountTotalCashBuyingPower(snap(id))
        if (c != null && Number.isFinite(c)) cash = (cash ?? 0) + c
        if (b != null && Number.isFinite(b)) bp = (bp ?? 0) + b
      }
      return { cash, bp }
    }

    let coreStockMV = 0
    let fixedIncomeMV = 0
    let cashLikeMV = 0
    let cash: number | null = null
    let bp: number | null = null

    const acct: 'all' | string = stockCoverageSectionAccount
    if (acct === 'all') {
      coreStockMV = sumStockMarketValueForAccountFilter(coreStockPositions, 'all')
      fixedIncomeMV = sumStockMarketValueForAccountFilter(fixedIncomeStockPositions, 'all')
      cashLikeMV = sumStockMarketValueForAccountFilter(cashLikeStockPositions, 'all')
      const ids = new Set<string>()
      for (const a of accounts) {
        const id = (a.account_id ?? '').trim()
        if (id) ids.add(id)
      }
      if (ids.size > 0) {
        const ag = aggregateForAccounts([...ids])
        cash = ag.cash
        bp = ag.bp
      }
    } else {
      coreStockMV = sumStockMarketValueForAccountFilter(coreStockPositions, acct)
      fixedIncomeMV = sumStockMarketValueForAccountFilter(fixedIncomeStockPositions, acct)
      cashLikeMV = sumStockMarketValueForAccountFilter(cashLikeStockPositions, acct)
      const ag = aggregateForAccounts([acct])
      cash = ag.cash
      bp = ag.bp
    }

    const wCore = Math.max(0, coreStockMV)
    const wFi = Math.max(0, fixedIncomeMV)
    const wCl = Math.max(0, cashLikeMV)
    const wCash = cash != null && Number.isFinite(cash) ? Math.max(0, cash) : 0
    const wBp = bp != null && Number.isFinite(bp) ? Math.max(0, bp) : 0
    const wFiIn = coverageAssetPieIncludeFi ? wFi : 0
    const wClIn = coverageAssetPieIncludeCashLike ? wCl : 0
    const wBpIn = coverageAssetPieIncludeBp ? wBp : 0
    const denom = wCore + wFiIn + wClIn + wCash + wBpIn
    const pStock = denom > 0 ? wCore / denom : 0
    const pFixedIncome = denom > 0 && coverageAssetPieIncludeFi ? wFi / denom : 0
    const pCashLike = denom > 0 && coverageAssetPieIncludeCashLike ? wCl / denom : 0
    const pCash = denom > 0 ? wCash / denom : 0
    const pBp = denom > 0 && coverageAssetPieIncludeBp ? wBp / denom : 0

    const netLiq =
      stockCoverageSectionAccount === 'all'
        ? accounts.reduce((s, a) => {
            const n = parseIbSummaryNumber(a, 'NetLiquidation')
            return s + (n != null && Number.isFinite(n) ? n : 0)
          }, 0)
        : parseIbSummaryNumber(snap(stockCoverageSectionAccount), 'NetLiquidation')

    const simpleCenterPct =
      !coverageAssetPieIncludeBp &&
      !coverageAssetPieIncludeFi &&
      !coverageAssetPieIncludeCashLike

    return {
      coreStockMV,
      fixedIncomeMV,
      cashLikeMV,
      cash,
      bp,
      denom,
      pStock,
      pFixedIncome,
      pCashLike,
      pCash,
      pBp,
      includeBpInChart: coverageAssetPieIncludeBp,
      includeFiInChart: coverageAssetPieIncludeFi,
      includeCashLikeInChart: coverageAssetPieIncludeCashLike,
      simpleCenterPct,
      netLiq: netLiq != null && Number.isFinite(netLiq) && netLiq > 0 ? netLiq : null,
    }
  }, [
    status?.portfolio?.accounts,
    coreStockPositions,
    fixedIncomeStockPositions,
    cashLikeStockPositions,
    stockCoverageSectionAccount,
    coverageAssetPieIncludeBp,
    coverageAssetPieIncludeFi,
    coverageAssetPieIncludeCashLike,
  ])

  const independentStockSections = useMemo(() => {
    const isIndep = (s: LivePositionRow) => s.optionable !== true
    return [
      { title: 'Stocks', key: 'ind-stk', rows: coreStockPositions.filter(isIndep) },
      { title: 'Fixed income', key: 'ind-fi', rows: fixedIncomeStockPositions.filter(isIndep) },
      { title: 'Cash-like', key: 'ind-cash', rows: cashLikeStockPositions.filter(isIndep) },
    ] as const
  }, [coreStockPositions, fixedIncomeStockPositions, cashLikeStockPositions])

  const filteredInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    let list = instanceAllGroups
    if (instanceFilterStructureType !== 'all') {
      list = list.filter(g => (g.structure_type ?? '') === instanceFilterStructureType)
    }
    if (instanceFilterScopeType !== 'all') {
      if (instanceFilterScopeType === '__none__') {
        list = list.filter(g => !g.scope_type)
      } else {
        list = list.filter(g => g.scope_type === instanceFilterScopeType)
      }
    }
    if (instanceFilterOppName !== 'all') {
      list = list.filter(g => (g.strategy_opportunity_name ?? '') === instanceFilterOppName)
    }
    if (instanceFilterAttributionType !== 'all') {
      list = list.filter(g => {
        const types = new Set(g.options.map(p => p.attribution_type ?? 'unassigned'))
        if (instanceFilterAttributionType === 'mixed') return types.has('mixed')
        if (instanceFilterAttributionType === 'single') return types.has('single') && !types.has('mixed')
        if (instanceFilterAttributionType === 'unassigned') return g.strategy_instance_id == null
        return true
      })
    }
    return list
  }, [instanceAllGroups, instanceFilterStructureType, instanceFilterScopeType, instanceFilterOppName, instanceFilterAttributionType])

  const instanceFilterOptions = useMemo(() => {
    const stSet = new Set<string>()
    const scSet = new Set<string>()
    const oppSet = new Set<string>()
    for (const g of instanceAllGroups) {
      if (g.structure_type) stSet.add(g.structure_type)
      scSet.add(g.scope_type ?? '')
      if (g.strategy_opportunity_name) oppSet.add(g.strategy_opportunity_name)
    }
    return {
      structureTypes: Array.from(stSet).sort(),
      scopeTypes: Array.from(scSet).sort(),
      oppNames: Array.from(oppSet).sort(),
    }
  }, [instanceAllGroups])

  const sortedInstanceAllGroups = useMemo((): InstanceAllGroup[] => {
    const { column, dir } = openOptSort
    const mult = dir === 'asc' ? 1 : -1
    const sortPositions = (positions: OpenOptionPosition[]) => {
      const list = [...positions]
      list.sort((a, b) => {
        if (column === 'contract') {
          const aParts = getContractLabelParts(a.contract_key)
          const bParts = getContractLabelParts(b.contract_key)
          const cmp = (aParts.symbol ?? '').localeCompare(bParts.symbol ?? '')
          if (cmp !== 0) return mult * cmp
          const cmpExp = a.expiry.localeCompare(b.expiry)
          if (cmpExp !== 0) return mult * cmpExp
          return mult * (a.strike - b.strike)
        }
        if (column === 'expiry') {
          const cmp = a.expiry.localeCompare(b.expiry)
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'strike') {
          const cmp = a.strike - b.strike
          if (cmp !== 0) return mult * cmp
          return mult * (getContractLabelParts(a.contract_key).symbol ?? '').localeCompare(getContractLabelParts(b.contract_key).symbol ?? '')
        }
        if (column === 'last') {
          const aLast = getPositionLast(a) ?? -Infinity
          const bLast = getPositionLast(b) ?? -Infinity
          if (aLast !== bLast) return mult * (aLast - bLast)
          return 0
        }
        if (column === 'qty') {
          return mult * (Math.abs(a.qty) - Math.abs(b.qty))
        }
        if (column === 'avg_cost') {
          return mult * ((a.avg_cost ?? -Infinity) - (b.avg_cost ?? -Infinity))
        }
        if (column === 'value') {
          const aVal = (a.avg_cost ?? 0) * Math.abs(a.qty) * 100
          const bVal = (b.avg_cost ?? 0) * Math.abs(b.qty) * 100
          return mult * (aVal - bVal)
        }
        if (column === 'time') {
          return mult * ((getPositionTime(a) ?? 0) - (getPositionTime(b) ?? 0))
        }
        return mult * (a.unrealized_pnl - b.unrealized_pnl)
      })
      return list
    }
    const out = filteredInstanceAllGroups.map(g => ({
      ...g,
      options: sortPositions(g.options),
    }))
    return out
  }, [filteredInstanceAllGroups, openOptSort, quotesMap])

  const [expandedInstanceKeys, setExpandedInstanceKeys] = useState<string[]>([])
  const toggleInstanceExpand = (key: string) => {
    setExpandedInstanceKeys(prev => {
      const isOpen = prev.includes(key)
      if (openAccordionMode) return isOpen ? [] : [key]
      return isOpen ? prev.filter(k => k !== key) : [...prev, key]
    })
  }

  /** Accordion: keep at most one expanded strategy row. */
  useEffect(() => {
    if (!openAccordionMode) return
    setExpandedInstanceKeys(prev => (prev.length <= 1 ? prev : [prev[prev.length - 1]!]))
  }, [openAccordionMode])

  const hasOpenOptions = optionsTabPositions.length > 0
  const hasCoreStocks = coreStockPositions.length > 0
  const hasFixedIncomeStocks = fixedIncomeStockPositions.length > 0
  const hasCashLikeStocks = cashLikeStockPositions.length > 0
  const hasInstances = instanceAllGroups.length > 0

  useEffect(() => {
    const order: OpenPositionsTab[] = ['instance', 'options', 'stocks', 'fixed_income', 'cash_like']
    const isAvailable = (t: OpenPositionsTab): boolean => {
      switch (t) {
        case 'instance':
          return hasInstances
        case 'options':
          return hasOpenOptions
        case 'stocks':
          return hasCoreStocks
        case 'fixed_income':
          return hasFixedIncomeStocks
        case 'cash_like':
          return hasCashLikeStocks
        default:
          return false
      }
    }
    if (isAvailable(openTab)) return
    for (const t of order) {
      if (isAvailable(t)) {
        setOpenTab(t)
        return
      }
    }
  }, [
    openTab,
    hasInstances,
    hasOpenOptions,
    hasCoreStocks,
    hasFixedIncomeStocks,
    hasCashLikeStocks,
  ])

  useEffect(() => {
    loadReplayData()
    loadAttributions()
  }, [loadReplayData, loadAttributions])



  return (
    <PageSection className="replay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <SectionPageTitle
          menu="Portfolio"
          pageTitle="Positions"
          onMenuClick={() => onViewChange?.('accounts')}
          infoText="Open positions (Pool On and Off) and manual execution records."
          style={{ margin: 0 }}
        />
      </div>

      {(symbolDonutSegments.length > 0 || optionDetailSegments.length > 0 || optionStockMix.segments.length > 0) && (
        <div className="pos-comp-charts-row pos-comp-charts-row--12">
          <div className="pos-comp-chart-col pos-comp-chart-col--span-4">
            <PositionCoverageCharts
              streamHostAccountId={streamHostAccountId}
              streamSecondaryAccountId={streamSecondaryAccountId}
              account={stockCoverageSectionAccount}
              onAccountChange={setStockCoverageSectionAccount}
              legendMode={coverageAssetMixLegendMode}
              onLegendModeChange={setCoverageAssetMixLegendMode}
              pieData={coverageAssetPieData}
              onIncludeBpChange={setCoverageAssetPieIncludeBp}
              onIncludeFiChange={setCoverageAssetPieIncludeFi}
              onIncludeCashLikeChange={setCoverageAssetPieIncludeCashLike}
            />
          </div>
          <div className="coverage-asset-pie-section pos-comp-chart-col pos-comp-chart-col--span-4" style={{ minWidth: 0, maxWidth: 'none' }}>
            <div
              className="coverage-asset-pie-chart-toggle-row"
              style={{ marginBottom: '0.45rem', gap: '0.35rem', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span className="coverage-asset-pie-bp-label">Underlying category</span>
              <div className="coverage-asset-pie-bubble-switch" role="group" aria-label="Toggle underlying categories">
                {UNDERLYING_CATEGORY_ORDER.map(cat => {
                  const active = underlyingCategoryFilter[cat]
                  return (
                    <button
                      key={cat}
                      type="button"
                      className={`coverage-asset-pie-bubble-btn${active ? ' active' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setUnderlyingCategoryFilter(prev => ({ ...prev, [cat]: !prev[cat] }))
                      }}
                      title={active ? `Hide ${cat}` : `Show ${cat}`}
                    >
                      {cat}
                    </button>
                  )
                })}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', alignItems: 'center', gap: '0.6rem' }}>
                <PositionDonutChart
                  title="Category Detail"
                  segments={symbolDonutSegments}
                  activeLabel={openFilterSymbol.trim().toUpperCase() || null}
                  onSegmentClick={sym => {
                    setOpenFilterSymbol(sym ?? '')
                    if (sym) setChartTypeFilter(null)
                  }}
                  showLegend={false}
                  embedded
                  showActiveChip={false}
                />
                <div className="coverage-asset-pie-legend" style={{ minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: '0.25rem 0.4rem' }}>
                  {categoryDetailLegendGroups.map(group => (
                    <div key={`detail-group-${group.category}`} style={{ flex: '1 1 100%', minWidth: 0 }}>
                      <div className="coverage-asset-pie-bp-label" style={{ marginBottom: '0.08rem' }}>{group.category}</div>
                      <div
                        className="coverage-asset-pie-legend"
                        style={
                          group.category === 'Stocks'
                            ? {
                                display: 'grid',
                                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                                gap: '0.16rem 0.34rem',
                              }
                            : { flexDirection: 'row', flexWrap: 'wrap', gap: '0.25rem 0.4rem' }
                        }
                      >
                        {group.segments.map(seg => {
                          const total = symbolDonutSegments.reduce((acc, s) => acc + s.value, 0)
                          const pct = total > 0 ? (seg.value / total) * 100 : 0
                          const isActive = openFilterSymbol.trim().toUpperCase() === seg.label
                          const isDimmed = openFilterSymbol.trim() !== '' && !isActive
                          return (
                            <div
                              key={`sym-${group.category}-${seg.label}`}
                              className="coverage-asset-pie-legend-item"
                              style={{
                                cursor: 'pointer',
                                opacity: isDimmed ? 0.38 : 1,
                                borderRadius: 4,
                                padding: group.category === 'Stocks' ? '0.03rem 0.16rem' : '0.06rem 0.25rem',
                                background: isActive ? `color-mix(in oklab, ${seg.color} 14%, transparent)` : 'transparent',
                                transition: 'opacity 0.18s, background 0.15s',
                                fontSize: group.category === 'Stocks' ? '0.74rem' : undefined,
                              }}
                              onClick={() => {
                                const curr = openFilterSymbol.trim().toUpperCase()
                                setOpenFilterSymbol(curr === seg.label ? '' : seg.label)
                                if (curr !== seg.label) setChartTypeFilter(null)
                              }}
                              title={`Click to filter: ${seg.label}`}
                            >
                              <span className="coverage-asset-pie-dot" style={{ background: seg.color }} />
                              <span
                                className={
                                  seg.marketValueTooltip
                                    ? 'coverage-asset-pie-legend-label pos-cat-symbol-mv-tooltip'
                                    : 'coverage-asset-pie-legend-label'
                                }
                              >
                                {seg.label}
                                {seg.marketValueTooltip ? (
                                  <span className="pos-cat-symbol-mv-tooltip-popup" role="tooltip">
                                    {seg.marketValueTooltip}
                                  </span>
                                ) : null}
                              </span>
                              <span className="coverage-asset-pie-legend-pct">{pct.toFixed(1)}%</span>
                              <span className="coverage-asset-pie-legend-value">{fmtMvAbbrev(seg.value)}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', alignItems: 'center', gap: '0.6rem' }}>
                <PositionDonutChart
                  title="Category Weight"
                  segments={underlyingCategorySegments}
                  activeLabel={activeCategoryWeightFilter}
                  onSegmentClick={handleCategoryWeightSelect}
                  interactive
                  showLegend={false}
                  embedded
                showActiveChip={false}
                />
                <div className="coverage-asset-pie-legend" style={{ minWidth: 0, flexDirection: 'column', gap: '0.25rem' }}>
                  {underlyingCategorySegments.map(seg => {
                    const total = underlyingCategorySegments.reduce((acc, s) => acc + s.value, 0)
                    const pct = total > 0 ? (seg.value / total) * 100 : 0
                    const isActive = activeCategoryWeightFilter === seg.label
                    return (
                      <div
                        key={`cat-${seg.label}`}
                        className="coverage-asset-pie-legend-item"
                        style={{
                          cursor: 'pointer',
                          borderRadius: 4,
                          padding: '0.06rem 0.25rem',
                          background: isActive ? `color-mix(in oklab, ${seg.color} 14%, transparent)` : 'transparent',
                          transition: 'background 0.15s ease',
                        }}
                        onClick={() => handleCategoryWeightSelect(seg.label)}
                        title={`Switch instruments tab: ${seg.label}`}
                      >
                        <span className="coverage-asset-pie-dot" style={{ background: seg.color }} />
                        <span className="coverage-asset-pie-legend-label">{seg.label}</span>
                        <span className="coverage-asset-pie-legend-pct">{pct.toFixed(1)}%</span>
                        <span className="coverage-asset-pie-legend-value">{fmtMvAbbrev(seg.value)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            {!anyUnderlyingCategoryEnabled && (
              <p className="section-hint" style={{ marginTop: '0.45rem' }}>
                Turn on at least one category to show symbol proportions.
              </p>
            )}
          </div>
          <div className="coverage-asset-pie-section pos-comp-chart-col pos-comp-chart-col--span-4" style={{ minWidth: 0, maxWidth: 'none' }}>
            <div
              className="coverage-asset-pie-header"
              style={{ flexWrap: 'nowrap', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}
            >
              <span className="coverage-asset-pie-title" style={{ flexShrink: 0 }}>
                Option
              </span>
              <div
                className="coverage-asset-pie-bubble-switch"
                style={{ flexShrink: 0 }}
                role="group"
                aria-label="Option ring legend: percent or dollars"
              >
                <button
                  type="button"
                  className={`coverage-asset-pie-bubble-btn${optionRingLegendMode === 'pct' ? ' active' : ''}`}
                  aria-pressed={optionRingLegendMode === 'pct'}
                  onClick={() => setOptionRingLegendMode('pct')}
                >
                  %
                </button>
                <button
                  type="button"
                  className={`coverage-asset-pie-bubble-btn${optionRingLegendMode === 'usd' ? ' active' : ''}`}
                  aria-pressed={optionRingLegendMode === 'usd'}
                  onClick={() => setOptionRingLegendMode('usd')}
                >
                  $
                </button>
              </div>
              <div
                style={{
                  marginLeft: 'auto',
                  minWidth: 0,
                  flex: '1 1 0%',
                  display: 'flex',
                  flexDirection: 'row',
                  flexWrap: 'nowrap',
                  alignItems: 'baseline',
                  justifyContent: 'flex-end',
                  gap: '0.3rem',
                  fontSize: '0.68rem',
                  lineHeight: 1.2,
                  color: 'var(--color-text-muted)',
                  textAlign: 'right',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: '0 1 auto',
                    minWidth: 0,
                  }}
                  title="Backing Pool / Other Stock / Cash-like"
                >
                  Backing / Other / Cash-like
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-main)',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {optionRingLegendMode === 'pct' ? (
                    <>
                      {optionStockMix.backingPct.toFixed(1)}% / {optionStockMix.otherPct.toFixed(1)}% /{' '}
                      {optionStockMix.cashLikePct.toFixed(1)}%
                    </>
                  ) : (
                    <>
                      {fmtMvAbbrev(optionStockMix.segments.find(s => s.label === 'Backing Pool')?.value ?? 0)} /{' '}
                      {fmtMvAbbrev(optionStockMix.segments.find(s => s.label === 'Other Stock')?.value ?? 0)} /{' '}
                      {fmtMvAbbrev(optionStockMix.segments.find(s => s.label === 'Cash-like')?.value ?? 0)}
                    </>
                  )}
                </span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', alignItems: 'center', gap: '0.6rem' }}>
              <PositionDonutChart
                title="Detail"
                centerValueMode={optionRingLegendMode}
                segments={optionDetailSegments}
                activeLabel={optionDetailActiveLabel}
                onSegmentClick={label => {
                  if (label == null) {
                    setOptionDetailActiveLabel(null)
                    return
                  }
                  if (label === optionDetailActiveLabel) {
                    setOptionDetailActiveLabel(null)
                    return
                  }
                  setOptionDetailActiveLabel(label)
                  setOpenTab('options')
                }}
                showLegend={false}
                embedded
                showActiveChip={false}
              />
              <div className="coverage-asset-pie-legend" style={{ minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: '0.25rem 0.4rem' }}>
                {optionDetailSegments.map(seg => {
                  const total = optionDetailSegments.reduce((acc, s) => acc + s.value, 0)
                  const pct = total > 0 ? (seg.value / total) * 100 : 0
                  const isActive = optionDetailActiveLabel === seg.label
                  return (
                    <div
                      key={`opt-detail-${seg.label}`}
                      style={{
                        cursor: 'pointer',
                        borderRadius: 4,
                        padding: '0.06rem 0.25rem',
                        background: isActive ? `color-mix(in oklab, ${seg.color} 14%, transparent)` : 'transparent',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.06rem',
                        minWidth: 0,
                      }}
                      onClick={() => {
                        if (optionDetailActiveLabel === seg.label) setOptionDetailActiveLabel(null)
                        else {
                          setOptionDetailActiveLabel(seg.label)
                          setOpenTab('options')
                        }
                      }}
                      title={`Filter by ${seg.label}`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span className="coverage-asset-pie-dot" style={{ background: seg.color, flexShrink: 0 }} />
                        <span className="coverage-asset-pie-legend-label" style={{ wordBreak: 'break-word' }}>{seg.label}</span>
                        {optionRingLegendMode === 'pct' ? (
                          <span className="coverage-asset-pie-legend-pct">{pct.toFixed(1)}%</span>
                        ) : (
                          <span className="coverage-asset-pie-legend-value">{fmtMvAbbrev(seg.value)}</span>
                        )}
                      </div>
                      {seg.optionDetailFoot ? (
                        <div style={{ fontSize: '0.68rem', lineHeight: 1.25, paddingLeft: '1.1rem' }}>
                          {seg.optionDetailFoot.kind === 'stock' ? (
                            <>
                              <span className="replay-muted">Stock cost </span>
                              <span className={`tabular-nums ${pnlClassForTone(seg.optionDetailFoot.tone)}`}>
                                {seg.optionDetailFoot.costFmt}
                              </span>
                              <span className="replay-muted"> · Market value </span>
                              <span className={`tabular-nums ${pnlClassForTone(seg.optionDetailFoot.tone)}`}>
                                {seg.optionDetailFoot.mvFmt}
                              </span>
                            </>
                          ) : seg.optionDetailFoot.text.startsWith('Margin (est.) ') ? (
                            <>
                              <span className="replay-muted">Margin (est.) </span>
                              <span className={`tabular-nums ${pnlClassForTone(seg.optionDetailFoot.tone)}`}>
                                {seg.optionDetailFoot.text.slice('Margin (est.) '.length)}
                              </span>
                            </>
                          ) : (
                            <span className="replay-muted">{seg.optionDetailFoot.text}</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', alignItems: 'center', gap: '0.6rem', marginTop: '0.2rem' }}>
              <PositionDonutChart
                title="Category"
                centerValueMode={optionRingLegendMode}
                segments={optionStockMix.segments}
                activeLabel={optionStockMixFilter}
                onSegmentClick={handleOptionStockMixSelect}
                interactive
                showLegend={false}
                embedded
                showActiveChip={false}
              />
              <div className="coverage-asset-pie-legend" style={{ minWidth: 0, flexDirection: 'column', gap: '0.22rem' }}>
                {optionStockMix.segments.map(seg => {
                  const total = optionStockMix.segments.reduce((acc, s) => acc + s.value, 0)
                  const pct = total > 0 ? (seg.value / total) * 100 : 0
                  const isActive = optionStockMixFilter === seg.label
                  return (
                    <div
                      key={`opt-cat-${seg.label}`}
                      className="coverage-asset-pie-legend-item"
                      style={{
                        padding: '0.06rem 0.25rem',
                        cursor: 'pointer',
                        borderRadius: 4,
                        background: isActive ? `color-mix(in oklab, ${seg.color} 14%, transparent)` : 'transparent',
                        transition: 'background 0.15s ease',
                      }}
                      role="button"
                      tabIndex={0}
                      title={`Filter open positions: ${seg.label}`}
                      onClick={() => handleOptionStockMixSelect(isActive ? null : seg.label)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleOptionStockMixSelect(isActive ? null : seg.label)
                        }
                      }}
                    >
                      <span className="coverage-asset-pie-dot" style={{ background: seg.color }} />
                      <span className="coverage-asset-pie-legend-label">{seg.label}</span>
                      {optionRingLegendMode === 'pct' ? (
                        <span className="coverage-asset-pie-legend-pct">{pct.toFixed(1)}%</span>
                      ) : (
                        <span className="coverage-asset-pie-legend-value">{fmtMvAbbrev(seg.value)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <section className="replay-section replay-section-trade-records" aria-label="Open positions">
          <div className="positions-open-controls-row">
            <div className="replay-fetch-range-group positions-open-filters" aria-label="Position filters">
              <input
                type="text"
                placeholder="Symbol"
                value={openFilterSymbol}
                onChange={e => setOpenFilterSymbol(e.target.value)}
                className="replay-filter-input replay-filter-input-symbol positions-open-filter-symbol"
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYYMMDD"
                value={openFilterExpiryStart}
                onChange={e => setOpenFilterExpiryStart(e.target.value.replace(/\D/g, '').slice(0, 8))}
                className="replay-filter-input replay-filter-date positions-open-filter-expiry"
                title="Option expiry: YYYYMMDD digits; shorter prefix also matches (e.g. 202503)"
                maxLength={8}
                aria-label="Filter by option expiry YYYYMMDD"
              />
            </div>
            {(streamHostAccountId ||
              (streamSecondaryAccountId && streamSecondaryAccountId !== streamHostAccountId)) && (
              <div
                className="coverage-asset-pie-bubble-switch positions-open-acct-bubbles"
                role="group"
                aria-label="Filter open positions by account (multi-select)"
              >
                {streamHostAccountId ? (
                  <button
                    type="button"
                    className={`coverage-asset-pie-bubble-btn${openFilterAccounts.host ? ' active' : ''}${
                      acctBubbleHoldHint === 'host' ? ' hold-deselect-hint' : ''
                    }`}
                    aria-pressed={openFilterAccounts.host}
                    title={`Host account ${streamHostAccountId}. Long-press when on: deselect hint.`}
                    onPointerDown={() => onAcctBubblePointerDown('host', openFilterAccounts.host)}
                    onPointerUp={finishAcctBubbleHold}
                    onPointerLeave={finishAcctBubbleHold}
                    onPointerCancel={finishAcctBubbleHold}
                    onClick={() => setOpenFilterAccounts(s => ({ ...s, host: !s.host }))}
                  >
                    HOST
                  </button>
                ) : null}
                {streamSecondaryAccountId && streamSecondaryAccountId !== streamHostAccountId ? (
                  <button
                    type="button"
                    className={`coverage-asset-pie-bubble-btn${openFilterAccounts.secondary ? ' active' : ''}${
                      acctBubbleHoldHint === 'secondary' ? ' hold-deselect-hint' : ''
                    }`}
                    aria-pressed={openFilterAccounts.secondary}
                    title={`Secondary account ${streamSecondaryAccountId}. Long-press when on: deselect hint.`}
                    onPointerDown={() => onAcctBubblePointerDown('secondary', openFilterAccounts.secondary)}
                    onPointerUp={finishAcctBubbleHold}
                    onPointerLeave={finishAcctBubbleHold}
                    onPointerCancel={finishAcctBubbleHold}
                    onClick={() => setOpenFilterAccounts(s => ({ ...s, secondary: !s.secondary }))}
                  >
                    Secondary
                  </button>
                ) : null}
              </div>
            )}
            <div
              className="replay-fetch-range-group positions-open-detail-rg"
              role="radiogroup"
              aria-label="Detail view: accordion for Strategy rows and option execution rows"
            >
              <span className="replay-fetch-days-label">Detail</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="accordion" checked={openAccordionMode} onChange={() => setOpenAccordionMode(true)} />
                <span>Accordion</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="multi" checked={!openAccordionMode} onChange={() => setOpenAccordionMode(false)} />
                <span>Multi</span>
              </label>
            </div>
            {optionsTabPositions.length > 0 || liveStockPositions.length > 0 ? (
              <>
                <span className="positions-open-controls-sep" aria-hidden />
                <div className="replay-ledger-tab-matrix replay-ledger-tab-matrix--aligned replay-ledger-tab-matrix--open-positions positions-open-tabs-merged">
                  <div
                    className="system-tabs replay-portfolio-tabs replay-ledger-tab-button-row"
                    role="tablist"
                    aria-label="Open positions: Strategy, Options, Stocks, Fixed income, Cash-like"
                  >
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-strategy"
                      aria-selected={openTab === 'instance'}
                      aria-controls="open-panel-strategy"
                      className={`system-tab ${openTab === 'instance' ? 'active' : ''}`}
                      onClick={() => setOpenTab('instance')}
                      disabled={!hasInstances}
                    >
                      Strategy
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-options"
                      aria-selected={openTab === 'options'}
                      aria-controls="open-panel-options"
                      className={`system-tab replay-ledger-tab-at-instruments ${openTab === 'options' ? 'active' : ''}`}
                      onClick={() => setOpenTab('options')}
                      disabled={!hasOpenOptions}
                    >
                      Options
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-stocks"
                      aria-selected={openTab === 'stocks'}
                      aria-controls="open-panel-stocks"
                      className={`system-tab ${openTab === 'stocks' ? 'active' : ''}`}
                      onClick={() => setOpenTab('stocks')}
                      disabled={!hasCoreStocks}
                    >
                      Stocks
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-fixed-income"
                      aria-selected={openTab === 'fixed_income'}
                      aria-controls="open-panel-fixed-income"
                      className={`system-tab ${openTab === 'fixed_income' ? 'active' : ''}`}
                      onClick={() => setOpenTab('fixed_income')}
                      disabled={!hasFixedIncomeStocks}
                    >
                      Fixed income
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-cash-like"
                      aria-selected={openTab === 'cash_like'}
                      aria-controls="open-panel-cash-like"
                      className={`system-tab ${openTab === 'cash_like' ? 'active' : ''}`}
                      onClick={() => setOpenTab('cash_like')}
                      disabled={!hasCashLikeStocks}
                    >
                      Cash-like
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          {optionsTabPositions.length === 0 && liveStockPositions.length === 0 ? (
            <p className="section-hint">No open positions under the current filters. Position data comes from account snapshots in `Accounts`, while Off-Track options are inferred from execution history.</p>
          ) : (
            <div className="replay-portfolio-block">
              {chartTypeFilter ? (
                <div className="replay-portfolio-header">
                  <div className="replay-portfolio-tabs-wrap">
                    <button type="button" className="pos-comp-filter-chip" onClick={() => setChartTypeFilter(null)}>
                      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ flexShrink: 0 }}><path d="M9 3 3 9M3 3l6 6"/></svg>
                      Type: {chartTypeFilter}
                    </button>
                  </div>
                </div>
              ) : null}
              {openTab === 'instance' ? (
                <PositionInstanceTab
                  sortedGroups={sortedInstanceAllGroups}
                  filter={{
                    structureType: instanceFilterStructureType,
                    onStructureTypeChange: setInstanceFilterStructureType,
                    scopeType: instanceFilterScopeType,
                    onScopeTypeChange: setInstanceFilterScopeType,
                    oppName: instanceFilterOppName,
                    onOppNameChange: setInstanceFilterOppName,
                    attributionType: instanceFilterAttributionType,
                    onAttributionTypeChange: setInstanceFilterAttributionType,
                    options: instanceFilterOptions,
                  }}
                  expand={{
                    instanceKeys: expandedInstanceKeys,
                    toggleInstance: toggleInstanceExpand,
                    positionKeys: expandedPositionKeys,
                    togglePosition: togglePositionExpand,
                  }}
                  sort={{
                    underlyingPool: underlyingPoolSort,
                    onUnderlyingPoolClick: onUnderlyingPoolSortClick,
                    backingPool: backingPoolSort,
                    onBackingPoolClick: onBackingPoolSortClick,
                  }}
                  actions={{
                    openStockInspector,
                    openOptionInspector,
                    openStrategyInspector,
                    tryOpenStock: tryOpenStockFromSymbolAccount,
                    getDefaultAccount: instanceDefaultAccountForStockInspect,
                  }}
                  oppMap={oppMap}
                  liveStockPositions={liveStockPositions}
                  quotesMap={quotesMap}
                  cashBp={hostSecondaryAccountCashBp}
                  underlyingPoolItems={optionUnderlyingPoolItems}
                  underlyingPoolMarketTotal={optionUnderlyingPoolMarketTotal}
                  sortedUnderlyingPoolItems={sortedOptionUnderlyingPoolItemsForSection}
                  watchlistItems={watchlistOptionableCoverageItems}
                  sortedWatchlistItems={sortedWatchlistOptionableCoverageItemsForSection}
                  independentSections={independentStockSections}
                  streamHostAccountId={streamHostAccountId}
                  streamSecondaryAccountId={streamSecondaryAccountId}
                  formatOptExecQtyCell={formatInstanceOptExecQtyCell}
                  getPositionKey={getPositionKey}
                  getExecLists={getPositionExecLists}
                  getTime={getPositionTime}
                  canonicalOptContractKeySet={canonicalOptContractKeySet}
                  syncingTwsAttributionKey={syncingTwsAttributionKey}
                  syncingFinalAttributionKey={syncingFinalAttributionKey}
                  execRowActions={execRowActions}
                />
              ) : openTab === 'options' ? (
                <PositionOptionsTab
                  positions={optionsTabPositions}
                  sortedPositions={sortedOptionsTabPositions}
                  sort={openOptSort}
                  onSortToggle={col => setOpenOptSort(prev => prev.column === col ? { column: col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { column: col, dir: 'desc' })}
                  expandedKeys={expandedPositionKeys}
                  onToggleExpand={togglePositionExpand}
                  getPositionKey={getOptionsTabPositionKey}
                  getExecLists={getPositionExecLists}
                  getTime={getPositionTime}
                  quotesMap={quotesMap}
                  onOpenOptionInspector={openOptionInspector}
                  canonicalOptContractKeySet={canonicalOptContractKeySet}
                  syncingTwsAttributionKey={syncingTwsAttributionKey}
                  syncingFinalAttributionKey={syncingFinalAttributionKey}
                  execRowActions={execRowActions}
                />
              ) : openTab === 'stocks' ? (
                <StockBucketPanel
                  panelId="open-panel-stocks"
                  tabButtonId="open-tab-stocks"
                  heading="Stock positions"
                  rows={coreStockPositionsFiltered}
                  rowKeyPrefix="stk"
                  emptyHint={stocksTabEmptyHint}
                  onInspectStock={openStockInspector}
                />
              ) : openTab === 'fixed_income' ? (
                <StockBucketPanel
                  panelId="open-panel-fixed-income"
                  tabButtonId="open-tab-fixed-income"
                  heading="Fixed income positions"
                  rows={fixedIncomeStockPositions}
                  rowKeyPrefix="fi"
                  emptyHint="No open fixed income positions under the current filters."
                  onInspectStock={openStockInspector}
                />
              ) : (
                <StockBucketPanel
                  panelId="open-panel-cash-like"
                  tabButtonId="open-tab-cash-like"
                  heading="Cash-like positions"
                  rows={cashLikeStockPositions}
                  rowKeyPrefix="cash"
                  emptyHint="No open cash-like positions under the current filters."
                  onInspectStock={openStockInspector}
                />
              )}
            </div>
          )}
        </section>


      {pageError && (
        <p className="section-hint replay-form-error" style={{ marginTop: '0.5rem' }}>{pageError}</p>
      )}
      {editExecConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="positions-edit-exec-confirm-title"
          onClick={() => setEditExecConfirmState({ open: false, exec: null })}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 440 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="positions-edit-exec-confirm-title" className="section-subtitle" style={{ marginTop: 0 }}>
              Edit execution?
            </h3>
            <p className="section-hint execution-flex-manual-warning" role="alert" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
              When Flex and TWS sync are healthy, missing or late fills usually appear automatically after the next Flex refresh.
              Manual edits can conflict with or duplicate those rows. Continue only if you are intentionally reconciling or correcting
              this line.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditExecConfirmState({ open: false, exec: null })}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const ex = editExecConfirmState.exec
                  setEditExecConfirmState({ open: false, exec: null })
                  if (ex) {
                    setEditExec(ex)
                    setPageError(null)
                  }
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}
      <ExecutionFormModal
        open={!!editExec}
        editExec={editExec}
        accountOptions={executionAccountOptions}
        initialDraft={null}
        onClose={() => {
          setEditExec(null)
          setPageError(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
          loadAttributions()
        }}
      />
      <LinkExecutionRecordModal
        open={linkModalOpen}
        context={linkContext}
        onClose={() => {
          setLinkModalOpen(false)
          setLinkContext(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
          loadAttributions()
        }}
      />
      {deleteConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="positions-delete-exec-title"
          onClick={() => {
            if (!deleteConfirmState.confirming) {
              setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
            }
          }}
        >
          <div
            className="modal-panel replay-exec-modal"
            style={{ maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 id="positions-delete-exec-title" className="section-subtitle" style={{ marginTop: 0 }}>
              {deleteConfirmState.title}
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              {deleteConfirmState.message}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))}
                disabled={deleteConfirmState.confirming}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={async () => {
                  const exec = deleteConfirmState.exec
                  if (!exec?.account_executions_id) {
                    setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))
                    return
                  }
                  setDeleteConfirmState(prev => ({ ...prev, confirming: true }))
                  const res = await deleteExecution(exec.account_executions_id)
                  if (res.ok) {
                    if (editExec?.account_executions_id === exec.account_executions_id) setEditExec(null)
                    await loadReplayData()
                    loadAttributions()
                  } else {
                    setPageError(res.error ?? 'Delete failed')
                  }
                  setDeleteConfirmState({ open: false, title: '', message: '', confirming: false, exec: null })
                }}
                disabled={deleteConfirmState.confirming}
              >
                {deleteConfirmState.confirming ? 'Deleting…' : 'Confirm delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
      <QuickCloseModal
        exec={closeAgainstExec}
        onClose={() => setCloseAgainstExec(null)}
        onSuccess={() => { loadReplayData(); loadAttributions() }}
      />
      <RightInspectorDrawer open={stockInspector != null} ariaLabel="Stock position">
        {stockInspector != null && (
          <StockInspectorPanel
            symbol={stockInspector.symbol}
            accountId={stockInspector.accountId}
            position={stockInspector.position}
            onClose={closeStockInspector}
          />
        )}
      </RightInspectorDrawer>
      <RightInspectorDrawer open={optionInspector != null} ariaLabel="Option contract detail">
        {optionInspector != null && (
          <OptionContractDetailFromOpenPosition
            position={optionInspector}
            optionQuote={quotesMap[optionInspector.contract_key]}
            underlyingHint={optionInspectorUnderlyingHint}
            onClose={closeOptionInspector}
            onOpenOptionDiscovery={onOpenOptionDiscovery != null ? handleNavigateOptionDiscovery : undefined}
          />
        )}
      </RightInspectorDrawer>
      <RightInspectorDrawer open={strategyInspectorInstanceId != null} ariaLabel="Strategy instance detail" variant="instance-detail">
        {strategyInspectorInstanceId != null && (
          <div className="flex min-w-0 flex-col" aria-label="Strategy instance detail">
            <div className="mb-3 flex items-start justify-between gap-2 border-b border-border pb-3">
              <h3 className="text-base font-semibold leading-tight">
                Strategy Instance
                <span className="font-normal text-muted-foreground"> · #{strategyInspectorInstanceId}</span>
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={closeStrategyInspector}
                aria-label="Close strategy instance inspector"
              >
                ✕
              </Button>
            </div>
            <StrategyInstanceDetailPage strategyInstanceId={strategyInspectorInstanceId} status={status} embedded />
          </div>
        )}
      </RightInspectorDrawer>
    </PageSection>
  )
}

