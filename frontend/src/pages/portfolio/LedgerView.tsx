import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { Execution, IbClient, OptExecutionGroup, StatusResponse } from '../../types'
import type { StrategyOpportunity } from '../../api'
import type { StrategyInstance } from '../../types'
import { deleteExecution, fetchOpportunities, fetchStrategyInstances, updateExecution } from '../../api'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { DraggableExplainPanel } from '../../components/DraggableExplainPanel'
import { LedgerExpiryMonthCombobox } from '../../components/LedgerExpiryMonthCombobox'
import { LedgerSymbolCombobox } from '../../components/LedgerSymbolCombobox'
import { StrategyOpportunityCombobox } from '../../components/StrategyOpportunityCombobox'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  fmtExpiry,
  fmtTradeDate,
  fmtTs,
  fmtUsd,
  fmtUsd0,
  getContractLabelParts,
} from '../../utils/format'
import {
  collectExpiryMonthKeys,
  collectUnderlyingSymbols,
  fallbackExpiryMonthKeys,
} from '../../utils/ledgerFilterSuggestions'
import { buildOptExecutionGroups, isOptionExpired } from './buildOptExecutionGroups'
import { ExecutionFormModal } from './ExecutionFormModal'
import { ExpiredCloseModal } from './ExpiredCloseModal'
import type { LinkExecutionContext } from './LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './LinkExecutionRecordModal'
import type { PortfolioView } from './types'
import { useExecutions } from './useExecutions'
import { LedgerClosedOptionContractsSection } from './LedgerClosedOptionContractsSection'
import { LedgerOrphanOpenOptionSection } from './LedgerOrphanOpenOptionSection'
import {
  executionInstanceLabel,
  executionStrategyInstanceIds,
  executionStrategyOpportunityKey,
  expandExecutionRowsForStrategyOptView,
  groupExecutionsByStrategyInstanceId,
  getOptGroupKey,
  sliceExecutionForInstanceOptView,
} from './ledgerOptHelpers'
import {
  LEDGER_SUMMARY_PERIOD_TABS,
  formatPeriodLabel,
  rollupOptionsFromMonthly,
  rollupStocksFromMonthly,
  type LedgerSummaryPeriod,
} from './ledgerSummaryPeriod'
import type { LedgerMetricExplainKind } from './ledgerMetricExplainKinds'
import type { LedgerMetricExplainPayload } from './ledgerSummaryExplainPayload'
import { buildLedgerMetricExplainPayload } from './ledgerSummaryExplainPayload'
import { LedgerSummaryMetricExplainContent, ledgerMetricExplainTitle } from './ledgerSummaryMetricExplain'

export interface LedgerViewProps {
  status: StatusResponse | null
  onViewChange: (view: PortfolioView) => void
  /** Controlled by Trade ledger page header — opens Add journal modal. */
  addJournalOpen: boolean
  onAddJournalOpenChange: (open: boolean) => void
}

export function LedgerView({
  status,
  onViewChange: _onViewChange,
  addJournalOpen,
  onAddJournalOpenChange,
}: LedgerViewProps) {
  const [ledgerFilterStrategyOpportunityId, setLedgerFilterStrategyOpportunityId] = useState<number | ''>('')
  const [ledgerFilterStrategyInstanceId, setLedgerFilterStrategyInstanceId] = useState<number | ''>('')
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])
  const [instances, setInstances] = useState<StrategyInstance[]>([])

  const strategyFilters = useMemo(
    () => ({
      strategy_opportunity_id: ledgerFilterStrategyOpportunityId === '' ? undefined : ledgerFilterStrategyOpportunityId,
      strategy_instance_id: ledgerFilterStrategyInstanceId === '' ? undefined : ledgerFilterStrategyInstanceId,
    }),
    [ledgerFilterStrategyOpportunityId, ledgerFilterStrategyInstanceId],
  )
  const { executions, executionsBook, loadReplayData, executionAccountOptions } = useExecutions(
    status,
    strategyFilters,
    true,
  )

  /** Trade ledger account tabs: All + Host/Secondary from Settings (Event Account), not every account in data. */
  const ledgerTradeAccountTabs = useMemo(() => {
    const ib = status?.config?.ib_client as IbClient | undefined
    const host = (ib?.account?.event_host ?? '').trim()
    const secondary = (ib?.account?.event_secondary ?? '').trim()
    const tabs: { id: string; label: string }[] = []
    const seen = new Set<string>()
    if (host && !seen.has(host)) {
      seen.add(host)
      tabs.push({ id: host, label: 'Host' })
    }
    if (secondary && !seen.has(secondary)) {
      seen.add(secondary)
      tabs.push({ id: secondary, label: 'Secondary' })
    }
    return tabs
  }, [status?.config?.ib_client])

  const ledgerMonthKeyOptions = useMemo(() => {
    const merged = [...(executions ?? []), ...(executionsBook ?? [])]
    const fromData = collectExpiryMonthKeys(merged)
    if (fromData.length > 0) return fromData
    return fallbackExpiryMonthKeys()
  }, [executions, executionsBook])

  const ledgerSymbolSuggestions = useMemo(() => {
    const merged = [...(executions ?? []), ...(executionsBook ?? [])]
    return collectUnderlyingSymbols(merged)
  }, [executions, executionsBook])

  useEffect(() => {
    fetchOpportunities(true)
      .then(r => setOpportunities(r.items ?? []))
      .catch(() => setOpportunities([]))
  }, [])
  const oppIdNum = ledgerFilterStrategyOpportunityId === '' ? null : Number(ledgerFilterStrategyOpportunityId)
  useEffect(() => {
    if (oppIdNum == null || !Number.isFinite(oppIdNum)) {
      setInstances([])
      return
    }
    fetchStrategyInstances({ strategy_opportunity_id: oppIdNum })
      .then(r => setInstances(r.items ?? []))
      .catch(() => setInstances([]))
  }, [oppIdNum])

  const [ledgerFilterSymbol, setLedgerFilterSymbol] = useState('')
  const [ledgerFilterExpiryStart, setLedgerFilterExpiryStart] = useState('')
  const [ledgerFilterAccount, setLedgerFilterAccount] = useState<string>('')
  const [ledgerTab, setLedgerTab] = useState<'strategy' | 'instance' | 'options' | 'stocks'>('strategy')
  const [ledgerOptionSubTab, setLedgerOptionSubTab] = useState<'contracts' | 'orphans'>('contracts')
  const [ledgerInstanceSubTab, setLedgerInstanceSubTab] = useState<'with_instance' | 'no_instance'>('with_instance')
  /** With-instance list: filter by whether the instance has any unrealized (open) contract group. */
  const [instanceContainOpenFilter, setInstanceContainOpenFilter] = useState<'all' | 'yes' | 'no'>('all')
  const [instanceExpandedIds, setInstanceExpandedIds] = useState<Set<number>>(new Set())
  /** Strategy (opportunity) tab: expanded group keys — `id` or `none`. */
  const [strategyOppExpandedKeys, setStrategyOppExpandedKeys] = useState<Set<string>>(new Set())
  /** Strategy tab: per-instance rows under an opportunity — `${oppKey}::${instKey}`, default collapsed. */
  const [strategyInstanceExpandedKeys, setStrategyInstanceExpandedKeys] = useState<Set<string>>(
    new Set(),
  )
  const [ledgerAccordionMode, setLedgerAccordionMode] = useState<boolean>(false)
  const [ledgerStockGroupByPosition, setLedgerStockGroupByPosition] = useState<boolean>(false)
  const [ledgerStockCategoryTab, setLedgerStockCategoryTab] = useState<string>('All')
  const [ledgerOptSort, setLedgerOptSort] = useState<{
    column: 'expiry' | 'trade_date'
    dir: 'asc' | 'desc'
  }>({ column: 'expiry', dir: 'desc' })
  const [ledgerStockSort, setLedgerStockSort] = useState<{
    column: 'trade_date'
    dir: 'asc' | 'desc'
  }>({ column: 'trade_date', dir: 'desc' })
  const [ledgerSummaryPeriod, setLedgerSummaryPeriod] = useState<LedgerSummaryPeriod>('month')
  const [ledgerMetricExplain, setLedgerMetricExplain] = useState<{
    id: string
    kind: LedgerMetricExplainKind
    anchor: { x: number; y: number }
    payload: LedgerMetricExplainPayload
  } | null>(null)
  const [expandedDetailKeys, setExpandedDetailKeys] = useState<string[]>([])
  const [editExec, setEditExec] = useState<Execution | null>(null)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkContext, setLinkContext] = useState<LinkExecutionContext | null>(null)
  const [expiredCloseKey, setExpiredCloseKey] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    open: boolean
    title: string
    message: string
    confirming: boolean
    exec: Execution | null
  }>({ open: false, title: '', message: '', confirming: false, exec: null })
  const [syncingAccountExecutionsId, setSyncingAccountExecutionsId] = useState<number | null>(null)

  const handleEditExecution = useCallback((ex: Execution) => {
    setEditExec(ex)
    setPageError(null)
  }, [])

  const handleLinkExecution = useCallback((ex: Execution) => {
    if (ex.account_executions_id == null) return
    setLinkContext({
      account_executions_id: ex.account_executions_id,
      execution: ex,
    })
    setLinkModalOpen(true)
    setPageError(null)
  }, [])

  const handleSyncOppositeLegAttribution = useCallback(
    async (target: Execution, peer: Execution) => {
      const tid = target.account_executions_id
      const opp = peer.strategy_opportunity_id
      const inst = peer.strategy_instance_id
      if (
        tid == null ||
        opp == null ||
        inst == null ||
        !Number.isFinite(Number(opp)) ||
        !Number.isFinite(Number(inst))
      ) {
        return
      }
      setSyncingAccountExecutionsId(tid)
      setPageError(null)
      try {
        const res = await updateExecution(tid, {
          strategy_opportunity_id: Number(opp),
          strategy_instance_id: Number(inst),
        })
        if (!res.ok) {
          setPageError(res.error ?? 'Failed to sync strategy from opposite leg.')
        } else {
          await loadReplayData()
        }
      } catch (err) {
        setPageError(err instanceof Error ? err.message : 'Failed to sync strategy from opposite leg.')
      } finally {
        setSyncingAccountExecutionsId(null)
      }
    },
    [loadReplayData],
  )

  const handleDeleteExecution = useCallback((ex: Execution) => {
    setPageError(null)
    setDeleteConfirmState({
      open: true,
      title: 'Delete execution',
      message:
        'This will permanently remove this execution from the trade ledger. This cannot be undone.',
      confirming: false,
      exec: ex,
    })
  }, [])

  const toggleDetailExpand = useCallback(
    (key: string) => {
      setExpandedDetailKeys(prev => {
        const isOpen = prev.includes(key)
        if (ledgerAccordionMode) {
          return isOpen ? [] : [key]
        }
        return isOpen ? prev.filter(k => k !== key) : [...prev, key]
      })
    },
    [ledgerAccordionMode],
  )

  /** (account_id, contract_key) -> category name for STK positions */
  const positionCategoryByAccountContract = useMemo(() => {
    const map = new Map<string, string>()
    const accounts = status?.portfolio?.accounts ?? []
    for (const acc of accounts) {
      const accountId = (acc.account_id ?? '').trim()
      const positions =
        (acc as { positions?: { account_id?: string; contract_key?: string; category?: string }[] })
          .positions ?? []
      for (const p of positions) {
        const ck = (p.contract_key ?? '').trim()
        if (accountId && ck) {
          const key = `${accountId}|${ck}`
          const name = (p as { category?: string }).category
          if (typeof name === 'string' && name.trim()) map.set(key, name.trim())
        }
      }
    }
    return map
  }, [status?.portfolio?.accounts])

  /** STK contract_key for lookup: symbol|STK||| */
  const stkContractKey = useCallback(
    (sym: string, accId: string) =>
      `${(accId ?? '').trim()}|${(sym ?? '').toString().trim().toUpperCase()}|STK|||`,
    [],
  )

  const getStockExecCategory = useCallback(
    (ex: Execution) =>
      positionCategoryByAccountContract.get(
        stkContractKey(ex.symbol ?? '', ex.account_id ?? ''),
      ) ?? '—',
    [positionCategoryByAccountContract, stkContractKey],
  )

  const ledgerBaseFilteredExecutions = useMemo(() => {
    let list = [...(executions || [])]
    const sym = ledgerFilterSymbol.trim().toUpperCase()
    if (sym) {
      list = list.filter(e => {
        const directSymbol = (e.symbol || '').toUpperCase().trim()
        if (directSymbol === sym || directSymbol.startsWith(sym)) return true
        const ck = (e.contract_key ?? '').trim()
        if (!ck) return false
        const partSymbol = getContractLabelParts(ck).symbol.toUpperCase().trim()
        if (!partSymbol) return false
        return partSymbol === sym || partSymbol.startsWith(sym)
      })
    }
    const expMonth = ledgerFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }
    return list
  }, [executions, ledgerFilterSymbol, ledgerFilterExpiryStart])

  const filteredExecutions = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutions]
    const acc = ledgerFilterAccount.trim()
    if (acc && acc !== 'All') list = list.filter(e => (e.account_id ?? '').trim() === acc)
    return list
  }, [ledgerBaseFilteredExecutions, ledgerFilterAccount])

  /** Same UI filters as `ledgerBaseFilteredExecutions`, applied to official-book executions (GET /executions performance_book → account_executions_final). */
  const ledgerBaseFilteredExecutionsBook = useMemo(() => {
    let list = [...(executionsBook || [])]
    const sym = ledgerFilterSymbol.trim().toUpperCase()
    if (sym) {
      list = list.filter(e => {
        const directSymbol = (e.symbol || '').toUpperCase().trim()
        if (directSymbol === sym || directSymbol.startsWith(sym)) return true
        const ck = (e.contract_key ?? '').trim()
        if (!ck) return false
        const partSymbol = getContractLabelParts(ck).symbol.toUpperCase().trim()
        if (!partSymbol) return false
        return partSymbol === sym || partSymbol.startsWith(sym)
      })
    }
    const expMonth = ledgerFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }
    return list
  }, [executionsBook, ledgerFilterSymbol, ledgerFilterExpiryStart])

  const filteredExecutionsBook = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutionsBook]
    const acc = ledgerFilterAccount.trim()
    if (acc && acc !== 'All') list = list.filter(e => (e.account_id ?? '').trim() === acc)
    return list
  }, [ledgerBaseFilteredExecutionsBook, ledgerFilterAccount])

  /** OPT-only executions from the book feed — single source for Instance / Options tabs. */
  const optionExecutionsBook = useMemo(
    () => filteredExecutionsBook.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT'),
    [filteredExecutionsBook],
  )

  /** All Options UI (Closed Option + Open Option): `GET /executions?source_scope=performance_book` → account_executions_final only. */
  const optExecutionGroups = useMemo(
    (): OptExecutionGroup[] => buildOptExecutionGroups(filteredExecutionsBook),
    [filteredExecutionsBook],
  )

  /* ── Instance tab data derivations ── */

  const withInstanceExecs = useMemo(
    () => optionExecutionsBook.filter(e => executionStrategyInstanceIds(e).length > 0),
    [optionExecutionsBook],
  )
  const noInstanceExecs = useMemo(
    () => optionExecutionsBook.filter(e => executionStrategyInstanceIds(e).length === 0),
    [optionExecutionsBook],
  )

  /** Groups by strategy_instance_id, each containing its own closed/open contract groups. */
  const instanceGroups = useMemo(() => {
    const byId = new Map<number, Execution[]>()
    for (const e of withInstanceExecs) {
      for (const id of executionStrategyInstanceIds(e)) {
        const arr = byId.get(id)
        if (arr) arr.push(e)
        else byId.set(id, [e])
      }
    }
    return Array.from(byId.entries())
      .map(([id, trades]) => {
        const tradesForGroups = trades.flatMap(t => {
          const row = sliceExecutionForInstanceOptView(t, id)
          return row ? [row] : []
        })
        const groups = buildOptExecutionGroups(tradesForGroups)
        const label =
          trades.map(t => executionInstanceLabel(t, id)).find(l => l && l.trim()) ?? null
        const oppName =
          trades.find(t => t.strategy_opportunity_name?.trim())?.strategy_opportunity_name?.trim() ?? null
        return { instanceId: id, label, opportunityName: oppName, groups, trades }
      })
      .sort((a, b) => b.instanceId - a.instanceId)
  }, [withInstanceExecs])

  /** Groups OPT book by opportunity, then by instance (allocation-weighted rows → per-instance contract groups). */
  const strategyOpportunityGroups = useMemo(() => {
    const byOpp = new Map<number | 'none', Execution[]>()
    for (const e of optionExecutionsBook) {
      for (const row of expandExecutionRowsForStrategyOptView(e)) {
        const key = executionStrategyOpportunityKey(row)
        const arr = byOpp.get(key)
        if (arr) arr.push(row)
        else byOpp.set(key, [row])
      }
    }
    const rows = Array.from(byOpp.entries()).map(([opportunityId, trades]) => {
      const byInst = groupExecutionsByStrategyInstanceId(trades)
      const instanceSubgroups = Array.from(byInst.entries())
        .map(([instanceId, instTrades]) => {
          const groups = buildOptExecutionGroups(instTrades)
          const numericId = instanceId === 'none' ? null : instanceId
          const label =
            numericId != null
              ? instTrades.map(t => executionInstanceLabel(t, numericId)).find(l => l && l.trim()) ?? null
              : null
          return { instanceId, label, groups, trades: instTrades }
        })
        .sort((a, b) => {
          if (a.instanceId === 'none') return 1
          if (b.instanceId === 'none') return -1
          return b.instanceId - a.instanceId
        })
      const nameFromTrade =
        trades.find(t => t.strategy_opportunity_name?.trim())?.strategy_opportunity_name?.trim() ?? null
      const nameFromList =
        opportunityId !== 'none'
          ? opportunities.find(o => o.strategy_opportunity_id === opportunityId)?.name?.trim() ?? null
          : null
      const title =
        nameFromTrade ??
        nameFromList ??
        (opportunityId === 'none' ? 'No opportunity' : `Opportunity #${opportunityId}`)
      return { opportunityId, title, instanceSubgroups }
    })
    rows.sort((a, b) => {
      if (a.opportunityId === 'none') return 1
      if (b.opportunityId === 'none') return -1
      return b.opportunityId - a.opportunityId
    })
    return rows
  }, [optionExecutionsBook, opportunities])

  const filteredInstanceGroups = useMemo(() => {
    if (instanceContainOpenFilter === 'all') return instanceGroups
    return instanceGroups.filter(ig => {
      const open = ig.groups.filter(g => g.status === 'unrealized')
      const hasOpen = open.length > 0
      return instanceContainOpenFilter === 'yes' ? hasOpen : !hasOpen
    })
  }, [instanceGroups, instanceContainOpenFilter])

  const noInstanceOptGroups = useMemo(
    (): OptExecutionGroup[] => buildOptExecutionGroups(noInstanceExecs),
    [noInstanceExecs],
  )

  const noInstanceClosedGroups = useMemo(
    () => noInstanceOptGroups.filter(g => g.status === 'realized'),
    [noInstanceOptGroups],
  )
  const noInstanceOpenGroups = useMemo(
    () => noInstanceOptGroups.filter(g => g.status === 'unrealized'),
    [noInstanceOptGroups],
  )

  const hasWithInstance = instanceGroups.length > 0
  const hasNoInstance = noInstanceOptGroups.length > 0

  const sortedNoInstanceClosedGroups = useMemo(() => {
    const list = [...noInstanceClosedGroups]
    const { column, dir } = ledgerOptSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'expiry') {
        const sa = (a.expiry ?? '').trim().replace(/-/g, '')
        const sb = (b.expiry ?? '').trim().replace(/-/g, '')
        return mult * sa.localeCompare(sb, undefined, { numeric: true })
      }
      const datesA = [
        ...(a.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const datesB = [
        ...(b.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const va = datesA.length > 0 ? datesA[0] : ''
      const vb = datesB.length > 0 ? datesB[0] : ''
      return mult * va.localeCompare(vb)
    })
    return list
  }, [noInstanceClosedGroups, ledgerOptSort])

  const noInstanceOpenNotExpired = useMemo(
    () => noInstanceOpenGroups.filter(g => !isOptionExpired(g.expiry)),
    [noInstanceOpenGroups],
  )
  const noInstanceExpiredUnrealized = useMemo(
    () => noInstanceOpenGroups.filter(g => isOptionExpired(g.expiry)),
    [noInstanceOpenGroups],
  )
  const sortedNoInstanceOpenNotExpired = useMemo(() => {
    const list = [...noInstanceOpenNotExpired]
    list.sort((a, b) => {
      const sa = (a.expiry ?? '').trim().replace(/-/g, '')
      const sb = (b.expiry ?? '').trim().replace(/-/g, '')
      return sb.localeCompare(sa, undefined, { numeric: true })
    })
    return list
  }, [noInstanceOpenNotExpired])

  const noInstanceOrphanGroups = useMemo(
    () => [...sortedNoInstanceOpenNotExpired, ...noInstanceExpiredUnrealized],
    [sortedNoInstanceOpenNotExpired, noInstanceExpiredUnrealized],
  )
  const noInstanceOrphanExpandedOptionGroups = useMemo(
    () => noInstanceOrphanGroups.filter(g => expandedDetailKeys.includes(getOptGroupKey(g))),
    [noInstanceOrphanGroups, expandedDetailKeys],
  )
  const noInstanceClosedExpandedOptionGroups = useMemo(
    () => sortedNoInstanceClosedGroups.filter(g => expandedDetailKeys.includes(getOptGroupKey(g))),
    [sortedNoInstanceClosedGroups, expandedDetailKeys],
  )
  const noInstanceClosedPnlSum = useMemo(
    () => sortedNoInstanceClosedGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0),
    [sortedNoInstanceClosedGroups],
  )
  const noInstanceClosedDetailsTotalPnl = useMemo(() => {
    let sum = 0
    for (const g of noInstanceClosedExpandedOptionGroups) {
      for (const ex of g.trades ?? []) {
        const s = (ex.side ?? '').toUpperCase()
        const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
        const q = Number(ex.quantity) || 0
        const p = Number(ex.price) || 0
        const c = Number(ex.commission) || 0
        const value = q * p * 100 - c
        sum += isBuy ? -value : value
      }
    }
    return sum
  }, [noInstanceClosedExpandedOptionGroups])

  const closedOptionGroups = useMemo(
    () => optExecutionGroups.filter(group => group.status === 'realized'),
    [optExecutionGroups],
  )

  const sortedClosedOptionGroups = useMemo(() => {
    const list = [...closedOptionGroups]
    const { column, dir } = ledgerOptSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'expiry') {
        const sa = (a.expiry ?? '').trim().replace(/-/g, '')
        const sb = (b.expiry ?? '').trim().replace(/-/g, '')
        return mult * sa.localeCompare(sb, undefined, { numeric: true })
      }
      const datesA = [
        ...(a.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const datesB = [
        ...(b.trades ?? []).map(t => t.trade_date).filter((d): d is string => d != null && String(d).trim() !== ''),
      ].sort()
      const va = datesA.length > 0 ? datesA[0] : ''
      const vb = datesB.length > 0 ? datesB[0] : ''
      return mult * va.localeCompare(vb)
    })
    return list
  }, [closedOptionGroups, ledgerOptSort])

  const expiredUnrealizedOptionGroups = useMemo(
    () =>
      optExecutionGroups.filter(
        group => group.status === 'unrealized' && isOptionExpired(group.expiry),
      ),
    [optExecutionGroups],
  )

  /** Open option legs (net qty ≠ 0, expiry not past): excluded from Summary and main closed table. */
  const openUnrealizedOptionGroups = useMemo(
    () =>
      optExecutionGroups.filter(
        group => group.status === 'unrealized' && !isOptionExpired(group.expiry),
      ),
    [optExecutionGroups],
  )

  const sortedOpenUnrealizedOptionGroups = useMemo(() => {
    const list = [...openUnrealizedOptionGroups]
    list.sort((a, b) => {
      const sa = (a.expiry ?? '').trim().replace(/-/g, '')
      const sb = (b.expiry ?? '').trim().replace(/-/g, '')
      return sb.localeCompare(sa, undefined, { numeric: true })
    })
    return list
  }, [openUnrealizedOptionGroups])

  const expiredCloseGroup =
    expiredCloseKey != null
      ? expiredUnrealizedOptionGroups.find(g => getOptGroupKey(g) === expiredCloseKey) ?? null
      : null

  const orphanOptionGroups = useMemo(
    () => [...sortedOpenUnrealizedOptionGroups, ...expiredUnrealizedOptionGroups],
    [sortedOpenUnrealizedOptionGroups, expiredUnrealizedOptionGroups],
  )
  const orphanOptionCount = orphanOptionGroups.length
  const orphanOptionDetailsCount = useMemo(
    () => orphanOptionGroups.reduce((sum, g) => sum + (g.trades?.length ?? 0), 0),
    [orphanOptionGroups],
  )

  const closedOptGroupsPnlSum = useMemo(
    () => closedOptionGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0),
    [closedOptionGroups],
  )

  const closedExpandedOptionGroups = useMemo(
    () => sortedClosedOptionGroups.filter(g => expandedDetailKeys.includes(getOptGroupKey(g))),
    [sortedClosedOptionGroups, expandedDetailKeys],
  )
  const orphanExpandedOptionGroups = useMemo(
    () => orphanOptionGroups.filter(g => expandedDetailKeys.includes(getOptGroupKey(g))),
    [orphanOptionGroups, expandedDetailKeys],
  )

  /** Closed-details sheet total PnL for expanded closed rows only. */
  const ledgerDetailsTotalPnl = useMemo(() => {
    let sum = 0
    for (const g of closedExpandedOptionGroups) {
      for (const ex of g.trades ?? []) {
        const s = (ex.side ?? '').toUpperCase()
        const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
        const q = Number(ex.quantity) || 0
        const p = Number(ex.price) || 0
        const c = Number(ex.commission) || 0
        const value = q * p * 100 - c
        sum += isBuy ? -value : value
      }
    }
    return sum
  }, [closedExpandedOptionGroups])

  const ledgerStockCategoryTabs = useMemo(() => {
    const stockExecs = (executions ?? []).filter(
      ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT',
    )
    const set = new Set<string>()
    for (const ex of stockExecs) {
      const cat = positionCategoryByAccountContract.get(
        stkContractKey(ex.symbol ?? '', ex.account_id ?? ''),
      )
      if (typeof cat === 'string' && cat.trim()) set.add(cat.trim())
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b))
    return ['All', ...list, 'Uncategorized']
  }, [executions, positionCategoryByAccountContract, stkContractKey])

  const ledgerTabLabel = useMemo(() => {
    switch (ledgerTab) {
      case 'strategy':
        return 'Strategy'
      case 'instance':
        return 'Instance'
      case 'options':
        return 'Options'
      case 'stocks':
        return 'Stocks'
      default:
        return ledgerTab
    }
  }, [ledgerTab])

  const summaryPeriodModeLabel = useMemo(
    () =>
      LEDGER_SUMMARY_PERIOD_TABS.find(t => t.id === ledgerSummaryPeriod)?.label ??
      ledgerSummaryPeriod,
    [ledgerSummaryPeriod],
  )

  const ledgerStockFilteredExecutions = useMemo(() => {
    let stockExecs = filteredExecutions.filter(
      ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT',
    )
    if (ledgerStockCategoryTab !== 'All') {
      stockExecs =
        ledgerStockCategoryTab === 'Uncategorized'
          ? stockExecs.filter(ex => getStockExecCategory(ex) === '—')
          : stockExecs.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
    }
    return stockExecs
  }, [filteredExecutions, ledgerStockCategoryTab, getStockExecCategory])

  const ledgerOptionsSummaryByMonth = useMemo(() => {
    const byMonth = new Map<string, { count: number; realizedPnl: number }>()
    for (const g of closedOptionGroups) {
      const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
      const ts = times.length > 0 ? Math.max(...times) : 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, realizedPnl: 0 }
      cur.count += 1
      cur.realizedPnl += Number(g.realized_pnl) || 0
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [closedOptionGroups])

  const ledgerStocksSummaryByMonth = useMemo(() => {
    const stockExecs = ledgerStockFilteredExecutions
    const byMonth = new Map<string, { count: number; notional: number; realizedPnl: number }>()
    for (const ex of stockExecs) {
      const ts = ex.time ?? 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, notional: 0, realizedPnl: 0 }
      cur.count += 1
      const q = Number(ex.quantity) || 0
      const p = Number(ex.price) || 0
      cur.notional += Math.abs(q) * p
      cur.realizedPnl += Number(ex.realized_pnl) || 0
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [ledgerStockFilteredExecutions])

  const ledgerStocksSummaryTotals = useMemo(() => {
    let trades = 0
    let notional = 0
    let realizedPnl = 0
    for (const [, d] of ledgerStocksSummaryByMonth) {
      trades += d.count
      notional += d.notional
      realizedPnl += d.realizedPnl
    }
    return { trades, notional, realizedPnl }
  }, [ledgerStocksSummaryByMonth])

  const handleMetricExplainEnter = useCallback(
    (kind: LedgerMetricExplainKind, id: string, e: MouseEvent) => {
      e.stopPropagation()
      const payload = buildLedgerMetricExplainPayload({
        kind,
        id,
        ledgerTabLabel,
        summaryPeriodModeLabel,
        ledgerSummaryPeriod,
        closedOptionGroups,
        stockFilteredExecutions: ledgerStockFilteredExecutions,
        closedOptGroupsPnlSum,
      })
      setLedgerMetricExplain(prev => {
        const anchor = prev === null ? { x: e.clientX, y: e.clientY } : prev.anchor
        return { id, kind, anchor, payload }
      })
    },
    [
      ledgerTabLabel,
      summaryPeriodModeLabel,
      ledgerSummaryPeriod,
      closedOptionGroups,
      ledgerStockFilteredExecutions,
      closedOptGroupsPnlSum,
    ],
  )

  const ledgerOptionsSummaryByPeriod = useMemo(
    () => rollupOptionsFromMonthly(ledgerOptionsSummaryByMonth, ledgerSummaryPeriod),
    [ledgerOptionsSummaryByMonth, ledgerSummaryPeriod],
  )

  const ledgerStocksSummaryByPeriod = useMemo(
    () => rollupStocksFromMonthly(ledgerStocksSummaryByMonth, ledgerSummaryPeriod),
    [ledgerStocksSummaryByMonth, ledgerSummaryPeriod],
  )

  const hasOptionExecutions = optExecutionGroups.length > 0
  const hasStockExecutions = useMemo(
    () => filteredExecutions.some(e => (e.sec_type ?? '').toUpperCase() !== 'OPT'),
    [filteredExecutions],
  )

  const sortedStockExecutions = useMemo(() => {
    const list = [...ledgerStockFilteredExecutions]
    const { dir } = ledgerStockSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const va = (a.trade_date ?? '').trim()
      const vb = (b.trade_date ?? '').trim()
      return mult * va.localeCompare(vb)
    })
    return list
  }, [ledgerStockFilteredExecutions, ledgerStockSort])

  useEffect(() => {
    if (ledgerTab === 'strategy' && !hasOptionExecutions && hasStockExecutions) {
      setLedgerTab('stocks')
      return
    }
    if (ledgerTab === 'instance' && !hasOptionExecutions && hasStockExecutions) {
      setLedgerTab('stocks')
      return
    }
    if (ledgerTab === 'options' && !hasOptionExecutions && hasStockExecutions) {
      setLedgerTab('stocks')
      return
    }
    if (ledgerTab === 'stocks' && !hasStockExecutions && hasOptionExecutions) {
      setLedgerTab('strategy')
    }
  }, [ledgerTab, hasOptionExecutions, hasStockExecutions])

  useEffect(() => {
    if (ledgerTab !== 'instance') return
    if (ledgerInstanceSubTab === 'with_instance' && !hasWithInstance && hasNoInstance) {
      setLedgerInstanceSubTab('no_instance')
      return
    }
    if (ledgerInstanceSubTab === 'no_instance' && !hasNoInstance && hasWithInstance) {
      setLedgerInstanceSubTab('with_instance')
    }
  }, [ledgerTab, ledgerInstanceSubTab, hasWithInstance, hasNoInstance])

  useEffect(() => {
    if (ledgerTab !== 'stocks') return
    if (!ledgerStockCategoryTabs.includes(ledgerStockCategoryTab)) {
      setLedgerStockCategoryTab('All')
    }
  }, [ledgerTab, ledgerStockCategoryTab, ledgerStockCategoryTabs])

  useEffect(() => {
    if (ledgerTab !== 'options') return
    if (ledgerOptionSubTab === 'contracts' && sortedClosedOptionGroups.length === 0 && orphanOptionCount > 0) {
      setLedgerOptionSubTab('orphans')
      return
    }
    if (ledgerOptionSubTab === 'orphans' && orphanOptionCount === 0 && sortedClosedOptionGroups.length > 0) {
      setLedgerOptionSubTab('contracts')
    }
  }, [ledgerTab, ledgerOptionSubTab, sortedClosedOptionGroups.length, orphanOptionCount])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  useEffect(() => {
    const acc = ledgerFilterAccount.trim()
    if (!acc || acc === 'All') return
    const allowed = new Set(ledgerTradeAccountTabs.map(t => t.id))
    if (allowed.size === 0 || !allowed.has(acc)) setLedgerFilterAccount('')
  }, [ledgerFilterAccount, ledgerTradeAccountTabs])

  return (
    <>
      <section
        className="replay-section replay-section-trade-records"
        aria-label="Trade ledger"
      >
        <div className="replay-filters replay-filters--bar">
          <label className="replay-filter-wrap-symbol">
            <LedgerSymbolCombobox
              value={ledgerFilterSymbol}
              onChange={setLedgerFilterSymbol}
              suggestions={ledgerSymbolSuggestions}
            />
          </label>
          <div className="ledger-filter-field ledger-filter-field--expiry">
            <LedgerExpiryMonthCombobox
              value={ledgerFilterExpiryStart}
              onChange={setLedgerFilterExpiryStart}
              monthKeys={ledgerMonthKeyOptions}
            />
          </div>
          <div className="ledger-filter-account-bubble-group">
            <div className="ledger-filter-account-bubbles" role="group" aria-label="Account filter">
              <button
                type="button"
                className={`ledger-account-bubble ${
                  !ledgerFilterAccount || ledgerFilterAccount === 'All' ? 'ledger-account-bubble--active' : ''
                }`}
                onClick={() => setLedgerFilterAccount('')}
              >
                All
              </button>
              {ledgerTradeAccountTabs.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={`ledger-account-bubble ${ledgerFilterAccount === id ? 'ledger-account-bubble--active' : ''}`}
                  title={id}
                  onClick={() => setLedgerFilterAccount(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ledger-filter-field ledger-filter-field--strategy">
            <StrategyOpportunityCombobox
              opportunities={opportunities}
              value={ledgerFilterStrategyOpportunityId}
              onChange={id => {
                setLedgerFilterStrategyOpportunityId(id)
                setLedgerFilterStrategyInstanceId('')
              }}
            />
          </div>
          {ledgerFilterStrategyOpportunityId !== '' ? (
            <label className="replay-filter-label-instance" title="Instance">
              <span className="replay-filter-label">Instance</span>
              <select
                value={ledgerFilterStrategyInstanceId === '' ? '' : String(ledgerFilterStrategyInstanceId)}
                onChange={e => {
                  const v = e.target.value
                  setLedgerFilterStrategyInstanceId(v === '' ? '' : Number(v))
                }}
                className="replay-filter-input replay-filter-select"
                aria-label="Instance filter"
              >
                <option value="">All</option>
                {instances.map(si => (
                  <option key={si.strategy_instance_id} value={String(si.strategy_instance_id)}>
                    {si.label?.trim() || `#${si.strategy_instance_id}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="replay-portfolio-block">
          <div className="replay-portfolio-header">
            <div className="replay-portfolio-tabs-wrap">
              <div
                className="system-tabs replay-portfolio-tabs"
                role="tablist"
                aria-label="Strategy, instance, option and stock ledger sections"
              >
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-strategy"
                  aria-selected={ledgerTab === 'strategy'}
                  aria-controls="replay-panel-strategy"
                  className={`system-tab ${ledgerTab === 'strategy' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('strategy')}
                  disabled={!hasOptionExecutions}
                >
                  Strategy
                </button>
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-instance"
                  aria-selected={ledgerTab === 'instance'}
                  aria-controls="replay-panel-instance"
                  className={`system-tab ${ledgerTab === 'instance' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('instance')}
                  disabled={!hasOptionExecutions}
                >
                  Instance
                </button>
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-options"
                  aria-selected={ledgerTab === 'options'}
                  aria-controls="replay-panel-options"
                  className={`system-tab ${ledgerTab === 'options' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('options')}
                  disabled={!hasOptionExecutions}
                >
                  Options
                </button>
                <button
                  type="button"
                  role="tab"
                  id="replay-tab-stocks"
                  aria-selected={ledgerTab === 'stocks'}
                  aria-controls="replay-panel-stocks"
                  className={`system-tab ${ledgerTab === 'stocks' ? 'active' : ''}`}
                  onClick={() => setLedgerTab('stocks')}
                  disabled={!hasStockExecutions}
                >
                  Stocks
                </button>
              </div>
            </div>
            <div className="replay-portfolio-filters">
              {(ledgerTab === 'options' ||
                ledgerTab === 'strategy' ||
                (ledgerTab === 'instance' && ledgerInstanceSubTab === 'no_instance')) && (
                <div
                  className="replay-fetch-range-group"
                  role="radiogroup"
                  aria-label="Detail view mode"
                >
                  <span className="replay-fetch-days-label">Detail view</span>
                  <InfoTooltip text="Completed option trades are grouped by contract and strike so the page reads like a closed-trade ledger." />
                  <label className="replay-fetch-radio">
                    <input
                      type="radio"
                      name="replay-detail-view"
                      value="accordion"
                      checked={ledgerAccordionMode}
                      onChange={() => setLedgerAccordionMode(true)}
                    />
                    <span>Accordion</span>
                  </label>
                  <label className="replay-fetch-radio">
                    <input
                      type="radio"
                      name="replay-detail-view"
                      value="multi"
                      checked={!ledgerAccordionMode}
                      onChange={() => setLedgerAccordionMode(false)}
                    />
                    <span>Multi</span>
                  </label>
                </div>
              )}
              {ledgerTab === 'stocks' && (
                <>
                  <div
                    className="system-tabs replay-stock-group-tabs"
                    role="tablist"
                    aria-label="Stock view mode"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!ledgerStockGroupByPosition}
                      className={`system-tab ${!ledgerStockGroupByPosition ? 'active' : ''}`}
                      onClick={() => setLedgerStockGroupByPosition(false)}
                    >
                      Flat
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={ledgerStockGroupByPosition}
                      className={`system-tab ${ledgerStockGroupByPosition ? 'active' : ''}`}
                      onClick={() => setLedgerStockGroupByPosition(true)}
                    >
                      Position
                    </button>
                  </div>
                  <div
                    className="system-tabs replay-stock-category-tabs"
                    role="tablist"
                    aria-label="Position category filter"
                  >
                    {ledgerStockCategoryTabs.map(cat => (
                      <button
                        key={cat}
                        type="button"
                        role="tab"
                        aria-selected={ledgerStockCategoryTab === cat}
                        className={`system-tab ${ledgerStockCategoryTab === cat ? 'active' : ''}`}
                        onClick={() => setLedgerStockCategoryTab(cat)}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {filteredExecutions.length === 0 && filteredExecutionsBook.length === 0 ? (
            <p className="section-hint">
              No execution data. Use Overview to fetch from IB (Refresh), or Trade ledger to add a manual journal
              entry (Add journal).
              {[ledgerFilterSymbol, ledgerFilterExpiryStart].some(Boolean) ||
              (ledgerFilterAccount && ledgerFilterAccount !== 'All') ||
              ledgerFilterStrategyOpportunityId !== '' ||
              ledgerFilterStrategyInstanceId !== ''
                ? ' Filters applied.'
                : ''}
            </p>
          ) : (
            <>
              <section
                className="replay-ledger-summary replay-ledger-summary--period"
                aria-label="Summary by period"
              >
                <div className="replay-ledger-summary-period-head">
                  <span className="replay-ledger-summary-label">Summary</span>
                  <div
                    className="replay-ledger-summary-period-tabs"
                    role="tablist"
                    aria-label="Summary aggregation period"
                  >
                    {LEDGER_SUMMARY_PERIOD_TABS.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={ledgerSummaryPeriod === id}
                        className={`replay-ledger-summary-period-tab ${ledgerSummaryPeriod === id ? 'active' : ''}`}
                        onClick={() => setLedgerSummaryPeriod(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {ledgerTab === 'options' || ledgerTab === 'strategy' || ledgerTab === 'instance' ? (
                  <div className="replay-ledger-summary-period-body">
                    <ul
                      className="replay-ledger-summary-calendar-grid"
                      aria-label="Option closed groups by period"
                    >
                      {ledgerOptionsSummaryByPeriod.map(([key, { count, realizedPnl }]) => (
                        <li key={key} className="replay-ledger-summary-period-cell">
                          <span className="replay-ledger-summary-period-cell-label">
                            {formatPeriodLabel(key, ledgerSummaryPeriod)}
                          </span>
                          <span className="replay-ledger-summary-period-cell-metrics">
                            <span>{count} groups</span>
                            <span className="replay-ledger-summary-stocks-metric-sep" aria-hidden>
                              ·
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className={`replay-ledger-metric-explain-trigger ${
                                realizedPnl > 0
                                  ? 'replay-pnl-realized'
                                  : realizedPnl < 0
                                    ? 'replay-pnl-detail-negative'
                                    : 'replay-ledger-summary-realized-zero'
                              }`}
                              aria-label="Open calculation details for this period realized PnL"
                              onMouseEnter={e =>
                                handleMetricExplainEnter(
                                  'options_period_realized',
                                  `opt-pnl-${key}`,
                                  e,
                                )
                              }
                              onClick={e => {
                                e.stopPropagation()
                                handleMetricExplainEnter(
                                  'options_period_realized',
                                  `opt-pnl-${key}`,
                                  e,
                                )
                              }}
                            >
                              {fmtUsd0(realizedPnl)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div
                      className="replay-ledger-summary-stocks-total"
                      aria-label="Option summary totals"
                    >
                      <span className="replay-ledger-summary-stocks-total-label">Total</span>
                      <span className="replay-ledger-summary-stocks-total-metrics">
                        <span>
                          {ledgerOptionsSummaryByMonth.reduce((s, [, d]) => s + d.count, 0)} groups
                        </span>
                        <span className="replay-ledger-summary-stocks-metric-sep" aria-hidden>
                          ·
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className={`replay-ledger-metric-explain-trigger ${
                            closedOptGroupsPnlSum > 0
                              ? 'replay-pnl-realized'
                              : closedOptGroupsPnlSum < 0
                                ? 'replay-pnl-detail-negative'
                                : 'replay-ledger-summary-realized-zero'
                          }`}
                          aria-label="Open calculation details for total option realized PnL"
                          onMouseEnter={e =>
                            handleMetricExplainEnter('options_total_realized', 'opt-pnl-total', e)
                          }
                          onClick={e => {
                            e.stopPropagation()
                            handleMetricExplainEnter('options_total_realized', 'opt-pnl-total', e)
                          }}
                        >
                          {fmtUsd0(closedOptGroupsPnlSum)}
                        </span>
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="replay-ledger-summary-period-body">
                    <ul
                      className="replay-ledger-summary-calendar-grid"
                      aria-label="Stock trades by period"
                    >
                      {ledgerStocksSummaryByPeriod.map(([key, { count, notional, realizedPnl }]) => (
                        <li key={key} className="replay-ledger-summary-period-cell">
                          <span className="replay-ledger-summary-period-cell-label">
                            {formatPeriodLabel(key, ledgerSummaryPeriod)}
                          </span>
                          <span className="replay-ledger-summary-period-cell-metrics">
                            <span>{count} trades</span>
                            <span className="replay-ledger-summary-stocks-metric-sep" aria-hidden>
                              ·
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              className={`replay-ledger-metric-explain-trigger ${
                                realizedPnl > 0
                                  ? 'replay-pnl-realized'
                                  : realizedPnl < 0
                                    ? 'replay-pnl-detail-negative'
                                    : 'replay-ledger-summary-realized-zero'
                              }`}
                              aria-label="Open calculation details for this period stock realized PnL"
                              onMouseEnter={e =>
                                handleMetricExplainEnter(
                                  'stocks_period_realized',
                                  `stk-rz-${key}`,
                                  e,
                                )
                              }
                              onClick={e => {
                                e.stopPropagation()
                                handleMetricExplainEnter(
                                  'stocks_period_realized',
                                  `stk-rz-${key}`,
                                  e,
                                )
                              }}
                            >
                              {fmtUsd0(realizedPnl)}
                            </span>
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            className="replay-ledger-summary-stocks-notional-line replay-ledger-metric-explain-trigger"
                            aria-label="Open calculation details for notional in this period"
                            onMouseEnter={e =>
                              handleMetricExplainEnter('stocks_period_notional', `stk-nv-${key}`, e)
                            }
                            onClick={e => {
                              e.stopPropagation()
                              handleMetricExplainEnter('stocks_period_notional', `stk-nv-${key}`, e)
                            }}
                          >
                            Notional {fmtUsd0(notional)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div
                      className="replay-ledger-summary-stocks-total"
                      aria-label="Stock summary totals"
                    >
                      <span className="replay-ledger-summary-stocks-total-label">Total</span>
                      <span className="replay-ledger-summary-stocks-total-metrics">
                        <span>{ledgerStocksSummaryTotals.trades} trades</span>
                        <span className="replay-ledger-summary-stocks-metric-sep" aria-hidden>
                          ·
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className={`replay-ledger-metric-explain-trigger ${
                            ledgerStocksSummaryTotals.realizedPnl > 0
                              ? 'replay-pnl-realized'
                              : ledgerStocksSummaryTotals.realizedPnl < 0
                                ? 'replay-pnl-detail-negative'
                                : 'replay-ledger-summary-realized-zero'
                          }`}
                          aria-label="Open calculation details for total stock realized PnL"
                          onMouseEnter={e =>
                            handleMetricExplainEnter('stocks_total_realized', 'stk-total-rz', e)
                          }
                          onClick={e => {
                            e.stopPropagation()
                            handleMetricExplainEnter('stocks_total_realized', 'stk-total-rz', e)
                          }}
                        >
                          {fmtUsd0(ledgerStocksSummaryTotals.realizedPnl)}
                        </span>
                        <span className="replay-ledger-summary-stocks-metric-sep" aria-hidden>
                          ·
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="replay-ledger-summary-stocks-notional replay-ledger-metric-explain-trigger"
                          aria-label="Open calculation details for total stock notional"
                          onMouseEnter={e =>
                            handleMetricExplainEnter('stocks_total_notional', 'stk-total-nv', e)
                          }
                          onClick={e => {
                            e.stopPropagation()
                            handleMetricExplainEnter('stocks_total_notional', 'stk-total-nv', e)
                          }}
                        >
                          nv {fmtUsd0(ledgerStocksSummaryTotals.notional)}
                        </span>
                      </span>
                    </div>
                  </div>
                )}
              </section>
              {ledgerTab === 'strategy' && (
                <div
                  id="replay-panel-strategy"
                  role="tabpanel"
                  aria-labelledby="replay-tab-strategy"
                  className="system-tab-panel"
                >
                  {hasOptionExecutions ? (
                    <>
                      {strategyOpportunityGroups.length === 0 ? (
                        <p className="section-hint">No option trades under the current filters.</p>
                      ) : (
                        <div>
                          {strategyOpportunityGroups.map(og => {
                            const closedAll = og.instanceSubgroups.flatMap(sg =>
                              sg.groups.filter(g => g.status === 'realized'),
                            )
                            const openAll = og.instanceSubgroups.flatMap(sg =>
                              sg.groups.filter(g => g.status === 'unrealized'),
                            )
                            const pnl = closedAll.reduce((s, g) => s + (Number(g.realized_pnl) || 0), 0)
                            const expandKey =
                              og.opportunityId === 'none' ? 'none' : String(og.opportunityId)
                            const isExpanded = strategyOppExpandedKeys.has(expandKey)
                            return (
                              <div key={expandKey} className="replay-instance-group">
                                <button
                                  type="button"
                                  className="replay-instance-group-header"
                                  onClick={() =>
                                    setStrategyOppExpandedKeys(prev => {
                                      const next = new Set(prev)
                                      if (next.has(expandKey)) next.delete(expandKey)
                                      else next.add(expandKey)
                                      return next
                                    })
                                  }
                                  aria-expanded={isExpanded}
                                >
                                  <span
                                    className={`replay-instance-chevron ${isExpanded ? 'replay-instance-chevron--open' : ''}`}
                                  >
                                    ▶
                                  </span>
                                  <span className="replay-instance-group-title">{og.title}</span>
                                  <span className="replay-instance-group-stats">
                                    <span>Instances: {og.instanceSubgroups.length}</span>
                                    <span>Closed: {closedAll.length}</span>
                                    <span>Open: {openAll.length}</span>
                                    <span
                                      className={
                                        pnl >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'
                                      }
                                    >
                                      PnL: {fmtUsd0(pnl)}
                                    </span>
                                  </span>
                                </button>
                                {isExpanded && (
                                  <div className="replay-instance-group-body">
                                    {og.instanceSubgroups.map(sg => {
                                      const closed = sg.groups.filter(g => g.status === 'realized')
                                      const open = sg.groups.filter(g => g.status === 'unrealized')
                                      const sgPnl = closed.reduce(
                                        (s, g) => s + (Number(g.realized_pnl) || 0),
                                        0,
                                      )
                                      const instKey =
                                        sg.instanceId === 'none'
                                          ? 'none'
                                          : String(sg.instanceId)
                                      const instanceCompositeKey = `${expandKey}::${instKey}`
                                      const instExpanded =
                                        strategyInstanceExpandedKeys.has(instanceCompositeKey)
                                      return (
                                        <div
                                          key={`${expandKey}-inst-${instKey}`}
                                          className="replay-strategy-instance-nest"
                                        >
                                          <div className="replay-strategy-instance-header-row">
                                            <button
                                              type="button"
                                              className="replay-strategy-instance-collapse-header"
                                              onClick={() =>
                                                setStrategyInstanceExpandedKeys(prev => {
                                                  const next = new Set(prev)
                                                  if (next.has(instanceCompositeKey))
                                                    next.delete(instanceCompositeKey)
                                                  else next.add(instanceCompositeKey)
                                                  return next
                                                })
                                              }
                                              aria-expanded={instExpanded}
                                            >
                                              <span
                                                className={`replay-instance-chevron ${instExpanded ? 'replay-instance-chevron--open' : ''}`}
                                                aria-hidden
                                              >
                                                ▶
                                              </span>
                                              <span className="replay-strategy-instance-head-title">
                                                {sg.instanceId === 'none' ? (
                                                  'No instance'
                                                ) : (
                                                  <>
                                                    {sg.label ? (
                                                      <span
                                                        className="replay-strategy-instance-label"
                                                        title={sg.label}
                                                      >
                                                        {sg.label}
                                                      </span>
                                                    ) : null}
                                                    {sg.label ? ' ' : null}
                                                    <span className="replay-strategy-instance-id-text">
                                                      #{sg.instanceId}
                                                    </span>
                                                  </>
                                                )}
                                              </span>
                                              <span className="replay-strategy-instance-stats">
                                                <span>Closed: {closed.length}</span>
                                                <span>Open: {open.length}</span>
                                                <span
                                                  className={
                                                    sgPnl >= 0
                                                      ? 'replay-pnl-realized'
                                                      : 'replay-pnl-detail-negative'
                                                  }
                                                >
                                                  PnL: {fmtUsd0(sgPnl)}
                                                </span>
                                              </span>
                                            </button>
                                            {sg.instanceId !== 'none' && (
                                              <a
                                                href={`#/strategies/instances/${sg.instanceId}`}
                                                className="replay-stg-ins-link replay-strategy-instance-open-link"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={
                                                  sg.label
                                                    ? `Open instance #${sg.instanceId} (${sg.label})`
                                                    : `Open instance #${sg.instanceId}`
                                                }
                                              >
                                                Open
                                              </a>
                                            )}
                                          </div>
                                          {instExpanded && (
                                            <div className="replay-strategy-instance-collapse-body">
                                              {closed.length > 0 && (
                                                <div className="replay-instance-group-block">
                                                  <h6 className="replay-instance-subheading">Closed Option</h6>
                                                  <div className="replay-portfolio-table-wrap">
                                                    <table className="table-operations replay-opt-groups">
                                                      <thead>
                                                        <tr>
                                                          <th>Contract</th>
                                                          <th>Expiry</th>
                                                          <th>Strike</th>
                                                          <th>Type</th>
                                                          <th>Buy&nbsp;Qty</th>
                                                          <th>Sell&nbsp;Qty</th>
                                                          <th>PnL</th>
                                                          <th>Trades</th>
                                                        </tr>
                                                      </thead>
                                                      <tbody>
                                                        {closed.map(g => {
                                                          const parts = getContractLabelParts(
                                                            g.contract_key ?? '',
                                                          )
                                                          return (
                                                            <tr key={getOptGroupKey(g)}>
                                                              <td>{parts.symbol || g.contract_key}</td>
                                                              <td>{fmtExpiry(g.expiry)}</td>
                                                              <td>{g.strike ?? '—'}</td>
                                                              <td>{parts.rightLabel || '—'}</td>
                                                              <td>{g.buy_volume}</td>
                                                              <td>{g.sell_volume}</td>
                                                              <td
                                                                className={
                                                                  Number(g.realized_pnl) >= 0
                                                                    ? 'replay-pnl-realized'
                                                                    : 'replay-pnl-detail-negative'
                                                                }
                                                              >
                                                                {fmtUsd0(Number(g.realized_pnl))}
                                                              </td>
                                                              <td>{g.trades?.length ?? 0}</td>
                                                            </tr>
                                                          )
                                                        })}
                                                      </tbody>
                                                    </table>
                                                  </div>
                                                </div>
                                              )}
                                              {open.length > 0 && (
                                                <div className="replay-instance-group-block">
                                                  <h6 className="replay-instance-subheading">Open Option</h6>
                                                  <div className="replay-portfolio-table-wrap">
                                                    <table className="table-operations replay-opt-groups">
                                                      <thead>
                                                        <tr>
                                                          <th>Contract</th>
                                                          <th>Expiry</th>
                                                          <th>Strike</th>
                                                          <th>Type</th>
                                                          <th>Net&nbsp;Qty</th>
                                                          <th>Trades</th>
                                                        </tr>
                                                      </thead>
                                                      <tbody>
                                                        {open.map(g => {
                                                          const parts = getContractLabelParts(
                                                            g.contract_key ?? '',
                                                          )
                                                          return (
                                                            <tr key={getOptGroupKey(g)}>
                                                              <td>{parts.symbol || g.contract_key}</td>
                                                              <td>{fmtExpiry(g.expiry)}</td>
                                                              <td>{g.strike ?? '—'}</td>
                                                              <td>{parts.rightLabel || '—'}</td>
                                                              <td>{g.net_qty ?? '—'}</td>
                                                              <td>{g.trades?.length ?? 0}</td>
                                                            </tr>
                                                          )
                                                        })}
                                                      </tbody>
                                                    </table>
                                                  </div>
                                                </div>
                                              )}
                                              {closed.length === 0 && open.length === 0 && (
                                                <p className="section-hint">No contracts for this instance.</p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                    {og.instanceSubgroups.length === 0 && (
                                      <p className="section-hint">No grouped contract data for this strategy.</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="section-hint">No option trades under the current filters.</p>
                  )}
                </div>
              )}
              {ledgerTab === 'instance' && (
                <div
                  id="replay-panel-instance"
                  role="tabpanel"
                  aria-labelledby="replay-tab-instance"
                  className="system-tab-panel"
                >
                  {hasOptionExecutions ? (
                    <>
                      <div
                        className={`replay-instance-contain-filter ${ledgerInstanceSubTab === 'no_instance' ? 'replay-instance-contain-filter--disabled' : ''}`}
                        role="group"
                        aria-label="Filter instances by open positions"
                      >
                        <span className="replay-instance-contain-filter-label">Contain open</span>
                        <InfoTooltip text="Filters the With instance list: Yes = at least one open (unrealized) option contract; No = only closed legs; All = every instance." />
                        <div
                          className="replay-bubble-switch"
                          role="radiogroup"
                          aria-label="Contain open"
                        >
                          {(['all', 'yes', 'no'] as const).map(v => (
                            <button
                              key={v}
                              type="button"
                              role="radio"
                              aria-checked={instanceContainOpenFilter === v}
                              className={`replay-bubble-switch-btn ${instanceContainOpenFilter === v ? 'active' : ''}`}
                              disabled={ledgerInstanceSubTab === 'no_instance'}
                              onClick={() => setInstanceContainOpenFilter(v)}
                            >
                              {v === 'all' ? 'All' : v === 'yes' ? 'Yes' : 'No'}
                            </button>
                          ))}
                        </div>
                        {ledgerInstanceSubTab === 'with_instance' &&
                          instanceContainOpenFilter !== 'all' &&
                          instanceGroups.length > 0 && (
                            <span className="replay-instance-contain-filter-meta">
                              Showing {filteredInstanceGroups.length} of {instanceGroups.length}
                            </span>
                          )}
                      </div>
                      <div
                        className="system-tabs replay-stock-group-tabs"
                        role="tablist"
                        aria-label="With instance and No instance"
                        style={{ marginBottom: '0.5rem' }}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={ledgerInstanceSubTab === 'with_instance'}
                          className={`system-tab ${ledgerInstanceSubTab === 'with_instance' ? 'active' : ''}`}
                          onClick={() => setLedgerInstanceSubTab('with_instance')}
                          disabled={!hasWithInstance}
                        >
                          With instance ({instanceGroups.length})
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={ledgerInstanceSubTab === 'no_instance'}
                          className={`system-tab ${ledgerInstanceSubTab === 'no_instance' ? 'active' : ''}`}
                          onClick={() => setLedgerInstanceSubTab('no_instance')}
                          disabled={!hasNoInstance}
                        >
                          No instance ({noInstanceOptGroups.length})
                        </button>
                      </div>

                      {ledgerInstanceSubTab === 'with_instance' && (
                        <div>
                          {instanceGroups.length === 0 ? (
                            <p className="section-hint">No option trades with a strategy instance under the current filters.</p>
                          ) : filteredInstanceGroups.length === 0 ? (
                            <p className="section-hint">
                              No instances match Contain open = {instanceContainOpenFilter === 'yes' ? 'Yes' : 'No'}. Change the filter or clear it (All).
                            </p>
                          ) : (
                            filteredInstanceGroups.map(ig => {
                              const closed = ig.groups.filter(g => g.status === 'realized')
                              const open = ig.groups.filter(g => g.status === 'unrealized')
                              const pnl = closed.reduce((s, g) => s + (Number(g.realized_pnl) || 0), 0)
                              const isExpanded = instanceExpandedIds.has(ig.instanceId)
                              return (
                                <div key={ig.instanceId} className="replay-instance-group">
                                  <div className="replay-instance-group-header-row">
                                    <button
                                      type="button"
                                      className="replay-instance-group-header"
                                      onClick={() => setInstanceExpandedIds(prev => {
                                        const next = new Set(prev)
                                        if (next.has(ig.instanceId)) next.delete(ig.instanceId)
                                        else next.add(ig.instanceId)
                                        return next
                                      })}
                                      aria-expanded={isExpanded}
                                    >
                                      <span className={`replay-instance-chevron ${isExpanded ? 'replay-instance-chevron--open' : ''}`}>▶</span>
                                      <span className="replay-instance-group-title">
                                        {ig.label ?? `Instance #${ig.instanceId}`}
                                      </span>
                                      {ig.opportunityName && (
                                        <span className="replay-instance-group-opp">({ig.opportunityName})</span>
                                      )}
                                      <span className="replay-instance-group-stats">
                                        <span>Closed: {closed.length}</span>
                                        <span>Open: {open.length}</span>
                                        <span className={pnl >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                                          PnL: {fmtUsd0(pnl)}
                                        </span>
                                      </span>
                                    </button>
                                    <a
                                      href={`#/strategies/instances/${ig.instanceId}`}
                                      className="replay-stg-ins-link replay-instance-detail-link"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title={
                                        ig.label
                                          ? `Open instance detail (#${ig.instanceId} — ${ig.label})`
                                          : `Open instance detail (#${ig.instanceId})`
                                      }
                                      aria-label={
                                        ig.label
                                          ? `Open instance detail for #${ig.instanceId} (${ig.label})`
                                          : `Open instance detail for #${ig.instanceId}`
                                      }
                                    >
                                      Detail
                                    </a>
                                  </div>
                                  {isExpanded && (
                                    <div className="replay-instance-group-body">
                                      {closed.length > 0 && (
                                        <div className="replay-instance-group-block">
                                          <h6 className="replay-instance-subheading">Closed Option</h6>
                                          <div className="replay-portfolio-table-wrap">
                                            <table className="table-operations replay-opt-groups">
                                              <thead>
                                                <tr>
                                                  <th>Contract</th>
                                                  <th>Expiry</th>
                                                  <th>Strike</th>
                                                  <th>Type</th>
                                                  <th>Buy&nbsp;Qty</th>
                                                  <th>Sell&nbsp;Qty</th>
                                                  <th>PnL</th>
                                                  <th>Trades</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {closed.map(g => {
                                                  const parts = getContractLabelParts(g.contract_key ?? '')
                                                  return (
                                                    <tr key={getOptGroupKey(g)}>
                                                      <td>{parts.symbol || g.contract_key}</td>
                                                      <td>{fmtExpiry(g.expiry)}</td>
                                                      <td>{g.strike ?? '—'}</td>
                                                      <td>{parts.rightLabel || '—'}</td>
                                                      <td>{g.buy_volume}</td>
                                                      <td>{g.sell_volume}</td>
                                                      <td className={Number(g.realized_pnl) >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                                                        {fmtUsd0(Number(g.realized_pnl))}
                                                      </td>
                                                      <td>{g.trades?.length ?? 0}</td>
                                                    </tr>
                                                  )
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      )}
                                      {open.length > 0 && (
                                        <div className="replay-instance-group-block">
                                          <h6 className="replay-instance-subheading">Open Option</h6>
                                          <div className="replay-portfolio-table-wrap">
                                            <table className="table-operations replay-opt-groups">
                                              <thead>
                                                <tr>
                                                  <th>Contract</th>
                                                  <th>Expiry</th>
                                                  <th>Strike</th>
                                                  <th>Type</th>
                                                  <th>Net&nbsp;Qty</th>
                                                  <th>Trades</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {open.map(g => {
                                                  const parts = getContractLabelParts(g.contract_key ?? '')
                                                  return (
                                                    <tr key={getOptGroupKey(g)}>
                                                      <td>{parts.symbol || g.contract_key}</td>
                                                      <td>{fmtExpiry(g.expiry)}</td>
                                                      <td>{g.strike ?? '—'}</td>
                                                      <td>{parts.rightLabel || '—'}</td>
                                                      <td>{g.net_qty ?? '—'}</td>
                                                      <td>{g.trades?.length ?? 0}</td>
                                                    </tr>
                                                  )
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      )}
                                      {closed.length === 0 && open.length === 0 && (
                                        <p className="section-hint">No grouped contract data for this instance.</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })
                          )}
                        </div>
                      )}

                      {ledgerInstanceSubTab === 'no_instance' && (
                        <div
                          className="replay-instance-no-inst-sheet"
                          aria-label="Option trades without strategy instance"
                        >
                          <p className="section-hint replay-instance-no-inst-sheet-intro">
                            All trades in this sheet have no strategy instance. Expand closed rows and use Link in Details (per trade) to assign an opportunity and instance.
                          </p>
                          <LedgerClosedOptionContractsSection
                            sortedClosedGroups={sortedNoInstanceClosedGroups}
                            closedExpandedGroups={noInstanceClosedExpandedOptionGroups}
                            closedPnlSum={noInstanceClosedPnlSum}
                            detailsTotalPnl={noInstanceClosedDetailsTotalPnl}
                            expandedDetailKeys={expandedDetailKeys}
                            toggleDetailExpand={toggleDetailExpand}
                            ledgerOptSort={ledgerOptSort}
                            setLedgerOptSort={setLedgerOptSort}
                            onEditExecution={handleEditExecution}
                            onLinkExecution={handleLinkExecution}
                            onDeleteExecution={handleDeleteExecution}
                            onSyncOppositeLegAttribution={handleSyncOppositeLegAttribution}
                            syncingAccountExecutionsId={syncingAccountExecutionsId}
                            detailPlaceholder="Click a closed trade row above to load details; then use Link to assign an instance."
                            sectionAriaLabel="No-instance closed option positions and details"
                          />
                          <LedgerOrphanOpenOptionSection
                            sortedOpenUnrealized={sortedNoInstanceOpenNotExpired}
                            expiredUnrealized={noInstanceExpiredUnrealized}
                            orphanExpandedGroups={noInstanceOrphanExpandedOptionGroups}
                            expandedDetailKeys={expandedDetailKeys}
                            toggleDetailExpand={toggleDetailExpand}
                            onExpiredCloseClick={key => setExpiredCloseKey(key)}
                            onEditExecution={handleEditExecution}
                            onLinkExecution={handleLinkExecution}
                            onDeleteExecution={handleDeleteExecution}
                            detailPlaceholder="Click an open or expired row above to load details; then use Link to assign an instance."
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="section-hint">
                      No option trades under the current filters.
                    </p>
                  )}
                </div>
              )}
              {ledgerTab === 'options' && (
                <div
                  id="replay-panel-options"
                  role="tabpanel"
                  aria-labelledby="replay-tab-options"
                  className="system-tab-panel"
                >
                  {hasOptionExecutions ? (
                    <>
                      <div
                        className="system-tabs replay-stock-group-tabs"
                        role="tablist"
                        aria-label="Closed Option and Open Option"
                        style={{ marginBottom: '0.5rem' }}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={ledgerOptionSubTab === 'contracts'}
                          className={`system-tab ${ledgerOptionSubTab === 'contracts' ? 'active' : ''}`}
                          onClick={() => setLedgerOptionSubTab('contracts')}
                          disabled={sortedClosedOptionGroups.length === 0}
                        >
                          Closed Option
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={ledgerOptionSubTab === 'orphans'}
                          className={`system-tab ${ledgerOptionSubTab === 'orphans' ? 'active' : ''}`}
                          onClick={() => setLedgerOptionSubTab('orphans')}
                          disabled={orphanOptionCount === 0}
                        >
                          Open Option ({orphanOptionCount} / {orphanOptionDetailsCount})
                        </button>
                      </div>
                      {ledgerOptionSubTab === 'contracts' && (
                      <LedgerClosedOptionContractsSection
                        sortedClosedGroups={sortedClosedOptionGroups}
                        closedExpandedGroups={closedExpandedOptionGroups}
                        closedPnlSum={closedOptGroupsPnlSum}
                        detailsTotalPnl={ledgerDetailsTotalPnl}
                        expandedDetailKeys={expandedDetailKeys}
                        toggleDetailExpand={toggleDetailExpand}
                        ledgerOptSort={ledgerOptSort}
                        setLedgerOptSort={setLedgerOptSort}
                        onEditExecution={handleEditExecution}
                        onLinkExecution={handleLinkExecution}
                        onDeleteExecution={handleDeleteExecution}
                        onSyncOppositeLegAttribution={handleSyncOppositeLegAttribution}
                        syncingAccountExecutionsId={syncingAccountExecutionsId}
                      />
                      )}


                      {ledgerOptionSubTab === 'orphans' && (
                        <LedgerOrphanOpenOptionSection
                          sortedOpenUnrealized={sortedOpenUnrealizedOptionGroups}
                          expiredUnrealized={expiredUnrealizedOptionGroups}
                          orphanExpandedGroups={orphanExpandedOptionGroups}
                          expandedDetailKeys={expandedDetailKeys}
                          toggleDetailExpand={toggleDetailExpand}
                          onExpiredCloseClick={key => setExpiredCloseKey(key)}
                          onEditExecution={handleEditExecution}
                          onLinkExecution={handleLinkExecution}
                          onDeleteExecution={handleDeleteExecution}
                        />
                      )}

                    </>
                  ) : (
                    <p className="section-hint">
                      No option trades under the current filters.
                    </p>
                  )}
                </div>
              )}
              {ledgerTab === 'stocks' && (
                <div
                  id="replay-panel-stocks"
                  role="tabpanel"
                  aria-labelledby="replay-tab-stocks"
                  className="system-tab-panel"
                >
                  {hasStockExecutions ? (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th
                              className="replay-th-sortable"
                              onClick={e => {
                                e.stopPropagation()
                                setLedgerStockSort(prev => ({
                                  column: 'trade_date',
                                  dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                }))
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setLedgerStockSort(prev => ({
                                    column: 'trade_date',
                                    dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                  }))
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              title="Sort by Trade date"
                            >
                              Trade date{' '}
                              {ledgerStockSort.dir === 'asc' ? ' ▲' : ' ▼'}
                            </th>
                            <th>Symbol</th>
                            <th>Account</th>
                            <th>Category</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Comm.</th>
                            <th>Source</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const stockExecs = sortedStockExecutions
                            if (!ledgerStockGroupByPosition) {
                              return stockExecs.map((ex, i) => {
                                const s = (ex.side ?? '').toUpperCase()
                                const sideLabel =
                                  s === 'BUY' || s === 'BOT' || s === 'B'
                                    ? 'Buy'
                                    : s === 'SELL' ||
                                        s === 'SLD' ||
                                        s === 'S'
                                      ? 'Sell'
                                      : (ex.side ?? '—')
                                return (
                                  <tr key={i}>
                                    <td>
                                      {ex.time != null
                                        ? fmtTs(ex.time)
                                        : '—'}
                                    </td>
                                    <td>{fmtTradeDate(ex.trade_date)}</td>
                                    <td>{ex.symbol ?? '—'}</td>
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>{getStockExecCategory(ex)}</td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <td>{fmtUsd(ex.commission ?? 0)}</td>
                                    <td><ExecSourceBadge source={ex.source} /></td>
                                    <td>
                                      {ex.account_executions_id != null ? (
                                        <span className="replay-exec-row-actions">
                                          <button
                                            type="button"
                                            className="btn btn-icon-small"
                                            onClick={() => {
                                              setEditExec(ex)
                                              setPageError(null)
                                            }}
                                            title="Edit"
                                            aria-label="Edit execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                            </svg>
                                          </button>
                                          <button
                                            type="button"
                                            className="btn btn-icon-small btn-icon-danger"
                                            onClick={() => {
                                              setPageError(null)
                                              setDeleteConfirmState({
                                                open: true,
                                                title: 'Delete execution',
                                                message:
                                                  'This will permanently remove this execution from the trade ledger. This cannot be undone.',
                                                confirming: false,
                                                exec: ex,
                                              })
                                            }}
                                            title="Delete"
                                            aria-label="Delete execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <polyline points="3 6 5 6 21 6" />
                                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                              <line x1="10" y1="11" x2="10" y2="17" />
                                              <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                          </button>
                                        </span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  </tr>
                                )
                              })
                            }
                            const groups = new Map<string, Execution[]>()
                            for (const ex of sortedStockExecutions) {
                              const acc = (ex.account_id ?? '').trim()
                              const sym = (ex.symbol ?? '')
                                .toString()
                                .trim()
                                .toUpperCase()
                              const key = `${acc}|${sym}`
                              if (!groups.has(key)) groups.set(key, [])
                              groups.get(key)!.push(ex)
                            }
                            const groupEntries = Array.from(
                              groups.entries(),
                            ).sort(([a], [b]) => {
                              const [accA, symA] = a.split('|')
                              const [accB, symB] = b.split('|')
                              if (symA !== symB)
                                return (symA || '').localeCompare(symB || '')
                              return (accA || '').localeCompare(accB || '')
                            })
                            const rows: JSX.Element[] = []
                            let rowIdx = 0
                            for (const [groupKey, execs] of groupEntries) {
                              const [accId, sym] = groupKey.split('|')
                              const category =
                                positionCategoryByAccountContract.get(
                                  stkContractKey(sym, accId),
                                ) ?? '—'
                              rows.push(
                                <tr
                                  key={`h-${groupKey}`}
                                  className="replay-stock-group-header"
                                >
                                  <td colSpan={11}>
                                    <span className="replay-stock-group-symbol">
                                      {sym || '—'}
                                    </span>
                                    <span className="replay-stock-group-account">
                                      {accId || '—'}
                                    </span>
                                    <span className="replay-stock-group-category">
                                      {category}
                                    </span>
                                  </td>
                                </tr>,
                              )
                              for (const ex of execs) {
                                const s = (ex.side ?? '').toUpperCase()
                                const sideLabel =
                                  s === 'BUY' || s === 'BOT' || s === 'B'
                                    ? 'Buy'
                                    : s === 'SELL' ||
                                        s === 'SLD' ||
                                        s === 'S'
                                      ? 'Sell'
                                      : (ex.side ?? '—')
                                rows.push(
                                  <tr key={rowIdx}>
                                    <td>
                                      {ex.time != null
                                        ? fmtTs(ex.time)
                                        : '—'}
                                    </td>
                                    <td>{fmtTradeDate(ex.trade_date)}</td>
                                    <td>{ex.symbol ?? '—'}</td>
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>{getStockExecCategory(ex)}</td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <td>{fmtUsd(ex.commission ?? 0)}</td>
                                    <td><ExecSourceBadge source={ex.source} /></td>
                                    <td>
                                      {ex.account_executions_id != null ? (
                                        <span className="replay-exec-row-actions">
                                          <button
                                            type="button"
                                            className="btn btn-icon-small"
                                            onClick={() => {
                                              setEditExec(ex)
                                              setPageError(null)
                                            }}
                                            title="Edit"
                                            aria-label="Edit execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                            </svg>
                                          </button>
                                          <button
                                            type="button"
                                            className="btn btn-icon-small btn-icon-danger"
                                            onClick={() => {
                                              setPageError(null)
                                              setDeleteConfirmState({
                                                open: true,
                                                title: 'Delete execution',
                                                message:
                                                  'This will permanently remove this execution from the trade ledger. This cannot be undone.',
                                                confirming: false,
                                                exec: ex,
                                              })
                                            }}
                                            title="Delete"
                                            aria-label="Delete execution"
                                          >
                                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                              <polyline points="3 6 5 6 21 6" />
                                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                              <line x1="10" y1="11" x2="10" y2="17" />
                                              <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                          </button>
                                        </span>
                                      ) : (
                                        '—'
                                      )}
                                    </td>
                                  </tr>,
                                )
                                rowIdx += 1
                              }
                            }
                            return rows
                          })()}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="section-hint">
                      No stock executions under the current filters.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {pageError && (
        <p
          className="section-hint replay-form-error"
          style={{ marginTop: '0.5rem' }}
        >
          {pageError}
        </p>
      )}
      {ledgerMetricExplain ? (
        <DraggableExplainPanel
          open
          explanationId={ledgerMetricExplain.id}
          anchor={ledgerMetricExplain.anchor}
          onClose={() => setLedgerMetricExplain(null)}
          title={ledgerMetricExplainTitle(ledgerMetricExplain.kind)}
        >
          <LedgerSummaryMetricExplainContent
            kind={ledgerMetricExplain.kind}
            payload={ledgerMetricExplain.payload}
          />
        </DraggableExplainPanel>
      ) : null}
      <ExecutionFormModal
        open={addJournalOpen || !!editExec}
        editExec={editExec}
        accountOptions={executionAccountOptions}
        createExecutionSource="journal_closed"
        onClose={() => {
          onAddJournalOpenChange(false)
          setEditExec(null)
          setPageError(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
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
        }}
      />
      <ExpiredCloseModal
        group={expiredCloseGroup}
        onClose={() => setExpiredCloseKey(null)}
        onSuccess={() => loadReplayData()}
      />
      {deleteConfirmState.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-exec-confirm-title"
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
            <h3 id="delete-exec-confirm-title" className="section-subtitle" style={{ marginTop: 0 }}>
              {deleteConfirmState.title}
            </h3>
            <p className="section-hint" style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
              {deleteConfirmState.message}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDeleteConfirmState(prev => ({ ...prev, open: false, exec: null }))}
                disabled={deleteConfirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
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
                  } else {
                    setPageError(res.error ?? 'Delete failed')
                  }
                  setDeleteConfirmState({ open: false, title: '', message: '', confirming: false, exec: null })
                }}
                disabled={deleteConfirmState.confirming}
              >
                {deleteConfirmState.confirming ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
