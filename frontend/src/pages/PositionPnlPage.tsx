import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Execution,
  IbPositionRow,
  OptExecutionGroup,
  RiskSummaryResponse,
  StatusResponse,
} from '../types'
import {
  createExecution,
  deleteExecution,
  fetchExecutions,
  fetchRiskSummary,
  postExecutionsFetch,
  updateExecution,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtUsd0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

function fmtExpiry(expiry: string | null | undefined): string {
  if (!expiry || !expiry.trim()) return '—'
  const s = expiry.trim()
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    const y = s.slice(0, 4)
    const m = s.slice(4, 6)
    const d = s.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  if (s.length === 6 && /^\d{6}$/.test(s)) {
    const y = s.slice(0, 4)
    const m = s.slice(4, 6)
    return `${y}-${m}`
  }
  return s
}

function unixToDatetimeLocal(ts: number | string | null | undefined): string {
  if (ts == null) return ''
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}`
}

function datetimeLocalToUnix(value: string): number {
  if (!value || !value.trim()) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(value).getTime() / 1000)
}

function getContractLabelParts(contract_key: string): { symbol: string; rightLabel: string } {
  const parts = contract_key.split('|')
  const symbol = parts[0]?.trim() || ''
  const right = (parts[4] ?? parts[parts.length - 1] ?? '').toString().toUpperCase()
  const rightLabel = right === 'C' ? 'CALL' : right === 'P' ? 'PUT' : right || ''
  return { symbol, rightLabel }
}

export type PortfolioView = 'overview' | 'open' | 'ledger'

interface PositionPnlPageProps {
  status: StatusResponse | null
  currentView?: PortfolioView
  onViewChange?: (view: PortfolioView) => void
  showViewTabs?: boolean
}

type LivePositionRow = IbPositionRow & {
  account_id: string
}

type OpenOptionGroup = {
  kind: 'live' | 'offtrack'
  contract_key: string
  strike: number
  expiry: string
  net_qty: number
  avg_cost: number | null
  mark_price: number | null
  unrealized_pnl: number | null
  account_count: number
  pool_label: 'On' | 'Off'
  /** BUY size (long qty); for same columns as Trade Ledger */
  buy_volume: number
  /** SELL size (short qty, as positive); for same columns as Trade Ledger */
  sell_volume: number
  buy_avg_price: number | null
  sell_avg_price: number | null
  buy_cost: number
  sell_premium: number
  positions?: LivePositionRow[]
  trades?: Execution[]
}

function buildOptExecutionGroups(sourceExecutions: Execution[]): OptExecutionGroup[] {
  const opt = sourceExecutions.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const key = (e: Execution) => `${e.contract_key ?? ''}|${e.strike ?? 0}`
  const groups = new Map<string, Execution[]>()
  for (const e of opt) {
    const k = key(e)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(e)
  }
  const result: OptExecutionGroup[] = []
  for (const [, trades] of groups) {
    if (trades.length === 0) continue
    const first = trades[0]
    const contract_key = first.contract_key ?? ''
    const strike = Number(first.strike) ?? 0
    const expiry = first.expiry ?? ''
    let buy_qty = 0
    let sell_qty = 0
    let buy_value = 0
    let sell_value = 0
    let buy_value_raw = 0
    let sell_value_raw = 0
    for (const t of trades) {
      const q = Number(t.quantity) || 0
      const p = Number(t.price) || 0
      const c = Number(t.commission) || 0
      const v = p * q * 100 - c
      const side = (t.side ?? '').toUpperCase()
      if (side === 'BUY' || side === 'BOT' || side === 'B') {
        buy_qty += q
        buy_value += v
        buy_value_raw += p * q
      } else if (side === 'SELL' || side === 'SLD' || side === 'S') {
        sell_qty += q
        sell_value += v
        sell_value_raw += p * q
      }
    }
    const net_qty = buy_qty - sell_qty
    const buy_cost = buy_value
    const sell_premium = sell_value
    const realized_pnl = sell_premium - buy_cost
    const buy_avg_price = buy_qty > 0 ? buy_value_raw / buy_qty : null
    const sell_avg_price = sell_qty > 0 ? sell_value_raw / sell_qty : null
    result.push({
      contract_key,
      strike,
      expiry,
      net_qty,
      buy_volume: buy_qty,
      sell_volume: sell_qty,
      buy_avg_price,
      sell_avg_price,
      buy_cost,
      sell_premium,
      realized_pnl,
      status: net_qty === 0 ? 'realized' : 'unrealized',
      trades: trades.slice().sort((a, b) => (b.time ?? 0) - (a.time ?? 0)),
    })
  }
  result.sort((a, b) => (b.trades[0]?.time ?? 0) - (a.trades[0]?.time ?? 0))
  return result
}

export function PositionPnlPage({
  status,
  currentView,
  onViewChange,
  showViewTabs = true,
}: PositionPnlPageProps) {
  const [riskSummary, setRiskSummary] = useState<RiskSummaryResponse | null>(null)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [replayLoading, setReplayLoading] = useState(false)
  const [replaySyncing, setReplaySyncing] = useState(false)
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [addExecOpen, setAddExecOpen] = useState(false)
  const [editExec, setEditExec] = useState<Execution | null>(null)
  /** Pool=Off only: execution to close against; when set, show Quick Trade (Close) modal */
  const [closeAgainstExec, setCloseAgainstExec] = useState<Execution | null>(null)
  const [closeForm, setCloseForm] = useState({ time: '', commission: '', price: '' })
  const [execFormError, setExecFormError] = useState<string | null>(null)
  const [execForm, setExecForm] = useState({
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
  })
  const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterExpiryEnd, setOpenFilterExpiryEnd] = useState('')
  const [openFilterPool, setOpenFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [ledgerFilterSymbol, setLedgerFilterSymbol] = useState('')
  const [ledgerFilterExpiryStart, setLedgerFilterExpiryStart] = useState('')
  const [ledgerFilterExpiryEnd, setLedgerFilterExpiryEnd] = useState('')
  const [ledgerFilterExecStart, setLedgerFilterExecStart] = useState('')
  const [ledgerFilterExecEnd, setLedgerFilterExecEnd] = useState('')
  const [ledgerFilterPool, setLedgerFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [internalPortfolioView, setInternalPortfolioView] = useState<PortfolioView>('overview')
  const [ledgerTab, setLedgerTab] = useState<'options' | 'stocks'>('options')
  const [openTab, setOpenTab] = useState<'options' | 'stocks'>('options')
  const portfolioView = currentView ?? internalPortfolioView
  const setPortfolioViewSelected = onViewChange ?? setInternalPortfolioView

  const getOptGroupKey = (g: OptExecutionGroup) => `${g.contract_key}-${g.strike}-${g.expiry}`
  const [expandedDetailKeys, setExpandedDetailKeys] = useState<string[]>([])
  const getOpenOptGroupKey = (g: OpenOptionGroup) => `${g.contract_key}-${g.strike}-${g.expiry}-${g.pool_label}`
  const [expandedOpenDetailKeys, setExpandedOpenDetailKeys] = useState<string[]>([])

  /** true = 手风琴模式（一次只展开一个），false = 可展开多列 */
  const [openAccordionMode, setOpenAccordionMode] = useState<boolean>(false)
  const [ledgerAccordionMode, setLedgerAccordionMode] = useState<boolean>(false)
  const toggleDetailExpand = (key: string) => {
    setExpandedDetailKeys(prev => {
      const isOpen = prev.includes(key)
      if (ledgerAccordionMode) {
        // 手风琴：点击已展开的就收起，点击未展开的只保留当前一个
        return isOpen ? [] : [key]
      }
      // 多开模式：和之前一样，可以展开多列
      return isOpen ? prev.filter(k => k !== key) : [...prev, key]
    })
  }

  const toggleOpenDetailExpand = (key: string) => {
    setExpandedOpenDetailKeys(prev => {
      const isOpen = prev.includes(key)
      if (openAccordionMode) {
        return isOpen ? [] : [key]
      }
      return isOpen ? prev.filter(k => k !== key) : [...prev, key]
    })
  }

  const ledgerBaseFilteredExecutions = useMemo(() => {
    let list = [...(executions || [])]
    const sym = ledgerFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expStart = ledgerFilterExpiryStart.trim().replace(/-/g, '')
    if (expStart) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex + '01'
        return cmp >= expStart.slice(0, 8)
      })
    }
    const expEnd = ledgerFilterExpiryEnd.trim().replace(/-/g, '')
    if (expEnd) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex.length === 6 ? ex + '31' : ex
        return cmp <= expEnd.slice(0, 8)
      })
    }
    if (ledgerFilterExecStart.trim()) {
      const t = datetimeLocalToUnix(ledgerFilterExecStart)
      if (Number.isFinite(t)) list = list.filter(e => (e.time ?? 0) >= t)
    }
    if (ledgerFilterExecEnd.trim()) {
      const t = datetimeLocalToUnix(ledgerFilterExecEnd + 'T23:59:59')
      if (Number.isFinite(t)) list = list.filter(e => (e.time ?? 0) <= t)
    }
    return list
  }, [executions, ledgerFilterSymbol, ledgerFilterExpiryStart, ledgerFilterExpiryEnd, ledgerFilterExecStart, ledgerFilterExecEnd])

  const filteredExecutions = useMemo(() => {
    let list = [...ledgerBaseFilteredExecutions]
    if (ledgerFilterPool === 'ON') list = list.filter(e => (e.account_id ?? '').trim() !== OFF_TRACK_ACCOUNT_ID)
    else if (ledgerFilterPool === 'Off') list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    return list
  }, [ledgerBaseFilteredExecutions, ledgerFilterPool])

  const openOffTrackBaseExecutions = useMemo(() => {
    let list = [...(executions || [])]
    list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expStart = openFilterExpiryStart.trim().replace(/-/g, '')
    if (expStart) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex + '01'
        return cmp >= expStart.slice(0, 8)
      })
    }
    const expEnd = openFilterExpiryEnd.trim().replace(/-/g, '')
    if (expEnd) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex.length === 6 ? ex + '31' : ex
        return cmp <= expEnd.slice(0, 8)
      })
    }
    return list
  }, [executions, openFilterSymbol, openFilterExpiryStart, openFilterExpiryEnd])

  const livePositions = useMemo((): LivePositionRow[] => {
    if (openFilterPool === 'Off') return []
    const accounts = status?.accounts ?? []
    let rows = accounts.flatMap(account =>
      (account.positions ?? [])
        .filter(position => {
          const qty = Number(position.position)
          return Number.isFinite(qty) && qty !== 0
        })
        .map(position => ({
          ...position,
          account_id: (account.account_id ?? '').trim(),
        })),
    )

    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) {
      rows = rows.filter(position => (position.symbol ?? '').toUpperCase() === sym)
    }

    const expStart = openFilterExpiryStart.trim().replace(/-/g, '')
    if (expStart) {
      rows = rows.filter(position => {
        const secType = (position.secType ?? '').toUpperCase()
        if (secType !== 'OPT') return true
        const ex = (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex + '01'
        return cmp >= expStart.slice(0, 8)
      })
    }

    const expEnd = openFilterExpiryEnd.trim().replace(/-/g, '')
    if (expEnd) {
      rows = rows.filter(position => {
        const secType = (position.secType ?? '').toUpperCase()
        if (secType !== 'OPT') return true
        const ex = (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim().replace(/-/g, '')
        const cmp = ex.length >= 8 ? ex.slice(0, 8) : ex.length === 6 ? ex + '31' : ex
        return cmp <= expEnd.slice(0, 8)
      })
    }

    rows.sort((a, b) => {
      const aSym = (a.symbol ?? '').toUpperCase()
      const bSym = (b.symbol ?? '').toUpperCase()
      if (aSym !== bSym) return aSym.localeCompare(bSym)
      return (a.account_id ?? '').localeCompare(b.account_id ?? '')
    })
    return rows
  }, [openFilterExpiryEnd, openFilterExpiryStart, openFilterPool, openFilterSymbol, status?.accounts])

  const liveOptionPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() === 'OPT'),
    [livePositions],
  )

  const openOptionGroups = useMemo((): OpenOptionGroup[] => {
    const result: OpenOptionGroup[] = []

    if (openFilterPool !== 'Off') {
      const groups = new Map<string, LivePositionRow[]>()
      for (const position of liveOptionPositions) {
        const expiry = position.lastTradeDateOrContractMonth ?? position.expiry ?? ''
        const strike = Number(position.strike) || 0
        const right = (position.right ?? '').toUpperCase().slice(0, 1)
        const contractKey = position.contract_key ?? `${position.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`
        const key = `${contractKey}|${strike}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(position)
      }

      for (const [, positions] of groups) {
        if (positions.length === 0) continue
        const first = positions[0]
        const expiry = first.lastTradeDateOrContractMonth ?? first.expiry ?? ''
        const strike = Number(first.strike) || 0
        const contract_key = first.contract_key ?? `${first.symbol ?? ''}|OPT|${expiry}|${strike}|${(first.right ?? '').toUpperCase().slice(0, 1)}`
        let grossQty = 0
        let netQty = 0
        let costWeightedSum = 0
        let markWeightedSum = 0
        let unrealizedPnl = 0
        let buyVolume = 0
        let sellVolume = 0
        let buyCost = 0
        let sellPremium = 0
        let buyValueRaw = 0
        let sellValueRaw = 0
        for (const position of positions) {
          const qty = Number(position.position) || 0
          const absQty = Math.abs(qty)
          const avgCost = position.avgCost != null && Number.isFinite(Number(position.avgCost))
            ? Number(position.avgCost)
            : null
          const markPrice = position.price != null && Number.isFinite(Number(position.price))
            ? Number(position.price)
            : null
          netQty += qty
          grossQty += absQty
          if (avgCost != null) costWeightedSum += avgCost * absQty
          if (markPrice != null) markWeightedSum += markPrice * absQty
          unrealizedPnl += Number(position.unrealized_pnl) || 0
          if (qty > 0) {
            buyVolume += qty
            if (avgCost != null) {
              buyCost += avgCost * qty * 100
              buyValueRaw += avgCost * qty
            }
          } else if (qty < 0) {
            sellVolume += absQty
            if (avgCost != null) {
              sellPremium += avgCost * absQty * 100
              sellValueRaw += avgCost * absQty
            }
          }
        }
        // Option @ is per-share (e.g. 2.50); API may give avgCost per-share or per-contract. Ledger uses per-share.
        // If displayed @ is 100x too large, avgCost is per-contract (250); store per-share for @: divide by 100.
        const buyAvgPerShare = buyVolume > 0 ? buyValueRaw / buyVolume / 100 : null
        const sellAvgPerShare = sellVolume > 0 ? sellValueRaw / sellVolume / 100 : null
        // When avgCost is per-contract (e.g. 250), total $ = avgCost * qty (no *100). When per-share (2.5), total $ = avgCost * qty * 100.
        const rawBuyAvg = buyVolume > 0 ? buyValueRaw / buyVolume : 0
        const rawSellAvg = sellVolume > 0 ? sellValueRaw / sellVolume : 0
        const isPerContract = rawBuyAvg >= 10 || rawSellAvg >= 10
        const buyCostDollars = isPerContract ? buyVolume * rawBuyAvg : buyCost
        const sellPremiumDollars = isPerContract ? sellVolume * rawSellAvg : sellPremium
        const markPerShare = grossQty > 0 ? markWeightedSum / grossQty : null
        // Unrealized PnL: long PnL (mark*buy_vol*100 - buy_cost) + short PnL (sell_premium - mark*sell_vol*100) = mark*net_qty*100 - buy_cost + sell_premium
        const computedUnrealizedPnl =
          markPerShare != null && Number.isFinite(markPerShare)
            ? markPerShare * netQty * 100 - buyCostDollars + sellPremiumDollars
            : unrealizedPnl
        result.push({
          kind: 'live',
          contract_key,
          strike,
          expiry,
          net_qty: netQty,
          avg_cost: grossQty > 0 ? costWeightedSum / grossQty : null,
          mark_price: grossQty > 0 ? markWeightedSum / grossQty : null,
          unrealized_pnl: computedUnrealizedPnl,
          account_count: new Set(positions.map(position => position.account_id || '—')).size,
          pool_label: 'On',
          buy_volume: buyVolume,
          sell_volume: sellVolume,
          buy_avg_price: buyAvgPerShare,
          sell_avg_price: sellAvgPerShare,
          buy_cost: buyCostDollars,
          sell_premium: sellPremiumDollars,
          positions: positions.slice().sort((a, b) => (b.account_id ?? '').localeCompare(a.account_id ?? '')),
        })
      }
    }

    if (openFilterPool !== 'ON') {
      const openOffTrackGroups = buildOptExecutionGroups(openOffTrackBaseExecutions).filter(group => group.status === 'unrealized')
      for (const group of openOffTrackGroups) {
        // Unrealized PnL = sum of Details PnL column (per trade: Buy = -(q*p*100-c), Sell = +(q*p*100-c)) => sell_premium - buy_cost
        const unrealizedPnlOff = group.sell_premium - group.buy_cost
        result.push({
          kind: 'offtrack',
          contract_key: group.contract_key,
          strike: group.strike,
          expiry: group.expiry,
          net_qty: group.net_qty,
          avg_cost: group.buy_avg_price,
          mark_price: null,
          unrealized_pnl: unrealizedPnlOff,
          account_count: new Set(group.trades.map(trade => (trade.account_id ?? '').trim() || '—')).size,
          pool_label: 'Off',
          buy_volume: group.buy_volume,
          sell_volume: group.sell_volume,
          buy_avg_price: group.buy_avg_price,
          sell_avg_price: group.sell_avg_price,
          buy_cost: group.buy_cost,
          sell_premium: group.sell_premium,
          trades: group.trades,
        })
      }
    }

    result.sort((a, b) => {
      const aSymbol = getContractLabelParts(a.contract_key).symbol
      const bSymbol = getContractLabelParts(b.contract_key).symbol
      if (aSymbol !== bSymbol) return aSymbol.localeCompare(bSymbol)
      if (a.expiry !== b.expiry) return a.expiry.localeCompare(b.expiry)
      return a.pool_label.localeCompare(b.pool_label)
    })
    return result
  }, [openFilterPool, liveOptionPositions, openOffTrackBaseExecutions])

  const liveStockPositions = useMemo(
    () => livePositions.filter(position => (position.secType ?? '').toUpperCase() !== 'OPT'),
    [livePositions],
  )

  const overviewLivePositions = useMemo((): LivePositionRow[] => {
    const accounts = status?.accounts ?? []
    return accounts.flatMap(account =>
      (account.positions ?? [])
        .filter(position => {
          const qty = Number(position.position)
          return Number.isFinite(qty) && qty !== 0
        })
        .map(position => ({
          ...position,
          account_id: (account.account_id ?? '').trim(),
        })),
    )
  }, [status?.accounts])

  const overviewOptionContracts = useMemo(() => {
    const keys = new Set<string>()
    for (const position of overviewLivePositions) {
      if ((position.secType ?? '').toUpperCase() !== 'OPT') continue
      const expiry = position.lastTradeDateOrContractMonth ?? position.expiry ?? ''
      const strike = Number(position.strike) || 0
      const right = (position.right ?? '').toUpperCase().slice(0, 1)
      keys.add(position.contract_key ?? `${position.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`)
    }
    return keys.size
  }, [overviewLivePositions])

  const overviewStockLines = useMemo(
    () => overviewLivePositions.filter(position => (position.secType ?? '').toUpperCase() !== 'OPT').length,
    [overviewLivePositions],
  )

  const overviewUnrealizedPnl = useMemo(
    () => overviewLivePositions.reduce((acc, position) => acc + (Number(position.unrealized_pnl) || 0), 0),
    [overviewLivePositions],
  )

  const executionAccountOptions = useMemo(() => {
    const fromStatus = ((status?.accounts as { account_id?: string }[] | undefined) ?? [])
      .map(a => (a.account_id ?? '').trim())
      .filter(Boolean)
    const fromExec = (executions || [])
      .map(e => (e.account_id ?? '').trim())
      .filter(Boolean)
    const merged = Array.from(new Set([...fromStatus, ...fromExec]))
    merged.sort().reverse()
    if (!merged.includes(OFF_TRACK_ACCOUNT_ID)) {
      merged.push(OFF_TRACK_ACCOUNT_ID)
    }
    return merged
  }, [status?.accounts, executions])

  /** Pool=On Details: (account_id, contract_key) -> latest execution with id; only show Actions when this position has a matching account_execution. */
  const livePositionExecutionMap = useMemo(() => {
    const map = new Map<string, Execution>()
    const opt = (executions || []).filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
    for (const ex of opt) {
      if (ex.id == null) continue
      const ck = (ex.contract_key ?? '').trim()
      const acc = (ex.account_id ?? '').trim()
      const key = `${acc}|${ck}`
      const existing = map.get(key)
      if (!existing || (ex.time ?? 0) > (existing.time ?? 0)) map.set(key, ex)
    }
    return map
  }, [executions])

  useEffect(() => {
    if (addExecOpen) {
      const defaultAccount = executionAccountOptions[0] ?? ''
      setExecForm({
        account_id: defaultAccount,
        time: unixToDatetimeLocal(Date.now() / 1000),
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
      })
    }
  }, [addExecOpen])
  useEffect(() => {
    if (editExec) {
      setExecForm({
        account_id: editExec.account_id ?? '',
        time: unixToDatetimeLocal(editExec.time),
        symbol: editExec.symbol ?? '',
        sec_type: (editExec.sec_type ?? 'STK').toUpperCase(),
        side: (editExec.side ?? 'BUY').toUpperCase(),
        quantity: String(editExec.quantity ?? ''),
        price: String(editExec.price ?? ''),
        expiry: editExec.expiry ?? '',
        strike: String(editExec.strike ?? ''),
        option_right: (editExec.option_right ?? 'C').toUpperCase().slice(0, 1),
        commission: String(editExec.commission ?? ''),
        realized_pnl: String(editExec.realized_pnl ?? ''),
        currency: editExec.currency ?? 'USD',
      })
    }
  }, [editExec])

  useEffect(() => {
    if (closeAgainstExec) {
      setCloseForm({
        time: unixToDatetimeLocal(Date.now() / 1000),
        commission: '',
        price: '',
      })
    }
  }, [closeAgainstExec])

  const optExecutionGroups = useMemo((): OptExecutionGroup[] => {
    return buildOptExecutionGroups(filteredExecutions)
  }, [filteredExecutions])

  const closedOptionGroups = useMemo(
    () => optExecutionGroups.filter(group => group.status === 'realized'),
    [optExecutionGroups],
  )
  const closedOptGroupsPnlSum = useMemo(() => {
    return closedOptionGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0)
  }, [closedOptionGroups])
  const hasOptionExecutions = closedOptionGroups.length > 0
  const hasStockExecutions = useMemo(
    () => filteredExecutions.some(e => (e.sec_type ?? '').toUpperCase() !== 'OPT'),
    [filteredExecutions],
  )

  useEffect(() => {
    if (ledgerTab === 'options' && !hasOptionExecutions && hasStockExecutions) {
      setLedgerTab('stocks')
      return
    }
    if (ledgerTab === 'stocks' && !hasStockExecutions && hasOptionExecutions) {
      setLedgerTab('options')
    }
  }, [ledgerTab, hasOptionExecutions, hasStockExecutions])

  const hasOpenOptions = openOptionGroups.length > 0
  const hasOpenStocks = liveStockPositions.length > 0
  useEffect(() => {
    if (openTab === 'options' && !hasOpenOptions && hasOpenStocks) {
      setOpenTab('stocks')
      return
    }
    if (openTab === 'stocks' && !hasOpenStocks && hasOpenOptions) {
      setOpenTab('options')
    }
  }, [openTab, hasOpenOptions, hasOpenStocks])

  const loadReplayData = useCallback(async () => {
    setReplayLoading(true)
    try {
      const summary = await fetchRiskSummary()
      setRiskSummary(summary)
      const execRes = await fetchExecutions(undefined, undefined, 100)
      setExecutions(execRes.executions || [])
    } catch {
      setRiskSummary(null)
      setExecutions([])
    } finally {
      setReplayLoading(false)
    }
  }, [])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  return (
    <div className="card process-section replay-page">
      <h2 className="page-title-with-tooltip">
        {portfolioView === 'overview' && (
          <>Portfolio<InfoTooltip text="Separate current open positions from closed trade history, while keeping PnL and execution tools in one portfolio workspace." /></>
        )}
        {portfolioView === 'open' && (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={() => onViewChange?.('overview')}
            >
              Portfolio
            </button>
            {' / Open Positions'}
          </>
        )}
        {portfolioView === 'ledger' && (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={() => onViewChange?.('overview')}
            >
              Portfolio
            </button>
            {' / Trade Ledger'}
            <InfoTooltip text="Trade Ledger is the maintenance workspace for closed trades, execution imports, and manual trade corrections." />
          </>
        )}
      </h2>
      {showViewTabs && (
      <div className="system-tabs replay-portfolio-view-tabs" role="tablist" aria-label="Portfolio view">
        <button
          type="button"
          role="tab"
          aria-selected={portfolioView === 'overview'}
          className={`system-tab ${portfolioView === 'overview' ? 'active' : ''}`}
          onClick={() => setPortfolioViewSelected('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={portfolioView === 'open'}
          className={`system-tab ${portfolioView === 'open' ? 'active' : ''}`}
          onClick={() => setPortfolioViewSelected('open')}
        >
          Open Positions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={portfolioView === 'ledger'}
          className={`system-tab ${portfolioView === 'ledger' ? 'active' : ''}`}
          onClick={() => setPortfolioViewSelected('ledger')}
        >
          Trade Ledger
        </button>
      </div>
      )}
      {portfolioView === 'overview' && (
      <p className="section-hint replay-portfolio-view-hint">
        Overview shows portfolio-level summary and risk model signals without trade-maintenance actions.
      </p>
      )}

      {portfolioView === 'overview' ? (
        <>
          <section className="replay-section" aria-labelledby="portfolio-overview-head">
            <h3 id="portfolio-overview-head">Portfolio overview</h3>
            <div className="risk-summary-cards">
              <div className="risk-card">
                <span className="risk-card-label">Accounts</span>
                <span className="risk-card-value">{status?.accounts?.length ?? 0}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Open option contracts</span>
                <span className="risk-card-value">{overviewOptionContracts}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Stock lines</span>
                <span className="risk-card-value">{overviewStockLines}</span>
              </div>
              <div className="risk-card">
                <span className="risk-card-label">Unrealized PnL</span>
                <span className="risk-card-value">{fmtUsd(overviewUnrealizedPnl)}</span>
              </div>
            </div>
            {status?.accounts_fetched_at != null && Number.isFinite(Number(status.accounts_fetched_at)) && (
              <p className="section-hint replay-overview-fetched-at">
                Live positions snapshot from {new Date(Number(status.accounts_fetched_at) * 1000).toLocaleString()}.
              </p>
            )}
          </section>

          <section className="replay-section" aria-labelledby="risk-summary-head">
            <h3 id="risk-summary-head">Risk model</h3>
            {replayLoading ? (
              <p className="section-hint">Loading…</p>
            ) : riskSummary ? (
              <div className="risk-summary-cards">
                <div className="risk-card">
                  <span className="risk-card-label">Daily hedge count</span>
                  <span className="risk-card-value">{riskSummary.daily_hedge_count ?? '—'}</span>
                </div>
                <div className="risk-card">
                  <span className="risk-card-label">Daily PnL (USD)</span>
                  <span className="risk-card-value">{fmtUsd(riskSummary.daily_pnl)}</span>
                </div>
                <div className="risk-card">
                  <span className="risk-card-label">Spot</span>
                  <span className="risk-card-value">{fmtUsd(riskSummary.spot)}</span>
                </div>
                <div className="risk-card">
                  <span className="risk-card-label">Ops (24h)</span>
                  <span className="risk-card-value">{riskSummary.operations_count_24h ?? 0}</span>
                </div>
              </div>
            ) : (
              <p className="section-hint">Unable to load risk summary (check API and DB).</p>
            )}
          </section>

          <section className="replay-section" aria-labelledby="portfolio-fetch-head">
            <h3 id="portfolio-fetch-head">Fetch from IB</h3>
            <div className="replay-toolbar">
              <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch range">
                <span className="replay-fetch-days-label">Fetch</span>
                <label className="replay-fetch-radio">
                  <input
                    type="radio"
                    name="replay-fetch-days"
                    value={1}
                    checked={replayFetchDays === 1}
                    onChange={() => setReplayFetchDays(1)}
                    disabled={replaySyncing}
                  />
                  <span>Today</span>
                </label>
                <label className="replay-fetch-radio">
                  <input
                    type="radio"
                    name="replay-fetch-days"
                    value={3}
                    checked={replayFetchDays === 3}
                    onChange={() => setReplayFetchDays(3)}
                    disabled={replaySyncing}
                  />
                  <span>Last 3 days</span>
                </label>
                <label className="replay-fetch-radio">
                  <input
                    type="radio"
                    name="replay-fetch-days"
                    value={7}
                    checked={replayFetchDays === 7}
                    onChange={() => setReplayFetchDays(7)}
                    disabled={replaySyncing}
                  />
                  <span>Last 7 days</span>
                </label>
                <button
                  type="button"
                  className="btn btn-small replay-fetch-refresh-btn"
                  disabled={replaySyncing || replayLoading}
                  onClick={async () => {
                    setReplaySyncing(true)
                    const res = await postExecutionsFetch(replayFetchDays)
                    if (!res.ok) {
                      setReplaySyncing(false)
                      return
                    }
                    await loadReplayData()
                    setReplaySyncing(false)
                  }}
                  aria-label="Fetch executions from IB and write to DB"
                >
                  {replaySyncing ? 'Fetching…' : 'Refresh'}
                </button>
              </div>
              {replaySyncing && (
                <span className="replay-sync-hint">Fetching executions from IB…</span>
              )}
            </div>
          </section>
        </>
      ) : portfolioView === 'open' ? (
        <section className="replay-section replay-section-trade-records" aria-label="Open positions">
          <div className="replay-filters">
            <label className="replay-filter-wrap-symbol">
              <input
                type="text"
                placeholder="Symbol"
                value={openFilterSymbol}
                onChange={e => setOpenFilterSymbol(e.target.value)}
                className="replay-filter-input"
              />
            </label>
            <label>
              <span className="replay-filter-label">Expiry</span>
              <input
                type="date"
                value={openFilterExpiryStart}
                onChange={e => setOpenFilterExpiryStart(e.target.value)}
                className="replay-filter-input replay-filter-date"
                title="Start"
              />
              <span className="replay-filter-sep">～</span>
              <input
                type="date"
                value={openFilterExpiryEnd}
                onChange={e => setOpenFilterExpiryEnd(e.target.value)}
                className="replay-filter-input replay-filter-date"
                title="End"
              />
            </label>
            <div className="replay-fetch-range-group replay-pool-group" role="radiogroup" aria-label="Pool filter">
              <span className="replay-fetch-days-label">Pool</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="Mix" checked={openFilterPool === 'Mix'} onChange={() => setOpenFilterPool('Mix')} />
                <span>Mix</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="ON" checked={openFilterPool === 'ON'} onChange={() => setOpenFilterPool('ON')} />
                <span>On</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="portfolio-open-pool" value="Off" checked={openFilterPool === 'Off'} onChange={() => setOpenFilterPool('Off')} />
                <span>Off</span>
              </label>
            </div>
            <div className="replay-fetch-range-group" role="radiogroup" aria-label="Open position detail view mode">
              <span className="replay-fetch-days-label">Detail view</span>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="accordion" checked={openAccordionMode} onChange={() => setOpenAccordionMode(true)} />
                <span>Accordion</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="open-detail-view" value="multi" checked={!openAccordionMode} onChange={() => setOpenAccordionMode(false)} />
                <span>Multi</span>
              </label>
            </div>
            <button
              type="button"
              className="btn btn-small replay-filter-clear"
              onClick={() => {
                setOpenFilterSymbol('')
                setOpenFilterExpiryStart('')
                setOpenFilterExpiryEnd('')
                setOpenFilterPool('Mix')
                setExpandedOpenDetailKeys([])
              }}
            >
              Clear filters
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setAddExecOpen(true); setExecFormError(null) }}
              aria-label="Add execution record manually (historical)"
            >
              Add Trade
            </button>
          </div>
          {openOptionGroups.length === 0 && liveStockPositions.length === 0 ? (
            <p className="section-hint">No open positions under the current filters. Position data comes from account snapshots in `Accounts`, while Off-Track options are inferred from execution history.</p>
          ) : (
            <div className="replay-portfolio-block">
              <div className="replay-portfolio-header">
                <div className="replay-portfolio-tabs-wrap">
                  <div className="system-tabs replay-portfolio-tabs" role="tablist" aria-label="Open position asset sections">
                    <button
                      type="button"
                      role="tab"
                      id="open-tab-options"
                      aria-selected={openTab === 'options'}
                      aria-controls="open-panel-options"
                      className={`system-tab ${openTab === 'options' ? 'active' : ''}`}
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
                      disabled={!hasOpenStocks}
                    >
                      Stocks
                    </button>
                  </div>
                  <p className="section-hint replay-portfolio-tab-hint">
                    {openTab === 'options'
                      ? 'Open option positions by contract; expand a row to see Details and Add/Edit/Close trades.'
                      : 'Open stock positions from account snapshots (Live only).'}
                  </p>
                </div>
              </div>
              {openTab === 'options' ? (
                <div
                  id="open-panel-options"
                  role="tabpanel"
                  aria-labelledby="open-tab-options"
                  className="system-tab-panel"
                >
                  <h5 className="replay-sub">Option positions</h5>
                  {openOptionGroups.length === 0 ? (
                    <p className="section-hint">No open option positions under the current filters.</p>
                  ) : (
                <>
                  <div className="replay-portfolio-table-wrap">
                    <table className="table-operations replay-opt-groups">
                      <thead>
                        <tr>
                          <th rowSpan={2} className="replay-opt-expand-col"></th>
                          <th rowSpan={2}>Contract</th>
                          <th rowSpan={2}>Expiry</th>
                          <th rowSpan={2}>STRIKE</th>
                          <th colSpan={3}>BUY</th>
                          <th colSpan={3}>SELL</th>
                          <th rowSpan={2}>Unrealized PnL</th>
                          <th rowSpan={2}>Pool</th>
                        </tr>
                        <tr>
                          <th className="replay-th-sub">Size</th>
                          <th className="replay-th-sub">@</th>
                          <th className="replay-th-sub">Cost</th>
                          <th className="replay-th-sub">Size</th>
                          <th className="replay-th-sub">@</th>
                          <th className="replay-th-sub">Premium</th>
                        </tr>
                      </thead>
                      <tbody>
                        {openOptionGroups.map(group => {
                          const groupKey = getOpenOptGroupKey(group)
                          const isExpanded = expandedOpenDetailKeys.includes(groupKey)
                          return (
                            <tr
                              key={groupKey}
                              className="replay-opt-group-row"
                              onClick={() => toggleOpenDetailExpand(groupKey)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpenDetailExpand(groupKey) } }}
                              aria-expanded={isExpanded}
                              aria-label={isExpanded ? 'Collapse open position details' : 'Expand open position details'}
                            >
                              <td className="replay-opt-expand-col">
                                <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                                  {isExpanded ? '▼' : '▶'}
                                </span>
                              </td>
                              <td className="replay-opt-contract">
                                {(() => {
                                  const p = getContractLabelParts(group.contract_key)
                                  return p.symbol ? (
                                    <>
                                      <strong>{p.symbol}</strong> {p.rightLabel}
                                    </>
                                  ) : (
                                    group.contract_key
                                  )
                                })()}
                              </td>
                              <td>{fmtExpiry(group.expiry)}</td>
                              <td><strong>{fmtUsd(group.strike)}</strong></td>
                              <td>{group.buy_volume}</td>
                              <td>{fmtUsd(group.buy_avg_price)}</td>
                              <td><span className="replay-cost">{fmtUsd(group.buy_cost)}</span></td>
                              <td>{group.sell_volume}</td>
                              <td>{fmtUsd(group.sell_avg_price)}</td>
                              <td><span className="replay-premium">{fmtUsd(group.sell_premium)}</span></td>
                              <td>
                                <span className="replay-pnl-unrealized">
                                  {fmtUsd(group.unrealized_pnl ?? 0)}
                                </span>
                              </td>
                              <td>{group.pool_label}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="replay-opt-tfoot-total">
                          <td colSpan={10} className="replay-opt-tfoot-label">Total</td>
                          <td>
                            <span className="replay-pnl-unrealized">
                              {fmtUsd(openOptionGroups.reduce((acc, g) => acc + (g.unrealized_pnl ?? 0), 0))}
                            </span>
                          </td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                    Details (per trade)
                    <InfoTooltip text="Click a grouped option row above to inspect live account snapshots or Off-Track open trades for that contract." />
                  </h5>
                  <table className="table-operations">
                    <thead>
                      <tr>
                        <th>Contract</th>
                        <th>Expiry</th>
                        <th>STRIKE</th>
                        <th>Time</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Price</th>
                        <th>Commission</th>
                        <th>PnL</th>
                        <th>Pool</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedOpenDetailKeys.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="replay-detail-placeholder">Click an open option row above to load details</td>
                        </tr>
                      ) : (
                        openOptionGroups
                          .filter(group => expandedOpenDetailKeys.includes(getOpenOptGroupKey(group)))
                          .flatMap(group =>
                            group.kind === 'live'
                              ? (group.positions ?? []).map((position, index) => {
                                  const qty = Number(position.position)
                                  const absQty = Math.abs(qty)
                                  const pricePerShare = position.avgCost != null && Number.isFinite(Number(position.avgCost))
                                    ? (Number(position.avgCost) >= 10 ? Number(position.avgCost) / 100 : Number(position.avgCost))
                                    : null
                                  const commission = 0
                                  const value = (pricePerShare ?? 0) * absQty * 100 - commission
                                  const rowPnl = qty > 0 ? -value : value
                                  const pnlClass = 'replay-pnl-unrealized'
                                  const execForRow = livePositionExecutionMap.get(`${(position.account_id ?? '').trim()}|${group.contract_key}`)
                                  return (
                                    <tr key={`${getOpenOptGroupKey(group)}-live-${position.account_id}-${index}`}>
                                      <td className="replay-opt-contract">
                                        {(() => {
                                          const p = getContractLabelParts(group.contract_key)
                                          return p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}
                                            </>
                                          ) : (
                                            group.contract_key
                                          )
                                        })()}
                                      </td>
                                      <td>{fmtExpiry(position.lastTradeDateOrContractMonth ?? position.expiry ?? group.expiry)}</td>
                                      <td><strong>{position.strike != null ? fmtUsd(position.strike) : fmtUsd(group.strike)}</strong></td>
                                      <td>{(() => {
                                        const ts = position.exec_time != null ? Number(position.exec_time) : (position.updated_at != null ? Number(position.updated_at) : null)
                                        return ts != null && Number.isFinite(ts) ? fmtTs(ts) : '—'
                                      })()}</td>
                                      <td>{qty > 0 ? 'Buy' : qty < 0 ? 'Sell' : '—'}</td>
                                      <td>{Number.isFinite(qty) ? Math.abs(qty) : '—'}</td>
                                      <td>{fmtUsd(pricePerShare)}</td>
                                      <td>{fmtUsd(0)}</td>
                                      <td><span className={pnlClass}>{fmtUsd(rowPnl)}</span></td>
                                      <td>{group.pool_label}</td>
                                      <td>
                                        {execForRow?.id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button type="button" className="btn btn-small" onClick={() => { setEditExec(execForRow); setExecFormError(null) }}>Edit</button>
                                            <button
                                              type="button"
                                              className="btn btn-small btn-x"
                                              onClick={async () => {
                                                if (!window.confirm('Delete this execution?')) return
                                                const res = await deleteExecution(execForRow.id!)
                                                if (res.ok) {
                                                  if (editExec?.id === execForRow.id) setEditExec(null)
                                                  await loadReplayData()
                                                } else {
                                                  setExecFormError(res.error ?? 'Delete failed')
                                                }
                                              }}
                                              title="Delete"
                                            >
                                              X
                                            </button>
                                          </span>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                  )
                                })
                              : (group.trades ?? []).map((ex, ti) => {
                                  const s = (ex.side ?? '').toUpperCase()
                                  const sideLabel =
                                    s === 'BUY' || s === 'BOT' || s === 'B'
                                      ? 'Buy'
                                      : s === 'SELL' || s === 'SLD' || s === 'S'
                                        ? 'Sell'
                                        : (ex.side ?? '—')
                                  const q = Number(ex.quantity) || 0
                                  const p = Number(ex.price) || 0
                                  const c = Number(ex.commission) || 0
                                  const value = q * p * 100 - c
                                  const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
                                  const pnl = isBuy ? -value : value
                                  const pnlClass = pnl < 0 ? 'replay-pnl-detail-negative' : pnl > 0 ? 'replay-pnl-detail-positive' : ''
                                  return (
                                    <tr key={`${getOpenOptGroupKey(group)}-${ti}-${ex.time ?? ti}`}>
                                      <td className="replay-opt-contract">
                                        {(() => {
                                          const p_ = getContractLabelParts(group.contract_key)
                                          return p_.symbol ? (
                                            <>
                                              <strong>{p_.symbol}</strong> {p_.rightLabel}
                                            </>
                                          ) : (
                                            group.contract_key
                                          )
                                        })()}
                                      </td>
                                      <td>{fmtExpiry(ex.expiry ?? group.expiry)}</td>
                                      <td><strong>{fmtUsd(ex.strike ?? group.strike)}</strong></td>
                                      <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                                      <td>{sideLabel}</td>
                                      <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                                      <td>{fmtUsd(ex.price)}</td>
                                      <td>{fmtUsd(ex.commission ?? 0)}</td>
                                      <td>
                                        <span className={pnlClass}>{fmtUsd(pnl)}</span>
                                      </td>
                                      <td>{group.pool_label}</td>
                                      <td>
                                        {ex.id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setExecFormError(null) }}>Edit</button>
                                            <button type="button" className="btn btn-small" onClick={() => { setCloseAgainstExec(ex); setExecFormError(null) }}>Close</button>
                                            <button
                                              type="button"
                                              className="btn btn-small btn-x"
                                              onClick={async () => {
                                                if (!window.confirm('Delete this execution?')) return
                                                const res = await deleteExecution(ex.id!)
                                                if (res.ok) {
                                                  if (editExec?.id === ex.id) setEditExec(null)
                                                  await loadReplayData()
                                                } else {
                                                  setExecFormError(res.error ?? 'Delete failed')
                                                }
                                              }}
                                              title="Delete"
                                            >
                                              X
                                            </button>
                                          </span>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                  )
                                }),
                          )
                      )}
                    </tbody>
                  </table>
                </>
              )}
                </div>
              ) : (
                <div
                  id="open-panel-stocks"
                  role="tabpanel"
                  aria-labelledby="open-tab-stocks"
                  className="system-tab-panel"
                >
                  <h5 className="replay-sub">Stock positions</h5>
                  {liveStockPositions.length === 0 ? (
                    <p className="section-hint">No open stock positions under the current filters.</p>
                  ) : (
                <div className="replay-portfolio-table-wrap">
                  <table className="table-operations">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Avg Cost</th>
                        <th>Mark</th>
                        <th>Unrealized PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveStockPositions.map((position, index) => {
                        const qty = Number(position.position)
                        const pnl = position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
                          ? Number(position.unrealized_pnl)
                          : null
                        const pnlClass = pnl == null ? '' : 'replay-pnl-unrealized'
                        return (
                          <tr key={`open-stk-${position.account_id}-${position.symbol ?? index}`}>
                            <td>{position.account_id || '—'}</td>
                            <td><strong>{position.symbol ?? '—'}</strong></td>
                            <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                            <td>{Number.isFinite(qty) ? qty : '—'}</td>
                            <td>{fmtUsd(position.avgCost)}</td>
                            <td>{fmtUsd(position.price)}</td>
                            <td><span className={pnlClass}>{fmtUsd(pnl ?? 0)}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="replay-section replay-section-trade-records" aria-label="Trade Ledger">
            <div className="replay-filters">
              <label className="replay-filter-wrap-symbol">
                <input
                  type="text"
                  placeholder="Symbol"
                  value={ledgerFilterSymbol}
                  onChange={e => setLedgerFilterSymbol(e.target.value)}
                  className="replay-filter-input"
                />
              </label>
              <label>
                <span className="replay-filter-label">Expiry</span>
                <input
                  type="date"
                  value={ledgerFilterExpiryStart}
                  onChange={e => setLedgerFilterExpiryStart(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="Start"
                />
                <span className="replay-filter-sep">～</span>
                <input
                  type="date"
                  value={ledgerFilterExpiryEnd}
                  onChange={e => setLedgerFilterExpiryEnd(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="End"
                />
              </label>
              <label>
                <span className="replay-filter-label">Submit</span>
                <input
                  type="date"
                  value={ledgerFilterExecStart}
                  onChange={e => setLedgerFilterExecStart(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="Start"
                />
                <span className="replay-filter-sep">～</span>
                <input
                  type="date"
                  value={ledgerFilterExecEnd}
                  onChange={e => setLedgerFilterExecEnd(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="End"
                />
              </label>
              <div className="replay-fetch-range-group replay-pool-group" role="radiogroup" aria-label="Pool filter">
                <span className="replay-fetch-days-label">Pool</span>
                <label className="replay-fetch-radio">
                  <input type="radio" name="replay-pool" value="Mix" checked={ledgerFilterPool === 'Mix'} onChange={() => setLedgerFilterPool('Mix')} />
                  <span>Mix</span>
                </label>
                <label className="replay-fetch-radio">
                  <input type="radio" name="replay-pool" value="ON" checked={ledgerFilterPool === 'ON'} onChange={() => setLedgerFilterPool('ON')} />
                  <span>ON</span>
                </label>
                <label className="replay-fetch-radio">
                  <input type="radio" name="replay-pool" value="Off" checked={ledgerFilterPool === 'Off'} onChange={() => setLedgerFilterPool('Off')} />
                  <span>Off</span>
                </label>
              </div>
              <button
                type="button"
                className="btn btn-small replay-filter-clear"
                onClick={() => {
                  setLedgerFilterSymbol('')
                  setLedgerFilterExpiryStart('')
                  setLedgerFilterExpiryEnd('')
                  setLedgerFilterExecStart('')
                  setLedgerFilterExecEnd('')
                  setLedgerFilterPool('Mix')
                  setExpandedDetailKeys([])
                }}
              >
                Clear filters
              </button>
            </div>
            <div className="replay-portfolio-block">
              <div className="replay-portfolio-header">
                <div className="replay-portfolio-tabs-wrap">
                  <div className="system-tabs replay-portfolio-tabs" role="tablist" aria-label="Closed trade asset sections">
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
                  <p className="section-hint replay-portfolio-tab-hint">
                    {ledgerTab === 'options'
                      ? 'Completed option trades are grouped by contract and strike so the page reads like a closed-trade ledger.'
                      : 'Stock execution history stays available here for audit and manual correction.'}
                    <InfoTooltip text={ledgerTab === 'options'
                      ? 'Closed option trades only: groups with net quantity = 0. Cost/Premium = Size×@×100−Commission; Realized PnL = Premium − Cost.'
                      : 'Shows non-option execution rows after current filters are applied.'} />
                  </p>
                </div>
                <div className="replay-portfolio-filters">
                  {ledgerTab === 'options' && (
                    <div className="replay-fetch-range-group" role="radiogroup" aria-label="Detail view mode">
                      <span className="replay-fetch-days-label">Detail view</span>
                      <label className="replay-fetch-radio">
                        <input type="radio" name="replay-detail-view" value="accordion" checked={ledgerAccordionMode} onChange={() => setLedgerAccordionMode(true)} />
                        <span>Accordion</span>
                      </label>
                      <label className="replay-fetch-radio">
                        <input type="radio" name="replay-detail-view" value="multi" checked={!ledgerAccordionMode} onChange={() => setLedgerAccordionMode(false)} />
                        <span>Multi</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>
              {filteredExecutions.length === 0 ? (
                <p className="section-hint">No execution data. Use Overview to fetch from IB (Refresh), or Open Positions to add manual history (Add Trade).{([ledgerFilterSymbol, ledgerFilterExpiryStart, ledgerFilterExpiryEnd, ledgerFilterExecStart, ledgerFilterExecEnd].some(Boolean) || ledgerFilterPool !== 'Mix') ? ' Filters applied; clear to see all.' : ''}</p>
              ) : (
                <>
                  {ledgerTab === 'options' ? (
                    <div
                      id="replay-panel-options"
                      role="tabpanel"
                      aria-labelledby="replay-tab-options"
                      className="system-tab-panel"
                    >
                      {hasOptionExecutions ? (
                        <>
                          <div className="replay-portfolio-table-wrap">
                            <table className="table-operations replay-opt-groups">
                              <thead>
                                <tr>
                                  <th rowSpan={2} className="replay-opt-expand-col"></th>
                                  <th rowSpan={2}>Contract</th>
                                  <th rowSpan={2}>Expiry</th>
                                  <th rowSpan={2}>STRIKE</th>
                                  <th colSpan={3}>BUY</th>
                                  <th colSpan={3}>SELL</th>
                                  <th rowSpan={2}>Realized PnL</th>
                                  <th rowSpan={2}>Pool</th>
                                </tr>
                                <tr>
                                  <th className="replay-th-sub">Size</th>
                                  <th className="replay-th-sub">@</th>
                                  <th className="replay-th-sub">Cost</th>
                                  <th className="replay-th-sub">Size</th>
                                  <th className="replay-th-sub">@</th>
                                  <th className="replay-th-sub">Premium</th>
                                </tr>
                              </thead>
                              <tbody>
                                {closedOptionGroups.map((g) => {
                                  const hasOff = g.trades.some(t => (t.account_id ?? '').trim() === 'Off-Track')
                                  const hasOn = g.trades.some(t => (t.account_id ?? '').trim() !== 'Off-Track')
                                  const poolLabel = hasOff && hasOn ? 'Mix' : hasOff ? 'Off' : 'On'
                                  const groupKey = getOptGroupKey(g)
                                  const isExpanded = expandedDetailKeys.includes(groupKey)
                                  return (
                                    <tr
                                      key={groupKey}
                                      className="replay-opt-group-row"
                                      onClick={() => toggleDetailExpand(groupKey)}
                                      role="button"
                                      tabIndex={0}
                                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDetailExpand(groupKey) } }}
                                      aria-expanded={isExpanded}
                                      aria-label={isExpanded ? 'Collapse group details' : 'Expand group details'}
                                    >
                                      <td className="replay-opt-expand-col">
                                        <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                                          {isExpanded ? '▼' : '▶'}
                                        </span>
                                      </td>
                                      <td className="replay-opt-contract">
                                        {(() => {
                                          const p = getContractLabelParts(g.contract_key)
                                          return p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}
                                            </>
                                          ) : (
                                            g.contract_key
                                          )
                                        })()}
                                      </td>
                                      <td>{fmtExpiry(g.expiry)}</td>
                                      <td><strong>{fmtUsd(g.strike)}</strong></td>
                                      <td>{g.buy_volume}</td>
                                      <td>{fmtUsd(g.buy_avg_price)}</td>
                                      <td><span className="replay-cost">{fmtUsd(g.buy_cost)}</span></td>
                                      <td>{g.sell_volume}</td>
                                      <td>{fmtUsd(g.sell_avg_price)}</td>
                                      <td><span className="replay-premium">{fmtUsd(g.sell_premium)}</span></td>
                                      <td>
                                        <span className={g.realized_pnl >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                                          {fmtUsd0(g.realized_pnl)}
                                        </span>
                                      </td>
                                      <td>{poolLabel}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                              <tfoot>
                                <tr className="replay-opt-summary-row">
                                  <td colSpan={10}>Total</td>
                                  <td>
                                    <strong className={closedOptGroupsPnlSum >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                                      {fmtUsd0(closedOptGroupsPnlSum)}
                                    </strong>
                                  </td>
                                  <td>—</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>

                          <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                            Details (per trade)
                            <InfoTooltip text="Click a closed trade row above to load its execution details." />
                          </h5>
                          <table className="table-operations">
                            <thead>
                              <tr>
                                <th>Contract</th>
                                <th>Expiry</th>
                                <th>STRIKE</th>
                                <th>Time</th>
                                <th>Side</th>
                                <th>Qty</th>
                                <th>Price</th>
                                <th>Commission</th>
                                <th>PnL</th>
                                <th>Pool</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {expandedDetailKeys.length === 0 ? (
                                <tr>
                                  <td colSpan={11} className="replay-detail-placeholder">Click a closed trade row above to load details</td>
                                </tr>
                              ) : (
                                closedOptionGroups
                                  .filter(g => expandedDetailKeys.includes(getOptGroupKey(g)))
                                  .flatMap((g) =>
                                    g.trades.map((ex, ti) => {
                                      const s = (ex.side ?? '').toUpperCase()
                                      const sideLabel =
                                        s === 'BUY' || s === 'BOT' || s === 'B'
                                          ? 'Buy'
                                          : s === 'SELL' || s === 'SLD' || s === 'S'
                                            ? 'Sell'
                                            : (ex.side ?? '—')
                                      const q = Number(ex.quantity) || 0
                                      const p = Number(ex.price) || 0
                                      const c = Number(ex.commission) || 0
                                      const value = q * p * 100 - c
                                      const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
                                      const pnl = isBuy ? -value : value
                                      const pnlClass =
                                        pnl < 0 ? 'replay-pnl-detail-negative' : pnl > 0 ? 'replay-pnl-detail-positive' : ''
                                      return (
                                        <tr key={`${getOptGroupKey(g)}-${ti}-${ex.time ?? ti}`}>
                                          <td>
                                            {(() => {
                                              const p_ = getContractLabelParts(g.contract_key)
                                              return p_.symbol ? (
                                                <>
                                                  <strong>{p_.symbol}</strong> {p_.rightLabel}
                                                </>
                                              ) : (
                                                g.contract_key
                                              )
                                            })()}
                                          </td>
                                          <td>{fmtExpiry(ex.expiry ?? g.expiry)}</td>
                                          <td><strong>{fmtUsd(g.strike)}</strong></td>
                                          <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                                          <td>{sideLabel}</td>
                                          <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                                          <td>{fmtUsd(ex.price)}</td>
                                          <td>{fmtUsd(ex.commission ?? 0)}</td>
                                          <td>
                                            <span className={pnlClass}>{fmtUsd(pnl)}</span>
                                          </td>
                                          <td>{(ex.account_id ?? '').trim() === 'Off-Track' ? 'Off' : 'On'}</td>
                                          <td>
                                            {ex.id != null ? (
                                              <span className="replay-exec-row-actions">
                                                <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setExecFormError(null) }}>Edit</button>
                                                <button
                                                  type="button"
                                                  className="btn btn-small btn-x"
                                                  onClick={async () => {
                                                    if (!window.confirm('Delete this execution?')) return
                                                    const res = await deleteExecution(ex.id!)
                                                    if (res.ok) {
                                                      if (editExec?.id === ex.id) setEditExec(null)
                                                      await loadReplayData()
                                                    } else {
                                                      setExecFormError(res.error ?? 'Delete failed')
                                                    }
                                                  }}
                                                  title="Delete"
                                                >
                                                  X
                                                </button>
                                              </span>
                                            ) : '—'}
                                          </td>
                                        </tr>
                                      )
                                    }),
                                  )
                              )}
                            </tbody>
                          </table>
                        </>
                      ) : (
                        <p className="section-hint">No closed option trades under the current filters.</p>
                      )}
                    </div>
                  ) : (
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
                                <th>Symbol</th>
                                <th>Side</th>
                                <th>Qty</th>
                                <th>Price</th>
                                <th>Commission</th>
                                <th>Source</th>
                                <th>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredExecutions
                                .filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
                                .map((ex, i) => {
                                  const s = (ex.side ?? '').toUpperCase()
                                  const sideLabel =
                                    s === 'BUY' || s === 'BOT' || s === 'B'
                                      ? 'Buy'
                                      : s === 'SELL' || s === 'SLD' || s === 'S'
                                        ? 'Sell'
                                        : (ex.side ?? '—')
                                  return (
                                    <tr key={i}>
                                      <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                                      <td>{ex.symbol ?? '—'}</td>
                                      <td>{sideLabel}</td>
                                      <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                                      <td>{fmtUsd(ex.price)}</td>
                                      <td>{fmtUsd(ex.commission ?? 0)}</td>
                                      <td>{ex.source ?? '—'}</td>
                                      <td>
                                        {ex.id != null ? (
                                          <span className="replay-exec-row-actions">
                                            <button type="button" className="btn btn-small" onClick={() => { setEditExec(ex); setExecFormError(null) }}>Edit</button>
                                            <button
                                              type="button"
                                              className="btn btn-small btn-x"
                                              onClick={async () => {
                                                if (!window.confirm('Delete this execution?')) return
                                                const res = await deleteExecution(ex.id!)
                                                if (res.ok) {
                                                  if (editExec?.id === ex.id) setEditExec(null)
                                                  await loadReplayData()
                                                } else {
                                                  setExecFormError(res.error ?? 'Delete failed')
                                                }
                                              }}
                                              title="Delete"
                                            >
                                              X
                                            </button>
                                          </span>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                  )
                                })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="section-hint">No stock executions under the current filters.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </>
      )}

      {(addExecOpen || editExec) && (
        <div className="modal-overlay" onClick={() => { setAddExecOpen(false); setEditExec(null); setExecFormError(null); }} role="dialog" aria-modal="true" aria-labelledby="exec-modal-title">
          <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
            <h3 id="exec-modal-title">{editExec ? 'Edit execution' : 'Add history'}</h3>
            {execFormError && <p className="section-hint replay-form-error">{execFormError}</p>}
            <form
              className="replay-exec-form"
              onSubmit={async e => {
                e.preventDefault()
                setExecFormError(null)
                const sym = execForm.symbol.trim()
                const q = Number(execForm.quantity)
                const p = Number(execForm.price)
                if (!sym || !Number.isFinite(q) || !Number.isFinite(p)) {
                  setExecFormError('Fill symbol, quantity, and price.')
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
                if (editExec?.id != null) {
                  const body: Record<string, unknown> = {
                    exec_time: timeUnix,
                    symbol: sym,
                    sec_type: execForm.sec_type || 'STK',
                    side: (execForm.side || 'BUY').toUpperCase(),
                    quantity: q,
                    price: p,
                    account_id: execForm.account_id.trim(),
                    strike: execForm.strike ? Number(execForm.strike) : undefined,
                    option_right: execForm.option_right || undefined,
                    contract_key: contract_key || undefined,
                    commission: execForm.commission ? Number(execForm.commission) : undefined,
                    realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                    currency: execForm.currency.trim() || undefined,
                  }
                  const expiryTrimmed = execForm.expiry.trim()
                  if (isOpt && expiryTrimmed && /^\d{6,8}$/.test(expiryTrimmed)) {
                    body.expiry = expiryTrimmed
                  }
                  const res = await updateExecution(editExec.id, body)
                  if (res.ok) {
                    setEditExec(null)
                    setAddExecOpen(false)
                    await loadReplayData()
                  } else {
                    setExecFormError(res.error ?? 'Update failed')
                  }
                } else {
                  const body: Record<string, unknown> = {
                    account_id: execForm.account_id.trim(),
                    time: timeUnix,
                    symbol: sym,
                    sec_type: execForm.sec_type || 'STK',
                    side: (execForm.side || 'BUY').toUpperCase(),
                    quantity: q,
                    price: p,
                    source: 'manual',
                    expiry: execForm.expiry.trim() || undefined,
                    strike: execForm.strike ? Number(execForm.strike) : undefined,
                    option_right: execForm.option_right || undefined,
                    contract_key: contract_key || undefined,
                    commission: execForm.commission ? Number(execForm.commission) : undefined,
                    realized_pnl: execForm.realized_pnl ? Number(execForm.realized_pnl) : undefined,
                    currency: execForm.currency.trim() || undefined,
                  }
                  const res = await createExecution(body)
                  if (res.ok) {
                    setAddExecOpen(false)
                    await loadReplayData()
                  } else {
                    setExecFormError(res.error ?? 'Add failed')
                  }
                }
              }}
            >
              <div className="replay-exec-form-row">
                <label>Account</label>
                <select
                  value={execForm.account_id}
                  onChange={e => setExecForm(f => ({ ...f, account_id: e.target.value }))}
                  required
                >
                  {executionAccountOptions.map(accId => (
                    <option key={accId} value={accId}>
                      {accId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="replay-exec-form-row">
                <label>Time</label>
                <input type="datetime-local" value={execForm.time} onChange={e => setExecForm(f => ({ ...f, time: e.target.value }))} required />
              </div>
              <div className="replay-exec-form-row">
                <label>Symbol</label>
                <input type="text" value={execForm.symbol} onChange={e => setExecForm(f => ({ ...f, symbol: e.target.value.trim().toUpperCase() }))} placeholder="e.g. NVDA" required />
              </div>
              <div className="replay-exec-form-row">
                <label>Type</label>
                <div className="replay-exec-type-radios">
                  <label>
                    <input
                      type="radio"
                      name="exec-sec-type"
                      value="STK"
                      checked={(execForm.sec_type || 'STK').toUpperCase() === 'STK'}
                      onChange={e => setExecForm(f => ({ ...f, sec_type: e.target.value }))}
                    />
                    STK
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="exec-sec-type"
                      value="OPT"
                      checked={(execForm.sec_type || 'STK').toUpperCase() === 'OPT'}
                      onChange={e => setExecForm(f => ({ ...f, sec_type: e.target.value }))}
                    />
                    OPT
                  </label>
                </div>
              </div>
              <div className="replay-exec-form-row">
                <label>Side</label>
                <select value={execForm.side} onChange={e => setExecForm(f => ({ ...f, side: e.target.value }))}>
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </div>
              <div className="replay-exec-form-row">
                <label>Quantity</label>
                <input type="number" step="any" value={execForm.quantity} onChange={e => setExecForm(f => ({ ...f, quantity: e.target.value }))} required />
              </div>
              <div className="replay-exec-form-row">
                <label>Price</label>
                <input type="number" step="any" value={execForm.price} onChange={e => setExecForm(f => ({ ...f, price: e.target.value }))} required />
              </div>
              {(execForm.sec_type || 'STK').toUpperCase() === 'OPT' && (
                <>
                  <div className="replay-exec-form-row">
                    <label>Expiry (YYYYMMDD)</label>
                    <input type="text" value={execForm.expiry} onChange={e => setExecForm(f => ({ ...f, expiry: e.target.value }))} placeholder="20251219" />
                  </div>
                  <div className="replay-exec-form-row">
                    <label>STRIKE</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={execForm.strike}
                      onChange={e => setExecForm(f => ({ ...f, strike: e.target.value }))}
                      required
                      placeholder="Required, > 0"
                    />
                  </div>
                  <div className="replay-exec-form-row">
                    <label>Right</label>
                    <div className="replay-exec-type-radios">
                      <label>
                        <input
                          type="radio"
                          name="exec-option-right"
                          value="C"
                          checked={(execForm.option_right || 'C').toUpperCase() === 'C'}
                          onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))}
                        />
                        Call
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="exec-option-right"
                          value="P"
                          checked={(execForm.option_right || 'C').toUpperCase() === 'P'}
                          onChange={e => setExecForm(f => ({ ...f, option_right: e.target.value }))}
                        />
                        Put
                      </label>
                    </div>
                  </div>
                </>
              )}
              <div className="replay-exec-form-row">
                <label>Commission</label>
                <input type="number" step="any" value={execForm.commission} onChange={e => setExecForm(f => ({ ...f, commission: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="replay-exec-form-row">
                <label>Realized PnL</label>
                <input type="number" step="any" value={execForm.realized_pnl} onChange={e => setExecForm(f => ({ ...f, realized_pnl: e.target.value }))} placeholder="Optional" />
              </div>
              <div className="replay-exec-form-row">
                <label>Currency</label>
                <input type="text" value={execForm.currency} onChange={e => setExecForm(f => ({ ...f, currency: e.target.value }))} placeholder="USD" />
              </div>
              <div className="replay-exec-form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => { setAddExecOpen(false); setEditExec(null); setExecFormError(null); }}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editExec ? 'Save' : 'Add'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {closeAgainstExec && (
        <div
          className="modal-overlay"
          onClick={() => { setCloseAgainstExec(null); setExecFormError(null) }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-trade-modal-title"
        >
          <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
            <h3 id="close-trade-modal-title">Quick Trade (Close) — Pool=Off only</h3>
            {execFormError && <p className="section-hint replay-form-error">{execFormError}</p>}
            <form
              className="replay-exec-form"
              onSubmit={async e => {
                e.preventDefault()
                setExecFormError(null)
                const ex = closeAgainstExec
                const sideUpper = (ex.side ?? '').toUpperCase()
                const isBuy = sideUpper === 'BUY' || sideUpper === 'BOT' || sideUpper === 'B'
                const closeSide = isBuy ? 'SELL' : 'BUY'
                const timeUnix = datetimeLocalToUnix(closeForm.time)
                const q = Number(ex.quantity)
                const contract_key = ex.contract_key ?? undefined
                const body: Record<string, unknown> = {
                  account_id: (ex.account_id ?? '').trim(),
                  time: timeUnix,
                  symbol: (ex.symbol ?? '').trim(),
                  sec_type: (ex.sec_type ?? 'OPT').toUpperCase(),
                  side: closeSide,
                  quantity: Number.isFinite(q) ? q : 0,
                  price: closeForm.price.trim() !== '' && Number.isFinite(Number(closeForm.price)) ? Number(closeForm.price) : 0,
                  source: 'manual',
                  expiry: (ex.expiry ?? '').trim() || undefined,
                  strike: ex.strike,
                  option_right: (ex.option_right ?? 'C').toUpperCase().slice(0, 1),
                  contract_key,
                  commission: closeForm.commission.trim() !== '' && Number.isFinite(Number(closeForm.commission)) ? Number(closeForm.commission) : undefined,
                  currency: 'USD',
                }
                const res = await createExecution(body)
                if (res.ok) {
                  setCloseAgainstExec(null)
                  await loadReplayData()
                } else {
                  setExecFormError(res.error ?? 'Close trade failed')
                }
              }}
            >
              <div className="replay-exec-form-row">
                <label>Account</label>
                <input type="text" value={closeAgainstExec.account_id ?? ''} readOnly className="replay-exec-readonly" />
              </div>
              <div className="replay-exec-form-row">
                <label>Symbol</label>
                <input type="text" value={closeAgainstExec.symbol ?? ''} readOnly className="replay-exec-readonly" />
              </div>
              <div className="replay-exec-form-row">
                <label>Quantity</label>
                <input type="text" value={closeAgainstExec.quantity ?? ''} readOnly className="replay-exec-readonly" />
              </div>
              <div className="replay-exec-form-row">
                <label>Expiry</label>
                <input type="text" value={closeAgainstExec.expiry ?? ''} readOnly className="replay-exec-readonly" />
              </div>
              <div className="replay-exec-form-row">
                <label>Strike</label>
                <input type="text" value={closeAgainstExec.strike ?? ''} readOnly className="replay-exec-readonly" />
              </div>
              <div className="replay-exec-form-row">
                <label>Side (close)</label>
                <input
                  type="text"
                  value={((closeAgainstExec.side ?? '').toUpperCase().startsWith('B') ? 'Sell' : 'Buy')}
                  readOnly
                  className="replay-exec-readonly"
                />
              </div>
              <div className="replay-exec-form-row">
                <label>Time</label>
                <input
                  type="datetime-local"
                  value={closeForm.time}
                  onChange={e => setCloseForm(f => ({ ...f, time: e.target.value }))}
                  required
                />
              </div>
              <div className="replay-exec-form-row">
                <label>Price (optional)</label>
                <input
                  type="number"
                  step="any"
                  value={closeForm.price}
                  onChange={e => setCloseForm(f => ({ ...f, price: e.target.value }))}
                  placeholder="Leave empty for 0"
                />
              </div>
              <div className="replay-exec-form-row">
                <label>Commission (optional)</label>
                <input
                  type="number"
                  step="any"
                  value={closeForm.commission}
                  onChange={e => setCloseForm(f => ({ ...f, commission: e.target.value }))}
                  placeholder="Leave empty"
                />
              </div>
              <div className="replay-exec-form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => { setCloseAgainstExec(null); setExecFormError(null) }}>Cancel</button>
                <button type="submit" className="btn btn-primary">Add Close Trade</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

