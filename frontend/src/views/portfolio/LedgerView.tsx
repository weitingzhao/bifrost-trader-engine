import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react'
import type {
  Execution,
  IbClient,
  IbPositionRow,
  OptExecutionGroup,
  OptionStockLinkRow,
  OptionStockLinkSummary,
  StatusResponse,
} from '../../types'
import type { StrategyOpportunity } from '../../api'
import { deleteExecution, fetchOpportunities, postOptionStockLinksQuery, updateExecution } from '../../api'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { DraggableExplainPanel } from '../../components/DraggableExplainPanel'
import { LedgerSymbolCombobox } from '../../components/LedgerSymbolCombobox'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  fmtExpiry,
  fmtPctCompact,
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
import { ExecutionFormModal, type ExecutionFormState } from './ExecutionFormModal'
import { ExpiredCloseModal } from './ExpiredCloseModal'
import type { LinkExecutionContext } from './LinkExecutionRecordModal'
import { LinkExecutionRecordModal } from './LinkExecutionRecordModal'
import type { LinkOptionStockContext } from './LinkOptionStockModal'
import { LinkOptionStockModal } from './LinkOptionStockModal'
import { ViewOptionStockLinksModal } from './ViewOptionStockLinksModal'
import type { PortfolioView } from './types'
import { useExecutions } from './useExecutions'
import { LedgerClosedOptionContractsSection } from './LedgerClosedOptionContractsSection'
import { LedgerOrphanOpenOptionSection } from './LedgerOrphanOpenOptionSection'
import {
  adjustedRealizedPnlForOptGroup,
  collectPeerInstancePicks,
  executionInstanceLabel,
  executionStrategyInstanceIds,
  executionStrategyOpportunityKey,
  expandExecutionRowsForStrategyOptView,
  getInstanceConsistencyState,
  groupExecutionsByStrategyInstanceId,
  getOptGroupKey,
  ledgerOptDetailRowPnl,
  sliceExecutionForInstanceOptView,
} from './ledgerOptHelpers'
import {
  LEDGER_SINCE_PRESET_TABS,
  LEDGER_SUMMARY_PERIOD_TABS,
  executionMatchesLedgerTradePeriod,
  formatPeriodLabel,
  getSinceTradeDateRange,
  rollupOptionsFromMonthly,
  rollupStocksFromMonthly,
  type LedgerSincePreset,
  type LedgerSummaryPeriod,
} from './ledgerSummaryPeriod'
import type { LedgerMetricExplainKind } from './ledgerMetricExplainKinds'
import type { LedgerMetricExplainPayload } from './ledgerSummaryExplainPayload'
import { buildLedgerMetricExplainPayload } from './ledgerSummaryExplainPayload'
import { LedgerSummaryMetricExplainContent, ledgerMetricExplainTitle } from './ledgerSummaryMetricExplain'
import {
  isLedgerCashLikeCategory,
  isLedgerFixedIncomeCategory,
} from './ledgerStockCategoryBuckets'
import { buildPositionCategoryByAccountContract, stkContractKey } from './stkLedgerBucket'
import { AppSelect } from '../../components/AppSelect'
import {
  aggregateInstanceIgListStats,
  aggregateStrategyOgListStats,
  executionMatchesExpiryYearMonth,
  fmtMdHint,
  getLedgerOpportunityDimensionMeta,
  ledgerUrPnlLineClass,
  stkCostBasisFromSnapshot,
  stkPctOf,
  stockGroupLatestSortKey,
  type LedgerOptSectionGroupBy,
} from './ledgerViewUtils'
import {
  LedgerStkNotionalCell,
  LedgerStkRowRealizedPnlCell,
  LedgerStkUrPnlGroupInline,
} from './LedgerCells'

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
  const [opportunities, setOpportunities] = useState<StrategyOpportunity[]>([])

  /** Top-bar filters use structure + wishlist client-side; do not narrow GET /executions by opportunity. */
  const strategyFilters = useMemo(() => ({}), [])
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

  const [ledgerFilterSymbol, setLedgerFilterSymbol] = useState('')
  /** Expiry: year `YYYY` or '' ; month `01`–`12` or '' (month disabled until year set). Mutually exclusive with Since. */
  const [expiryFilterYear, setExpiryFilterYear] = useState<string>('')
  const [expiryFilterMonth, setExpiryFilterMonth] = useState<string>('')
  /** Mutually exclusive with expiry year/month — "Since" rolling trade-date window (end = today). */
  const [ledgerTradeDatePreset, setLedgerTradeDatePreset] = useState<LedgerSincePreset | null>('month')
  /** AND on opportunities; client-side filter on executions when set (with wishlist). */
  const [ledgerFilterStructure, setLedgerFilterStructure] = useState<string>('')
  const [ledgerFilterWishlistSymbol, setLedgerFilterWishlistSymbol] = useState<string>('')
  const [ledgerFilterAccount, setLedgerFilterAccount] = useState<string>('')
  const [ledgerTab, setLedgerTab] = useState<
    'strategy' | 'instance' | 'options' | 'stocks' | 'fixed_income' | 'cash_like'
  >('strategy')
  const [ledgerOptInstanceFilter, setLedgerOptInstanceFilter] = useState<'all' | 'has_instance' | 'no_instance' | 'mixed'>('all')
  const [stocksPage, setStocksPage] = useState(1)
  const [ledgerOptionSubTab, setLedgerOptionSubTab] = useState<'contracts' | 'orphans'>('contracts')
  const [ledgerInstanceSubTab, setLedgerInstanceSubTab] = useState<'with_instance' | 'no_instance'>('with_instance')
  /** With-instance list: filter by whether the instance has any unrealized (open) contract group. */
  const [instanceContainOpenFilter, setInstanceContainOpenFilter] = useState<'all' | 'yes' | 'no'>('all')
  const [instanceExpandedIds, setInstanceExpandedIds] = useState<Set<number>>(new Set())
  /** Strategy + Instance panels: Call/Put only (executions already filtered by top bar). */
  const [ledgerOptionRightFilter, setLedgerOptionRightFilter] = useState<'' | 'C' | 'P'>('')
  /** Strategy (opportunity) tab: expanded group keys — `id` or `none`. */
  const [strategyOppExpandedKeys, setStrategyOppExpandedKeys] = useState<Set<string>>(new Set())
  /** Strategy tab: per-instance rows under an opportunity — `${oppKey}::${instKey}`, default collapsed. */
  const [strategyInstanceExpandedKeys, setStrategyInstanceExpandedKeys] = useState<Set<string>>(
    new Set(),
  )
  const [ledgerAccordionMode, setLedgerAccordionMode] = useState<boolean>(false)
  const [ledgerStockGroupByPosition, setLedgerStockGroupByPosition] = useState<boolean>(true)
  const [ledgerOptSectionGroupBy, setLedgerOptSectionGroupBy] =
    useState<LedgerOptSectionGroupBy>('opportunity')
  const [ledgerStrategyOuterExpandedKeys, setLedgerStrategyOuterExpandedKeys] = useState(
    () => new Set<string>(),
  )
  const [ledgerInstanceOuterExpandedKeys, setLedgerInstanceOuterExpandedKeys] = useState(
    () => new Set<string>(),
  )
  const [ledgerStockCategoryTab, setLedgerStockCategoryTab] = useState<string>('All')
  const [ledgerOptSort, setLedgerOptSort] = useState<{
    column: 'expiry' | 'trade_date'
    dir: 'asc' | 'desc'
  }>({ column: 'expiry', dir: 'desc' })
  /** Default: Trade date descending; group-by-position order uses each group's latest fill (see stockGroupLatestSortKey). */
  const [ledgerStockSort, setLedgerStockSort] = useState<{
    column: 'trade_date' | 'realized_pnl'
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
  const [optionStockModalOpen, setOptionStockModalOpen] = useState(false)
  const [optionStockModalContext, setOptionStockModalContext] = useState<LinkOptionStockContext | null>(null)
  const [optionStockLinkByOptionId, setOptionStockLinkByOptionId] = useState<
    Record<number, OptionStockLinkSummary>
  >({})
  const [viewStockLinksModal, setViewStockLinksModal] = useState<{
    open: boolean
    title: string
    rows: OptionStockLinkRow[]
    slippageTotal: number | null
  }>({ open: false, title: '', rows: [], slippageTotal: null })
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
  const [addJournalInitialDraft, setAddJournalInitialDraft] = useState<Partial<ExecutionFormState> | null>(null)
  const [addJournalLockContract, setAddJournalLockContract] = useState(false)
  const prevAddJournalOpenRef = useRef(false)
  const skipNextJournalDraftResetRef = useRef(false)

  const ledgerTradeDateRange = useMemo(
    () => (ledgerTradeDatePreset ? getSinceTradeDateRange(ledgerTradeDatePreset) : null),
    [ledgerTradeDatePreset],
  )

  const strategyDimensionFilterActive = useMemo(
    () => Boolean(ledgerFilterStructure.trim() || ledgerFilterWishlistSymbol.trim()),
    [ledgerFilterStructure, ledgerFilterWishlistSymbol],
  )

  const allowedOpportunityIds = useMemo(() => {
    const sf = ledgerFilterStructure.trim()
    const wf = ledgerFilterWishlistSymbol.trim().toUpperCase()
    if (!sf && !wf) return opportunities.map(o => o.strategy_opportunity_id)
    return opportunities
      .filter(o => {
        if (sf) {
          const sn = (o.structure_name ?? '').trim()
          if (sn !== sf) return false
        }
        if (wf) {
          const syms = (o.symbols ?? []).map(s => String(s).trim().toUpperCase())
          if (!syms.includes(wf)) return false
        }
        return true
      })
      .map(o => o.strategy_opportunity_id)
  }, [opportunities, ledgerFilterStructure, ledgerFilterWishlistSymbol])

  const structureNameOptions = useMemo(() => {
    const set = new Set<string>()
    for (const o of opportunities) {
      const n = (o.structure_name ?? '').trim()
      if (n) set.add(n)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [opportunities])

  const wishlistSymbolOptions = useMemo(() => {
    const set = new Set<string>()
    for (const o of opportunities) {
      for (const s of o.symbols ?? []) {
        const u = String(s).trim().toUpperCase()
        if (u) set.add(u)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [opportunities])

  const expiryYearOptions = useMemo(() => {
    const years = new Set<number>()
    for (const k of ledgerMonthKeyOptions) {
      const y = parseInt(k.slice(0, 4), 10)
      if (Number.isFinite(y)) years.add(y)
    }
    years.add(new Date().getFullYear())
    return Array.from(years).sort((a, b) => b - a)
  }, [ledgerMonthKeyOptions])

  const handleEditExecution = useCallback((ex: Execution) => {
    setEditExec(ex)
    setPageError(null)
  }, [])

  const openQuickStockJournal = useCallback(
    (accountId: string, symbol: string) => {
      const acc = (accountId ?? '').trim()
      const sym = (symbol ?? '').trim().toUpperCase()
      skipNextJournalDraftResetRef.current = true
      setAddJournalInitialDraft({
        account_id: acc,
        symbol: sym,
        sec_type: 'STK',
      })
      setAddJournalLockContract(true)
      onAddJournalOpenChange(true)
    },
    [onAddJournalOpenChange],
  )

  useEffect(() => {
    if (addJournalOpen && !prevAddJournalOpenRef.current) {
      if (!skipNextJournalDraftResetRef.current) {
        setAddJournalInitialDraft(null)
        setAddJournalLockContract(false)
      }
      skipNextJournalDraftResetRef.current = false
    }
    prevAddJournalOpenRef.current = addJournalOpen
  }, [addJournalOpen])

  const handleLinkStockExecution = useCallback((ex: Execution) => {
    if (ex.account_executions_id == null) return
    setOptionStockModalContext({ execution: ex })
    setOptionStockModalOpen(true)
    setPageError(null)
  }, [])

  const handleViewOptionStockLinks = useCallback(
    (rows: OptionStockLinkRow[], title: string, slippageTotal: number | null) => {
      setViewStockLinksModal({ open: true, title, rows, slippageTotal })
    },
    [],
  )

  const handleLinkExecution = useCallback((ex: Execution, sameContractTrades?: Execution[]) => {
    if (ex.account_executions_id == null) return
    const peerPicks =
      sameContractTrades && sameContractTrades.length > 0
        ? collectPeerInstancePicks(sameContractTrades, ex.account_executions_id)
        : []
    setLinkContext({
      account_executions_id: ex.account_executions_id,
      execution: ex,
      ...(peerPicks.length > 0 ? { peer_instance_picks: peerPicks } : {}),
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
  const positionCategoryByAccountContract = useMemo(
    () => buildPositionCategoryByAccountContract(status),
    [status?.portfolio?.accounts],
  )

  /** (account_id, contract_key) -> unrealized_pnl for STK rows from GET /status positions (Ib). */
  const stkUnrealizedPnlByAccountContract = useMemo(() => {
    const map = new Map<string, number | null>()
    const accounts = status?.portfolio?.accounts ?? []
    for (const acc of accounts) {
      const accountId = (acc.account_id ?? '').trim()
      const positions = (acc as { positions?: IbPositionRow[] }).positions ?? []
      for (const p of positions) {
        const stRaw = (p.secType ?? (p as { sec_type?: string }).sec_type ?? '').toString().trim().toUpperCase()
        if (stRaw !== 'STK') continue
        const ck = (p.contract_key ?? '').trim()
        if (!accountId || !ck) continue
        const key = `${accountId}|${ck}`
        const u = p.unrealized_pnl
        if (u != null && typeof u === 'number' && Number.isFinite(u)) {
          map.set(key, u)
        } else {
          map.set(key, null)
        }
      }
    }
    return map
  }, [status?.portfolio?.accounts])

  /** (account_id, contract_key) -> position snapshot for STK rows from GET /status (same keys as unrealized map). */
  const stkPositionSnapshotByAccountContract = useMemo(() => {
    const map = new Map<
      string,
      { position: number | null; avgCost: number | null; price: number | null }
    >()
    const accounts = status?.portfolio?.accounts ?? []
    for (const acc of accounts) {
      const accountId = (acc.account_id ?? '').trim()
      const positions = (acc as { positions?: IbPositionRow[] }).positions ?? []
      for (const p of positions) {
        const stRaw = (p.secType ?? (p as { sec_type?: string }).sec_type ?? '').toString().trim().toUpperCase()
        if (stRaw !== 'STK') continue
        const ck = (p.contract_key ?? '').trim()
        if (!accountId || !ck) continue
        const key = `${accountId}|${ck}`
        const posRaw = p.position
        let position: number | null = null
        if (posRaw != null) {
          const pq = typeof posRaw === 'number' ? posRaw : Number(posRaw)
          if (Number.isFinite(pq)) position = pq
        }
        const rawAvg = p.avgCost
        const avgFin =
          rawAvg != null && Number.isFinite(Number(rawAvg)) ? Number(rawAvg) : null
        const rawPx = p.price
        const priceFin =
          rawPx != null && Number.isFinite(Number(rawPx)) ? Number(rawPx) : null
        map.set(key, { position, avgCost: avgFin, price: priceFin })
      }
    }
    return map
  }, [status?.portfolio?.accounts])

  const getStockExecCategory = useCallback(
    (ex: Execution) =>
      positionCategoryByAccountContract.get(
        stkContractKey(ex.symbol ?? '', ex.account_id ?? ''),
      ) ?? '—',
    [positionCategoryByAccountContract],
  )

  const getStkUnrealizedForExecution = useCallback(
    (ex: Execution) => stkUnrealizedPnlByAccountContract.get(stkContractKey(ex.symbol ?? '', ex.account_id ?? '')),
    [stkUnrealizedPnlByAccountContract],
  )

  const getStkPositionSnapshotForGroup = useCallback(
    (accId: string, sym: string) => stkPositionSnapshotByAccountContract.get(stkContractKey(sym, accId)),
    [stkPositionSnapshotByAccountContract],
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
    if (ledgerTradeDateRange) {
      list = list.filter(e =>
        executionMatchesLedgerTradePeriod(e.trade_date, e.time, ledgerTradeDateRange),
      )
    } else if (expiryFilterYear.trim()) {
      list = list.filter(e =>
        executionMatchesExpiryYearMonth(e.expiry, expiryFilterYear, expiryFilterMonth),
      )
    }
    if (strategyDimensionFilterActive) {
      if (allowedOpportunityIds.length === 0) {
        list = []
      } else {
        const allow = new Set(allowedOpportunityIds)
        list = list.filter(e => {
          const oid = e.strategy_opportunity_id
          return oid != null && allow.has(Number(oid))
        })
      }
    }
    return list
  }, [
    executions,
    ledgerFilterSymbol,
    ledgerTradeDateRange,
    expiryFilterYear,
    expiryFilterMonth,
    strategyDimensionFilterActive,
    allowedOpportunityIds,
  ])

  const filteredExecutions = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutions]
    const acc = ledgerFilterAccount.trim()
    if (acc && acc !== 'All') list = list.filter(e => (e.account_id ?? '').trim() === acc)
    return list
  }, [ledgerBaseFilteredExecutions, ledgerFilterAccount])

  /** STK executions in the current instrument sub-tab bucket (before category pill filter). */
  const stkInstrumentBucketExecs = useMemo(() => {
    const list = filteredExecutions.filter(e => (e.sec_type ?? '').toUpperCase() === 'STK')
    if (ledgerTab === 'stocks') {
      return list.filter(ex => {
        const c = getStockExecCategory(ex)
        if (c === '—') return true
        return !isLedgerFixedIncomeCategory(c) && !isLedgerCashLikeCategory(c)
      })
    }
    if (ledgerTab === 'fixed_income') {
      return list.filter(ex => isLedgerFixedIncomeCategory(getStockExecCategory(ex)))
    }
    if (ledgerTab === 'cash_like') {
      return list.filter(ex => isLedgerCashLikeCategory(getStockExecCategory(ex)))
    }
    return []
  }, [filteredExecutions, ledgerTab, getStockExecCategory])

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
    if (ledgerTradeDateRange) {
      list = list.filter(e =>
        executionMatchesLedgerTradePeriod(e.trade_date, e.time, ledgerTradeDateRange),
      )
    } else if (expiryFilterYear.trim()) {
      list = list.filter(e =>
        executionMatchesExpiryYearMonth(e.expiry, expiryFilterYear, expiryFilterMonth),
      )
    }
    if (strategyDimensionFilterActive) {
      if (allowedOpportunityIds.length === 0) {
        list = []
      } else {
        const allow = new Set(allowedOpportunityIds)
        list = list.filter(e => {
          const oid = e.strategy_opportunity_id
          return oid != null && allow.has(Number(oid))
        })
      }
    }
    return list
  }, [
    executionsBook,
    ledgerFilterSymbol,
    ledgerTradeDateRange,
    expiryFilterYear,
    expiryFilterMonth,
    strategyDimensionFilterActive,
    allowedOpportunityIds,
  ])

  const filteredExecutionsBook = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutionsBook]
    const acc = ledgerFilterAccount.trim()
    if (acc && acc !== 'All') list = list.filter(e => (e.account_id ?? '').trim() === acc)
    return list
  }, [ledgerBaseFilteredExecutionsBook, ledgerFilterAccount])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const opt = filteredExecutionsBook.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
      const byAccount = new Map<string, number[]>()
      for (const e of opt) {
        const id = e.account_executions_id
        const acc = (e.account_id ?? '').trim()
        if (id == null || !acc) continue
        if (!byAccount.has(acc)) byAccount.set(acc, [])
        byAccount.get(acc)!.push(id)
      }
      const batches = Array.from(byAccount.entries()).map(([account_id, option_account_executions_ids]) => ({
        account_id,
        option_account_executions_ids,
      }))
      if (batches.length === 0) {
        if (!cancelled) setOptionStockLinkByOptionId({})
        return
      }
      let res: Awaited<ReturnType<typeof postOptionStockLinksQuery>>
      try {
        res = await postOptionStockLinksQuery({ batches })
      } catch {
        if (!cancelled) setOptionStockLinkByOptionId({})
        return
      }
      if (cancelled) return
      const raw = res.by_option_id ?? {}
      const next: Record<number, OptionStockLinkSummary> = {}
      for (const [k, v] of Object.entries(raw)) {
        const num = Number(k)
        if (!Number.isFinite(num)) continue
        const summary = v as OptionStockLinkSummary
        next[num] = {
          links: summary.links ?? [],
          slippage_total: summary.slippage_total ?? null,
        }
      }
      setOptionStockLinkByOptionId(next)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [filteredExecutionsBook])

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

  /** Call/Put options present in Instance list — for Type row only (Structure/Symbol/Expiry are top bar). */
  const instancePanelOptionRights = useMemo(() => {
    const rights = new Set<'C' | 'P'>()
    for (const ig of filteredInstanceGroups) {
      for (const g of ig.groups) {
        const r = (g.contract_key?.split('|')[4] ?? '').toUpperCase().slice(0, 1)
        if (r === 'C' || r === 'P') rights.add(r)
      }
    }
    return Array.from(rights).sort() as ('C' | 'P')[]
  }, [filteredInstanceGroups])

  /** filteredInstanceGroups further filtered by Call/Put (structure/symbol/expiry come from top bar). */
  const instanceFinalFiltered = useMemo(() => {
    if (!ledgerOptionRightFilter) return filteredInstanceGroups
    return filteredInstanceGroups.filter(ig =>
      ig.groups.some(g => {
        const r = (g.contract_key?.split('|')[4] ?? '').toUpperCase().slice(0, 1)
        return r === ledgerOptionRightFilter
      }),
    )
  }, [filteredInstanceGroups, ledgerOptionRightFilter])

  type InstanceGroupRow = (typeof instanceGroups)[number]

  const ledgerInstanceDisplayBuckets = useMemo((): {
    key: string
    label: string
    groups: InstanceGroupRow[]
  }[] => {
    const groups = instanceFinalFiltered
    if (ledgerOptSectionGroupBy === 'opportunity') {
      return [{ key: '_all', label: '', groups }]
    }
    if (ledgerOptSectionGroupBy === 'structure') {
      const m = new Map<string, InstanceGroupRow[]>()
      for (const ig of groups) {
        const oidRaw = ig.trades
          .map(t => t.strategy_opportunity_id)
          .find(id => id != null && Number.isFinite(Number(id)))
        const structureName =
          oidRaw != null
            ? getLedgerOpportunityDimensionMeta(Number(oidRaw), opportunities).structureName
            : '—'
        const k = structureName
        if (!m.has(k)) m.set(k, [])
        m.get(k)!.push(ig)
      }
      return Array.from(m.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, g]) => ({
          key: `struct:${key}`,
          label: key === '—' ? 'Unspecified structure' : key,
          groups: g,
        }))
    }
    const m = new Map<string, InstanceGroupRow[]>()
    for (const ig of groups) {
      const oidRaw = ig.trades
        .map(t => t.strategy_opportunity_id)
        .find(id => id != null && Number.isFinite(Number(id)))
      const symbols =
        oidRaw != null ? getLedgerOpportunityDimensionMeta(Number(oidRaw), opportunities).symbols : []
      if (symbols.length === 0) {
        const k = '—'
        if (!m.has(k)) m.set(k, [])
        m.get(k)!.push(ig)
      } else {
        const seen = new Set<string>()
        for (const sym of symbols) {
          if (seen.has(sym)) continue
          seen.add(sym)
          if (!m.has(sym)) m.set(sym, [])
          m.get(sym)!.push(ig)
        }
      }
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, g]) => ({
        key: `sym:${key}`,
        label: key === '—' ? 'No watchlist symbol' : key,
        groups: g,
      }))
  }, [instanceFinalFiltered, ledgerOptSectionGroupBy, opportunities])

  useEffect(() => {
    if (ledgerOptSectionGroupBy === 'opportunity') {
      setLedgerInstanceOuterExpandedKeys(new Set())
      return
    }
    setLedgerInstanceOuterExpandedKeys(new Set(ledgerInstanceDisplayBuckets.map(b => b.key)))
  }, [ledgerOptSectionGroupBy, ledgerInstanceDisplayBuckets])

  /** Call/Put options in Strategy opportunity list — for Type row only. */
  const strategyPanelOptionRights = useMemo(() => {
    const rights = new Set<'C' | 'P'>()
    for (const og of strategyOpportunityGroups) {
      for (const sg of og.instanceSubgroups) {
        for (const g of sg.groups) {
          const r = (g.contract_key?.split('|')[4] ?? '').toUpperCase().slice(0, 1)
          if (r === 'C' || r === 'P') rights.add(r)
        }
      }
    }
    return Array.from(rights).sort() as ('C' | 'P')[]
  }, [strategyOpportunityGroups])

  const filteredStrategyOpportunityGroups = useMemo(() => {
    if (!ledgerOptionRightFilter) return strategyOpportunityGroups
    return strategyOpportunityGroups.filter(og =>
      og.instanceSubgroups.some(sg =>
        sg.groups.some(g => {
          const r = (g.contract_key?.split('|')[4] ?? '').toUpperCase().slice(0, 1)
          return r === ledgerOptionRightFilter
        }),
      ),
    )
  }, [strategyOpportunityGroups, ledgerOptionRightFilter])

  type StrategyOppGroupRow = (typeof strategyOpportunityGroups)[number]

  const ledgerStrategyDisplayBuckets = useMemo((): {
    key: string
    label: string
    groups: StrategyOppGroupRow[]
  }[] => {
    const groups = filteredStrategyOpportunityGroups
    if (ledgerOptSectionGroupBy === 'opportunity') {
      return [{ key: '_all', label: '', groups }]
    }
    if (ledgerOptSectionGroupBy === 'structure') {
      const m = new Map<string, StrategyOppGroupRow[]>()
      for (const og of groups) {
        const { structureName } = getLedgerOpportunityDimensionMeta(og.opportunityId, opportunities)
        const k = structureName
        if (!m.has(k)) m.set(k, [])
        m.get(k)!.push(og)
      }
      return Array.from(m.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, g]) => ({
          key: `struct:${key}`,
          label: key === '—' ? 'Unspecified structure' : key,
          groups: g,
        }))
    }
    const m = new Map<string, StrategyOppGroupRow[]>()
    for (const og of groups) {
      const { symbols } = getLedgerOpportunityDimensionMeta(og.opportunityId, opportunities)
      if (symbols.length === 0) {
        const k = '—'
        if (!m.has(k)) m.set(k, [])
        m.get(k)!.push(og)
      } else {
        const seen = new Set<string>()
        for (const sym of symbols) {
          if (seen.has(sym)) continue
          seen.add(sym)
          if (!m.has(sym)) m.set(sym, [])
          m.get(sym)!.push(og)
        }
      }
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, g]) => ({
        key: `sym:${key}`,
        label: key === '—' ? 'No watchlist symbol' : key,
        groups: g,
      }))
  }, [filteredStrategyOpportunityGroups, ledgerOptSectionGroupBy, opportunities])

  useEffect(() => {
    if (ledgerOptSectionGroupBy === 'opportunity') {
      setLedgerStrategyOuterExpandedKeys(new Set())
      return
    }
    setLedgerStrategyOuterExpandedKeys(new Set(ledgerStrategyDisplayBuckets.map(b => b.key)))
  }, [ledgerOptSectionGroupBy, ledgerStrategyDisplayBuckets])

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
    () =>
      sortedNoInstanceClosedGroups.reduce(
        (acc, g) => acc + adjustedRealizedPnlForOptGroup(g, optionStockLinkByOptionId),
        0,
      ),
    [sortedNoInstanceClosedGroups, optionStockLinkByOptionId],
  )
  const noInstanceClosedDetailsTotalPnl = useMemo(() => {
    let sum = 0
    for (const g of noInstanceClosedExpandedOptionGroups) {
      for (const ex of g.trades ?? []) {
        sum += ledgerOptDetailRowPnl(ex, optionStockLinkByOptionId).displayPnl
      }
    }
    return sum
  }, [noInstanceClosedExpandedOptionGroups, optionStockLinkByOptionId])

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
    () =>
      closedOptionGroups.reduce(
        (acc, g) => acc + adjustedRealizedPnlForOptGroup(g, optionStockLinkByOptionId),
        0,
      ),
    [closedOptionGroups, optionStockLinkByOptionId],
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
        sum += ledgerOptDetailRowPnl(ex, optionStockLinkByOptionId).displayPnl
      }
    }
    return sum
  }, [closedExpandedOptionGroups, optionStockLinkByOptionId])

  const ledgerStockCategoryTabs = useMemo(() => {
    if (ledgerTab !== 'stocks' && ledgerTab !== 'fixed_income' && ledgerTab !== 'cash_like') {
      return ['All', 'Uncategorized']
    }
    const set = new Set<string>()
    for (const ex of stkInstrumentBucketExecs) {
      const cat = getStockExecCategory(ex)
      if (typeof cat === 'string' && cat.trim() && cat !== '—') set.add(cat.trim())
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b))
    return ['All', ...list, 'Uncategorized']
  }, [stkInstrumentBucketExecs, getStockExecCategory, ledgerTab])

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
      case 'fixed_income':
        return 'Fixed income'
      case 'cash_like':
        return 'Cash-like'
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
    if (ledgerTab !== 'stocks' && ledgerTab !== 'fixed_income' && ledgerTab !== 'cash_like') {
      return []
    }
    let stockExecs = [...stkInstrumentBucketExecs]
    if (ledgerStockCategoryTab !== 'All') {
      stockExecs =
        ledgerStockCategoryTab === 'Uncategorized'
          ? stockExecs.filter(ex => getStockExecCategory(ex) === '—')
          : stockExecs.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
    }
    return stockExecs
  }, [stkInstrumentBucketExecs, ledgerStockCategoryTab, getStockExecCategory, ledgerTab])

  const ledgerOptionsSummaryByMonth = useMemo(() => {
    const byMonth = new Map<string, { count: number; realizedPnl: number }>()
    for (const g of closedOptionGroups) {
      const times = (g.trades ?? []).map(t => t.time ?? 0).filter(Boolean)
      const ts = times.length > 0 ? Math.max(...times) : 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, realizedPnl: 0 }
      cur.count += 1
      cur.realizedPnl += adjustedRealizedPnlForOptGroup(g, optionStockLinkByOptionId)
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [closedOptionGroups, optionStockLinkByOptionId])

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
    const seen = new Set<string>()
    for (const ex of ledgerStockFilteredExecutions) {
      seen.add(stkContractKey(ex.symbol ?? '', ex.account_id ?? ''))
    }
    let totalUnrealized: number | null = null
    let sumU = 0
    let anyPositionRow = false
    for (const key of seen) {
      if (!stkUnrealizedPnlByAccountContract.has(key)) continue
      anyPositionRow = true
      const u = stkUnrealizedPnlByAccountContract.get(key)
      if (u != null && Number.isFinite(u)) sumU += u
    }
    if (anyPositionRow) totalUnrealized = sumU
    return { trades, notional, realizedPnl, totalUnrealized }
  }, [ledgerStocksSummaryByMonth, ledgerStockFilteredExecutions, stkUnrealizedPnlByAccountContract])

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
        stkUnrealizedByAccountContract: stkUnrealizedPnlByAccountContract,
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
      stkUnrealizedPnlByAccountContract,
    ],
  )

  const metricHoverTimerRef = useRef<number | null>(null)
  const handleMetricHoverEnter = useCallback(
    (kind: LedgerMetricExplainKind, id: string, e: MouseEvent) => {
      e.stopPropagation()
      const clientX = e.clientX
      const clientY = e.clientY
      if (metricHoverTimerRef.current != null) clearTimeout(metricHoverTimerRef.current)
      metricHoverTimerRef.current = window.setTimeout(() => {
        metricHoverTimerRef.current = null
        handleMetricExplainEnter(kind, id, {
          clientX,
          clientY,
          stopPropagation: () => {},
        } as unknown as MouseEvent)
      }, 700)
    },
    [handleMetricExplainEnter],
  )
  const handleMetricHoverLeave = useCallback(() => {
    if (metricHoverTimerRef.current != null) {
      clearTimeout(metricHoverTimerRef.current)
      metricHoverTimerRef.current = null
    }
  }, [])

  const ledgerOptionsSummaryByPeriod = useMemo(
    () => rollupOptionsFromMonthly(ledgerOptionsSummaryByMonth, ledgerSummaryPeriod),
    [ledgerOptionsSummaryByMonth, ledgerSummaryPeriod],
  )

  const ledgerStocksSummaryByPeriod = useMemo(
    () => rollupStocksFromMonthly(ledgerStocksSummaryByMonth, ledgerSummaryPeriod),
    [ledgerStocksSummaryByMonth, ledgerSummaryPeriod],
  )

  const filteredClosedOptionGroupsByInstance = useMemo(() => {
    if (ledgerOptInstanceFilter === 'all') return sortedClosedOptionGroups
    return sortedClosedOptionGroups.filter(g => {
      const state = getInstanceConsistencyState(g.trades ?? [])
      if (ledgerOptInstanceFilter === 'has_instance') return state === 'same' || state === 'multiple'
      if (ledgerOptInstanceFilter === 'no_instance') return state === 'none'
      if (ledgerOptInstanceFilter === 'mixed') return state === 'mixed'
      return true
    })
  }, [sortedClosedOptionGroups, ledgerOptInstanceFilter])

  const STOCKS_PAGE_SIZE = 50
  const hasOptionExecutions = optExecutionGroups.length > 0
  const hasPlainStockExecutions = useMemo(
    () =>
      filteredExecutions.some(e => {
        if ((e.sec_type ?? '').toUpperCase() !== 'STK') return false
        const c = getStockExecCategory(e)
        if (c === '—') return true
        return !isLedgerFixedIncomeCategory(c) && !isLedgerCashLikeCategory(c)
      }),
    [filteredExecutions, getStockExecCategory],
  )
  const hasFixedIncomeStockExecutions = useMemo(
    () =>
      filteredExecutions.some(
        e =>
          (e.sec_type ?? '').toUpperCase() === 'STK' &&
          isLedgerFixedIncomeCategory(getStockExecCategory(e)),
      ),
    [filteredExecutions, getStockExecCategory],
  )
  const hasCashLikeStockExecutions = useMemo(
    () =>
      filteredExecutions.some(
        e =>
          (e.sec_type ?? '').toUpperCase() === 'STK' &&
          isLedgerCashLikeCategory(getStockExecCategory(e)),
      ),
    [filteredExecutions, getStockExecCategory],
  )
  const hasAnyInstrumentStkTab = useMemo(
    () => hasPlainStockExecutions || hasFixedIncomeStockExecutions || hasCashLikeStockExecutions,
    [hasPlainStockExecutions, hasFixedIncomeStockExecutions, hasCashLikeStockExecutions],
  )

  const hasDataForCurrentInstrumentStkTab = useMemo(() => {
    if (ledgerTab === 'stocks') return hasPlainStockExecutions
    if (ledgerTab === 'fixed_income') return hasFixedIncomeStockExecutions
    if (ledgerTab === 'cash_like') return hasCashLikeStockExecutions
    return false
  }, [ledgerTab, hasPlainStockExecutions, hasFixedIncomeStockExecutions, hasCashLikeStockExecutions])

  const sortedStockExecutions = useMemo(() => {
    const list = [...ledgerStockFilteredExecutions]
    const { column, dir } = ledgerStockSort
    const mult = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      if (column === 'realized_pnl') {
        const va = Number(a.realized_pnl) || 0
        const vb = Number(b.realized_pnl) || 0
        if (Math.abs(va - vb) > 1e-9) return mult * (va - vb)
      } else {
        const da = (a.trade_date ?? '').trim()
        const db = (b.trade_date ?? '').trim()
        const c = da.localeCompare(db)
        if (c !== 0) return mult * c
      }
      const da = (a.trade_date ?? '').trim()
      const db = (b.trade_date ?? '').trim()
      const tie = da.localeCompare(db)
      if (tie !== 0) return tie
      return (Number(a.time) || 0) - (Number(b.time) || 0)
    })
    return list
  }, [ledgerStockFilteredExecutions, ledgerStockSort])

  useEffect(() => {
    setStocksPage(1)
  }, [sortedStockExecutions.length, ledgerStockGroupByPosition, ledgerStockCategoryTab])

  useEffect(() => {
    const pickStkTab = () =>
      hasPlainStockExecutions
        ? 'stocks'
        : hasFixedIncomeStockExecutions
          ? 'fixed_income'
          : 'cash_like'
    if (ledgerTab === 'strategy' && !hasOptionExecutions && hasAnyInstrumentStkTab) {
      setLedgerTab(pickStkTab())
      return
    }
    if (ledgerTab === 'instance' && !hasOptionExecutions && hasAnyInstrumentStkTab) {
      setLedgerTab(pickStkTab())
      return
    }
    if (ledgerTab === 'options' && !hasOptionExecutions && hasAnyInstrumentStkTab) {
      setLedgerTab(pickStkTab())
      return
    }
    if (
      (ledgerTab === 'stocks' || ledgerTab === 'fixed_income' || ledgerTab === 'cash_like') &&
      !hasDataForCurrentInstrumentStkTab
    ) {
      if (hasPlainStockExecutions) setLedgerTab('stocks')
      else if (hasFixedIncomeStockExecutions) setLedgerTab('fixed_income')
      else if (hasCashLikeStockExecutions) setLedgerTab('cash_like')
      else if (hasOptionExecutions) setLedgerTab('strategy')
    }
  }, [
    ledgerTab,
    hasOptionExecutions,
    hasAnyInstrumentStkTab,
    hasPlainStockExecutions,
    hasFixedIncomeStockExecutions,
    hasCashLikeStockExecutions,
    hasDataForCurrentInstrumentStkTab,
  ])

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
    if (ledgerTab !== 'stocks' && ledgerTab !== 'fixed_income' && ledgerTab !== 'cash_like') return
    if (!ledgerStockCategoryTabs.includes(ledgerStockCategoryTab)) {
      setLedgerStockCategoryTab('All')
    }
  }, [ledgerTab, ledgerStockCategoryTab, ledgerStockCategoryTabs])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  useEffect(() => {
    const acc = ledgerFilterAccount.trim()
    if (!acc || acc === 'All') return
    const allowed = new Set(ledgerTradeAccountTabs.map(t => t.id))
    if (allowed.size === 0 || !allowed.has(acc)) setLedgerFilterAccount('')
  }, [ledgerFilterAccount, ledgerTradeAccountTabs])

  const ledgerActiveFilterSummary = useMemo(() => {
    const parts: string[] = []
    const sym = ledgerFilterSymbol.trim()
    if (sym) parts.push(`Symbol: ${sym}`)
    if (ledgerTradeDatePreset) {
      const tab = LEDGER_SINCE_PRESET_TABS.find(t => t.id === ledgerTradeDatePreset)
      parts.push(`Since: ${tab?.label ?? ledgerTradeDatePreset}`)
    }
    if (expiryFilterYear.trim()) {
      parts.push(
        expiryFilterMonth.trim()
          ? `Expiry: ${expiryFilterYear}-${expiryFilterMonth}`
          : `Expiry year: ${expiryFilterYear}`,
      )
    }
    if (ledgerFilterAccount.trim() && ledgerFilterAccount !== 'All') {
      const acc = ledgerTradeAccountTabs.find(t => t.id === ledgerFilterAccount)
      parts.push(`Account: ${acc?.label ?? ledgerFilterAccount}`)
    }
    if (ledgerFilterStructure.trim()) parts.push(`Structure: ${ledgerFilterStructure.trim()}`)
    if (ledgerFilterWishlistSymbol.trim()) parts.push(`Wishlist: ${ledgerFilterWishlistSymbol.trim()}`)
    return parts
  }, [
    ledgerFilterSymbol,
    ledgerTradeDatePreset,
    expiryFilterYear,
    expiryFilterMonth,
    ledgerFilterAccount,
    ledgerTradeAccountTabs,
    ledgerFilterStructure,
    ledgerFilterWishlistSymbol,
  ])

  const clearExpiryFilters = useCallback(() => {
    setExpiryFilterYear('')
    setExpiryFilterMonth('')
  }, [])

  return (
    <>
      <section
        className="replay-section replay-section-trade-records"
        aria-label="Trade ledger"
      >
        <div className="replay-portfolio-block">
          <div
            className="replay-filters replay-filters--bar ledger-top-quick-filters"
            aria-label="Trade ledger quick filters"
          >
            <div className="ledger-top-quick-filters-rows">
              <div className="replay-filters--bar-row ledger-top-quick-filters-row ledger-top-quick-filters-row--primary">
                <div
                  className="ledger-filter-account-bubble-group ledger-since-bubble-group"
                  role="group"
                  aria-label="Since (rolling trade date window)"
                >
                  <span className="ledger-trade-period-label">Since</span>
                  <InfoTooltip text="Include executions whose trade date falls in a rolling window ending today: 1 month, 1 quarter, half-year, or 1 year back from today’s date, or year-to-date from Jan 1. YTD uses Jan 1 through today. trade_date is used when set; otherwise execution time (local date). Mutually exclusive with expiry year/month." />
                  <div className="ledger-filter-account-bubbles">
                    <button
                      type="button"
                      className={`ledger-account-bubble ${
                        ledgerTradeDatePreset === null ? 'ledger-account-bubble--active' : ''
                      }`}
                      onClick={() => {
                        setLedgerTradeDatePreset(null)
                      }}
                      aria-pressed={ledgerTradeDatePreset === null}
                    >
                      All
                    </button>
                    {LEDGER_SINCE_PRESET_TABS.map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        className={`ledger-account-bubble ${
                          ledgerTradeDatePreset === id ? 'ledger-account-bubble--active' : ''
                        }`}
                        onClick={() => {
                          setLedgerTradeDatePreset(id)
                          clearExpiryFilters()
                        }}
                        aria-pressed={ledgerTradeDatePreset === id}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ledger-filter-account-bubble-group">
                  <div className="ledger-filter-account-bubbles" role="group" aria-label="Account filter">
                    <button
                      type="button"
                      className={`ledger-account-bubble ${
                        !ledgerFilterAccount || ledgerFilterAccount === 'All'
                          ? 'ledger-account-bubble--active'
                          : ''
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
                {ledgerTradeDatePreset != null && ledgerTradeDateRange != null ? (
                  <span
                    className="ledger-since-cutoff-inline"
                    role="status"
                    title={`Trade date window: ${fmtTradeDate(ledgerTradeDateRange.start)} → ${fmtTradeDate(ledgerTradeDateRange.end)}`}
                    aria-label={`Trade dates ${fmtTradeDate(ledgerTradeDateRange.start)} through ${fmtTradeDate(ledgerTradeDateRange.end)}; preset ${LEDGER_SINCE_PRESET_TABS.find(t => t.id === ledgerTradeDatePreset)?.label ?? ledgerTradeDatePreset}`}
                  >
                    <span className="ledger-since-range-muted">
                      {fmtMdHint(ledgerTradeDateRange.start)}–{fmtMdHint(ledgerTradeDateRange.end)}
                    </span>
                    <span className="ledger-since-range-muted"> · </span>
                    <span className="ledger-since-preset-label">Since </span>
                    <span className="ledger-since-preset-highlight">
                      {LEDGER_SINCE_PRESET_TABS.find(t => t.id === ledgerTradeDatePreset)?.label ??
                        ledgerTradeDatePreset}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="replay-filters--bar-row ledger-top-quick-filters-row ledger-top-quick-filters-row--secondary">
              <label
                className="ledger-strategy-filter-label ledger-strategy-filter-label--symbol"
                title="Underlying symbol"
              >
                <span className="replay-filter-label">Symbol</span>
                <LedgerSymbolCombobox
                  value={ledgerFilterSymbol}
                  onChange={setLedgerFilterSymbol}
                  suggestions={ledgerSymbolSuggestions}
                  className="ledger-symbol-combobox--toolbar"
                  inputClassName="ledger-symbol-combobox__input--toolbar"
                />
              </label>
              <label className="ledger-strategy-filter-label" title="Structure">
                <span className="replay-filter-label">Structure</span>
                <AppSelect
                  value={ledgerFilterStructure}
                  onChange={setLedgerFilterStructure}
                  className="replay-filter-input replay-filter-select"
                  aria-label="Structure filter"
                  options={[{ value: '', label: 'All structures' }, ...structureNameOptions.map(s => ({ value: s, label: s }))]}
                />
              </label>
              <div
                className="ledger-filter-field ledger-filter-field--expiry-split"
                role="group"
                aria-label="Expiry filter"
              >
                <span className="ledger-expiry-split-label">Expiry</span>
                <AppSelect
                  value={expiryFilterYear}
                  onChange={(v) => {
                    setExpiryFilterYear(v)
                    setExpiryFilterMonth('')
                    setLedgerTradeDatePreset(null)
                  }}
                  className="replay-filter-input replay-filter-select ledger-expiry-year-select"
                  aria-label="Expiry year"
                  disabled={ledgerTradeDatePreset != null}
                  options={[{ value: '', label: 'All years' }, ...expiryYearOptions.map(y => ({ value: String(y), label: String(y) }))]}
                />
                <AppSelect
                  value={expiryFilterMonth}
                  onChange={(v) => {
                    setExpiryFilterMonth(v)
                    setLedgerTradeDatePreset(null)
                  }}
                  className="replay-filter-input replay-filter-select ledger-expiry-month-select"
                  aria-label="Expiry month"
                  disabled={ledgerTradeDatePreset != null || !expiryFilterYear.trim()}
                  options={[
                    { value: '', label: 'All months' },
                    ...Array.from({ length: 12 }, (_, i) => {
                      const mm = String(i + 1).padStart(2, '0')
                      return { value: mm, label: mm }
                    }),
                  ]}
                />
              </div>
              <label className="ledger-strategy-filter-label" title="Wishlist symbol">
                <span className="replay-filter-label">Wishlist</span>
                <AppSelect
                  value={ledgerFilterWishlistSymbol}
                  onChange={setLedgerFilterWishlistSymbol}
                  className="replay-filter-input replay-filter-select"
                  aria-label="Wishlist symbol filter"
                  options={[{ value: '', label: 'All symbols' }, ...wishlistSymbolOptions.map(s => ({ value: s, label: s }))]}
                />
              </label>
              </div>
            </div>
          </div>

          <div className="replay-ledger-toolbar">
            <div className="replay-portfolio-tabs-wrap">
              <div className="replay-ledger-tab-matrix replay-ledger-tab-matrix--aligned">
                <div className="replay-ledger-tab-matrix-labels" aria-hidden="true">
                  <span className="replay-ledger-tab-group-caption replay-ledger-tab-group-caption--attr">
                    Attribution
                  </span>
                  <span className="replay-ledger-tab-group-caption replay-ledger-tab-group-caption--inst">
                    Instruments
                  </span>
                </div>
                <div
                  className="system-tabs replay-portfolio-tabs replay-ledger-tab-button-row"
                  role="tablist"
                  aria-label="Trade ledger: attribution and instruments (options, equities, fixed income, cash-like)"
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
                    className={`system-tab replay-ledger-tab-at-instruments ${
                      ledgerTab === 'options' ? 'active' : ''
                    }`}
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
                    disabled={!hasPlainStockExecutions}
                  >
                    Stocks
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="replay-tab-fixed-income"
                    aria-selected={ledgerTab === 'fixed_income'}
                    aria-controls="replay-panel-stocks"
                    className={`system-tab ${ledgerTab === 'fixed_income' ? 'active' : ''}`}
                    onClick={() => setLedgerTab('fixed_income')}
                    disabled={!hasFixedIncomeStockExecutions}
                  >
                    Fixed income
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="replay-tab-cash-like"
                    aria-selected={ledgerTab === 'cash_like'}
                    aria-controls="replay-panel-stocks"
                    className={`system-tab ${ledgerTab === 'cash_like' ? 'active' : ''}`}
                    onClick={() => setLedgerTab('cash_like')}
                    disabled={!hasCashLikeStockExecutions}
                  >
                    Cash-like
                  </button>
                </div>
              </div>
            </div>
            <div
              className="replay-ledger-detail-view-toolbar"
              role="toolbar"
              aria-label="Detail view mode"
            >
              <span className="replay-fetch-days-label">Detail view</span>
              <InfoTooltip text="Accordion keeps one expandable panel open (strategy group, instance card, option detail rows, or other sections on this tab). Multi allows several. Option rows use the same expand state as Strategy/Instance trees where applicable." />
              <div className="replay-fetch-range-group replay-ledger-detail-view-radios" role="radiogroup">
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
            </div>
          </div>

          <div className="ledger-tab-filters" aria-label="Tab filters">
              {ledgerTab === 'strategy' && hasOptionExecutions ? (
                <div className="ledger-tab-filters-section" aria-label="Strategy tab filters">
                  <div className="ledger-strategy-filter-row" role="group" aria-label="Group strategy rows">
                    <span className="ledger-strategy-filter-label">Group</span>
                    <InfoTooltip text="Group rows by opportunity (default), by strategy structure name, or by watchlist symbols on the opportunity." />
                    <div className="replay-bubble-switch ledger-opt-section-group-bubbles">
                      <button
                        type="button"
                        className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'opportunity' ? 'active' : ''}`}
                        onClick={() => setLedgerOptSectionGroupBy('opportunity')}
                      >
                        Opportunity
                      </button>
                      <button
                        type="button"
                        className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'structure' ? 'active' : ''}`}
                        onClick={() => setLedgerOptSectionGroupBy('structure')}
                      >
                        Structure
                      </button>
                      <button
                        type="button"
                        className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'watchlist_symbol' ? 'active' : ''}`}
                        onClick={() => setLedgerOptSectionGroupBy('watchlist_symbol')}
                      >
                        Watchlist symbol
                      </button>
                    </div>
                  </div>
                  {strategyOpportunityGroups.length > 0 &&
                    (strategyPanelOptionRights.length > 1 || ledgerOptionRightFilter) && (
                      <div className="ledger-strategy-tab-filters">
                        <div className="ledger-strategy-filter-row" role="group" aria-label="Filter by call or put">
                          <span className="ledger-strategy-filter-label">Type</span>
                          <div className="ledger-strategy-filter-bubbles">
                            <button
                              type="button"
                              className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === '' ? 'active' : ''}`}
                              onClick={() => setLedgerOptionRightFilter('')}
                            >
                              All
                            </button>
                            {(strategyPanelOptionRights.includes('C') || ledgerOptionRightFilter === 'C') && (
                              <button
                                type="button"
                                className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === 'C' ? 'active' : ''}`}
                                onClick={() =>
                                  setLedgerOptionRightFilter(prev => (prev === 'C' ? '' : 'C'))
                                }
                              >
                                Call
                              </button>
                            )}
                            {(strategyPanelOptionRights.includes('P') || ledgerOptionRightFilter === 'P') && (
                              <button
                                type="button"
                                className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === 'P' ? 'active' : ''}`}
                                onClick={() =>
                                  setLedgerOptionRightFilter(prev => (prev === 'P' ? '' : 'P'))
                                }
                              >
                                Put
                              </button>
                            )}
                          </div>
                        </div>
                        {ledgerOptionRightFilter ? (
                          <div className="ledger-strategy-filter-meta">
                            <span>
                              Showing {filteredStrategyOpportunityGroups.length} of {strategyOpportunityGroups.length}{' '}
                              opportunities
                            </span>
                            <button
                              type="button"
                              className="ledger-strategy-filter-clear"
                              onClick={() => setLedgerOptionRightFilter('')}
                            >
                              Clear type filter
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                </div>
              ) : null}

              {ledgerTab === 'instance' && hasOptionExecutions ? (
                <div className="ledger-tab-filters-section" aria-label="Instance tab filters">
                  <div className="ledger-instance-controls-row ledger-instance-toolbar-row">
                    <div
                      className="replay-bubble-switch ledger-instance-scope-bubbles ledger-instance-toolbar-segment"
                      role="tablist"
                      aria-label="With instance and No instance"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerInstanceSubTab === 'with_instance'}
                        className={`replay-bubble-switch-btn ${ledgerInstanceSubTab === 'with_instance' ? 'active' : ''}`}
                        onClick={() => setLedgerInstanceSubTab('with_instance')}
                        disabled={!hasWithInstance}
                      >
                        With instance ({instanceGroups.length})
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerInstanceSubTab === 'no_instance'}
                        className={`replay-bubble-switch-btn ${ledgerInstanceSubTab === 'no_instance' ? 'active' : ''}`}
                        onClick={() => setLedgerInstanceSubTab('no_instance')}
                        disabled={!hasNoInstance}
                      >
                        No instance ({noInstanceOptGroups.length})
                      </button>
                    </div>
                    <span className="ledger-instance-toolbar-sep" aria-hidden="true" />
                    <div
                      className={`replay-instance-contain-filter ledger-instance-toolbar-segment ${ledgerInstanceSubTab === 'no_instance' ? 'replay-instance-contain-filter--disabled' : ''}`}
                      role="group"
                      aria-label="Filter instances by open positions"
                    >
                      <span className="replay-instance-contain-filter-label">Contain open</span>
                      <InfoTooltip text="Filters the With instance list: Yes = at least one open (unrealized) option contract; No = only closed legs; All = every instance." />
                      <div className="replay-bubble-switch" role="radiogroup" aria-label="Contain open">
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
                    {ledgerInstanceSubTab === 'with_instance' ? (
                      <>
                        <span className="ledger-instance-toolbar-sep" aria-hidden="true" />
                        <div
                          className="ledger-instance-toolbar-segment"
                          role="group"
                          aria-label="Group instance rows"
                        >
                          <span className="ledger-strategy-filter-label">Group</span>
                          <InfoTooltip text="Group rows by opportunity (default), by strategy structure name, or by watchlist symbols on the opportunity." />
                          <div className="replay-bubble-switch ledger-opt-section-group-bubbles">
                            <button
                              type="button"
                              className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'opportunity' ? 'active' : ''}`}
                              onClick={() => setLedgerOptSectionGroupBy('opportunity')}
                            >
                              Opportunity
                            </button>
                            <button
                              type="button"
                              className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'structure' ? 'active' : ''}`}
                              onClick={() => setLedgerOptSectionGroupBy('structure')}
                            >
                              Structure
                            </button>
                            <button
                              type="button"
                              className={`replay-bubble-switch-btn ${ledgerOptSectionGroupBy === 'watchlist_symbol' ? 'active' : ''}`}
                              onClick={() => setLedgerOptSectionGroupBy('watchlist_symbol')}
                            >
                              Watchlist symbol
                            </button>
                          </div>
                        </div>
                      </>
                    ) : null}
                    {ledgerInstanceSubTab === 'with_instance' &&
                    filteredInstanceGroups.length > 0 &&
                    (instancePanelOptionRights.length > 1 || ledgerOptionRightFilter) ? (
                      <>
                        <span className="ledger-instance-toolbar-sep" aria-hidden="true" />
                        <div
                          className="ledger-instance-toolbar-segment"
                          role="group"
                          aria-label="Filter by call or put"
                        >
                          <span className="ledger-strategy-filter-label">Type</span>
                          <div className="replay-bubble-switch ledger-instance-type-bubbles">
                            <button
                              type="button"
                              className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === '' ? 'active' : ''}`}
                              onClick={() => setLedgerOptionRightFilter('')}
                            >
                              All
                            </button>
                            {(instancePanelOptionRights.includes('C') || ledgerOptionRightFilter === 'C') && (
                              <button
                                type="button"
                                className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === 'C' ? 'active' : ''}`}
                                onClick={() =>
                                  setLedgerOptionRightFilter(prev => (prev === 'C' ? '' : 'C'))
                                }
                              >
                                Call
                              </button>
                            )}
                            {(instancePanelOptionRights.includes('P') || ledgerOptionRightFilter === 'P') && (
                              <button
                                type="button"
                                className={`replay-bubble-switch-btn ${ledgerOptionRightFilter === 'P' ? 'active' : ''}`}
                                onClick={() =>
                                  setLedgerOptionRightFilter(prev => (prev === 'P' ? '' : 'P'))
                                }
                              >
                                Put
                              </button>
                            )}
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>
                  {ledgerInstanceSubTab === 'with_instance' &&
                    ledgerOptionRightFilter &&
                    filteredInstanceGroups.length > 0 && (
                      <div className="ledger-instance-filter-meta-row">
                        <span>
                          Showing {instanceFinalFiltered.length} of {filteredInstanceGroups.length} instances
                        </span>
                        <button
                          type="button"
                          className="ledger-strategy-filter-clear"
                          onClick={() => setLedgerOptionRightFilter('')}
                        >
                          Clear type filter
                        </button>
                      </div>
                    )}
                </div>
              ) : null}

              {ledgerTab === 'options' && hasOptionExecutions ? (
                <div className="ledger-tab-filters-section" aria-label="Options tab filters">
                  <div className="ledger-options-subtab-row ledger-options-subtab-row--in-sheet">
                    <div
                      className="system-tabs replay-stock-group-tabs"
                      role="tablist"
                      aria-label="Closed Option and Open Option"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerOptionSubTab === 'contracts'}
                        className={`system-tab ${ledgerOptionSubTab === 'contracts' ? 'active' : ''}`}
                        onClick={() => setLedgerOptionSubTab('contracts')}
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
                    {ledgerOptionSubTab === 'contracts' && sortedClosedOptionGroups.length > 0 && (
                      <div
                        className="ledger-opt-instance-filter"
                        role="radiogroup"
                        aria-label="Filter contracts by strategy instance status"
                      >
                        <span className="ledger-opt-instance-filter-label">Instance</span>
                        {(
                          [
                            { v: 'all', label: 'All' },
                            { v: 'has_instance', label: 'Has instance' },
                            { v: 'no_instance', label: 'No instance' },
                            { v: 'mixed', label: 'Mixed' },
                          ] as const
                        ).map(({ v, label }) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={ledgerOptInstanceFilter === v}
                            className={`replay-bubble-switch-btn ${ledgerOptInstanceFilter === v ? 'active' : ''}`}
                            onClick={() => setLedgerOptInstanceFilter(v)}
                          >
                            {label}
                          </button>
                        ))}
                        {ledgerOptInstanceFilter !== 'all' && (
                          <span className="ledger-opt-instance-filter-count">
                            {filteredClosedOptionGroupsByInstance.length} / {sortedClosedOptionGroups.length}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {(ledgerTab === 'stocks' ||
                ledgerTab === 'fixed_income' ||
                ledgerTab === 'cash_like') &&
              hasDataForCurrentInstrumentStkTab ? (
                <div className="ledger-tab-filters-section" aria-label="Stock bucket tab filters">
                  <div className="ledger-stock-bucket-filter-row">
                    <div
                      className="replay-bubble-switch ledger-stock-view-bubbles"
                      role="tablist"
                      aria-label="Stock view mode"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={!ledgerStockGroupByPosition}
                        className={`replay-bubble-switch-btn ${!ledgerStockGroupByPosition ? 'active' : ''}`}
                        onClick={() => setLedgerStockGroupByPosition(false)}
                      >
                        Flat
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerStockGroupByPosition}
                        className={`replay-bubble-switch-btn ${ledgerStockGroupByPosition ? 'active' : ''}`}
                        onClick={() => setLedgerStockGroupByPosition(true)}
                      >
                        Position
                      </button>
                    </div>
                    <span className="ledger-stock-bucket-filter-sep" aria-hidden="true" />
                    <div
                      className="replay-bubble-switch ledger-stock-category-bubbles"
                      role="tablist"
                      aria-label="Position category filter"
                    >
                      {ledgerStockCategoryTabs.map(cat => (
                        <button
                          key={cat}
                          type="button"
                          role="tab"
                          aria-selected={ledgerStockCategoryTab === cat}
                          className={`replay-bubble-switch-btn ${ledgerStockCategoryTab === cat ? 'active' : ''}`}
                          onClick={() => setLedgerStockCategoryTab(cat)}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
          </div>

          {ledgerActiveFilterSummary.length > 0 ? (
            <p className="ledger-active-filters-summary" role="status" aria-label="Active filters">
              {ledgerActiveFilterSummary.join(' · ')}
            </p>
          ) : null}
          {filteredExecutions.length === 0 && filteredExecutionsBook.length === 0 ? (
            <p className="section-hint">
              No execution data. Use Overview to fetch from IB (Refresh), or Trade ledger to add a manual journal
              entry (Add journal).
              {ledgerActiveFilterSummary.length > 0 ? ' Filters applied.' : ''}
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
                                handleMetricHoverEnter(
                                  'options_period_realized',
                                  `opt-pnl-${key}`,
                                  e,
                                )
                              }
                              onMouseLeave={handleMetricHoverLeave}
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
                            handleMetricHoverEnter('options_total_realized', 'opt-pnl-total', e)
                          }
                          onMouseLeave={handleMetricHoverLeave}
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
                                handleMetricHoverEnter(
                                  'stocks_period_realized',
                                  `stk-rz-${key}`,
                                  e,
                                )
                              }
                              onMouseLeave={handleMetricHoverLeave}
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
                              handleMetricHoverEnter('stocks_period_notional', `stk-nv-${key}`, e)
                            }
                            onMouseLeave={handleMetricHoverLeave}
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
                            handleMetricHoverEnter('stocks_total_realized', 'stk-total-rz', e)
                          }
                          onMouseLeave={handleMetricHoverLeave}
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
                          className={`replay-ledger-metric-explain-trigger replay-ledger-summary-stocks-total-u ${
                            ledgerStocksSummaryTotals.totalUnrealized != null
                              ? 'ledger-stk-ur-pnl-unrealized'
                              : 'replay-ledger-summary-realized-zero'
                          }`}
                          aria-label="Open calculation details for total stock unrealized PnL"
                          onMouseEnter={e =>
                            handleMetricHoverEnter('stocks_total_unrealized', 'stk-total-u', e)
                          }
                          onMouseLeave={handleMetricHoverLeave}
                          onClick={e => {
                            e.stopPropagation()
                            handleMetricExplainEnter('stocks_total_unrealized', 'stk-total-u', e)
                          }}
                        >
                          U{' '}
                          {ledgerStocksSummaryTotals.totalUnrealized != null
                            ? fmtUsd0(ledgerStocksSummaryTotals.totalUnrealized)
                            : '—'}
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
                            handleMetricHoverEnter('stocks_total_notional', 'stk-total-nv', e)
                          }
                          onMouseLeave={handleMetricHoverLeave}
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
                      ) : filteredStrategyOpportunityGroups.length === 0 ? (
                        <p className="section-hint">No opportunities match the current type filter.</p>
                      ) : (
                        <div>
                          {ledgerStrategyDisplayBuckets.map(bucket => {
                            const outerStats = aggregateStrategyOgListStats(bucket.groups)
                            const innerOpportunities = bucket.groups.map(og => {
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
                                      if (prev.has(expandKey)) {
                                        const next = new Set(prev)
                                        next.delete(expandKey)
                                        return next
                                      }
                                      if (ledgerAccordionMode) return new Set([expandKey])
                                      const next = new Set(prev)
                                      next.add(expandKey)
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
                                                  if (prev.has(instanceCompositeKey)) {
                                                    const next = new Set(prev)
                                                    next.delete(instanceCompositeKey)
                                                    return next
                                                  }
                                                  const next = new Set(prev)
                                                  if (ledgerAccordionMode) {
                                                    for (const k of next) {
                                                      if (k.startsWith(`${expandKey}::`) && k !== instanceCompositeKey) {
                                                        next.delete(k)
                                                      }
                                                    }
                                                  }
                                                  next.add(instanceCompositeKey)
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
                          })
                            const isDimExpanded = ledgerStrategyOuterExpandedKeys.has(bucket.key)
                            if (!bucket.label) {
                              return <Fragment key={bucket.key}>{innerOpportunities}</Fragment>
                            }
                            return (
                              <div key={bucket.key} className="replay-ledger-dimension-bundle">
                                <button
                                  type="button"
                                  className="replay-ledger-dimension-header"
                                  onClick={() =>
                                    setLedgerStrategyOuterExpandedKeys(prev => {
                                      if (prev.has(bucket.key)) {
                                        const next = new Set(prev)
                                        next.delete(bucket.key)
                                        return next
                                      }
                                      if (ledgerAccordionMode) return new Set([bucket.key])
                                      const next = new Set(prev)
                                      next.add(bucket.key)
                                      return next
                                    })
                                  }
                                  aria-expanded={isDimExpanded}
                                >
                                  <span
                                    className={`replay-instance-chevron ${isDimExpanded ? 'replay-instance-chevron--open' : ''}`}
                                    aria-hidden
                                  >
                                    ▶
                                  </span>
                                  <span className="replay-instance-group-title">{bucket.label}</span>
                                  <span className="replay-instance-group-stats">
                                    <span>Opportunities: {bucket.groups.length}</span>
                                    <span>Instances: {outerStats.instances}</span>
                                    <span>Closed: {outerStats.closed}</span>
                                    <span>Open: {outerStats.open}</span>
                                    <span
                                      className={
                                        outerStats.pnl >= 0
                                          ? 'replay-pnl-realized'
                                          : 'replay-pnl-detail-negative'
                                      }
                                    >
                                      PnL: {fmtUsd0(outerStats.pnl)}
                                    </span>
                                  </span>
                                </button>
                                {isDimExpanded ? (
                                  <div className="replay-ledger-dimension-body">{innerOpportunities}</div>
                                ) : null}
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
                      {ledgerInstanceSubTab === 'with_instance' && (
                        <div>
                          {instanceGroups.length === 0 ? (
                            <p className="section-hint">No option trades with a strategy instance under the current filters.</p>
                          ) : filteredInstanceGroups.length === 0 ? (
                            <p className="section-hint">
                              No instances match Contain open = {instanceContainOpenFilter === 'yes' ? 'Yes' : 'No'}. Change the filter or clear it (All).
                            </p>
                          ) : instanceFinalFiltered.length === 0 ? (
                            <p className="section-hint">No instances match the current type filter.</p>
                          ) : (
                            <>
                            {ledgerInstanceDisplayBuckets.map(bucket => {
                              const outerIgStats = aggregateInstanceIgListStats(bucket.groups)
                              const innerInstances = bucket.groups.map(ig => {
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
                                      onClick={() =>
                                        setInstanceExpandedIds(prev => {
                                          if (prev.has(ig.instanceId)) {
                                            const next = new Set(prev)
                                            next.delete(ig.instanceId)
                                            return next
                                          }
                                          if (ledgerAccordionMode) return new Set([ig.instanceId])
                                          const next = new Set(prev)
                                          next.add(ig.instanceId)
                                          return next
                                        })
                                      }
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
                            const isInstDimExpanded = ledgerInstanceOuterExpandedKeys.has(bucket.key)
                            if (!bucket.label) {
                              return <Fragment key={bucket.key}>{innerInstances}</Fragment>
                            }
                            return (
                              <div key={bucket.key} className="replay-ledger-dimension-bundle">
                                <button
                                  type="button"
                                  className="replay-ledger-dimension-header"
                                  onClick={() =>
                                    setLedgerInstanceOuterExpandedKeys(prev => {
                                      if (prev.has(bucket.key)) {
                                        const next = new Set(prev)
                                        next.delete(bucket.key)
                                        return next
                                      }
                                      if (ledgerAccordionMode) return new Set([bucket.key])
                                      const next = new Set(prev)
                                      next.add(bucket.key)
                                      return next
                                    })
                                  }
                                  aria-expanded={isInstDimExpanded}
                                >
                                  <span
                                    className={`replay-instance-chevron ${isInstDimExpanded ? 'replay-instance-chevron--open' : ''}`}
                                    aria-hidden
                                  >
                                    ▶
                                  </span>
                                  <span className="replay-instance-group-title">{bucket.label}</span>
                                  <span className="replay-instance-group-stats">
                                    <span>Instances: {bucket.groups.length}</span>
                                    <span>Closed legs: {outerIgStats.closed}</span>
                                    <span>Open legs: {outerIgStats.open}</span>
                                    <span
                                      className={
                                        outerIgStats.pnl >= 0
                                          ? 'replay-pnl-realized'
                                          : 'replay-pnl-detail-negative'
                                      }
                                    >
                                      PnL: {fmtUsd0(outerIgStats.pnl)}
                                    </span>
                                  </span>
                                </button>
                                {isInstDimExpanded ? (
                                  <div className="replay-ledger-dimension-body">{innerInstances}</div>
                                ) : null}
                              </div>
                            )
                          })}
                            </>
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
                            onLinkStockExecution={handleLinkStockExecution}
                            onDeleteExecution={handleDeleteExecution}
                            onSyncOppositeLegAttribution={handleSyncOppositeLegAttribution}
                            syncingAccountExecutionsId={syncingAccountExecutionsId}
                            detailPlaceholder="Click a closed trade row above to load details; then use Link to assign an instance."
                            sectionAriaLabel="No-instance closed option positions and details"
                            optionStockLinkByOptionId={optionStockLinkByOptionId}
                            onViewOptionStockLinks={handleViewOptionStockLinks}
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
                            onLinkStockExecution={handleLinkStockExecution}
                            onDeleteExecution={handleDeleteExecution}
                            optionStockLinkByOptionId={optionStockLinkByOptionId}
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
                      {ledgerOptionSubTab === 'contracts' && (
                        <LedgerClosedOptionContractsSection
                          sortedClosedGroups={filteredClosedOptionGroupsByInstance}
                          closedExpandedGroups={closedExpandedOptionGroups}
                          closedPnlSum={closedOptGroupsPnlSum}
                          detailsTotalPnl={ledgerDetailsTotalPnl}
                          expandedDetailKeys={expandedDetailKeys}
                          toggleDetailExpand={toggleDetailExpand}
                          ledgerOptSort={ledgerOptSort}
                          setLedgerOptSort={setLedgerOptSort}
                          onEditExecution={handleEditExecution}
                          onLinkExecution={handleLinkExecution}
                          onLinkStockExecution={handleLinkStockExecution}
                          onDeleteExecution={handleDeleteExecution}
                          onSyncOppositeLegAttribution={handleSyncOppositeLegAttribution}
                          syncingAccountExecutionsId={syncingAccountExecutionsId}
                          optionStockLinkByOptionId={optionStockLinkByOptionId}
                          onViewOptionStockLinks={handleViewOptionStockLinks}
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
                          onLinkStockExecution={handleLinkStockExecution}
                          onDeleteExecution={handleDeleteExecution}
                          optionStockLinkByOptionId={optionStockLinkByOptionId}
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
              {(ledgerTab === 'stocks' ||
                ledgerTab === 'fixed_income' ||
                ledgerTab === 'cash_like') && (
                <div
                  id="replay-panel-stocks"
                  role="tabpanel"
                  aria-labelledby={
                    ledgerTab === 'stocks'
                      ? 'replay-tab-stocks'
                      : ledgerTab === 'fixed_income'
                        ? 'replay-tab-fixed-income'
                        : 'replay-tab-cash-like'
                  }
                  className="system-tab-panel"
                >
                  {hasDataForCurrentInstrumentStkTab ? (
                    <div className="replay-portfolio-table-wrap">
                      <table className="table-operations">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th
                              className="replay-th-sortable"
                              onClick={e => {
                                e.stopPropagation()
                                setLedgerStockSort(prev => {
                                  if (prev.column === 'trade_date') {
                                    return {
                                      column: 'trade_date',
                                      dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                    }
                                  }
                                  return { column: 'trade_date', dir: 'desc' }
                                })
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setLedgerStockSort(prev => {
                                    if (prev.column === 'trade_date') {
                                      return {
                                        column: 'trade_date',
                                        dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                      }
                                    }
                                    return { column: 'trade_date', dir: 'desc' }
                                  })
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              title="Sort by Trade date"
                            >
                              Trade date{' '}
                              {ledgerStockSort.column === 'trade_date'
                                ? ledgerStockSort.dir === 'asc'
                                  ? ' ▲'
                                  : ' ▼'
                                : ''}
                            </th>
                            {!ledgerStockGroupByPosition ? <th>Symbol</th> : null}
                            <th>Account</th>
                            <th>Category</th>
                            <th>Side</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Notional</th>
                            <th
                              className="replay-th-sortable"
                              onClick={e => {
                                e.stopPropagation()
                                setLedgerStockSort(prev => {
                                  if (prev.column === 'realized_pnl') {
                                    return {
                                      column: 'realized_pnl',
                                      dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                    }
                                  }
                                  return { column: 'realized_pnl', dir: 'desc' }
                                })
                              }}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setLedgerStockSort(prev => {
                                    if (prev.column === 'realized_pnl') {
                                      return {
                                        column: 'realized_pnl',
                                        dir: prev.dir === 'desc' ? 'asc' : 'desc',
                                      }
                                    }
                                    return { column: 'realized_pnl', dir: 'desc' }
                                  })
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              title="Sort by realized per fill"
                            >
                              Realized{' '}
                              <InfoTooltip text="Realized on this fill (IB commission report). Zero shows as dash. Unrealized is position-level: see Group U/R PnL when grouped, or Total U in the summary." />{' '}
                              {ledgerStockSort.column === 'realized_pnl'
                                ? ledgerStockSort.dir === 'asc'
                                  ? ' ▲'
                                  : ' ▼'
                                : ''}
                            </th>
                            <th>Comm.</th>
                            <th>Source</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const stockExecs = sortedStockExecutions
                            if (!ledgerStockGroupByPosition) {
                              const pagedStockExecs = stockExecs.slice(
                                (stocksPage - 1) * STOCKS_PAGE_SIZE,
                                stocksPage * STOCKS_PAGE_SIZE,
                              )
                              return pagedStockExecs.map((ex, i) => {
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
                                    <td>
                                      {ledgerTab === 'stocks' ? (
                                        <span className="ledger-stk-cell-symbol">{ex.symbol ?? '—'}</span>
                                      ) : (
                                        (ex.symbol ?? '—')
                                      )}
                                    </td>
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>
                                      {ledgerTab === 'stocks' ? (
                                        <span className="ledger-stk-cell-category">{getStockExecCategory(ex)}</span>
                                      ) : (
                                        getStockExecCategory(ex)
                                      )}
                                    </td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <LedgerStkNotionalCell ex={ex} />
                                    <LedgerStkRowRealizedPnlCell realized={Number(ex.realized_pnl) || 0} />
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
                            const groupByLatestNewestFirst =
                              ledgerStockSort.column !== 'trade_date' ||
                              ledgerStockSort.dir === 'desc'
                            const allGroupEntries = Array.from(
                              groups.entries(),
                            ).sort((entryA, entryB) => {
                              const [, execsA] = entryA
                              const [, execsB] = entryB
                              const ka = stockGroupLatestSortKey(execsA)
                              const kb = stockGroupLatestSortKey(execsB)
                              if (Math.abs(ka - kb) > 1e-6) {
                                return groupByLatestNewestFirst ? kb - ka : ka - kb
                              }
                              const [a] = entryA
                              const [b] = entryB
                              const [accA, symA] = a.split('|')
                              const [accB, symB] = b.split('|')
                              if (symA !== symB)
                                return (symA || '').localeCompare(symB || '')
                              return (accA || '').localeCompare(accB || '')
                            })
                            const groupEntries = allGroupEntries.slice(
                              (stocksPage - 1) * STOCKS_PAGE_SIZE,
                              stocksPage * STOCKS_PAGE_SIZE,
                            )
                            const rows: ReactElement[] = []
                            let rowIdx = 0
                            for (const [groupKey, execs] of groupEntries) {
                              const [accId, sym] = groupKey.split('|')
                              const category =
                                positionCategoryByAccountContract.get(
                                  stkContractKey(sym, accId),
                                ) ?? '—'
                              const groupTotalRealizedPnl = execs.reduce(
                                (sum, ex) => sum + (Number(ex.realized_pnl) || 0),
                                0,
                              )
                              const groupUnrealized = execs[0]
                                ? getStkUnrealizedForExecution(execs[0])
                                : undefined
                              const snap = getStkPositionSnapshotForGroup(accId, sym ?? '')
                              const posSnapStr =
                                snap?.position != null && Number.isFinite(snap.position)
                                  ? snap.position.toLocaleString('en-US', { maximumFractionDigits: 6 })
                                  : '—'
                              const avgSnapStr =
                                snap?.avgCost != null && Number.isFinite(snap.avgCost)
                                  ? fmtUsd(snap.avgCost)
                                  : '—'
                              const mktSnapStr =
                                snap?.price != null && Number.isFinite(snap.price)
                                  ? fmtUsd(snap.price)
                                  : '—'
                              const costBaseUsd = stkCostBasisFromSnapshot(snap)
                              const costBaseStr =
                                costBaseUsd != null ? fmtUsd0(costBaseUsd) : '—'
                              const uDollar =
                                groupUnrealized != null && Number.isFinite(groupUnrealized)
                                  ? groupUnrealized
                                  : null
                              const rPct = stkPctOf(groupTotalRealizedPnl, costBaseUsd)
                              const uPct = uDollar != null ? stkPctOf(uDollar, costBaseUsd) : null
                              const rPctStr = rPct != null ? fmtPctCompact(rPct) : '—'
                              const uPctStr = uPct != null ? fmtPctCompact(uPct) : '—'
                              rows.push(
                                <tr
                                  key={`h-${groupKey}`}
                                  className="replay-stock-group-header"
                                >
                                  <td colSpan={12}>
                                    <div className="replay-stock-group-header-inner">
                                      <span
                                        className={`replay-stock-group-symbol${ledgerTab === 'stocks' ? ' ledger-stk-pill ledger-stk-pill--symbol' : ''}`}
                                      >
                                        {sym || '—'}
                                      </span>
                                      <span className="replay-stock-group-account">
                                        {accId || '—'}
                                      </span>
                                      <span
                                        className={`replay-stock-group-category${ledgerTab === 'stocks' ? ' ledger-stk-pill ledger-stk-pill--category' : ''}`}
                                      >
                                        {category}
                                      </span>
                                      <span
                                        className="replay-stock-group-position-snapshot"
                                        title="Current position snapshot from GET /status (portfolio positions); same source as U."
                                      >
                                        <span className="replay-stock-group-position-snapshot-label">Pos</span>{' '}
                                        {posSnapStr}
                                        <span className="replay-stock-group-position-snapshot-sep" aria-hidden>
                                          {' '}
                                          ·{' '}
                                        </span>
                                        <span className="replay-stock-group-position-snapshot-label">Avg</span>{' '}
                                        {avgSnapStr}
                                        <span className="replay-stock-group-position-snapshot-sep" aria-hidden>
                                          {' '}
                                          ·{' '}
                                        </span>
                                        <span className="replay-stock-group-position-snapshot-label">Mkt</span>{' '}
                                        {mktSnapStr}
                                      </span>
                                      <span
                                        className="replay-stock-group-basis-pct"
                                        title="Cost basis = |position| × avg cost (from GET /status). R% and U% are realized and unrealized PnL as a percentage of that basis (not annualized)."
                                      >
                                        <span className="replay-stock-group-position-snapshot-label">Basis</span>{' '}
                                        {costBaseStr}
                                        <span className="replay-stock-group-position-snapshot-sep" aria-hidden>
                                          {' '}
                                          ·{' '}
                                        </span>
                                        <span className="replay-stock-group-position-snapshot-label">R%</span>{' '}
                                        <span
                                          className={
                                            rPct != null ? ledgerUrPnlLineClass(rPct) : 'replay-ledger-summary-realized-zero'
                                          }
                                        >
                                          {rPctStr}
                                        </span>
                                        <span className="replay-stock-group-position-snapshot-sep" aria-hidden>
                                          {' '}
                                          ·{' '}
                                        </span>
                                        <span className="replay-stock-group-position-snapshot-label">U%</span>{' '}
                                        <span
                                          className={
                                            uPct != null ? ledgerUrPnlLineClass(uPct) : 'replay-ledger-summary-realized-zero'
                                          }
                                        >
                                          {uPctStr}
                                        </span>
                                      </span>
                                      <LedgerStkUrPnlGroupInline
                                        realized={groupTotalRealizedPnl}
                                        unrealized={groupUnrealized}
                                      />
                                      {ledgerTab === 'stocks' && ledgerStockGroupByPosition && (
                                        <button
                                          type="button"
                                          className="btn btn-icon-small ledger-stock-quick-journal-btn"
                                          onClick={() => openQuickStockJournal(accId, sym)}
                                          title="Add journal"
                                          aria-label="Add journal"
                                        >
                                          <svg
                                            viewBox="0 0 24 24"
                                            width={16}
                                            height={16}
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden
                                          >
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <polyline points="14 2 14 8 20 8" />
                                            <line x1="16" y1="13" x2="8" y2="13" />
                                            <line x1="16" y1="17" x2="8" y2="17" />
                                            <line x1="10" y1="9" x2="8" y2="9" />
                                          </svg>
                                        </button>
                                      )}
                                    </div>
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
                                    <td>{ex.account_id ?? '—'}</td>
                                    <td>
                                      {ledgerTab === 'stocks' ? (
                                        <span className="ledger-stk-cell-category">{getStockExecCategory(ex)}</span>
                                      ) : (
                                        getStockExecCategory(ex)
                                      )}
                                    </td>
                                    <td>{sideLabel}</td>
                                    <td>
                                      {ex.quantity != null
                                        ? Number(ex.quantity)
                                        : '—'}
                                    </td>
                                    <td>{fmtUsd(ex.price)}</td>
                                    <LedgerStkNotionalCell ex={ex} />
                                    <LedgerStkRowRealizedPnlCell realized={Number(ex.realized_pnl) || 0} />
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
                      {(() => {
                        const totalItems = ledgerStockGroupByPosition
                          ? Array.from(
                              new Set(
                                sortedStockExecutions.map(
                                  ex =>
                                    `${(ex.account_id ?? '').trim()}|${(ex.symbol ?? '').toString().trim().toUpperCase()}`,
                                ),
                              ),
                            ).length
                          : sortedStockExecutions.length
                        const totalStockPages = Math.max(1, Math.ceil(totalItems / STOCKS_PAGE_SIZE))
                        if (totalStockPages <= 1) return null
                        return (
                          <div className="ledger-pagination-bar" role="navigation" aria-label="Stocks pagination">
                            <button type="button" className="ledger-pagination-btn" onClick={() => setStocksPage(1)} disabled={stocksPage === 1} aria-label="First page">«</button>
                            <button type="button" className="ledger-pagination-btn" onClick={() => setStocksPage(p => Math.max(1, p - 1))} disabled={stocksPage === 1} aria-label="Previous page">‹</button>
                            <span className="ledger-pagination-info">
                              {stocksPage} / {totalStockPages}
                              <span className="ledger-pagination-total"> ({totalItems})</span>
                            </span>
                            <button type="button" className="ledger-pagination-btn" onClick={() => setStocksPage(p => Math.min(totalStockPages, p + 1))} disabled={stocksPage === totalStockPages} aria-label="Next page">›</button>
                            <button type="button" className="ledger-pagination-btn" onClick={() => setStocksPage(totalStockPages)} disabled={stocksPage === totalStockPages} aria-label="Last page">»</button>
                          </div>
                        )
                      })()}
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
        initialDraft={editExec ? null : addJournalInitialDraft}
        lockContractContext={addJournalLockContract && !editExec}
        createExecutionSource="journal_closed"
        onClose={() => {
          onAddJournalOpenChange(false)
          setEditExec(null)
          setAddJournalInitialDraft(null)
          setAddJournalLockContract(false)
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
      <LinkOptionStockModal
        open={optionStockModalOpen}
        context={optionStockModalContext}
        onClose={() => {
          setOptionStockModalOpen(false)
          setOptionStockModalContext(null)
        }}
        onSuccess={() => {
          setPageError(null)
          loadReplayData()
        }}
      />
      <ViewOptionStockLinksModal
        open={viewStockLinksModal.open}
        title={viewStockLinksModal.title}
        rows={viewStockLinksModal.rows}
        slippageTotal={viewStockLinksModal.slippageTotal}
        onClose={() =>
          setViewStockLinksModal({ open: false, title: '', rows: [], slippageTotal: null })
        }
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
