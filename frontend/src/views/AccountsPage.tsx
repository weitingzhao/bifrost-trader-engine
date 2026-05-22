import { useEffect, useMemo, useState } from 'react'
import type { ExecutionFreshnessItem, IbAccountSnapshot, IbPositionRow, RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchQuotes, fetchExecutionsFreshness, postExecutionsFetch, postExecutionsFetchFlex, postExecutionsFetchFlexUpload, subscribeQuotes } from '../api'
import { fetchPositionCategories, postPositionCategory, patchPositionCategory, deletePositionCategory, putPositionCategoryTag } from '../api'
import type { PositionCategory } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { fmtExpiry, fmtUsd, fmtUsdRound0 } from '../utils/format'
import {
  computeDailyChange,
  formatLastUpdate,
  getNetLiq,
  ibPositionMarketValue,
  mergeQuotesIntoSymbolMap,
  optionIntrinsic,
  resolvePreferredPrice,
  rightLabel,
  type DailyBenchmark,
} from './accounts/accountsUtils'
import { isLedgerCashLikeCategory, isLedgerFixedIncomeCategory } from './portfolio/ledgerStockCategoryBuckets'

/**
 * `<select>` value must match an `<option value>`. Prefer `category_id` when it matches a known
 * category; otherwise resolve from `category` name (same field used to group rows in the table)
 * so Host/Secondary tabs stay in sync with the stock table when ids are missing or JSON types differ.
 */
function positionCategorySelectValue(pos: IbPositionRow, categories: PositionCategory[]): string {
  const cats = categories ?? []
  const idRaw = pos.category_id
  if (idRaw != null) {
    const n = Number(idRaw)
    if (Number.isFinite(n) && cats.some((c) => Number(c.id) === n)) {
      return String(n)
    }
  }
  const name = String(pos.category ?? '').trim()
  if (name && name !== 'Uncategorized') {
    const hit = cats.find((c) => c.name.trim() === name)
    if (hit != null) return String(hit.id)
  }
  return ''
}

/** Tag icon for header Categories (stroke follows currentColor). */
function AccountsCategoriesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l6.59-6.59a1 1 0 0 0 0-1.41L12 2Z" />
      <path d="M7 7h.01" />
    </svg>
  )
}

/** Inline refresh icon for TWS / Flex import buttons (stroke follows currentColor). */
function ReplayRefreshIcon({ spinning, size = 14 }: { spinning?: boolean; size?: number }) {
  return (
    <svg
      className={spinning ? 'replay-fetch-refresh-svg replay-fetch-refresh-svg--spin' : 'replay-fetch-refresh-svg'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

export interface AccountsPageProps {
  status: StatusResponse | null
  accountsDisplay: IbAccountSnapshot[] | null
  ibAccountIndex: number
  setIbAccountIndex: (i: number) => void
  ibAccountsRefreshing: boolean
  onRefreshAccounts: () => Promise<void>
  /** Short feedback after refresh (success/fail/timeout); cleared by parent after a few seconds */
  refreshFeedback?: string | null
  /** Optional: navigate to Portfolio sub-view (e.g. back to Accounts); used for breadcrumb "Portfolio" link */
  onViewChange?: (view: 'accounts') => void
}

export function AccountsPage({
  status,
  accountsDisplay,
  ibAccountIndex,
  setIbAccountIndex,
  ibAccountsRefreshing,
  onRefreshAccounts,
  refreshFeedback,
  onViewChange,
}: AccountsPageProps) {
  const j = status
  const rawAccounts = (accountsDisplay ?? j?.portfolio?.accounts) as IbAccountSnapshot[] | undefined
  const hasAccounts = Array.isArray(rawAccounts) && rawAccounts.length > 0
  const fetchedAt = j?.portfolio?.accounts_fetched_at
  const accounts = hasAccounts ? [...rawAccounts!].sort((a, b) => getNetLiq(b) - getNetLiq(a)) : []
  const selectedIndex = accounts.length > 0 ? Math.min(ibAccountIndex, accounts.length - 1) : 0
  const acc = accounts[selectedIndex] ?? null
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  /** OPT rows: keyed by contract_key (stream + GET contract_quote_live). */
  const [optQuotesByCk, setOptQuotesByCk] = useState<Record<string, RealtimeQuote>>({})
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [replaySyncing, setReplaySyncing] = useState(false)
  const [flexSyncing, setFlexSyncing] = useState(false)
  const [flexMessage, setFlexMessage] = useState<string | null>(null)
  const [twsFetchMessage, setTwsFetchMessage] = useState<string | null>(null)
  const [twsFetchIsError, setTwsFetchIsError] = useState(false)
  const [flexUseUpload, setFlexUseUpload] = useState(false)
  const [execFreshness, setExecFreshness] = useState<ExecutionFreshnessItem[]>([])
  // Reserved for future Flex range preset UI (currently unused).
  // const [flexRangePreset, setFlexRangePreset] = useState<null | string>(null)
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  /** In Position categories modal: assign tags for Host vs Secondary (when Secondary is configured). */
  const [categoryAssignTab, setCategoryAssignTab] = useState<'host' | 'secondary'>('host')
  /** Portfolio by category ring (Accounts): same semantics as Positions Asset mix ledger buckets. */
  const [portfolioPieIncludeFi, setPortfolioPieIncludeFi] = useState(false)
  const [portfolioPieIncludeOpt, setPortfolioPieIncludeOpt] = useState(true)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null)
  const [editingCategoryName, setEditingCategoryName] = useState('')

  // Categories are DB-backed and independent of whether accounts are in the snapshot yet; do not gate on hasAccounts
  // (otherwise opening the modal before accounts load, or failed portfolio-only routing, leaves lists empty).
  useEffect(() => {
    let cancelled = false
    fetchPositionCategories()
      .then((r) => {
        if (!cancelled) setPositionCategories(r.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setPositionCategories([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** Settings → IB: Event account IDs (same as Model Analysis / Live streams). */
  const ibAccountCfg = j?.config?.ib_client?.account
  const hostAssignId = (ibAccountCfg?.event_host ?? ibAccountCfg?.trading ?? '').trim()
  const secondaryAssignId = (ibAccountCfg?.event_secondary ?? '').trim()
  const showCategoryAssignHostSecondaryTabs = Boolean(secondaryAssignId)

  const accountSnapshotById = useMemo(() => {
    const list = (rawAccounts ?? []) as IbAccountSnapshot[]
    const m = new Map<string, IbAccountSnapshot>()
    for (const a of list) {
      const id = (a.account_id ?? '').trim()
      if (id) m.set(id.toLowerCase(), a)
    }
    return m
  }, [rawAccounts])

  const hostAccForCategories = hostAssignId
    ? accountSnapshotById.get(hostAssignId.toLowerCase()) ?? null
    : null
  const secondaryAccForCategories = secondaryAssignId
    ? accountSnapshotById.get(secondaryAssignId.toLowerCase()) ?? null
    : null

  /** Snapshot used in "Assign category to positions" (modal); Host/Secondary tabs when Secondary ID is set. */
  const accForCategoryAssign = useMemo(() => {
    if (showCategoryAssignHostSecondaryTabs) {
      return categoryAssignTab === 'secondary' ? secondaryAccForCategories : hostAccForCategories
    }
    if (hostAssignId) return hostAccForCategories
    return acc ?? null
  }, [
    showCategoryAssignHostSecondaryTabs,
    categoryAssignTab,
    secondaryAccForCategories,
    hostAccForCategories,
    hostAssignId,
    acc,
  ])

  const overviewTotals = useMemo(() => {
    const list = rawAccounts ?? []
    const optKeys = new Set<string>()
    let stockLines = 0
    let unrealizedPnl = 0
    for (const account of list) {
      for (const position of account.positions ?? []) {
        const qty = Number(position.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        if ((position.secType ?? '').toUpperCase() === 'OPT') {
          const expiry = position.lastTradeDateOrContractMonth ?? position.expiry ?? ''
          const strike = Number(position.strike) || 0
          const right = (position.right ?? '').toUpperCase().slice(0, 1)
          optKeys.add(position.contract_key ?? `${position.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`)
        } else {
          stockLines += 1
        }
        unrealizedPnl += Number(position.unrealized_pnl) || 0
      }
    }
    return { optionContracts: optKeys.size, stockLines, unrealizedPnl }
  }, [rawAccounts])

  /** Aggregated totals across accounts from status (all rows returned by API). */
  const aggregatedTotals = useMemo(() => {
    let totalNetLiq = 0
    let totalCash = 0
    let totalBuyingPower = 0
    for (const a of accounts) {
      totalNetLiq += getNetLiq(a)
      const cash = a.summary?.TotalCashValue
      if (cash != null) {
        const n = parseFloat(String(cash))
        if (Number.isFinite(n)) totalCash += n
      }
      const bp = a.summary?.BuyingPower
      if (bp != null) {
        const n = parseFloat(String(bp))
        if (Number.isFinite(n)) totalBuyingPower += n
      }
    }
    return { totalNetLiq, totalCash, totalBuyingPower }
  }, [accounts])

  /**
   * Portfolio by category: Stocks (core STK incl. SEPA / Option Pool / Uncategorized), Fixed income,
   * Cash + Cash-like (IB cash + cash-like STK MV), Options. Ring styled like Positions Asset mix.
   */
  const portfolioCategoryPie = useMemo(() => {
    let coreStockMV = 0
    let fixedIncomeMV = 0
    let cashLikeMV = 0
    let optionsMV = 0
    for (const account of accounts) {
      for (const pos of account.positions ?? []) {
        const st = (pos.secType ?? '').toUpperCase()
        const mv = ibPositionMarketValue(pos)
        if (st === 'OPT') {
          optionsMV += mv
          continue
        }
        const cat = String(pos.category ?? '').trim()
        if (isLedgerFixedIncomeCategory(cat)) fixedIncomeMV += mv
        else if (isLedgerCashLikeCategory(cat)) cashLikeMV += mv
        else coreStockMV += mv
      }
    }
    const cashIb = aggregatedTotals.totalCash
    const wCash = cashIb != null && Number.isFinite(cashIb) ? Math.max(0, cashIb) : 0
    const wCashLikeStk = Math.max(0, cashLikeMV)
    const wCashMerged = wCash + wCashLikeStk
    const wCore = Math.max(0, coreStockMV)
    const wFi = Math.max(0, fixedIncomeMV)
    const wOpt = Math.max(0, optionsMV)

    const wFiIn = portfolioPieIncludeFi ? wFi : 0
    const wOptIn = portfolioPieIncludeOpt ? wOpt : 0
    const denom = wCore + wFiIn + wCashMerged + wOptIn

    const pStock = denom > 0 ? wCore / denom : 0
    const pFixedIncome = denom > 0 && portfolioPieIncludeFi ? wFi / denom : 0
    const pCashMerged = denom > 0 && wCashMerged > 0 ? wCashMerged / denom : 0
    const pOpt = denom > 0 && portfolioPieIncludeOpt ? wOpt / denom : 0

    const netLiq =
      aggregatedTotals.totalNetLiq != null &&
      Number.isFinite(aggregatedTotals.totalNetLiq) &&
      aggregatedTotals.totalNetLiq > 0
        ? aggregatedTotals.totalNetLiq
        : null

    const simpleCenterPct =
      !portfolioPieIncludeFi && !portfolioPieIncludeOpt && denom > 0

    const ringHasData = wCore + wFi + wCashMerged + wOpt > 0

    return {
      coreStockMV: wCore,
      fixedIncomeMV: wFi,
      cashLikeMV: wCashLikeStk,
      cashIb,
      cashMergedMV: wCashMerged,
      optionsMV: wOpt,
      denom,
      pStock,
      pFixedIncome,
      pCashMerged,
      pOpt,
      netLiq,
      simpleCenterPct,
      includeFiInChart: portfolioPieIncludeFi,
      includeOptInChart: portfolioPieIncludeOpt,
      ringHasData,
    }
  }, [
    accounts,
    aggregatedTotals.totalCash,
    aggregatedTotals.totalNetLiq,
    portfolioPieIncludeFi,
    portfolioPieIncludeOpt,
  ])

  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const stockSymbols = useMemo(() => {
    const positions = acc?.positions ?? []
    return [
      ...new Set(
        positions
          .filter((p) => (p.secType ?? '').toUpperCase() === 'STK')
          .map((p) => (p.symbol ?? '').trim())
          .filter(Boolean),
      ),
    ].map((s) => s.toUpperCase())
  }, [acc])
  const optionContractKeys = useMemo(() => {
    const positions = acc?.positions ?? []
    const out: string[] = []
    const seen = new Set<string>()
    for (const p of positions) {
      if ((p.secType ?? '').toUpperCase() !== 'OPT') continue
      const expiry = p.lastTradeDateOrContractMonth ?? p.expiry ?? ''
      const strike = Number(p.strike) || 0
      const right = (p.right ?? '').toUpperCase().slice(0, 1)
      const ck = (p.contract_key ?? `${p.symbol ?? ''}|OPT|${expiry}|${strike}|${right}`).trim()
      if (!ck || seen.has(ck)) continue
      seen.add(ck)
      out.push(ck)
    }
    return out
  }, [acc])
  const runTwsRefresh = async () => {
    setReplaySyncing(true)
    setTwsFetchMessage(null)
    setTwsFetchIsError(false)
    try {
      const res = await postExecutionsFetch(replayFetchDays)
      if (res.ok) {
        await onRefreshAccounts()
        setTwsFetchMessage(
          res.message ??
            `Fetched ${res.fetched_total ?? res.count ?? 0} execution(s) from IB.`,
        )
        setTwsFetchIsError(false)
      } else {
        setTwsFetchMessage(res.error ?? 'Failed to fetch executions from TWS.')
        setTwsFetchIsError(true)
      }
    } catch (e) {
      setTwsFetchMessage(e instanceof Error ? e.message : 'Failed to fetch executions from TWS.')
      setTwsFetchIsError(true)
    } finally {
      setReplaySyncing(false)
    }
  }

  const benchmarkSymbols = useMemo(
    () =>
      [...new Set([...stockSymbols, ...(status?.live_ui?.reference_indices?.map((r) => r.symbol) ?? [])])].sort(),
    [stockSymbols, status?.live_ui?.reference_indices],
  )
  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((r) => {
        if (!cancelled) setBenchmarks(r.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])
  useEffect(() => {
    if (stockSymbols.length === 0 && optionContractKeys.length === 0) {
      setQuotesMap({})
      setOptQuotesByCk({})
      return
    }
    let cancelled = false
    const stockSet = new Set(stockSymbols.map((s) => s.toUpperCase()))
    const optSet = new Set(optionContractKeys)
    const mergeFetched = (quotes: RealtimeQuote[] | undefined) => {
      if (cancelled || !quotes?.length) return
      setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, quotes))
      setOptQuotesByCk((prev) => {
        const next: Record<string, RealtimeQuote> = {}
        for (const k of optSet) {
          if (prev[k]) next[k] = prev[k]!
        }
        for (const q of quotes) {
          const ck = (q.contract_key ?? '').trim()
          if (ck && (q.sec_type ?? '').toUpperCase() === 'OPT' && optSet.has(ck)) next[ck] = { ...q, contract_key: ck }
        }
        return next
      })
    }
    const unsub = subscribeQuotes((q) => {
      const sym = (q.symbol || '').toUpperCase()
      const ck = (q.contract_key ?? '').trim()
      if (ck && (q.sec_type ?? '').toUpperCase() === 'OPT' && optSet.has(ck)) {
        setOptQuotesByCk((prev) => ({ ...prev, [ck]: { ...q, contract_key: ck } }))
      }
      if (sym && stockSet.has(sym)) {
        setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, [q]))
      }
    })
    fetchQuotes(
      stockSymbols.length ? stockSymbols : undefined,
      optionContractKeys.length ? optionContractKeys : undefined,
    )
      .then((res) => mergeFetched(res.quotes))
      .catch(() => {})
    const pollId = window.setInterval(() => {
      fetchQuotes(
        stockSymbols.length ? stockSymbols : undefined,
        optionContractKeys.length ? optionContractKeys : undefined,
      )
        .then((res) => mergeFetched(res.quotes))
        .catch(() => {})
    }, 8000)
    return () => {
      cancelled = true
      unsub()
      window.clearInterval(pollId)
    }
  }, [stockSymbols.join(','), optionContractKeys.join(',')])

  useEffect(() => {
    let cancelled = false
    fetchExecutionsFreshness()
      .then((res) => {
        if (!cancelled) setExecFreshness(res.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setExecFreshness([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!hasAccounts) {
    return (
      <PageSection>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <SectionPageTitle
            menu="Portfolio"
            pageTitle="Accounts"
            onMenuClick={() => onViewChange?.('accounts')}
            infoText="Multi-account summary & positions from DB; auto-refresh every 1h."
            style={{ margin: 0 }}
          >
            {(() => {
              const asdHb = (status as any)?.account_sync_daemon?.heartbeat
              if (!asdHb) return null
              const alive = asdHb.daemon_alive === true
              const lastTs = asdHb.last_ts
              const agoSec = lastTs != null ? Math.round(Date.now() / 1000 - lastTs) : null
              const freshLabel = agoSec != null ? (agoSec < 10 ? 'just now' : agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`) : ''
              return (
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginLeft: '0.5rem', fontSize: '0.72rem', padding: '0.1rem 0.45rem', borderRadius: '6px', background: alive ? 'rgba(56,176,0,0.12)' : 'rgba(220,53,69,0.10)', color: alive ? '#38b000' : '#dc3545' }}
                  title={`Account Sync Daemon: ${alive ? 'running' : 'not running'}${freshLabel ? ` — last sync ${freshLabel}` : ''}`}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: alive ? '#38b000' : '#dc3545', flexShrink: 0 }} />
                  {alive ? `Synced ${freshLabel}` : 'Sync offline'}
                </span>
              )
            })()}
          </SectionPageTitle>
          <div className="accounts-page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span
              className="accounts-page-header-icon-wrap"
              title="Manage position categories"
            >
              <button
                type="button"
                className="section-header-icon-btn"
                onClick={() => {
                  setCategoryModalOpen(true)
                  setCategoryError(null)
                  setCategoryAssignTab('host')
                }}
                aria-label="Manage position categories"
              >
                <AccountsCategoriesIcon size={16} />
              </button>
            </span>
            <span
              className="accounts-page-header-icon-wrap"
              title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
            >
              <button
                type="button"
                className="section-header-icon-btn"
                disabled={ibAccountsRefreshing}
                onClick={onRefreshAccounts}
                aria-label="Refresh accounts and positions from IB"
                aria-busy={ibAccountsRefreshing}
              >
                <ReplayRefreshIcon spinning={ibAccountsRefreshing} size={16} />
              </button>
            </span>
          </div>
        </div>
        <section className="replay-section accounts-import-pills" aria-label="Execution import from Tws and Flex">
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch time range">
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={1} checked={replayFetchDays === 1} onChange={() => setReplayFetchDays(1)} disabled={replaySyncing} />
                <span>Today</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={3} checked={replayFetchDays === 3} onChange={() => setReplayFetchDays(3)} disabled={replaySyncing} />
                <span>Last 3 days</span>
              </label>
              <label className="replay-fetch-radio">
                <input type="radio" name="ib-replay-fetch-days" value={7} checked={replayFetchDays === 7} onChange={() => setReplayFetchDays(7)} disabled={replaySyncing} />
                <span>Last 7 days</span>
              </label>
              <button
                type="button"
                className={`replay-fetch-refresh-btn${replaySyncing ? ' replay-fetch-refresh-btn--busy' : ''}`}
                disabled={replaySyncing}
                onClick={() => {
                  void runTwsRefresh()
                }}
                aria-label="Fetch executions from IB Tws and write to DB"
              >
                <ReplayRefreshIcon spinning={replaySyncing} />
                <span>{replaySyncing ? 'Fetching…' : 'Tws Refresh'}</span>
              </button>
            </div>
            {replaySyncing && <span className="replay-sync-hint">Fetching executions from IB…</span>}
            {twsFetchMessage && (
              <p
                className="section-hint"
                style={{
                  marginTop: '0.25rem',
                  marginBottom: 0,
                  color: twsFetchIsError ? 'var(--color-danger, #c00)' : 'var(--color-success, #16a34a)',
                }}
              >
                {twsFetchMessage}
              </p>
            )}
          </div>
        </section>
        {refreshFeedback != null && refreshFeedback !== '' && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
            {refreshFeedback}
          </p>
        )}

        <div className="ib-portfolio-overview-compact" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
          <span><span className="ib-portfolio-overview-label">Accounts</span> {status?.portfolio?.accounts?.length ?? 0}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Options</span> {overviewTotals.optionContracts}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Stock lines</span> {overviewTotals.stockLines}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Unrealized PnL</span> {fmtUsd(overviewTotals.unrealizedPnl)}</span>
        </div>

        <p className="section-hint">
          No account data (IB not connected or daemon has not written yet; after connection, data is pulled on heartbeat and written to accounts / account_positions)
        </p>

        {categoryModalOpen && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-modal-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setCategoryModalOpen(false)
                setEditingCategoryId(null)
              }
            }}
          >
            <div className="modal-content rounded-lg border border-border bg-background p-4 shadow-sm" style={{ maxWidth: '28rem' }} onClick={(e) => e.stopPropagation()}>
              <h3 id="category-modal-title" style={{ marginTop: 0 }}>Position categories</h3>
              {categoryError && (
                <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem', color: 'var(--color-danger, #c00)' }}>
                  {categoryError}
                </p>
              )}
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                Add or edit categories to tag STK positions (e.g. Dividend, Short-term). Use the Category column in the table to assign.
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem 0' }}>
                {positionCategories.map((c) => (
                  <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                    {editingCategoryId === c.id ? (
                      <>
                        <input
                          type="text"
                          value={editingCategoryName}
                          onChange={(e) => setEditingCategoryName(e.target.value)}
                          placeholder="Category name"
                          style={{ flex: 1, minWidth: '8rem' }}
                          aria-label="Edit category name"
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={async () => {
                            const name = editingCategoryName.trim()
                            if (!name) return
                            setCategoryError(null)
                            const res = await patchPositionCategory(c.id, { name })
                            if (res.ok) {
                              const r = await fetchPositionCategories()
                              setPositionCategories(r.items ?? [])
                              setEditingCategoryId(null)
                            } else {
                              setCategoryError(res.error ?? 'Failed to update name.')
                            }
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => { setEditingCategoryId(null); setCategoryError(null) }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <span style={{ flex: 1 }}>{c.name}</span>
                        {c.description && (
                          <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => { setEditingCategoryId(c.id); setEditingCategoryName(c.name); setCategoryError(null) }}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={async () => {
                            if (!confirm(`Delete category "${c.name}"? Positions tagged with it will be untagged.`)) return
                            await deletePositionCategory(c.id)
                            const r = await fetchPositionCategories()
                            setPositionCategories(r.items ?? [])
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <form
                onSubmit={async (e) => {
                  e.preventDefault()
                  setCategoryError(null)
                  const form = e.currentTarget
                  const name = (form.querySelector('input[name="newCategoryNameNoAcc"]') as HTMLInputElement)?.value?.trim()
                  if (!name) return
                  const res = await postPositionCategory({ name })
                  if (res.ok) {
                    const r = await fetchPositionCategories()
                    setPositionCategories(r.items ?? [])
                    form.reset()
                  } else {
                    setCategoryError(res.error ?? 'Failed to create category.')
                  }
                }}
                style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}
              >
                <input
                  type="text"
                  name="newCategoryNameNoAcc"
                  placeholder="New category name"
                  required
                  style={{ minWidth: '10rem' }}
                />
                <Button type="submit" size="sm">Add</Button>
              </form>
              <div style={{ marginTop: '1rem' }}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setCategoryModalOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageSection>
    )
  }

  const aid = acc.account_id ?? `Account-${selectedIndex + 1}`
  const sum = acc.summary ?? {}
  const netLiq = sum.NetLiquidation != null ? parseFloat(String(sum.NetLiquidation)) : undefined
  const totalCash = sum.TotalCashValue != null ? parseFloat(String(sum.TotalCashValue)) : undefined
  const buyingPower = sum.BuyingPower != null ? parseFloat(String(sum.BuyingPower)) : undefined
  const positions = acc.positions ?? []
  const stockPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() !== 'OPT')
  const optionPositions = positions.filter((p) => (p.secType ?? '').toUpperCase() === 'OPT')
  const stockByCategory = useMemo(() => {
    const map: Record<string, typeof stockPositions> = {}
    for (const p of stockPositions) {
      const k = (p.category && String(p.category).trim()) || 'Uncategorized'
      if (!map[k]) map[k] = []
      map[k].push(p)
    }
    return map
  }, [stockPositions])
  const categoryOrder = useMemo(() => {
    const keys = Object.keys(stockByCategory)
    keys.sort((a, b) => {
      if (a === 'Uncategorized') return -1
      if (b === 'Uncategorized') return 1
      return a.localeCompare(b)
    })
    return keys
  }, [stockByCategory])

  /** Execution freshness for this account: IB Flex (flex_trades) and IB Stream (all other sources, latest row). */
  const execFreshnessForAccount = useMemo(() => {
    const forAcc = execFreshness.filter((r) => (r.account_id || '') === (aid || ''))
    const flexRow = forAcc.find((r) => (r.source || '').toLowerCase() === 'flex_trades') ?? null
    const streamRows = forAcc.filter((r) => (r.source || '').toLowerCase() !== 'flex_trades')
    const streamBest =
      streamRows.length > 0
        ? streamRows.reduce((best, r) =>
            (r.latest_exec_ts ?? 0) > (best.latest_exec_ts ?? 0) ? r : best,
          )
        : null
    return { ibFlex: flexRow, ibStream: streamBest }
  }, [execFreshness, aid])

  /** Returns "Today", "1 day ago", or "N days ago" for display; null item → caller shows "Never". */
  function formatExecDaysAgo(item: ExecutionFreshnessItem | null): string {
    if (!item) return '—'
    const days = item.days_since_latest
    if (days == null || !Number.isFinite(days)) return '—'
    if (days < 0.5) return 'Today'
    if (days < 1.5) return '1 day ago'
    return `${Math.round(days)} days ago`
  }

  const autoStRow = status?.daemon?.trading?.auto_status
  const spot =
    autoStRow?.spot != null && Number.isFinite(Number(autoStRow.spot)) ? Number(autoStRow.spot) : null
  const statusTs =
    autoStRow?.ts != null && Number.isFinite(Number(autoStRow.ts)) ? Number(autoStRow.ts) : null

  return (
    <PageSection>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <SectionPageTitle
          menu="Portfolio"
          pageTitle="Accounts"
          onMenuClick={() => onViewChange?.('accounts')}
          infoText="Multi-account summary & positions from DB; auto-refresh every 1h."
          style={{ margin: 0 }}
        />
        <div className="accounts-page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span
            className="accounts-page-header-icon-wrap"
            title="Manage position categories"
          >
            <button
              type="button"
              className="section-header-icon-btn"
              onClick={() => {
                setCategoryModalOpen(true)
                setCategoryError(null)
                setCategoryAssignTab('host')
              }}
              aria-label="Manage position categories"
            >
              <AccountsCategoriesIcon size={16} />
            </button>
          </span>
          <span
            className="accounts-page-header-icon-wrap"
            title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
          >
            <button
              type="button"
              className="section-header-icon-btn"
              disabled={ibAccountsRefreshing}
              onClick={onRefreshAccounts}
              aria-label="Refresh accounts and positions from IB"
              aria-busy={ibAccountsRefreshing}
            >
              <ReplayRefreshIcon spinning={ibAccountsRefreshing} size={16} />
            </button>
          </span>
        </div>
      </div>
      <section className="replay-section accounts-import-pills" aria-label="Execution import from Tws and Flex">
        <div className="replay-toolbar">
          <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch time range">
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={1} checked={replayFetchDays === 1} onChange={() => setReplayFetchDays(1)} disabled={replaySyncing} />
              <span>Today</span>
            </label>
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={3} checked={replayFetchDays === 3} onChange={() => setReplayFetchDays(3)} disabled={replaySyncing} />
              <span>Last 3 days</span>
            </label>
            <label className="replay-fetch-radio">
              <input type="radio" name="ib-replay-fetch-days" value={7} checked={replayFetchDays === 7} onChange={() => setReplayFetchDays(7)} disabled={replaySyncing} />
              <span>Last 7 days</span>
            </label>
            <button
              type="button"
              className={`replay-fetch-refresh-btn${replaySyncing ? ' replay-fetch-refresh-btn--busy' : ''}`}
              disabled={replaySyncing || flexSyncing}
              onClick={() => {
                setFlexMessage(null)
                void runTwsRefresh()
              }}
              aria-label="Fetch executions from IB Tws and write to DB"
            >
              <ReplayRefreshIcon spinning={replaySyncing} />
              <span>{replaySyncing ? 'Fetching…' : 'Tws Refresh'}</span>
            </button>
          </div>
          <div className="replay-fetch-range-group" role="group" aria-label="Flex executions import">
            <div className="accounts-flex-xml-toggle-wrap">
              <span className="accounts-flex-xml-toggle-label" id="flex-xml-local-label">
                Use local Flex XML
              </span>
              <button
                type="button"
                className="watchlist-toggle-switch accounts-flex-xml-toggle"
                role="switch"
                aria-checked={flexUseUpload}
                aria-labelledby="flex-xml-local-label"
                disabled={replaySyncing || flexSyncing}
                onClick={() => setFlexUseUpload((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (!replaySyncing && !flexSyncing) setFlexUseUpload((v) => !v)
                }}
              >
                <span className="watchlist-toggle-switch-track" />
                <span
                  className={
                    flexUseUpload ? 'watchlist-toggle-switch-thumb on' : 'watchlist-toggle-switch-thumb'
                  }
                />
              </button>
            </div>
            <button
              type="button"
              className={`replay-fetch-refresh-btn${flexSyncing ? ' replay-fetch-refresh-btn--busy' : ''}`}
              disabled={replaySyncing || flexSyncing}
              onClick={async () => {
                if (flexUseUpload) {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = '.xml,text/xml,application/xml'
                  input.onchange = async () => {
                    const file = input.files && input.files[0]
                    if (!file) return
                    setFlexSyncing(true)
                    setFlexMessage(null)
                    try {
                      const text = await file.text()
                      const res = await postExecutionsFetchFlexUpload(text)
                      if (res.ok) {
                        await onRefreshAccounts()
                        const n = res.count ?? 0
                        const accCount = res.updated_accounts ?? 0
                        const parts: string[] = []
                        if (n > 0) {
                          parts.push(
                            `Upserted ${n} execution(s) from uploaded Flex XML for ${accCount} account(s).`,
                          )
                        } else {
                          parts.push('No executions parsed from uploaded Flex XML.')
                        }
                        if (res.message && res.message.trim()) {
                          parts.push(res.message.trim())
                        }
                        setFlexMessage(parts.join(' '))
                      } else {
                        setFlexMessage(res.error || 'Failed to import executions from uploaded Flex XML.')
                      }
                    } finally {
                      setFlexSyncing(false)
                    }
                  }
                  input.click()
                  return
                }

                setFlexSyncing(true)
                setFlexMessage(null)
                try {
                  const res = await postExecutionsFetchFlex()
                  const {
                    ok,
                    count,
                    raw_count,
                    updated_accounts,
                    last_flex_date_after,
                    range_from,
                    range_to,
                    data_from,
                    data_to,
                    message,
                    error,
                    per_query,
                  } = res

                  if (ok) {
                    await onRefreshAccounts()
                    const n = count ?? 0
                    const accCount = updated_accounts ?? 0
                    const latest = last_flex_date_after ?? null
                    const rangeFrom = range_from ?? null
                    const rangeTo = range_to ?? null
                    const rowsInFlex = raw_count ?? n

                    const parts: string[] = []
                    if (n > 0) {
                      parts.push(
                        `Upserted ${n} execution(s) from IB Flex for ${accCount} account(s).`,
                      )
                    } else {
                      parts.push(
                        'Fetched 0 executions from IB Flex (no new trades written to DB).',
                      )
                    }
                    if (rowsInFlex != null && rowsInFlex >= 0) {
                      parts.push(`Flex report had ${rowsInFlex} execution row(s).`)
                    }
                    if (data_from && data_to) {
                      parts.push(`Flex data time span: ${data_from} .. ${data_to}.`)
                    }
                    if (rangeFrom && rangeTo) {
                      parts.push(`Request range used: ${rangeFrom} .. ${rangeTo}.`)
                    }
                    if (latest) {
                      parts.push(`Latest Flex execution date in DB is ${latest}.`)
                    }
                    if (Array.isArray(per_query) && per_query.length > 0) {
                      const perParts = per_query.map((q) => {
                        const roleLabel =
                          (q.role === 'host' || q.role === 'primary') ? 'Host' :
                          (q.role === 'secondary' && 'Secondary') ||
                          'Flex'
                        const label = q.label ? ` ${q.label}` : ''
                        const rows = q.rows ?? 0
                        const span =
                          q.data_from && q.data_to
                            ? `, span ${q.data_from} .. ${q.data_to}`
                            : ''
                        return `${roleLabel}${label} [${q.query_id}]: ${rows} row(s)${span}`
                      })
                      parts.push(`Per Flex ID: ${perParts.join('; ')}.`)
                    }
                    if (message && message.trim()) {
                      parts.push(message.trim())
                    }

                    setFlexMessage(parts.join(' '))
                  } else {
                    const rowsInFlex = raw_count ?? count ?? 0
                    const span =
                      data_from && data_to
                        ? ` Flex data time span: ${data_from} .. ${data_to}.`
                        : ''
                    const rowsText =
                      rowsInFlex > 0
                        ? ` Flex report had ${rowsInFlex} execution row(s).`
                        : ''
                    const reqRange =
                      range_from && range_to
                        ? ` Request range used: ${range_from} .. ${range_to}.`
                        : ''
                    const perDetail =
                      Array.isArray(per_query) && per_query.length > 0
                        ? ' ' +
                          per_query
                            .map((q) => {
                              const roleLabel =
                                (q.role === 'host' || q.role === 'primary') ? 'Host' :
                                (q.role === 'secondary' && 'Secondary') ||
                                'Flex'
                              const label = q.label ? ` ${q.label}` : ''
                              const rows = q.rows ?? 0
                              const subSpan =
                                q.data_from && q.data_to
                                  ? `, span ${q.data_from} .. ${q.data_to}`
                                  : ''
                              return `${roleLabel}${label} [${q.query_id}]: ${rows} row(s)${subSpan}`
                            })
                            .join('; ')
                        : ''
                    setFlexMessage(
                      `${error || 'Failed to fetch executions from IB Flex.'}${rowsText}${span}${reqRange}${perDetail}`,
                    )
                  }
                } finally {
                  setFlexSyncing(false)
                }
              }}
              aria-label="Fetch executions from IB Flex Trades and write to DB"
            >
              <ReplayRefreshIcon spinning={flexSyncing} />
              <span>{flexSyncing ? 'Fetching…' : 'Flex Refresh'}</span>
            </button>
          </div>
          {(replaySyncing || flexSyncing) && (
            <span className="replay-sync-hint">
              {replaySyncing ? 'Fetching executions from IB (TWS)…' : 'Fetching executions from IB Flex…'}
            </span>
          )}
          {fetchedAt != null && Number.isFinite(fetchedAt) && (
            <span className="section-hint replay-data-from-inline">
              Data from {new Date(fetchedAt * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })}
              , {(() => {
                const sec = Math.floor(Date.now() / 1000 - fetchedAt)
                if (sec < 60) return `${sec}s ago`
                if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
                return `${(sec / 3600).toFixed(1)}h ago`
              })()}
            </span>
          )}
          {hasAccounts && (fetchedAt == null || !Number.isFinite(fetchedAt)) && (
            <span className="section-hint replay-data-from-inline">
              Data time unknown (click "Refresh" to have monitor fetch from IB and write to DB)
            </span>
          )}
        </div>
        {twsFetchMessage && (
          <p
            className="section-hint"
            style={{
              marginTop: '0.25rem',
              marginBottom: 0,
              color: twsFetchIsError ? 'var(--color-danger, #c00)' : 'var(--color-success, #16a34a)',
            }}
          >
            {twsFetchMessage}
          </p>
        )}
        {flexMessage && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0 }}>
            {flexMessage}
          </p>
        )}
      </section>

      {refreshFeedback != null && refreshFeedback !== '' && (
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
          {refreshFeedback}
        </p>
      )}

      <div className="ib-portfolio-overview-dashboard">
        <div className="ib-portfolio-overview-tile ib-portfolio-overview-tile-pnl">
          <span className="ib-portfolio-overview-label">Unrealized PnL</span>
          <span
            className="ib-portfolio-overview-value"
            style={{
              color:
                overviewTotals.unrealizedPnl > 0
                  ? 'var(--color-success, #16a34a)'
                  : overviewTotals.unrealizedPnl < 0
                    ? 'var(--color-danger, #dc2626)'
                    : undefined,
            }}
          >
            {fmtUsd(overviewTotals.unrealizedPnl)}
          </span>
        </div>
        <div className="ib-portfolio-overview-tile">
          <span className="ib-portfolio-overview-label">Net Liquidation</span>
          <span className="ib-portfolio-overview-value">{fmtUsd(aggregatedTotals.totalNetLiq)}</span>
        </div>
        <div className="ib-portfolio-overview-tile">
          <span className="ib-portfolio-overview-label">Cash</span>
          <span className="ib-portfolio-overview-value">{fmtUsd(aggregatedTotals.totalCash)}</span>
        </div>
        <div className="ib-portfolio-overview-tile">
          <span className="ib-portfolio-overview-label">Buying Power</span>
          <span className="ib-portfolio-overview-value">{fmtUsd(aggregatedTotals.totalBuyingPower)}</span>
        </div>
      </div>
      <div className="ib-portfolio-charts-row">
        {portfolioCategoryPie.ringHasData && (
        <div className="ib-portfolio-overview-row-pie">
          <div className="coverage-asset-pie-section accounts-portfolio-by-category-pie">
            <div className="coverage-asset-pie-header">
              <span className="coverage-asset-pie-title">Portfolio by category</span>
              <InfoTooltip text="Stock = core STK (same ledger rules as Positions: not Fixed income or Cash-like), including SEPA, Option Pool, and other equity categories. Cash + Cash-like = IB TotalCashValue plus cash-like STK market value. Fixed income and Options can be excluded from the ring via Include/Exclude; dollar amounts stay in the legend. Center shows total net liquidation when available." />
            </div>
            {(() => {
              const {
                coreStockMV,
                fixedIncomeMV,
                cashMergedMV,
                optionsMV,
                denom,
                pStock,
                pFixedIncome,
                pCashMerged,
                pOpt,
                netLiq,
                simpleCenterPct,
                includeFiInChart,
                includeOptInChart,
              } = portfolioCategoryPie
              const cx = 66
              const cy = 66
              const rO = 56
              const rI = 36
              const rMid = (rO + rI) / 2
              const ringStroke = rO - rI
              const circ = 2 * Math.PI * rMid
              let ringOff = 0
              const ringSeg = (frac: number, className: string, key: string) => {
                const len = Math.max(0, frac) * circ
                if (len < 0.5) return null
                const el = (
                  <circle
                    key={key}
                    cx={cx}
                    cy={cy}
                    r={rMid}
                    fill="none"
                    className={className}
                    strokeWidth={ringStroke}
                    strokeLinecap="butt"
                    strokeDasharray={`${len} ${circ}`}
                    strokeDashoffset={-ringOff}
                    transform={`rotate(-90 ${cx} ${cy})`}
                  />
                )
                ringOff += len
                return el
              }
              const centerMain =
                netLiq != null
                  ? fmtUsd(netLiq)
                  : denom > 0
                    ? simpleCenterPct
                      ? `${(pStock * 100).toFixed(1)} · ${(pCashMerged * 100).toFixed(1)}`
                      : fmtUsd(denom)
                    : '—'
              const centerSub =
                netLiq != null
                  ? 'Net liq.'
                  : denom > 0
                    ? simpleCenterPct
                      ? '% of sum'
                      : 'Chart basis'
                    : ''
              const ringAriaParts = [
                'Stock',
                includeFiInChart ? 'Fixed income' : null,
                'Cash and cash-like',
                includeOptInChart ? 'Options' : null,
              ].filter(Boolean) as string[]
              return (
                <div className="coverage-asset-pie-body">
                  <div className="coverage-asset-pie-chart-block">
                    <svg
                      width={132}
                      height={132}
                      viewBox="0 0 132 132"
                      className="coverage-asset-pie-svg"
                      role="img"
                      aria-label={`Ring chart: ${ringAriaParts.join(', ')} as shares of their sum`}
                    >
                      <circle
                        cx={cx}
                        cy={cy}
                        r={rMid}
                        fill="none"
                        className="coverage-asset-pie-ring-track"
                        strokeWidth={ringStroke}
                      />
                      {denom > 0 ? (
                        <>
                          {ringSeg(pStock, 'coverage-asset-pie-ring-seg-stock', 'seg-stock')}
                          {includeFiInChart
                            ? ringSeg(pFixedIncome, 'coverage-asset-pie-ring-seg-fi', 'seg-fi')
                            : null}
                          {ringSeg(pCashMerged, 'coverage-asset-pie-ring-seg-cash', 'seg-cash-merged')}
                          {includeOptInChart
                            ? ringSeg(pOpt, 'coverage-asset-pie-ring-seg-opt', 'seg-opt')
                            : null}
                        </>
                      ) : null}
                      <text
                        x={cx}
                        y={cy - 4}
                        className={`coverage-asset-pie-center-val${
                          netLiq != null
                            ? ' coverage-asset-pie-center-val--netliq'
                            : simpleCenterPct
                              ? ''
                              : ' coverage-asset-pie-center-val--basis'
                        }`}
                        textAnchor="middle"
                        dominantBaseline="auto"
                      >
                        {centerMain}
                      </text>
                      <text
                        x={cx}
                        y={cy + 11}
                        className="coverage-asset-pie-center-sub"
                        textAnchor="middle"
                        dominantBaseline="auto"
                      >
                        {centerSub}
                      </text>
                    </svg>
                    <div className="coverage-asset-pie-bp-side">
                      <div className="coverage-asset-pie-chart-toggle-row">
                        <span className="coverage-asset-pie-bp-label">Fixed income in chart</span>
                        <div
                          className="coverage-asset-pie-bubble-switch"
                          role="group"
                          aria-label="Include fixed income in ring denominator"
                        >
                          <button
                            type="button"
                            className={`coverage-asset-pie-bubble-btn${!portfolioPieIncludeFi ? ' active' : ''}`}
                            aria-pressed={!portfolioPieIncludeFi}
                            onClick={() => setPortfolioPieIncludeFi(false)}
                          >
                            Exclude
                          </button>
                          <button
                            type="button"
                            className={`coverage-asset-pie-bubble-btn${portfolioPieIncludeFi ? ' active' : ''}`}
                            aria-pressed={portfolioPieIncludeFi}
                            onClick={() => setPortfolioPieIncludeFi(true)}
                          >
                            Include
                          </button>
                        </div>
                      </div>
                      <div className="coverage-asset-pie-chart-toggle-row">
                        <span className="coverage-asset-pie-bp-label">Options in chart</span>
                        <div
                          className="coverage-asset-pie-bubble-switch"
                          role="group"
                          aria-label="Include options in ring denominator"
                        >
                          <button
                            type="button"
                            className={`coverage-asset-pie-bubble-btn${!portfolioPieIncludeOpt ? ' active' : ''}`}
                            aria-pressed={!portfolioPieIncludeOpt}
                            onClick={() => setPortfolioPieIncludeOpt(false)}
                          >
                            Exclude
                          </button>
                          <button
                            type="button"
                            className={`coverage-asset-pie-bubble-btn${portfolioPieIncludeOpt ? ' active' : ''}`}
                            aria-pressed={portfolioPieIncludeOpt}
                            onClick={() => setPortfolioPieIncludeOpt(true)}
                          >
                            Include
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="coverage-asset-pie-legend">
                    <div className="coverage-asset-pie-legend-item">
                      <span className="coverage-asset-pie-dot coverage-asset-pie-dot--stock" />
                      <span className="coverage-asset-pie-legend-label">Stock</span>
                      <span className="coverage-asset-pie-legend-pct">
                        {denom > 0 ? `${(pStock * 100).toFixed(1)}%` : '—'}
                      </span>
                      <span className="coverage-asset-pie-legend-value">{fmtUsd(coreStockMV)}</span>
                    </div>
                    <div
                      className={`coverage-asset-pie-legend-item${!includeFiInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                      title={
                        !includeFiInChart
                          ? 'Fixed income MV is listed; not included in ring denominator.'
                          : undefined
                      }
                    >
                      <span className="coverage-asset-pie-dot coverage-asset-pie-dot--fi" />
                      <span className="coverage-asset-pie-legend-label">Fixed income</span>
                      <span className="coverage-asset-pie-legend-pct">
                        {includeFiInChart && denom > 0 ? `${(pFixedIncome * 100).toFixed(1)}%` : '—'}
                      </span>
                      <span className="coverage-asset-pie-legend-value">{fmtUsd(fixedIncomeMV)}</span>
                    </div>
                    <div className="coverage-asset-pie-legend-item">
                      <span className="coverage-asset-pie-dot coverage-asset-pie-dot--cash" />
                      <span className="coverage-asset-pie-legend-label">Cash + Cash-like</span>
                      <span className="coverage-asset-pie-legend-pct">
                        {denom > 0 && cashMergedMV > 0 ? `${(pCashMerged * 100).toFixed(1)}%` : '—'}
                      </span>
                      <span className="coverage-asset-pie-legend-value">{fmtUsd(cashMergedMV)}</span>
                    </div>
                    <div
                      className={`coverage-asset-pie-legend-item${!includeOptInChart ? ' coverage-asset-pie-legend-item--ring-excluded' : ''}`}
                      title={
                        !includeOptInChart
                          ? 'Options MV is listed; not included in ring denominator.'
                          : undefined
                      }
                    >
                      <span className="coverage-asset-pie-dot coverage-asset-pie-dot--opt" />
                      <span className="coverage-asset-pie-legend-label">Options</span>
                      <span className="coverage-asset-pie-legend-pct">
                        {includeOptInChart && denom > 0 ? `${(pOpt * 100).toFixed(1)}%` : '—'}
                      </span>
                      <span className="coverage-asset-pie-legend-value">{fmtUsd(optionsMV)}</span>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
        )}
        <div className="ib-portfolio-netliq-chart-wrap">
        <span className="ib-portfolio-pie-title">Net Liquidation over time</span>
        {(() => {
          const series = accounts.map((a) => ({
            accountId: a.account_id ?? '',
            label: a.account_id ?? '—',
            points: [{ t: Date.now() / 1000, y: getNetLiq(a) }],
          })).filter((s) => Number.isFinite(s.points[0].y))
          const allTs = series.flatMap((s) => s.points.map((p) => p.t))
          const minT = allTs.length ? Math.min(...allTs) : 0
          const maxT = allTs.length ? Math.max(...allTs) : 1
          const allY = series.flatMap((s) => s.points.map((p) => p.y))
          const minY = allY.length ? Math.min(...allY, 0) : 0
          const maxY = allY.length ? Math.max(...allY) * 1.05 : 1
          const w = 480
          const h = 120
          const pad = { left: 40, right: 12, top: 6, bottom: 20 }
          const x = (t: number) => pad.left + ((t - minT) / (maxT - minT || 1)) * (w - pad.left - pad.right)
          const y = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY || 1)) * (h - pad.top - pad.bottom)
          const lineColors = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6']
          return (
            <div className="ib-portfolio-netliq-chart">
              {series.length === 0 ? (
                <p className="ib-portfolio-chart-empty">No account data.</p>
              ) : (
                <svg className="ib-portfolio-line-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <linearGradient id="netliq-fill" x1="0" y1="1" x2="0" y2="0">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {series.map((s, idx) => {
                    const pts = s.points.sort((a, b) => a.t - b.t)
                    const pathD = pts.length ? `M ${pts.map((p) => `${x(p.t)} ${y(p.y)}`).join(' L ')}` : ''
                    const pathFill = pts.length >= 2
                      ? `${pathD} L ${x(pts[pts.length - 1].t)} ${y(minY)} L ${x(pts[0].t)} ${y(minY)} Z`
                      : ''
                    return (
                      <g key={s.accountId}>
                        {pathFill && <path d={pathFill} fill="url(#netliq-fill)" />}
                        <path d={pathD} fill="none" stroke={lineColors[idx % lineColors.length]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        {pts.map((p, i) => (
                          <circle key={i} cx={x(p.t)} cy={y(p.y)} r="4" fill={lineColors[idx % lineColors.length]} />
                        ))}
                      </g>
                    )
                  })}
                  <line x1={pad.left} y1={h - pad.bottom} x2={w - pad.right} y2={h - pad.bottom} stroke="var(--color-border)" strokeWidth="1" />
                  <line x1={pad.left} y1={pad.top} x2={pad.left} y2={h - pad.bottom} stroke="var(--color-border)" strokeWidth="1" />
                </svg>
              )}
              <ul className="ib-portfolio-line-legend">
                {series.map((s, idx) => (
                  <li key={s.accountId}>
                    <span className="ib-portfolio-pie-legend-dot" style={{ backgroundColor: lineColors[idx % lineColors.length] }} />
                    <span>{s.label}</span>
                    <span className="ib-portfolio-line-legend-value">{fmtUsd(s.points[s.points.length - 1]?.y ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })()}
        </div>
      </div>

      <div className="ib-accounts-wrap">
        {accounts.length > 1 && (
          <div className="system-tabs ib-accounts-tab-row" role="tablist" aria-label="Account">
            {accounts.map((a, idx) => (
              <button
                key={a.account_id ?? idx}
                type="button"
                role="tab"
                aria-selected={idx === selectedIndex}
                className={`system-tab ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => setIbAccountIndex(idx)}
              >
                {a.account_id ?? `Account-${idx + 1}`}
                {(a.positions?.length ?? 0) > 0 && (
                  <span className="ib-accounts-tab-count">({a.positions!.length})</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="ib-accounts-content system-tab-panel">
          {!acc ? (
            <p className="section-hint" style={{ marginTop: '0.5rem' }}>No accounts</p>
          ) : (
          <>
          <div className="ib-summary-panel">
            <div className="ib-summary-row">
            <div className="ib-summary-item">
              <span className="label">Account</span>
              <span className="value">{aid}</span>
            </div>
            {netLiq != null && Number.isFinite(netLiq) && (
              <div className="ib-summary-item">
                <span className="label">Net liquidation</span>
                <span className="value">{fmtUsd(netLiq)}</span>
              </div>
            )}
            {totalCash != null && Number.isFinite(totalCash) && (
              <div className="ib-summary-item">
                <span className="label">Total cash</span>
                <span className="value">{fmtUsd(totalCash)}</span>
              </div>
            )}
            {buyingPower != null && Number.isFinite(buyingPower) && (
              <div className="ib-summary-item">
                <span className="label">Buying power</span>
                <span className="value">{fmtUsd(buyingPower)}</span>
              </div>
            )}
            <section className="ib-summary-ib-section" aria-label="IB execution data">
              <div className="ib-summary-item">
                <span className="label">IB Flex</span>
                <span className="value">
                  {execFreshnessForAccount.ibFlex
                    ? formatExecDaysAgo(execFreshnessForAccount.ibFlex)
                    : '—'}
                </span>
              </div>
              <div className="ib-summary-item">
                <span className="label">IB Stream</span>
                <span className="value">
                  {execFreshnessForAccount.ibStream
                    ? formatExecDaysAgo(execFreshnessForAccount.ibStream)
                    : '—'}
                </span>
              </div>
            </section>
            </div>
          </div>

          <div className="ib-positions-title">Stock positions</div>
          {stockPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <div style={{ marginBottom: '0.35rem' }} />
              <div className="ib-accounts-stock-table-wrap">
              <table className="ib-positions-table ib-accounts-stock-positions">
                <colgroup>
                  <col className="ib-acs-col-symbol" />
                  <col className="ib-acs-col-qty" />
                  <col className="ib-acs-col-cost" />
                  <col className="ib-acs-col-total-cost" />
                  <col className="ib-acs-col-total-mkt" />
                  <col className="ib-acs-col-last" />
                  <col className="ib-acs-col-daily-pct" />
                  <col className="ib-acs-col-daily-usd" />
                  <col className="ib-acs-col-chg-pct" />
                  <col className="ib-acs-col-chg-usd" />
                  <col className="ib-acs-col-upd" />
                  <col className="ib-acs-col-strategy" />
                  <col className="ib-acs-col-instance" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Cost</th>
                    <th>Total cost</th>
                    <th>Total market</th>
                    <th>Last</th>
                    <th>Daily %</th>
                    <th>Daily $</th>
                    <th>CHANGE %</th>
                    <th>CHANGE $</th>
                    <th>Upd</th>
                    <th>Strategy</th>
                    <th>Instance</th>
                  </tr>
                </thead>
                {categoryOrder.map((catLabel) => (
                  <tbody key={catLabel}>
                    <tr className="ib-stock-group-header">
                      <td colSpan={13}>
                        <button
                          type="button"
                          className="ib-stock-group-header-btn"
                          onClick={() => {
                            setCategoryModalOpen(true)
                            setCategoryAssignTab('host')
                          }}
                          title="Manage categories and assign to positions"
                        >
                          {catLabel}
                        </button>
                      </td>
                    </tr>
                  {stockByCategory[catLabel].map((pos, i) => {
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const totalCost = Number.isFinite(qty) && Number.isFinite(cost) ? qty * cost : null
                    const sym = (pos.symbol ?? '').toString().toUpperCase()
                    const mainSym = (status?.daemon?.trading?.auto_status?.symbol ?? '').toString().toUpperCase()
                    const perPrice =
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null
                    const showSpotForRow =
                      spot != null &&
                      Number.isFinite(spot) &&
                      sym !== '' &&
                      mainSym !== '' &&
                      sym === mainSym
                    const priceInfo = resolvePreferredPrice({
                      liveQuote: quotesMap[sym],
                      dbPrice: perPrice,
                      dbUpdatedAt:
                        pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                          ? Number(pos.price_updated_at)
                          : null,
                      daemonSpot: showSpotForRow ? spot : null,
                      daemonUpdatedAt: showSpotForRow ? statusTs : null,
                    })
                    const currPrice = priceInfo.price
                    const totalMarket =
                      currPrice != null && Number.isFinite(qty) && Number.isFinite(currPrice) ? qty * currPrice : null
                    const pnl =
                      pos.unrealized_pnl != null && Number.isFinite(pos.unrealized_pnl)
                        ? (priceInfo.source === 'db' ? pos.unrealized_pnl : (
                            currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                              ? (currPrice - cost) * qty
                              : pos.unrealized_pnl
                          ))
                        : currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                          ? (currPrice - cost) * qty
                          : null
                    const bench = benchmarks[sym]
                    const { changePct, pnlVsBench } = computeDailyChange(
                      bench,
                      currPrice,
                      qty,
                      priceInfo.source === 'db' ? pos.daily_prev_close : undefined,
                    )
                    const marketColor =
                      currPrice != null && Number.isFinite(cost)
                        ? (currPrice > cost ? 'var(--color-success, green)' : currPrice < cost ? 'var(--color-danger, #c00)' : undefined)
                        : undefined
                    const pnlColor =
                      pnl != null ? (pnl > 0 ? 'var(--color-success, green)' : pnl < 0 ? 'var(--color-danger, #c00)' : undefined) : undefined
                    const changePctVsCost =
                      cost > 0 && currPrice != null && Number.isFinite(currPrice)
                        ? ((currPrice - cost) / cost) * 100
                        : null
                    return (
                      <tr key={`stk-${catLabel}-${pos.contract_key ?? pos.symbol}-${i}`} className="ib-pos-stock">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{totalCost != null ? fmtUsd(totalCost) : '—'}</td>
                        <td>{totalMarket != null ? fmtUsd(totalMarket) : '—'}</td>
                        <td style={marketColor ? { color: marketColor, fontWeight: 600 } : undefined}>
                          {currPrice != null ? fmtUsd(currPrice) : '—'}
                        </td>
                        <td>
                          {changePct != null && Number.isFinite(changePct) ? (
                            <span style={{ color: changePct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                            <span style={{ color: pnlVsBench >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {fmtUsdRound0(pnlVsBench)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {changePctVsCost != null && Number.isFinite(changePctVsCost) ? (
                            <span style={{ color: changePctVsCost >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {changePctVsCost >= 0 ? '+' : ''}{changePctVsCost.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td style={pnlColor ? { color: pnlColor, fontWeight: 600 } : undefined}>
                          {pnl != null ? fmtUsdRound0(pnl) : '—'}
                        </td>
                        <td>
                          {priceInfo.updatedAtSec != null ? formatLastUpdate(priceInfo.updatedAtSec) : '—'}
                        </td>
                        <td>{(pos as { strategy_opportunity_name?: string | null }).strategy_opportunity_name?.trim() ?? '—'}</td>
                        <td>{(pos as { strategy_instance_label?: string | null }).strategy_instance_label?.trim() ?? '—'}</td>
                      </tr>
                    )
                  })}
                  {(() => {
                    const groupTotalCost = stockByCategory[catLabel].reduce((acc, pos) => {
                      const qty = pos.position != null ? Number(pos.position) : NaN
                      const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                      if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                      return acc
                    }, 0)
                    let groupTotalMarket = 0
                    let groupDailyDollar = 0
                    let groupChangeDollar = 0
                    let groupDailyDenom = 0
                    for (const pos of stockByCategory[catLabel]) {
                      const qty = pos.position != null ? Number(pos.position) : NaN
                      const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                      const sym = (pos.symbol ?? '').toString().toUpperCase()
                      const mainSym = (status?.daemon?.trading?.auto_status?.symbol ?? '').toString().toUpperCase()
                      const perPrice = pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
                      const showSpot = spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                      const priceInfo = resolvePreferredPrice({
                        liveQuote: quotesMap[sym],
                        dbPrice: perPrice,
                        dbUpdatedAt: pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at)) ? Number(pos.price_updated_at) : null,
                        daemonSpot: showSpot ? spot : null,
                        daemonUpdatedAt: showSpot ? statusTs : null,
                      })
                      const currPrice = priceInfo.price
                      if (currPrice != null && Number.isFinite(qty) && Number.isFinite(currPrice)) groupTotalMarket += qty * currPrice
                      const bench = benchmarks[sym]
                      const daily = computeDailyChange(bench, currPrice, qty, priceInfo.source === 'db' ? pos.daily_prev_close : undefined)
                      if (daily.pnlVsBench != null && Number.isFinite(daily.pnlVsBench)) groupDailyDollar += daily.pnlVsBench
                      if (currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)) groupChangeDollar += (currPrice - cost) * qty
                      else if (pos.unrealized_pnl != null && Number.isFinite(pos.unrealized_pnl)) groupChangeDollar += pos.unrealized_pnl
                      let basePrice: number | null = null
                      if (pos.daily_prev_close != null && Number.isFinite(pos.daily_prev_close) && pos.daily_prev_close > 0) basePrice = pos.daily_prev_close
                      else if (bench && Number.isFinite(bench.close) && bench.close > 0) basePrice = (bench.is_today && bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0 ? bench.prev_close : bench.close)
                      if (basePrice != null && Number.isFinite(qty) && qty !== 0) groupDailyDenom += basePrice * Math.abs(qty)
                    }
                    const groupChangePct = groupTotalCost !== 0 && Number.isFinite(groupChangeDollar) ? (groupChangeDollar / groupTotalCost) * 100 : null
                    const groupDailyPct = groupDailyDenom !== 0 && Number.isFinite(groupDailyDollar) ? (groupDailyDollar / groupDailyDenom) * 100 : null
                    return (
                      <tr className="ib-stock-group-summary">
                        <td></td>
                        <td></td>
                        <td></td>
                        <td>{fmtUsd(groupTotalCost)}</td>
                        <td>{fmtUsd(groupTotalMarket)}</td>
                        <td></td>
                        <td>
                          {groupDailyPct != null && Number.isFinite(groupDailyPct) ? (
                            <span style={{ color: groupDailyPct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {groupDailyPct >= 0 ? '+' : ''}{groupDailyPct.toFixed(2)}%
                            </span>
                          ) : '—'}
                        </td>
                        <td>
                          {groupDailyDollar !== 0 || groupTotalCost !== 0 ? (
                            <span style={{ color: groupDailyDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {fmtUsdRound0(groupDailyDollar)}
                            </span>
                          ) : '—'}
                        </td>
                        <td>
                          {groupChangePct != null && Number.isFinite(groupChangePct) ? (
                            <span style={{ color: groupChangePct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {groupChangePct >= 0 ? '+' : ''}{groupChangePct.toFixed(2)}%
                            </span>
                          ) : '—'}
                        </td>
                        <td>
                          {groupChangeDollar !== 0 || groupTotalCost !== 0 ? (
                            <span style={{ color: groupChangeDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)', fontWeight: 600 }}>
                              {fmtUsdRound0(groupChangeDollar)}
                            </span>
                          ) : '—'}
                        </td>
                        <td></td>
                        <td></td>
                        <td></td>
                      </tr>
                    )
                  })()}
                  </tbody>
                ))}
              </table>
              </div>
              {(() => {
                const sumTotal = stockPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                  return acc
                }, 0)
                const sumTotalMarket = stockPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const mainSym = (status?.daemon?.trading?.auto_status?.symbol ?? '').toString().toUpperCase()
                  const priceInfo = resolvePreferredPrice({
                    liveQuote: quotesMap[sym],
                    dbPrice:
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null,
                    dbUpdatedAt:
                      pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                        ? Number(pos.price_updated_at)
                        : null,
                    daemonSpot:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? spot
                        : null,
                    daemonUpdatedAt:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? statusTs
                        : null,
                  })
                  const p = priceInfo.price
                  if (p != null && Number.isFinite(qty) && Number.isFinite(p)) return acc + qty * p
                  return acc
                }, 0)
                const sumPnl = stockPositions.reduce((acc, pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const mainSym = (status?.daemon?.trading?.auto_status?.symbol ?? '').toString().toUpperCase()
                  const priceInfo = resolvePreferredPrice({
                    liveQuote: quotesMap[sym],
                    dbPrice:
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null,
                    dbUpdatedAt:
                      pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                        ? Number(pos.price_updated_at)
                        : null,
                    daemonSpot:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? spot
                        : null,
                    daemonUpdatedAt:
                      spot != null && Number.isFinite(spot) && sym !== '' && mainSym !== '' && sym === mainSym
                        ? statusTs
                        : null,
                  })
                  const p =
                    priceInfo.price != null && pos.avgCost != null && pos.position != null &&
                    Number.isFinite(priceInfo.price) && Number.isFinite(pos.avgCost) && Number.isFinite(pos.position)
                      ? (Number(priceInfo.price) - Number(pos.avgCost)) * Number(pos.position)
                      : NaN
                  return Number.isFinite(p) ? acc + p : acc
                }, 0)
                const sumDailyDollar = stockPositions.reduce((acc, pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const bench = benchmarks[sym]
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const currPrice = resolvePreferredPrice({
                    liveQuote: quotesMap[sym],
                    dbPrice:
                      pos.price != null && Number.isFinite(Number(pos.price))
                        ? Number(pos.price)
                        : null,
                    dbUpdatedAt:
                      pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                        ? Number(pos.price_updated_at)
                        : null,
                    daemonSpot: null,
                    daemonUpdatedAt: null,
                  }).price
                  const dailyChange = computeDailyChange(
                    bench,
                    currPrice,
                    qty,
                    pos.daily_prev_close ?? undefined,
                  )
                  if (dailyChange.pnlVsBench != null && Number.isFinite(dailyChange.pnlVsBench)) {
                    return acc + dailyChange.pnlVsBench
                  }
                  return acc
                }, 0)
                const totalPct = Number.isFinite(sumTotal) && sumTotal !== 0 && Number.isFinite(sumPnl)
                  ? (sumPnl / sumTotal) * 100
                  : null
                let dailyDenom = 0
                stockPositions.forEach((pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const bench = benchmarks[sym]
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  let basePrice: number | null = null
                  if (pos.daily_prev_close != null && Number.isFinite(pos.daily_prev_close) && pos.daily_prev_close > 0) basePrice = pos.daily_prev_close
                  else if (bench && Number.isFinite(bench.close) && bench.close > 0) basePrice = (bench.is_today && bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0 ? bench.prev_close : bench.close)
                  if (basePrice != null && Number.isFinite(qty) && qty !== 0) dailyDenom += basePrice * Math.abs(qty)
                })
                const dailyPct = dailyDenom !== 0 && Number.isFinite(sumDailyDollar) ? (sumDailyDollar / dailyDenom) * 100 : null
                return (
                  <div className="ib-positions-empty ib-positions-stock-totals" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    <span className="ib-positions-stock-totals__metric">
                      <span className="ib-positions-stock-totals__k">Stock total cost:</span>{' '}
                      <span className="ib-positions-stock-totals__v">{fmtUsd(sumTotal)}</span>
                    </span>
                    <span className="ib-positions-stock-totals__metric">
                      <span className="ib-positions-stock-totals__k">Stock total market:</span>{' '}
                      <span className="ib-positions-stock-totals__v">{fmtUsd(sumTotalMarket)}</span>
                    </span>
                    <span
                      className="ib-positions-stock-totals__metric"
                      style={{
                        color: Number.isFinite(sumPnl)
                          ? sumPnl >= 0
                            ? 'var(--color-success, green)'
                            : 'var(--color-danger, #c00)'
                          : 'var(--color-text-muted)',
                      }}
                    >
                      <span className="ib-positions-stock-totals__k">Change</span>{' '}
                      <span className="ib-positions-stock-totals__v ib-positions-stock-totals__v--wide">
                        {Number.isFinite(sumPnl) ? fmtUsdRound0(sumPnl) : '—'} /{' '}
                        {totalPct != null && Number.isFinite(totalPct)
                          ? (totalPct >= 0 ? '+' : '') + totalPct.toFixed(2) + '%'
                          : '—'}
                      </span>
                    </span>
                    <span
                      className="ib-positions-stock-totals__metric"
                      style={{
                        color: Number.isFinite(sumDailyDollar)
                          ? sumDailyDollar >= 0
                            ? 'var(--color-success, green)'
                            : 'var(--color-danger, #c00)'
                          : 'var(--color-text-muted)',
                      }}
                    >
                      <span className="ib-positions-stock-totals__k">Daily</span>{' '}
                      <span className="ib-positions-stock-totals__v ib-positions-stock-totals__v--wide">
                        {Number.isFinite(sumDailyDollar) ? fmtUsdRound0(sumDailyDollar) : '—'} /{' '}
                        {dailyPct != null && Number.isFinite(dailyPct)
                          ? (dailyPct >= 0 ? '+' : '') + dailyPct.toFixed(2) + '%'
                          : '—'}
                      </span>
                    </span>
                  </div>
                )
              })()}
            </>
          )}

          <div className="ib-positions-title" style={{ marginTop: '1rem' }}>Option positions</div>
          {optionPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <div className="ib-accounts-stock-table-wrap">
              <table className="ib-positions-table ib-accounts-option-positions">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Right</th>
                    <th>Expiry</th>
                    <th>Strike</th>
                    <th>Qty</th>
                    <th>Side</th>
                    <th>Cost</th>
                    <th>Premium</th>
                    <th>Details</th>
                    <th>Last</th>
                    <th>Daily %</th>
                    <th>Daily $</th>
                    <th>Change %</th>
                    <th>Change $</th>
                    <th>Upd</th>
                  </tr>
                </thead>
                <tbody>
                  {optionPositions.map((pos, i) => {
                    const expiryRaw = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
                    const strike = pos.strike != null ? Number(pos.strike) : NaN
                    const strikeKey = Number.isFinite(strike) ? strike : 0
                    const rightLetter = (pos.right ?? '').toUpperCase().slice(0, 1)
                    const contractKey = (
                      pos.contract_key ?? `${pos.symbol ?? ''}|OPT|${expiryRaw}|${strikeKey}|${rightLetter}`
                    ).trim()
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const right = (pos.right ?? '').toUpperCase()
                    const isCall = right === 'C' || right === 'CALL'
                    const premium = Number.isFinite(qty) && Number.isFinite(cost) ? -(qty * cost) : null
                    const intrinsic = spot != null && Number.isFinite(strike) ? optionIntrinsic(isCall, strike, spot) : null
                    const sideLabel = Number.isFinite(qty) ? (qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—') : '—'
                    const strategyName = (pos as { strategy_opportunity_name?: string | null }).strategy_opportunity_name?.trim() ?? ''
                    const instanceLabel = (pos as { strategy_instance_label?: string | null }).strategy_instance_label?.trim() ?? ''
                    const liveOpt = optQuotesByCk[contractKey]
                    const perPrice =
                      pos.price != null && Number.isFinite(Number(pos.price)) ? Number(pos.price) : null
                    const priceInfo = resolvePreferredPrice({
                      liveQuote: liveOpt,
                      dbPrice: perPrice,
                      dbUpdatedAt:
                        pos.price_updated_at != null && Number.isFinite(Number(pos.price_updated_at))
                          ? Number(pos.price_updated_at)
                          : null,
                      daemonSpot: null,
                      daemonUpdatedAt: null,
                    })
                    const currPrice = priceInfo.price
                    const { changePct, pnlVsBench } = computeDailyChange(
                      undefined,
                      currPrice,
                      qty,
                      pos.daily_prev_close ?? undefined,
                    )
                    const pnl =
                      pos.unrealized_pnl != null && Number.isFinite(pos.unrealized_pnl)
                        ? priceInfo.source === 'db'
                          ? pos.unrealized_pnl
                          : currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                            ? (currPrice - cost) * qty
                            : pos.unrealized_pnl
                        : currPrice != null && Number.isFinite(qty) && Number.isFinite(cost)
                          ? (currPrice - cost) * qty
                          : null
                    const marketColor =
                      currPrice != null && Number.isFinite(cost)
                        ? currPrice > cost
                          ? 'var(--color-success, green)'
                          : currPrice < cost
                            ? 'var(--color-danger, #c00)'
                            : undefined
                        : undefined
                    const pnlColor =
                      pnl != null
                        ? pnl > 0
                          ? 'var(--color-success, green)'
                          : pnl < 0
                            ? 'var(--color-danger, #c00)'
                            : undefined
                        : undefined
                    const changePctVsCost =
                      cost > 0 && currPrice != null && Number.isFinite(currPrice)
                        ? ((currPrice - cost) / cost) * 100
                        : null
                    const hasDetails =
                      (intrinsic != null && Number.isFinite(intrinsic)) || strategyName !== '' || instanceLabel !== ''
                    return (
                      <tr key={`opt-${contractKey}-${i}`} className="ib-pos-opt">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{rightLabel(pos.right)}</td>
                        <td>{expiryRaw ? fmtExpiry(expiryRaw) : '—'}</td>
                        <td>{Number.isFinite(strike) ? fmtUsd(strike) : '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{sideLabel}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{premium != null ? fmtUsd(premium) : '—'}</td>
                        <td className="ib-accounts-opt-details">
                          {hasDetails ? (
                            <div className="ib-accounts-opt-details-lines">
                              {intrinsic != null && Number.isFinite(intrinsic) && (
                                <div>
                                  <span className="ib-accounts-opt-details-k">Intrinsic</span>{' '}
                                  {fmtUsd(intrinsic)}
                                </div>
                              )}
                              {strategyName !== '' && <div className="ib-accounts-opt-details-strategy">{strategyName}</div>}
                              {instanceLabel !== '' && (
                                <div className="ib-accounts-opt-details-instance section-hint">{instanceLabel}</div>
                              )}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td style={marketColor ? { color: marketColor, fontWeight: 600 } : undefined}>
                          {currPrice != null ? fmtUsd(currPrice) : '—'}
                        </td>
                        <td>
                          {changePct != null && Number.isFinite(changePct) ? (
                            <span
                              style={{
                                color: changePct >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                                fontWeight: 600,
                              }}
                            >
                              {changePct >= 0 ? '+' : ''}
                              {changePct.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {pnlVsBench != null && Number.isFinite(pnlVsBench) ? (
                            <span
                              style={{
                                color: pnlVsBench >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                                fontWeight: 600,
                              }}
                            >
                              {fmtUsdRound0(pnlVsBench)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {changePctVsCost != null && Number.isFinite(changePctVsCost) ? (
                            <span
                              style={{
                                color: changePctVsCost >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)',
                                fontWeight: 600,
                              }}
                            >
                              {changePctVsCost >= 0 ? '+' : ''}
                              {changePctVsCost.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td style={pnlColor ? { color: pnlColor, fontWeight: 600 } : undefined}>
                          {pnl != null ? fmtUsdRound0(pnl) : '—'}
                        </td>
                        <td>
                          {priceInfo.updatedAtSec != null ? formatLastUpdate(priceInfo.updatedAtSec) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {(() => {
                const sumPremium = optionPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc - qty * cost
                  return acc
                }, 0)
                if (!Number.isFinite(sumPremium)) return null
                return (
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Option premium total: {fmtUsd(sumPremium)}
                    {spot != null && (
                      <span className="section-desc" style={{ marginLeft: '0.5rem' }}>
                        (spot {fmtUsd(spot)})
                      </span>
                    )}
                  </p>
                )
              })()}
            </>
          )}
          </>
          )}
        </div>
      </div>

      {categoryModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="category-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCategoryModalOpen(false)
              setEditingCategoryId(null)
            }
          }}
        >
          <div className="modal-content rounded-lg border border-border bg-background p-4 shadow-sm" style={{ maxWidth: '30rem' }} onClick={(e) => e.stopPropagation()}>
            <h3 id="category-modal-title" style={{ marginTop: 0 }}>Position categories</h3>
            {categoryError && (
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem', color: 'var(--color-danger, #c00)' }}>
                {categoryError}
              </p>
            )}
            <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              Add or edit categories, then assign them to STK positions below. Positions are grouped by category in the table.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem 0' }}>
              {positionCategories.map((c) => (
                <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                  {editingCategoryId === c.id ? (
                    <>
                      <input
                        type="text"
                        value={editingCategoryName}
                        onChange={(e) => setEditingCategoryName(e.target.value)}
                        placeholder="Category name"
                        style={{ flex: 1, minWidth: '8rem' }}
                        aria-label="Edit category name"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={async () => {
                          const name = editingCategoryName.trim()
                          if (!name) return
                          setCategoryError(null)
                          const res = await patchPositionCategory(c.id, { name })
                          if (res.ok) {
                            const r = await fetchPositionCategories()
                            setPositionCategories(r.items ?? [])
                            setEditingCategoryId(null)
                          } else {
                            setCategoryError(res.error ?? 'Failed to update name.')
                          }
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => { setEditingCategoryId(null); setCategoryError(null) }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{c.name}</span>
                      {c.description && (
                        <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => { setEditingCategoryId(c.id); setEditingCategoryName(c.name); setCategoryError(null) }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={async () => {
                          if (!confirm(`Delete category "${c.name}"? Positions tagged with it will be untagged.`)) return
                          await deletePositionCategory(c.id)
                          const r = await fetchPositionCategories()
                          setPositionCategories(r.items ?? [])
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                setCategoryError(null)
                const form = e.currentTarget
                const name = (form.querySelector('input[name="newCategoryName"]') as HTMLInputElement)?.value?.trim()
                if (!name) return
                const res = await postPositionCategory({ name })
                if (res.ok) {
                  const r = await fetchPositionCategories()
                  setPositionCategories(r.items ?? [])
                  form.reset()
                } else {
                  setCategoryError(res.error ?? 'Failed to create category.')
                }
              }}
              style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}
            >
              <input
                type="text"
                name="newCategoryName"
                placeholder="New category name"
                required
                style={{ minWidth: '10rem' }}
              />
              <Button type="submit" size="sm">Add</Button>
            </form>
            <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
              <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Assign category to positions</strong>
              {showCategoryAssignHostSecondaryTabs && (
                <div
                  className="system-tabs ib-accounts-tab-row"
                  style={{ marginBottom: '0.65rem' }}
                  role="tablist"
                  aria-label="Host or Secondary account for category tags"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={categoryAssignTab === 'host'}
                    className={`system-tab ${categoryAssignTab === 'host' ? 'active' : ''}`}
                    onClick={() => setCategoryAssignTab('host')}
                  >
                    Host
                    {hostAssignId ? (
                      <span className="ib-accounts-tab-count" title={hostAssignId}>
                        ({hostAssignId})
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={categoryAssignTab === 'secondary'}
                    className={`system-tab ${categoryAssignTab === 'secondary' ? 'active' : ''}`}
                    onClick={() => setCategoryAssignTab('secondary')}
                  >
                    Secondary
                    {secondaryAssignId ? (
                      <span className="ib-accounts-tab-count" title={secondaryAssignId}>
                        ({secondaryAssignId})
                      </span>
                    ) : null}
                  </button>
                </div>
              )}
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                {(() => {
                  if (showCategoryAssignHostSecondaryTabs) {
                    return categoryAssignTab === 'host'
                      ? `Host account${hostAssignId ? `: ${hostAssignId}` : ''}. Select a category per STK symbol.`
                      : `Secondary account${secondaryAssignId ? `: ${secondaryAssignId}` : ''}. Select a category per STK symbol.`
                  }
                  if (hostAssignId) {
                    return `Host account: ${hostAssignId}. Select a category per STK symbol.`
                  }
                  return acc?.account_id
                    ? `Current account (page tab): ${acc.account_id}. Select a category per symbol.`
                    : 'Select an account on the page first, or set Event account IDs under Settings → IB Connection.'
                })()}
              </p>
              {(() => {
                const assignAcc = accForCategoryAssign
                const aid = (assignAcc?.account_id ?? '').trim()
                if (!aid) {
                  const wantId = showCategoryAssignHostSecondaryTabs
                    ? (categoryAssignTab === 'secondary' ? secondaryAssignId : hostAssignId)
                    : (hostAssignId || acc?.account_id || '')
                  return (
                    <p className="section-hint" style={{ margin: 0, fontSize: '0.85rem' }}>
                      {wantId
                        ? `Account ${wantId} is not in the current portfolio snapshot. Refresh accounts from IB, or verify Settings → Event account IDs.`
                        : 'Configure Host account under Settings → IB Connection, or pick an account tab on this page when no Host ID is set.'}
                    </p>
                  )
                }
                const stkPositions = (assignAcc?.positions ?? []).filter(
                  (p) => (p.secType ?? '').toUpperCase() === 'STK',
                )
                if (stkPositions.length === 0) {
                  return <p className="section-hint" style={{ margin: 0, fontSize: '0.85rem' }}>No STK positions in this account.</p>
                }
                return (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '12rem', overflowY: 'auto' }}>
                    {stkPositions.map((pos) => {
                      const ck = pos.contract_key ?? `${pos.symbol ?? ''}|STK|||`
                      return (
                        <li key={ck} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                          <span style={{ minWidth: '4rem', fontWeight: 500 }}>{pos.symbol ?? '—'}</span>
                          <select
                            className="ib-position-category-select ib-category-modal-select"
                            value={positionCategorySelectValue(pos, positionCategories)}
                            onChange={async (e) => {
                              const v = e.target.value
                              await putPositionCategoryTag(aid, ck, v ? Number(v) : null)
                              onRefreshAccounts()
                            }}
                            aria-label={`Category for ${pos.symbol ?? 'position'}`}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <option value="">Uncategorized</option>
                            {positionCategories.map((c) => (
                              <option key={c.id} value={String(c.id)}>{c.name}</option>
                            ))}
                          </select>
                        </li>
                      )
                    })}
                  </ul>
                )
              })()}
            </div>
            <div style={{ marginTop: '1rem' }}>
              <Button type="button" variant="secondary" size="sm" onClick={() => setCategoryModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageSection>
  )
}
