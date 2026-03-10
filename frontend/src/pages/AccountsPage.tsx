import { useEffect, useMemo, useState } from 'react'
import type { ExecutionFreshnessItem, IbAccountSnapshot, RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchQuotes, fetchExecutionsFreshness, postExecutionsFetch, postExecutionsFetchFlex, postExecutionsFetchFlexUpload, subscribeQuotes } from '../api'
import { fetchPositionCategories, postPositionCategory, deletePositionCategory, putPositionCategoryTag } from '../api'
import type { PositionCategory } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'

type DailyBenchmark = {
  bar_time: number
  close: number
  prev_close?: number | null
  is_today?: boolean
  is_stale?: boolean
}

type PriceSource = 'live' | 'db' | 'daemon' | null

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtUsdRound0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(n))
}

function fmtExpiry(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '—'
  const s = String(raw).trim().replace(/\D/g, '')
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return raw
}

function getNetLiq(a: IbAccountSnapshot): number {
  const v = a.summary?.NetLiquidation
  if (v == null) return 0
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function rightLabel(r: string | undefined): string {
  if (!r) return '—'
  const u = String(r).toUpperCase()
  if (u === 'C' || u === 'CALL') return 'Call'
  if (u === 'P' || u === 'PUT') return 'Put'
  return r
}

/** 根据 price_updated_at (Unix 秒) 与当前时间差显示：秒 → 分钟 → 小时 → 天 */
function formatLastUpdate(updatedAtSec: number | null | undefined): string {
  if (updatedAtSec == null || !Number.isFinite(updatedAtSec)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - updatedAtSec))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

function optionIntrinsic(isCall: boolean, k: number, s: number): number {
  return isCall ? Math.max(0, s - k) : Math.max(0, k - s)
}

function optionMoneyness(isCall: boolean, k: number, s: number): string {
  if (!Number.isFinite(k) || !Number.isFinite(s)) return '—'
  if (Math.abs(s - k) < 0.01) return 'ATM'
  if (isCall) return s > k ? 'ITM' : 'OTM'
  return s < k ? 'ITM' : 'OTM'
}

function computeDailyChange(
  bench: DailyBenchmark | undefined,
  currPrice: number | null,
  qty: number,
  /** When price is from stock_day fallback (db), use this as base for daily %/$ instead of bench */
  dailyPrevClose?: number | null,
): { changePct: number | null; pnlVsBench: number | null } {
  if (currPrice == null || !Number.isFinite(currPrice)) {
    return { changePct: null, pnlVsBench: null }
  }
  let basePrice: number | null = null
  if (dailyPrevClose != null && Number.isFinite(dailyPrevClose) && dailyPrevClose > 0) {
    basePrice = dailyPrevClose
  } else if (bench && Number.isFinite(bench.close) && bench.close > 0) {
    const prevClose =
      bench.prev_close != null && Number.isFinite(bench.prev_close) && bench.prev_close > 0
        ? bench.prev_close
        : null
    basePrice = bench.is_today && prevClose != null ? prevClose : bench.close
  }
  if (basePrice == null || !Number.isFinite(basePrice) || basePrice <= 0) {
    return { changePct: null, pnlVsBench: null }
  }
  return {
    changePct: ((currPrice - basePrice) / basePrice) * 100,
    pnlVsBench: Number.isFinite(qty) ? (currPrice - basePrice) * qty : null,
  }
}

function resolvePreferredPrice(args: {
  liveQuote?: RealtimeQuote
  dbPrice?: number | null
  dbUpdatedAt?: number | null
  daemonSpot?: number | null
  daemonUpdatedAt?: number | null
}): { price: number | null; source: PriceSource; updatedAtSec: number | null } {
  const liveLast = args.liveQuote?.last
  if (liveLast != null && Number.isFinite(liveLast) && liveLast > 0) {
    return {
      price: liveLast,
      source: 'live',
      updatedAtSec:
        args.liveQuote?.ts != null && Number.isFinite(args.liveQuote.ts)
          ? args.liveQuote.ts
          : null,
    }
  }
  if (args.dbPrice != null && Number.isFinite(args.dbPrice) && args.dbPrice > 0) {
    return {
      price: args.dbPrice,
      source: 'db',
      updatedAtSec:
        args.dbUpdatedAt != null && Number.isFinite(args.dbUpdatedAt)
          ? args.dbUpdatedAt
          : null,
    }
  }
  if (args.daemonSpot != null && Number.isFinite(args.daemonSpot) && args.daemonSpot > 0) {
    return {
      price: args.daemonSpot,
      source: 'daemon',
      updatedAtSec:
        args.daemonUpdatedAt != null && Number.isFinite(args.daemonUpdatedAt)
          ? args.daemonUpdatedAt
          : null,
    }
  }
  return { price: null, source: null, updatedAtSec: null }
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
  const rawAccounts = (accountsDisplay ?? j?.accounts) as IbAccountSnapshot[] | undefined
  const hasAccounts = Array.isArray(rawAccounts) && rawAccounts.length > 0
  const fetchedAt = j?.accounts_fetched_at
  const accounts = hasAccounts ? [...rawAccounts!].sort((a, b) => getNetLiq(b) - getNetLiq(a)) : []
  const selectedIndex = accounts.length > 0 ? Math.min(ibAccountIndex, accounts.length - 1) : 0
  const acc = accounts[selectedIndex]
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [replaySyncing, setReplaySyncing] = useState(false)
  const [flexSyncing, setFlexSyncing] = useState(false)
  const [flexMessage, setFlexMessage] = useState<string | null>(null)
  const [flexUseUpload, setFlexUseUpload] = useState(false)
  const [execFreshness, setExecFreshness] = useState<ExecutionFreshnessItem[]>([])
  // Reserved for future Flex range preset UI (currently unused).
  // const [flexRangePreset, setFlexRangePreset] = useState<null | string>(null)
  const [positionCategories, setPositionCategories] = useState<PositionCategory[]>([])
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [categoryError, setCategoryError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasAccounts) return
    let cancelled = false
    fetchPositionCategories()
      .then((r) => {
        if (!cancelled) setPositionCategories(r.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setPositionCategories([])
      })
    return () => { cancelled = true }
  }, [hasAccounts])

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
  const benchmarkSymbols = useMemo(
    () =>
      [...new Set([...stockSymbols, ...(status?.reference_indices?.map((r) => r.symbol) ?? [])])].sort(),
    [stockSymbols, status?.reference_indices],
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
    if (stockSymbols.length === 0) {
      setQuotesMap({})
      return
    }
    let cancelled = false
    fetchQuotes(stockSymbols)
      .then((res) => {
        if (cancelled || !res.quotes?.length) return
        setQuotesMap((prev) => {
          const next = { ...prev }
          res.quotes.forEach((q) => {
            next[q.symbol] = q
          })
          return next
        })
      })
      .catch(() => {})
    const symbolSet = new Set(stockSymbols.map((s) => s.toUpperCase()))
    const unsub = subscribeQuotes((q) => {
      const sym = (q.symbol || '').toUpperCase()
      if (!sym || !symbolSet.has(sym)) return
      setQuotesMap((prev) => ({ ...prev, [sym]: { ...q, symbol: sym } }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [stockSymbols.join(',')])

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
      <div className="card process-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={() => onViewChange?.('accounts')}
            >
              Portfolio
            </button>
            {' / Accounts'}
            <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-small btn-size-default"
              onClick={() => { setCategoryModalOpen(true); setCategoryError(null); }}
              aria-label="Manage position categories"
            >
              Categories
            </button>
            <button
              type="button"
              className="btn-resume"
              disabled={ibAccountsRefreshing}
              onClick={onRefreshAccounts}
              title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
            >
              {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {refreshFeedback != null && refreshFeedback !== '' && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
            {refreshFeedback}
          </p>
        )}

        <div className="ib-portfolio-overview-compact" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
          <span><span className="ib-portfolio-overview-label">Accounts</span> {status?.accounts?.length ?? 0}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Options</span> {overviewTotals.optionContracts}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Stock lines</span> {overviewTotals.stockLines}</span>
          <span className="ib-portfolio-overview-sep">·</span>
          <span><span className="ib-portfolio-overview-label">Unrealized PnL</span> {fmtUsd(overviewTotals.unrealizedPnl)}</span>
        </div>

        <section className="replay-section" aria-label="Execution fetch range">
          <div className="replay-toolbar">
            <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch range">
              <span className="replay-fetch-days-label">Fetch</span>
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
                className="btn btn-small replay-fetch-refresh-btn"
                disabled={replaySyncing}
                onClick={async () => {
                  setReplaySyncing(true)
                  await postExecutionsFetch(replayFetchDays)
                  setReplaySyncing(false)
                }}
                aria-label="Fetch executions from IB and write to DB"
              >
                {replaySyncing ? 'Fetching…' : 'Refresh'}
              </button>
            </div>
            {replaySyncing && <span className="replay-sync-hint">Fetching executions from IB…</span>}
          </div>
        </section>

        <p className="section-hint">
          No account data (IB not connected or daemon has not written yet; after connection, data is pulled on heartbeat and written to accounts / account_positions)
        </p>

        {categoryModalOpen && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-modal-title"
            onClick={(e) => e.target === e.currentTarget && setCategoryModalOpen(false)}
          >
            <div className="modal-content card" style={{ maxWidth: '28rem' }} onClick={(e) => e.stopPropagation()}>
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
                  <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <span style={{ flex: 1 }}>{c.name}</span>
                    {c.description && (
                      <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={async () => {
                        if (!confirm(`Delete category "${c.name}"? Positions tagged with it will be untagged.`)) return
                        await deletePositionCategory(c.id)
                        const r = await fetchPositionCategories()
                        setPositionCategories(r.items ?? [])
                      }}
                    >
                      Delete
                    </button>
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
                <button type="submit" className="btn btn-small">Add</button>
              </form>
              <div style={{ marginTop: '1rem' }}>
                <button type="button" className="btn btn-small" onClick={() => setCategoryModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
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
  const spot =
    status?.status?.spot != null && Number.isFinite(Number(status.status.spot))
      ? Number(status.status.spot)
      : null
  const statusTs =
    status?.status?.ts != null && Number.isFinite(Number(status.status.ts))
      ? Number(status.status.ts)
      : null

  return (
    <div className="card process-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }} className="page-title-with-tooltip">
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Accounts'}
          <InfoTooltip text="Multi-account summary & positions from DB; auto-refresh every 1h." />
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-small btn-size-default"
            onClick={() => { setCategoryModalOpen(true); setCategoryError(null); }}
            aria-label="Manage position categories"
          >
            Categories
          </button>
          <button
            type="button"
            className="btn-resume"
            disabled={ibAccountsRefreshing}
            onClick={onRefreshAccounts}
            title="Monitor Account Client fetches accounts & positions from IB, writes to DB, then updates display"
          >
            {ibAccountsRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {refreshFeedback != null && refreshFeedback !== '' && (
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: refreshFeedback.startsWith('Refreshed') ? 'var(--color-success, green)' : undefined }}>
          {refreshFeedback}
        </p>
      )}

      {fetchedAt != null && Number.isFinite(fetchedAt) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data from {new Date(fetchedAt * 1000).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' })}
          , {(() => {
            const sec = Math.floor(Date.now() / 1000 - fetchedAt)
            if (sec < 60) return `${sec}s ago`
            if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
            return `${(sec / 3600).toFixed(1)}h ago`
          })()}
        </p>
      )}
      {hasAccounts && (fetchedAt == null || !Number.isFinite(fetchedAt)) && (
        <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Data time unknown (click "Refresh" to have monitor fetch from IB and write to DB; fetch time will appear here)
        </p>
      )}

      <div className="ib-portfolio-overview-compact" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
        <span><span className="ib-portfolio-overview-label">Accounts</span> {accounts.length}</span>
        <span className="ib-portfolio-overview-sep">·</span>
        <span><span className="ib-portfolio-overview-label">Options</span> {overviewTotals.optionContracts}</span>
        <span className="ib-portfolio-overview-sep">·</span>
        <span><span className="ib-portfolio-overview-label">Stock lines</span> {overviewTotals.stockLines}</span>
        <span className="ib-portfolio-overview-sep">·</span>
        <span><span className="ib-portfolio-overview-label">Unrealized PnL</span> {fmtUsd(overviewTotals.unrealizedPnl)}</span>
      </div>

      <section className="replay-section" aria-label="Execution fetch range">
        <div className="replay-toolbar">
          <div className="replay-fetch-range-group" role="radiogroup" aria-label="Execution fetch range">
            <span className="replay-fetch-days-label">Fetch</span>
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
              className="btn btn-small replay-fetch-refresh-btn"
              disabled={replaySyncing || flexSyncing}
              onClick={async () => {
                setReplaySyncing(true)
                setFlexMessage(null)
                try {
                  const res = await postExecutionsFetch(replayFetchDays)
                  if (res.ok) await onRefreshAccounts()
                } finally {
                  setReplaySyncing(false)
                }
              }}
              aria-label="Fetch executions from IB and write to DB"
            >
              {replaySyncing ? 'Fetching…' : 'Refresh'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <input
                id="flex-use-upload"
                type="checkbox"
                checked={flexUseUpload}
                onChange={(e) => setFlexUseUpload(e.target.checked)}
                disabled={replaySyncing || flexSyncing}
              />
              <label htmlFor="flex-use-upload" className="section-hint">
                Use local Flex Trades XML (upload instead of Web Service)
              </label>
            </div>
            <button
              type="button"
              className="btn btn-small replay-fetch-refresh-btn"
              disabled={replaySyncing || flexSyncing}
              onClick={async () => {
                if (flexUseUpload) {
                  // 上传本地 Flex XML：打开文件选择框，读取内容后 POST /executions/fetch-flex-upload
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
                          (q.role === 'primary' && 'Primary') ||
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
                                (q.role === 'primary' && 'Primary') ||
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
              {flexSyncing ? 'Fetching…' : 'Fetch from IB (Flex)'}
            </button>
            {(replaySyncing || flexSyncing) && (
              <span className="replay-sync-hint">
                {replaySyncing ? 'Fetching executions from IB (TWS)…' : 'Fetching executions from IB Flex…'}
              </span>
            )}
          </div>
          {execFreshness.length > 0 && (
            <div className="replay-exec-freshness">
              <div className="section-hint" style={{ marginTop: '0.25rem', marginBottom: '0.25rem' }}>
                Execution data status by source &amp; account (latest row per group).
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="ib-positions-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Source</th>
                      <th>Latest execution time</th>
                      <th>Gap (days)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {execFreshness.map((row, idx) => {
                      const days = row.days_since_latest
                      let gapLabel = '—'
                      if (days != null && Number.isFinite(days)) {
                        if (days < 0.5) {
                          gapLabel = 'Today'
                        } else if (days < 1.5) {
                          gapLabel = '1 day'
                        } else {
                          gapLabel = `${Math.round(days)} days`
                        }
                      }
                      const tsSec = row.latest_exec_ts
                      const tsLabel =
                        tsSec != null && Number.isFinite(tsSec)
                          ? new Date(tsSec * 1000).toLocaleString('en-US', {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            })
                          : '—'
                      return (
                        <tr key={`${row.account_id || 'unknown'}-${row.source || 'unknown'}-${idx}`}>
                          <td>{row.account_id || '—'}</td>
                          <td>{row.source || '—'}</td>
                          <td>{tsLabel}</td>
                          <td>{gapLabel}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        {flexMessage && (
          <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0 }}>
            {flexMessage}
          </p>
        )}
      </section>

      <div className="ib-accounts-wrap">
        {accounts.length > 1 && (
          <div className="ib-accounts-tabs">
            {accounts.map((a, idx) => (
              <button
                key={a.account_id ?? idx}
                type="button"
                className={`ib-accounts-tab ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => setIbAccountIndex(idx)}
              >
                {a.account_id ?? `Account-${idx + 1}`}
                {(a.positions?.length ?? 0) > 0 && (
                  <span className="section-hint" style={{ marginLeft: '0.35rem', fontWeight: 'normal' }}>
                    ({a.positions!.length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="ib-accounts-content">
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
          </div>

          <div className="ib-positions-title">Stock positions</div>
          {stockPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <div style={{ marginBottom: '0.35rem' }} />
              <table className="ib-positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Cost</th>
                    <th>Total cost</th>
                    <th>Market</th>
                    <th>Daily %</th>
                    <th>Daily $</th>
                    <th>CHANGE %</th>
                    <th>CHANGE $</th>
                    <th>Upd</th>
                  </tr>
                </thead>
                {categoryOrder.map((catLabel) => (
                  <tbody key={catLabel}>
                    <tr className="ib-stock-group-header">
                      <td colSpan={10}>
                        <button
                          type="button"
                          className="ib-stock-group-header-btn"
                          onClick={() => setCategoryModalOpen(true)}
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
                    const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
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
                    let groupDailyDollar = 0
                    let groupChangeDollar = 0
                    let groupDailyDenom = 0
                    for (const pos of stockByCategory[catLabel]) {
                      const qty = pos.position != null ? Number(pos.position) : NaN
                      const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                      const sym = (pos.symbol ?? '').toString().toUpperCase()
                      const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
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
                      </tr>
                    )
                  })()}
                  </tbody>
                ))}
              </table>
              {(() => {
                const sumTotal = stockPositions.reduce((acc, pos) => {
                  const qty = pos.position != null ? Number(pos.position) : NaN
                  const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                  if (Number.isFinite(qty) && Number.isFinite(cost)) return acc + qty * cost
                  return acc
                }, 0)
                const sumPnl = stockPositions.reduce((acc, pos) => {
                  const sym = (pos.symbol ?? '').toString().toUpperCase()
                  const mainSym = (status?.status?.symbol ?? '').toString().toUpperCase()
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
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Stock total cost: {fmtUsd(sumTotal)}
                    <span style={{ marginLeft: '1rem', color: Number.isFinite(sumPnl) ? (sumPnl >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)') : 'var(--color-text-muted)' }}>
                      Change {Number.isFinite(sumPnl) ? fmtUsdRound0(sumPnl) : '—'} / {totalPct != null && Number.isFinite(totalPct) ? (totalPct >= 0 ? '+' : '') + totalPct.toFixed(2) + '%' : '—'}
                    </span>
                    <span style={{ marginLeft: '1rem', color: Number.isFinite(sumDailyDollar) ? (sumDailyDollar >= 0 ? 'var(--color-success, green)' : 'var(--color-danger, #c00)') : 'var(--color-text-muted)' }}>
                      Daily {Number.isFinite(sumDailyDollar) ? fmtUsdRound0(sumDailyDollar) : '—'} / {dailyPct != null && Number.isFinite(dailyPct) ? (dailyPct >= 0 ? '+' : '') + dailyPct.toFixed(2) + '%' : '—'}
                    </span>
                  </p>
                )
              })()}
            </>
          )}

          <div className="ib-positions-title" style={{ marginTop: '1rem' }}>Option positions</div>
          {optionPositions.length === 0 ? (
            <p className="ib-positions-empty">None</p>
          ) : (
            <>
              <table className="ib-positions-table">
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
                    <th>Intrinsic</th>
                    <th>Moneyness</th>
                  </tr>
                </thead>
                <tbody>
                  {optionPositions.map((pos, i) => {
                    const expiryRaw = pos.lastTradeDateOrContractMonth ?? pos.expiry ?? ''
                    const strike = pos.strike != null ? Number(pos.strike) : NaN
                    const qty = pos.position != null ? Number(pos.position) : NaN
                    const cost = pos.avgCost != null ? Number(pos.avgCost) : NaN
                    const right = (pos.right ?? '').toUpperCase()
                    const isCall = right === 'C' || right === 'CALL'
                    const premium = Number.isFinite(qty) && Number.isFinite(cost) ? -(qty * cost) : null
                    const intrinsic = spot != null && Number.isFinite(strike) ? optionIntrinsic(isCall, strike, spot) : null
                    const moneyness = spot != null && Number.isFinite(strike) ? optionMoneyness(isCall, strike, spot) : '—'
                    const sideLabel = Number.isFinite(qty) ? (qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—') : '—'
                    return (
                      <tr key={`opt-${pos.symbol}-${i}`} className="ib-pos-opt">
                        <td>{pos.symbol ?? '—'}</td>
                        <td>{rightLabel(pos.right)}</td>
                        <td>{expiryRaw ? fmtExpiry(expiryRaw) : '—'}</td>
                        <td>{Number.isFinite(strike) ? fmtUsd(strike) : '—'}</td>
                        <td>{pos.position != null ? pos.position : '—'}</td>
                        <td>{sideLabel}</td>
                        <td>{pos.avgCost != null ? fmtUsd(pos.avgCost) : '—'}</td>
                        <td>{premium != null ? fmtUsd(premium) : '—'}</td>
                        <td>{intrinsic != null ? fmtUsd(intrinsic) : '—'}</td>
                        <td>{moneyness}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
        </div>
      </div>

      {categoryModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="category-modal-title"
          onClick={(e) => e.target === e.currentTarget && setCategoryModalOpen(false)}
        >
          <div className="modal-content card" style={{ maxWidth: '30rem' }} onClick={(e) => e.stopPropagation()}>
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
                <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <span style={{ flex: 1 }}>{c.name}</span>
                  {c.description && (
                    <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={async () => {
                      if (!confirm(`Delete category "${c.name}"? Positions tagged with it will be untagged.`)) return
                      await deletePositionCategory(c.id)
                      const r = await fetchPositionCategories()
                      setPositionCategories(r.items ?? [])
                    }}
                  >
                    Delete
                  </button>
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
              <button type="submit" className="btn btn-small">Add</button>
            </form>
            <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
              <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Assign category to positions</strong>
              <p className="section-hint" style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                {acc?.account_id ? `Current account: ${acc.account_id}. Select a category per symbol.` : 'Select an account on the page first.'}
              </p>
              {(() => {
                const stkPositions = (acc?.positions ?? []).filter(
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
                            value={pos.category_id ?? ''}
                            onChange={async (e) => {
                              const v = e.target.value
                              await putPositionCategoryTag(acc!.account_id!, ck, v ? Number(v) : null)
                              onRefreshAccounts()
                            }}
                            aria-label={`Category for ${pos.symbol ?? 'position'}`}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <option value="">Uncategorized</option>
                            {positionCategories.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
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
              <button type="button" className="btn btn-small" onClick={() => setCategoryModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
