import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Execution,
  IbPositionRow,
  OptExecutionGroup,
  StatusResponse,
} from '../types'
import {
  createExecution,
  deleteExecution,
  fetchExecutions,
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

export type PortfolioView = 'overview' | 'open' | 'ledger' | 'performance' | 'accounts' | 'transfer'

interface PositionsPageProps {
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

function isOptionExpired(expiryRaw: string | undefined | null): boolean {
  if (!expiryRaw) return false
  const s = String(expiryRaw).trim().replace(/-/g, '')
  if (s.length !== 6 && s.length !== 8) return false
  const year = Number(s.slice(0, 4))
  const month = Number(s.slice(4, 6))
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return false
  let day = 1
  if (s.length === 8) {
    day = Number(s.slice(6, 8))
    if (!Number.isFinite(day) || day < 1 || day > 31) return false
  } else {
    // yyyyMM: approximate as last day of that month (sufficient to detect "already expired" vs "not yet")
    const lastDay = new Date(year, month, 0).getDate()
    day = lastDay
  }
  const expDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59))
  const now = new Date()
  return now.getTime() > expDate.getTime()
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
    let contract_key = first.contract_key ?? ''
    if (!contract_key && (first.sec_type ?? '').toUpperCase() === 'OPT') {
      const sym = (first.symbol ?? '').trim()
      const exp = String(first.expiry ?? '').trim().replace(/-/g, '')
      const str = first.strike != null ? String(first.strike) : ''
      const right = ((first.option_right ?? 'C') + '').toUpperCase().slice(0, 1)
      contract_key = `${sym}|OPT|${exp}|${str}|${right}`
    }
    const strike = Number(first.strike) ?? 0
    const expiry = first.expiry ?? ''
    let buy_qty = 0
    let sell_qty = 0
    let buy_value = 0
    let sell_value = 0
    let buy_value_raw = 0
    let sell_value_raw = 0
    let net_qty = 0
    for (const t of trades) {
      const rawQty = Number(t.quantity) || 0
      const q = Math.abs(rawQty)
      const p = Number(t.price) || 0
      const c = Number(t.commission) || 0
      const side = (t.side ?? '').toUpperCase()
      if (side === 'BUY' || side === 'BOT' || side === 'B') {
        buy_qty += q
        buy_value += p * q * 100 + c
        buy_value_raw += p * q
        net_qty += q
      } else if (side === 'SELL' || side === 'SLD' || side === 'S') {
        sell_qty += q
        sell_value += p * q * 100 - c
        sell_value_raw += p * q
        net_qty -= q
      }
    }
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

export function PositionsPage({
  status,
  currentView,
  onViewChange,
  showViewTabs = true,
}: PositionsPageProps) {
  const [executions, setExecutions] = useState<Execution[]>([])
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
  const [expiredCloseKey, setExpiredCloseKey] = useState<string | null>(null)
  const [expiredCloseForm, setExpiredCloseForm] = useState({ quantity: '', price: '', commission: '' })
  const [expiredCloseError, setExpiredCloseError] = useState<string | null>(null)
  const [expiredCloseSubmitting, setExpiredCloseSubmitting] = useState(false)
  const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

  const [openFilterSymbol, setOpenFilterSymbol] = useState('')
  const [openFilterExpiryStart, setOpenFilterExpiryStart] = useState('')
  const [openFilterPool, setOpenFilterPool] = useState<'Mix' | 'ON' | 'Off'>('Mix')
  const [openFilterAccountId, setOpenFilterAccountId] = useState<string>('all')
  const [ledgerFilterSymbol, setLedgerFilterSymbol] = useState('')
  const [ledgerFilterExpiryStart, setLedgerFilterExpiryStart] = useState('')
  const [ledgerFilterAccount, setLedgerFilterAccount] = useState<string>('')
  const [internalPortfolioView, setInternalPortfolioView] = useState<PortfolioView>('open')
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
  /** Trade History Stocks: group rows by (account_id, symbol) and show category under each position */
  const [ledgerStockGroupByPosition, setLedgerStockGroupByPosition] = useState<boolean>(false)
  /** Trade History Stocks: filter by position category tab (All | category name | Uncategorized) */
  const [ledgerStockCategoryTab, setLedgerStockCategoryTab] = useState<string>('All')
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

  const openOffTrackBaseExecutions = useMemo(() => {
    let list = [...(executions || [])]
    list = list.filter(e => (e.account_id ?? '').trim() === OFF_TRACK_ACCOUNT_ID)
    const sym = openFilterSymbol.trim().toUpperCase()
    if (sym) list = list.filter(e => (e.symbol || '').toUpperCase() === sym)
    const expMonth = openFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      list = list.filter(e => {
        const ex = (e.expiry || '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }
    return list
  }, [executions, openFilterSymbol, openFilterExpiryStart])

  const livePositions = useMemo((): LivePositionRow[] => {
    if (openFilterPool === 'Off') return []
    const accounts = status?.accounts ?? []
    let rows = accounts.flatMap(account => {
      const accId = (account.account_id ?? '').trim()
      if (openFilterAccountId !== 'all' && accId !== openFilterAccountId) return []
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

    const expMonth = openFilterExpiryStart.trim().replace(/-/g, '').slice(0, 6)
    if (expMonth) {
      rows = rows.filter(position => {
        const secType = (position.secType ?? '').toUpperCase()
        if (secType !== 'OPT') return true
        const ex = (position.lastTradeDateOrContractMonth ?? position.expiry ?? '').trim().replace(/-/g, '')
        const cmp = ex.length >= 6 ? ex.slice(0, 6) : ex
        return cmp === expMonth
      })
    }

    rows.sort((a, b) => {
      const aSym = (a.symbol ?? '').toUpperCase()
      const bSym = (b.symbol ?? '').toUpperCase()
      if (aSym !== bSym) return aSym.localeCompare(bSym)
      return (a.account_id ?? '').localeCompare(b.account_id ?? '')
    })
    return rows
  }, [openFilterAccountId, openFilterExpiryStart, openFilterPool, openFilterSymbol, status?.accounts])

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

  const openFilterAccountOptions = useMemo(() => {
    const accounts = (status?.accounts ?? []).map(a => (a.account_id ?? '').trim()).filter(Boolean)
    const unique = Array.from(new Set(accounts))
    unique.sort()
    return unique
  }, [status?.accounts])

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

  /** (account_id, contract_key) -> category name for STK positions (Trade History Stocks category column and group headers) */
  const positionCategoryByAccountContract = useMemo(() => {
    const map = new Map<string, string>()
    const accounts = status?.accounts ?? []
    for (const acc of accounts) {
      const accountId = (acc.account_id ?? '').trim()
      const positions = (acc as { positions?: { account_id?: string; contract_key?: string; category?: string }[] }).positions ?? []
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
  }, [status?.accounts])

  /** STK contract_key for lookup: symbol|STK||| */
  const stkContractKey = useCallback((sym: string, accId: string) =>
    `${(accId ?? '').trim()}|${(sym ?? '').toString().trim().toUpperCase()}|STK|||`, [])

  /** Category label for a stock execution (from position tag); '—' when no category */
  const getStockExecCategory = useCallback((ex: Execution) =>
    positionCategoryByAccountContract.get(stkContractKey(ex.symbol ?? '', ex.account_id ?? '')) ?? '—',
  [positionCategoryByAccountContract, stkContractKey])

  /** Trade History Stocks: unique category tabs from current stock executions (All + categories + Uncategorized) */
  const ledgerStockCategoryTabs = useMemo(() => {
    const stockExecs = (executions ?? []).filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
    const set = new Set<string>()
    for (const ex of stockExecs) {
      const cat = positionCategoryByAccountContract.get(stkContractKey(ex.symbol ?? '', ex.account_id ?? ''))
      if (typeof cat === 'string' && cat.trim()) set.add(cat.trim())
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b))
    return ['All', ...list, 'Uncategorized']
  }, [executions, positionCategoryByAccountContract, stkContractKey])

  useEffect(() => {
    if (ledgerTab !== 'stocks') return
    if (!ledgerStockCategoryTabs.includes(ledgerStockCategoryTab)) setLedgerStockCategoryTab('All')
  }, [ledgerTab, ledgerStockCategoryTab, ledgerStockCategoryTabs])

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
        quantity: editExec.quantity != null ? String(Math.abs(Number(editExec.quantity))) : '',
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
  const expiredUnrealizedOptionGroups = useMemo(
    () => optExecutionGroups.filter(group => group.status === 'unrealized' && isOptionExpired(group.expiry)),
    [optExecutionGroups],
  )
  const expiredCloseGroup = expiredCloseKey
    ? expiredUnrealizedOptionGroups.find(g => getOptGroupKey(g) === expiredCloseKey) ?? null
    : null
  const expiredCloseBaseExec = expiredCloseGroup
    ? (expiredCloseGroup.trades ?? []).find(ex => (ex.account_id ?? '').trim()) || (expiredCloseGroup.trades ?? [])[0]
    : null
  const expiredCloseSide: 'BUY' | 'SELL' | null = expiredCloseGroup
    ? (Number(expiredCloseGroup.net_qty) || 0) > 0
      ? 'SELL'
      : (Number(expiredCloseGroup.net_qty) || 0) < 0
        ? 'BUY'
        : null
    : null
  const closedOptGroupsPnlSum = useMemo(() => {
    return closedOptionGroups.reduce((acc, g) => acc + (Number(g.realized_pnl) || 0), 0)
  }, [closedOptionGroups])

  /** Options: by-month summary (month YYYY-MM -> { count, realizedPnl }) for Summary section */
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

  /** Stocks: by-month summary (month YYYY-MM -> { count, notional }) for Summary section; respects category tab filter */
  const ledgerStocksSummaryByMonth = useMemo(() => {
    let stockExecs = filteredExecutions.filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
    if (ledgerStockCategoryTab !== 'All') {
      stockExecs = ledgerStockCategoryTab === 'Uncategorized'
        ? stockExecs.filter(ex => getStockExecCategory(ex) === '—')
        : stockExecs.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
    }
    const byMonth = new Map<string, { count: number; notional: number }>()
    for (const ex of stockExecs) {
      const ts = ex.time ?? 0
      const monthStr = ts ? new Date(ts * 1000).toISOString().slice(0, 7) : ''
      if (!monthStr) continue
      const cur = byMonth.get(monthStr) ?? { count: 0, notional: 0 }
      cur.count += 1
      const q = Number(ex.quantity) || 0
      const p = Number(ex.price) || 0
      cur.notional += Math.abs(q) * p
      byMonth.set(monthStr, cur)
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [filteredExecutions, ledgerStockCategoryTab, getStockExecCategory])

  const hasOptionExecutions = closedOptionGroups.length > 0 || expiredUnrealizedOptionGroups.length > 0
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
    try {
      const execRes = await fetchExecutions(undefined, undefined, 0)
      setExecutions(execRes.executions || [])
    } catch {
      setExecutions([])
    }
  }, [])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  return (
    <div className="card process-section replay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h2 className="page-title-with-tooltip" style={{ margin: 0 }}>
          {portfolioView === 'overview' && (
            <>Portfolio<InfoTooltip text="Separate current open positions from closed trade history, while keeping PnL and execution tools in one portfolio workspace." /></>
          )}
          {portfolioView === 'open' && (
            <>
              <button
                type="button"
                className="page-title-breadcrumb-link"
                onClick={() => onViewChange?.('accounts')}
              >
                Portfolio
              </button>
              {' / Positions'}
            </>
          )}
          {portfolioView === 'ledger' && (
            <>
              <button
                type="button"
                className="page-title-breadcrumb-link"
                onClick={() => onViewChange?.('accounts')}
              >
                Portfolio
              </button>
              {' / Trade History'}
              <InfoTooltip text="Trade History is the maintenance workspace for closed trades, execution imports, and manual trade corrections." />
            </>
          )}
        </h2>
        {portfolioView === 'open' && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { setAddExecOpen(true); setExecFormError(null) }}
            aria-label="Add execution record manually (historical)"
          >
            Add Trade
          </button>
        )}
      </div>
      {showViewTabs && (
      <div className="system-tabs replay-portfolio-view-tabs" role="tablist" aria-label="Portfolio view">
        <button
          type="button"
          role="tab"
          aria-selected={portfolioView === 'open'}
          className={`system-tab ${portfolioView === 'open' ? 'active' : ''}`}
          onClick={() => setPortfolioViewSelected('open')}
        >
          Positions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={portfolioView === 'ledger'}
          className={`system-tab ${portfolioView === 'ledger' ? 'active' : ''}`}
          onClick={() => setPortfolioViewSelected('ledger')}
        >
          Trade History
        </button>
      </div>
      )}
      {portfolioView === 'overview' && (
        <>
          <p className="section-hint replay-portfolio-view-hint">
            Portfolio summary, risk model and Fetch from IB are now under Portfolio / Accounts.
          </p>
          <p className="section-hint" style={{ marginTop: '0.25rem' }}>
            Go to <strong>Portfolio / Accounts</strong> for portfolio overview, risk model and Fetch from IB.
          </p>
        </>
      )}

      {portfolioView === 'open' ? (
        <section className="replay-section replay-section-trade-records" aria-label="Open positions">
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" aria-label="Position filters">
              <input
                type="text"
                placeholder="Symbol"
                value={openFilterSymbol}
                onChange={e => setOpenFilterSymbol(e.target.value)}
                className="replay-filter-input replay-filter-input-symbol"
              />
            </div>
            <div className="ib-accounts-tabs">
              <button
                type="button"
                className={`ib-accounts-tab ${openFilterAccountId === 'all' ? 'active' : ''}`}
                onClick={() => setOpenFilterAccountId('all')}
              >
                All
              </button>
              {openFilterAccountOptions.map(id => (
                <button
                  key={id}
                  type="button"
                  className={`ib-accounts-tab ${openFilterAccountId === id ? 'active' : ''}`}
                  onClick={() => setOpenFilterAccountId(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            <div className="replay-fetch-range-group replay-pool-group" role="radiogroup" aria-label="Account filter">
              <span className="replay-fetch-days-label">Account</span>
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
                          <th rowSpan={2}>Account</th>
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
                                  const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                  return p.symbol ? (
                                    <>
                                      <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
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
                              <td>
                                {(() => {
                                  if (group.kind === 'live') {
                                    const accounts = Array.from(
                                      new Set(
                                        (group.positions ?? []).map(p => (p.account_id ?? '').trim()).filter(Boolean),
                                      ),
                                    )
                                    if (accounts.length === 0) return '—'
                                    if (accounts.length === 1) return accounts[0]
                                    return 'Multi'
                                  }
                                  if (group.kind === 'offtrack') {
                                    const accounts = Array.from(
                                      new Set(
                                        (group.trades ?? []).map(t => (t.account_id ?? '').trim()).filter(Boolean),
                                      ),
                                    )
                                    if (accounts.length === 0) return '—'
                                    if (accounts.length === 1) return accounts[0]
                                    return 'Multi'
                                  }
                                  return '—'
                                })()}
                              </td>
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
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {expandedOpenDetailKeys.length > 0 && (
                    <>
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
                            <th>Comm.</th>
                            <th>PnL</th>
                            <th>Account</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {openOptionGroups
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
                                          const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                          return p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
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
                                      <td>{position.account_id ?? '—'}</td>
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
                                          const strikeStr = group.strike != null ? ` ${group.strike}` : ''
                                          return p_.symbol ? (
                                            <>
                                              <strong>{p_.symbol}</strong> {p_.rightLabel}{strikeStr}
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
                                      <td>{ex.account_id ?? '—'}</td>
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
                            )}
                        </tbody>
                      </table>
                    </>
                  )}
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
                          {(() => {
                            const byAccount: Record<string, typeof liveStockPositions> = {}
                            for (const position of liveStockPositions) {
                              const accId = (position.account_id ?? '').trim() || '—'
                              if (!byAccount[accId]) byAccount[accId] = []
                              byAccount[accId].push(position)
                            }
                            const accountIds = Object.keys(byAccount).sort()
                            const rows: JSX.Element[] = []
                            for (const accId of accountIds) {
                              rows.push(
                                <tr key={`open-stk-header-${accId}`} className="replay-portfolio-group-header">
                                  <td colSpan={7}>
                                    <strong>{accId}</strong>
                                  </td>
                                </tr>,
                              )
                              for (const position of byAccount[accId]) {
                                const qty = Number(position.position)
                                const pnl = position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
                                  ? Number(position.unrealized_pnl)
                                  : null
                                const pnlClass = pnl == null ? '' : 'replay-pnl-unrealized'
                                rows.push(
                                  <tr key={`open-stk-${accId}-${position.symbol ?? ''}-${position.contract_key ?? ''}`}>
                                    <td>{accId}</td>
                                    <td><strong>{position.symbol ?? '—'}</strong></td>
                                    <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
                                    <td>{Number.isFinite(qty) ? qty : '—'}</td>
                                    <td>{fmtUsd(position.avgCost)}</td>
                                    <td>{fmtUsd(position.price)}</td>
                                    <td><span className={pnlClass}>{fmtUsd(pnl ?? 0)}</span></td>
                                  </tr>,
                                )
                              }
                            }
                            return rows
                          })()}
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
          <section className="replay-section replay-section-trade-records" aria-label="Trade History">
            <div className="replay-filters replay-filters--bar">
              <label className="replay-filter-wrap-symbol">
                <input
                  type="text"
                  placeholder="e.g. NV → NVDA"
                  value={ledgerFilterSymbol}
                  onChange={e => setLedgerFilterSymbol(e.target.value)}
                  className="replay-filter-input replay-filter-input--symbol"
                  aria-label="Symbol filter"
                />
              </label>
              <label className="replay-filter-label-month">
                <span className="replay-filter-label">Exp</span>
                <input
                  type="month"
                  value={ledgerFilterExpiryStart}
                  onChange={e => setLedgerFilterExpiryStart(e.target.value)}
                  className="replay-filter-input replay-filter-date"
                  title="Expiry month"
                />
              </label>
              <div className="ib-accounts-tabs" role="group" aria-label="Account filter">
                <button
                  type="button"
                  className={`ib-accounts-tab ${!ledgerFilterAccount || ledgerFilterAccount === 'All' ? 'active' : ''}`}
                  onClick={() => setLedgerFilterAccount('')}
                >
                  All
                </button>
                {executionAccountOptions.map(accId => (
                  <button
                    key={accId}
                    type="button"
                    className={`ib-accounts-tab ${ledgerFilterAccount === accId ? 'active' : ''}`}
                    onClick={() => setLedgerFilterAccount(accId)}
                  >
                    {accId}
                  </button>
                ))}
              </div>
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
                </div>
                <div className="replay-portfolio-filters">
                  {ledgerTab === 'options' && (
                    <div className="replay-fetch-range-group" role="radiogroup" aria-label="Detail view mode">
                      <span className="replay-fetch-days-label">Detail view</span>
                      <InfoTooltip text="Completed option trades are grouped by contract and strike so the page reads like a closed-trade ledger." />
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
                  {ledgerTab === 'stocks' && (
                    <>
                      <div className="system-tabs replay-stock-group-tabs" role="tablist" aria-label="Stock view mode">
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
                      <div className="system-tabs replay-stock-category-tabs" role="tablist" aria-label="Position category filter">
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
              {filteredExecutions.length === 0 ? (
                <p className="section-hint">No execution data. Use Overview to fetch from IB (Refresh), or Positions to add manual history (Add Trade).{([ledgerFilterSymbol, ledgerFilterExpiryStart].some(Boolean) || (ledgerFilterAccount && ledgerFilterAccount !== 'All')) ? ' Filters applied.' : ''}</p>
              ) : (
                <>
                  <section className="replay-ledger-summary" aria-label="Summary by month">
                    {ledgerTab === 'options' ? (
                      <>
                        <span className="replay-ledger-summary-label">Summary</span>
                        <span className="replay-ledger-summary-inline">
                          {ledgerOptionsSummaryByMonth.map(([month, { count, realizedPnl }], i) => (
                            <span key={month}>
                              {i > 0 && <span className="replay-ledger-summary-sep"> | </span>}
                              <span className="replay-ledger-summary-item">
                                {month}: {count} groups, <span className={realizedPnl >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>{fmtUsd0(realizedPnl)}</span>
                              </span>
                            </span>
                          ))}
                          {ledgerOptionsSummaryByMonth.length > 0 && <span className="replay-ledger-summary-sep"> | </span>}
                          <span className="replay-ledger-summary-total">
                            Total: {ledgerOptionsSummaryByMonth.reduce((s, [, d]) => s + d.count, 0)} groups,{' '}
                            <span className={closedOptGroupsPnlSum >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'}>
                              {fmtUsd0(closedOptGroupsPnlSum)}
                            </span>
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="replay-ledger-summary-label">Summary</span>
                        <span className="replay-ledger-summary-inline">
                          {ledgerStocksSummaryByMonth.map(([month, { count, notional }], i) => (
                            <span key={month}>
                              {i > 0 && <span className="replay-ledger-summary-sep"> | </span>}
                              <span className="replay-ledger-summary-item">
                                {month}: {count} trades, {fmtUsd0(notional)}
                              </span>
                            </span>
                          ))}
                          {ledgerStocksSummaryByMonth.length > 0 && <span className="replay-ledger-summary-sep"> | </span>}
                          <span className="replay-ledger-summary-total">
                            Total: {ledgerStocksSummaryByMonth.reduce((s, [, d]) => s + d.count, 0)} trades,{' '}
                            {fmtUsd0(ledgerStocksSummaryByMonth.reduce((s, [, d]) => s + d.notional, 0))}
                          </span>
                        </span>
                      </>
                    )}
                  </section>
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
                                  <th rowSpan={2}>Account</th>
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
                                  const uniqueAccounts = Array.from(
                                    new Set(
                                      (g.trades ?? []).map(t => (t.account_id ?? '').trim()).filter(Boolean),
                                    ),
                                  )
                                  const accountLabel = uniqueAccounts.length === 0 ? '—' : uniqueAccounts.length === 1 ? uniqueAccounts[0] : 'Mix'
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
                                          const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                                          return p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
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
                                      <td>{accountLabel}</td>
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
                                </tr>
                              </tfoot>
                            </table>
                          </div>

                          {expiredUnrealizedOptionGroups.length > 0 && (
                          <div className="replay-portfolio-table-wrap replay-portfolio-table-wrap--no-scroll">
                              <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
                                Expired but not closed
                                <InfoTooltip text="These option contracts have expired but net quantity is not zero. This usually means some executions are missing in Trade History; please add the missing trades to close the position." />
                              </h5>
                              <table className="table-operations replay-opt-groups">
                                <thead>
                                  <tr>
                                    <th>Contract</th>
                                    <th>Account</th>
                                    <th>Expiry</th>
                                    <th>STRIKE</th>
                                    <th>Net qty</th>
                                    <th>Trades (side / qty / price / id)</th>
                                    <th>Source</th>
                                    <th>Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {expiredUnrealizedOptionGroups.map((g) => {
                                    const p = getContractLabelParts(g.contract_key)
                                    const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                                    const tradesSummary = (g.trades ?? []).map((ex) => {
                                      const s = (ex.side ?? '').toUpperCase()
                                      const sideLabel =
                                        s === 'BUY' || s === 'BOT' || s === 'B'
                                          ? 'Buy'
                                          : s === 'SELL' || s === 'SLD' || s === 'S'
                                            ? 'Sell'
                                            : (ex.side ?? '—')
                                      const q = ex.quantity != null ? Number(ex.quantity) : NaN
                                      const p_ = ex.price != null ? Number(ex.price) : NaN
                                      const idLabel = ex.id != null ? `#${ex.id}` : 'id?'
                                      const parts: string[] = []
                                      parts.push(sideLabel)
                                      if (Number.isFinite(q)) parts.push(String(q))
                                      if (Number.isFinite(p_)) parts.push(`@${p_}`)
                                      parts.push(`(${idLabel})`)
                                      return parts.join(' ')
                                    }).join('; ')
                                    const uniqueSources = Array.from(
                                      new Set(
                                        (g.trades ?? [])
                                          .map(ex => (ex.source ?? '').trim())
                                          .filter(src => src.length > 0),
                                      ),
                                    )
                                    const groupKey = getOptGroupKey(g)
                                    const uniqueAccounts = Array.from(
                                      new Set(
                                        (g.trades ?? [])
                                          .map(ex => (ex.account_id ?? '').trim())
                                          .filter(acc => acc.length > 0),
                                      ),
                                    )
                                    return (
                                      <tr key={`expired-${groupKey}`}>
                                        <td>
                                          {p.symbol ? (
                                            <>
                                              <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                                            </>
                                          ) : (
                                            g.contract_key
                                          )}
                                        </td>
                                        <td>{uniqueAccounts.length > 0 ? uniqueAccounts.join(', ') : '—'}</td>
                                        <td>{fmtExpiry(g.expiry)}</td>
                                        <td><strong>{fmtUsd(g.strike)}</strong></td>
                                        <td>{g.net_qty}</td>
                                        <td>{tradesSummary || '—'}</td>
                                        <td>{uniqueSources.length > 0 ? uniqueSources.join(', ') : '—'}</td>
                                        <td>
                                          <button
                                            type="button"
                                            className="btn btn-small"
                                            onClick={() => {
                                              const defaultQty = Math.abs(Number(g.net_qty) || 0)
                                              setExpiredCloseKey(groupKey)
                                              setExpiredCloseError(null)
                                              setExpiredCloseForm({
                                                quantity: defaultQty > 0 ? String(defaultQty) : '',
                                                price: '',
                                                commission: '',
                                              })
                                            }}
                                          >
                                            Close
                                          </button>
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}

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
                                <th>Comm.</th>
                                <th>PnL</th>
                                <th>Account</th>
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
                                              const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                                              return p_.symbol ? (
                                                <>
                                                  <strong>{p_.symbol}</strong> {p_.rightLabel}{strikeStr}
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
                                          <td>{ex.account_id ?? '—'}</td>
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
                                let stockExecs = filteredExecutions.filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
                                if (ledgerStockCategoryTab !== 'All') {
                                  stockExecs = ledgerStockCategoryTab === 'Uncategorized'
                                    ? stockExecs.filter(ex => getStockExecCategory(ex) === '—')
                                    : stockExecs.filter(ex => getStockExecCategory(ex) === ledgerStockCategoryTab)
                                }
                                if (!ledgerStockGroupByPosition) {
                                  return stockExecs.map((ex, i) => {
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
                                        <td>{ex.account_id ?? '—'}</td>
                                        <td>{getStockExecCategory(ex)}</td>
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
                                  })
                                }
                                const groups = new Map<string, Execution[]>()
                                for (const ex of stockExecs) {
                                  const acc = (ex.account_id ?? '').trim()
                                  const sym = (ex.symbol ?? '').toString().trim().toUpperCase()
                                  const key = `${acc}|${sym}`
                                  if (!groups.has(key)) groups.set(key, [])
                                  groups.get(key)!.push(ex)
                                }
                                const groupEntries = Array.from(groups.entries()).sort(([a], [b]) => {
                                  const [accA, symA] = a.split('|')
                                  const [accB, symB] = b.split('|')
                                  if (symA !== symB) return (symA || '').localeCompare(symB || '')
                                  return (accA || '').localeCompare(accB || '')
                                })
                                const rows: JSX.Element[] = []
                                let rowIdx = 0
                                for (const [groupKey, execs] of groupEntries) {
                                  const [accId, sym] = groupKey.split('|')
                                  const category = positionCategoryByAccountContract.get(stkContractKey(sym, accId)) ?? '—'
                                  rows.push(
                                    <tr key={`h-${groupKey}`} className="replay-stock-group-header">
                                      <td colSpan={10}>
                                        <span className="replay-stock-group-symbol">{sym || '—'}</span>
                                        <span className="replay-stock-group-account">{accId || '—'}</span>
                                        <span className="replay-stock-group-category">{category}</span>
                                      </td>
                                    </tr>,
                                  )
                                  for (const ex of execs) {
                                    const s = (ex.side ?? '').toUpperCase()
                                    const sideLabel =
                                      s === 'BUY' || s === 'BOT' || s === 'B'
                                        ? 'Buy'
                                        : s === 'SELL' || s === 'SLD' || s === 'S'
                                          ? 'Sell'
                                          : (ex.side ?? '—')
                                    rows.push(
                                      <tr key={rowIdx}>
                                        <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                                        <td>{ex.symbol ?? '—'}</td>
                                        <td>{ex.account_id ?? '—'}</td>
                                        <td>{getStockExecCategory(ex)}</td>
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
                const qRaw = Number(execForm.quantity)
                const q = Math.abs(qRaw)
                const p = Number(execForm.price)
                if (!sym || !Number.isFinite(q) || q <= 0 || !Number.isFinite(p)) {
                  setExecFormError('Fill symbol, quantity (> 0), and price.')
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
                const sideUpper = (execForm.side || 'BUY').toUpperCase()
                const quantityForDb = sideUpper === 'SELL' ? -q : q
                if (editExec?.id != null) {
                  const body: Record<string, unknown> = {
                    exec_time: timeUnix,
                    symbol: sym,
                    sec_type: execForm.sec_type || 'STK',
                    side: sideUpper,
                    quantity: quantityForDb,
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
                    side: sideUpper,
                    quantity: quantityForDb,
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
                <div className="replay-exec-type-radios">
                  <label>
                    <input
                      type="radio"
                      name="exec-side"
                      value="BUY"
                      checked={(execForm.side || 'BUY').toUpperCase() === 'BUY'}
                      onChange={e => setExecForm(f => ({ ...f, side: e.target.value }))}
                    />
                    Buy
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="exec-side"
                      value="SELL"
                      checked={(execForm.side || 'BUY').toUpperCase() === 'SELL'}
                      onChange={e => setExecForm(f => ({ ...f, side: e.target.value }))}
                    />
                    Sell
                  </label>
                </div>
              </div>
              <div className="replay-exec-form-row">
                <label>Quantity</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={execForm.quantity}
                  onChange={e => setExecForm(f => ({ ...f, quantity: e.target.value }))}
                  required
                />
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

      {expiredCloseGroup && (
        <div
          className="modal-overlay"
          onClick={() => {
            setExpiredCloseKey(null)
            setExpiredCloseError(null)
            setExpiredCloseForm({ quantity: '', price: '', commission: '' })
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="expired-close-modal-title"
        >
          <div className="modal-panel replay-exec-modal" onClick={e => e.stopPropagation()}>
            <h3 id="expired-close-modal-title">Close expired option</h3>
            {expiredCloseError && <p className="section-hint replay-form-error">{expiredCloseError}</p>}
            <p className="section-hint">
              This will add a closing trade with source = journal_closed for this expired option group.
            </p>
            <div className="replay-expired-close-summary">
              <div>
                <strong>Contract:</strong>{' '}
                {(() => {
                  const p = getContractLabelParts(expiredCloseGroup.contract_key)
                  const strikeStr = expiredCloseGroup.strike != null ? ` ${expiredCloseGroup.strike}` : ''
                  return p.symbol ? (
                    <>
                      <strong>{p.symbol}</strong> {p.rightLabel}{strikeStr}
                    </>
                  ) : (
                    expiredCloseGroup.contract_key
                  )
                })()}
              </div>
              <div>
                <strong>Expiry:</strong> {fmtExpiry(expiredCloseGroup.expiry)} &nbsp;|&nbsp; <strong>STRIKE:</strong>{' '}
                {fmtUsd(expiredCloseGroup.strike)} &nbsp;|&nbsp; <strong>Net qty:</strong> {expiredCloseGroup.net_qty}
              </div>
              <div>
                <strong>Side:</strong> {expiredCloseSide ?? '—'}
              </div>
            </div>
            <form
              className="replay-expired-close-form"
              onSubmit={async e => {
                e.preventDefault()
                setExpiredCloseError(null)
                if (!expiredCloseSide || !expiredCloseBaseExec || !expiredCloseGroup) {
                  setExpiredCloseError('Cannot determine side or base execution for this group.')
                  return
                }
                const qRaw = Number(expiredCloseForm.quantity)
                const q = Math.abs(qRaw)
                const priceNum = Number(expiredCloseForm.price)
                if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(priceNum)) {
                  setExpiredCloseError('Fill quantity (> 0) and price.')
                  return
                }
                const accountId = (expiredCloseBaseExec.account_id ?? '').trim()
                if (!accountId) {
                  setExpiredCloseError('Account is missing for this group; cannot create closing trade.')
                  return
                }
                const quantityForDb = expiredCloseSide === 'SELL' ? -q : q
                const nowUnix = Math.floor(Date.now() / 1000)
                const body: Record<string, unknown> = {
                  account_id: accountId,
                  time: nowUnix,
                  symbol: (expiredCloseBaseExec.symbol ?? '').trim() || getContractLabelParts(expiredCloseGroup.contract_key).symbol || undefined,
                  sec_type: (expiredCloseBaseExec.sec_type || 'OPT').toUpperCase(),
                  side: expiredCloseSide,
                  quantity: quantityForDb,
                  price: priceNum,
                  source: 'journal_closed',
                  expiry: expiredCloseGroup.expiry,
                  strike: expiredCloseGroup.strike,
                  option_right: expiredCloseBaseExec.option_right || undefined,
                  contract_key: expiredCloseGroup.contract_key,
                  commission: expiredCloseForm.commission ? Number(expiredCloseForm.commission) : undefined,
                  currency: expiredCloseBaseExec.currency || undefined,
                }
                try {
                  setExpiredCloseSubmitting(true)
                  const res = await createExecution(body)
                  if (res.ok) {
                    setExpiredCloseKey(null)
                    setExpiredCloseForm({ quantity: '', price: '', commission: '' })
                    await loadReplayData()
                  } else {
                    setExpiredCloseError(res.error ?? 'Add failed')
                  }
                } finally {
                  setExpiredCloseSubmitting(false)
                }
              }}
            >
              <div className="replay-expired-close-row">
                <label>
                  Qty
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={expiredCloseForm.quantity}
                    onChange={e => setExpiredCloseForm(f => ({ ...f, quantity: e.target.value }))}
                    required
                  />
                </label>
                <label>
                  Price
                  <input
                    type="number"
                    step="any"
                    value={expiredCloseForm.price}
                    onChange={e => setExpiredCloseForm(f => ({ ...f, price: e.target.value }))}
                    required
                  />
                </label>
                <label>
                  Commission
                  <input
                    type="number"
                    step="any"
                    value={expiredCloseForm.commission}
                    onChange={e => setExpiredCloseForm(f => ({ ...f, commission: e.target.value }))}
                  />
                </label>
              </div>
              <div className="replay-expired-close-actions">
                <button
                  type="submit"
                  className="btn btn-small btn-primary"
                  disabled={expiredCloseSubmitting}
                >
                  {expiredCloseSubmitting ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-secondary"
                  onClick={() => {
                    setExpiredCloseKey(null)
                    setExpiredCloseError(null)
                    setExpiredCloseForm({ quantity: '', price: '', commission: '' })
                  }}
                >
                  Cancel
                </button>
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

