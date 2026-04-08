import { useEffect, useMemo, useState } from 'react'
import type { ExecutionFreshnessItem, IbAccountSnapshot, RealtimeQuote, StatusResponse } from '../types'
import { fetchBarsBenchmark, fetchQuotes, fetchExecutionsFreshness, postExecutionsFetch, postExecutionsFetchFlex, postExecutionsFetchFlexUpload, subscribeQuotes } from '../api'
import { fetchPositionCategories, postPositionCategory, patchPositionCategory, deletePositionCategory, putPositionCategoryTag } from '../api'
import type { PositionCategory } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtExpiry, fmtUsd, fmtUsdRound0 } from '../utils/format'
import { computeDailyChange, formatLastUpdate, getNetLiq, optionIntrinsic, optionMoneyness, resolvePreferredPrice, rightLabel, type DailyBenchmark } from './accounts/accountsUtils'

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
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null)
  const [editingCategoryName, setEditingCategoryName] = useState('')

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

  /** Pie chart: composition by Cash + stock categories + Options (market value). */
  const portfolioPieData = useMemo(() => {
    const slices: { name: string; value: number }[] = []
    const cash = aggregatedTotals.totalCash
    if (cash > 0) slices.push({ name: 'Cash', value: cash })

    const categoryValue: Record<string, number> = {}
    let optionsValue = 0
    for (const account of accounts) {
      for (const pos of account.positions ?? []) {
        const qty = Number(pos.position)
        if (!Number.isFinite(qty) || qty === 0) continue
        const price = pos.price != null && Number.isFinite(pos.price) ? pos.price : (pos.avgCost ?? 0)
        const mv = Math.abs(qty) * (Number.isFinite(price) ? price : 0)
        if ((pos.secType ?? '').toUpperCase() === 'OPT') {
          optionsValue += mv
        } else {
          const cat = (pos.category && String(pos.category).trim()) || 'Uncategorized'
          categoryValue[cat] = (categoryValue[cat] ?? 0) + mv
        }
      }
    }
    Object.entries(categoryValue).sort((a, b) => b[1] - a[1]).forEach(([name, value]) => {
      if (value > 0) slices.push({ name, value })
    })
    if (optionsValue > 0) slices.push({ name: 'Options', value: optionsValue })
    return slices
  }, [accounts, aggregatedTotals.totalCash])

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
    if (stockSymbols.length === 0) {
      setQuotesMap({})
      return
    }
    let cancelled = false
    const mergeFetched = (quotes: RealtimeQuote[] | undefined) => {
      if (cancelled || !quotes?.length) return
      setQuotesMap((prev) => {
        const next = { ...prev }
        quotes.forEach((q) => {
          const k = (q.symbol ?? '').trim().toUpperCase()
          if (k) next[k] = { ...q, symbol: k }
        })
        return next
      })
    }
    fetchQuotes(stockSymbols).then((res) => mergeFetched(res.quotes)).catch(() => {})
    const symbolSet = new Set(stockSymbols.map((s) => s.toUpperCase()))
    const unsub = subscribeQuotes((q) => {
      const sym = (q.symbol || '').toUpperCase()
      if (!sym || !symbolSet.has(sym)) return
      setQuotesMap((prev) => ({ ...prev, [sym]: { ...q, symbol: sym } }))
    })
    // Same as Live: periodic GET /quotes so UI stays fresh if SSE drops messages (e.g. strict JSON types).
    const pollId = window.setInterval(() => {
      fetchQuotes(stockSymbols)
        .then((res) => mergeFetched(res.quotes))
        .catch(() => {})
    }, 8000)
    return () => {
      cancelled = true
      unsub()
      window.clearInterval(pollId)
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
          <div className="accounts-page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span
              className="accounts-page-header-icon-wrap"
              title="Manage position categories"
            >
              <button
                type="button"
                className="section-header-icon-btn"
                onClick={() => { setCategoryModalOpen(true); setCategoryError(null); }}
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
                onClick={async () => {
                  setReplaySyncing(true)
                  await postExecutionsFetch(replayFetchDays)
                  setReplaySyncing(false)
                }}
                aria-label="Fetch executions from IB Tws and write to DB"
              >
                <ReplayRefreshIcon spinning={replaySyncing} />
                <span>{replaySyncing ? 'Fetching…' : 'Tws Refresh'}</span>
              </button>
            </div>
            {replaySyncing && <span className="replay-sync-hint">Fetching executions from IB…</span>}
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
                        <button
                          type="button"
                          className="btn btn-small"
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
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => { setEditingCategoryId(null); setCategoryError(null) }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span style={{ flex: 1 }}>{c.name}</span>
                        {c.description && (
                          <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                        )}
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => { setEditingCategoryId(c.id); setEditingCategoryName(c.name); setCategoryError(null) }}
                        >
                          Edit
                        </button>
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
        <div className="accounts-page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span
            className="accounts-page-header-icon-wrap"
            title="Manage position categories"
          >
            <button
              type="button"
              className="section-header-icon-btn"
              onClick={() => { setCategoryModalOpen(true); setCategoryError(null); }}
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
        {portfolioPieData.length > 0 && (
        <div className="ib-portfolio-overview-row-pie">
          <span className="ib-portfolio-pie-title">Portfolio by category</span>
          <div className="ib-portfolio-pie-inner">
            <svg className="ib-portfolio-pie-svg" viewBox="0 0 100 100" aria-label="Portfolio composition by category">
              {(() => {
                const total = portfolioPieData.reduce((s, d) => s + d.value, 0)
                if (total <= 0) return null
                const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#64748b']
                let start = -0.25
                return portfolioPieData.map((d, i) => {
                  const ratio = d.value / total
                  const angle = ratio * 2 * Math.PI
                  const end = start + angle
                  const x1 = 50 + 45 * Math.cos(start)
                  const y1 = 50 + 45 * Math.sin(start)
                  const x2 = 50 + 45 * Math.cos(end)
                  const y2 = 50 + 45 * Math.sin(end)
                  const large = ratio > 0.5 ? 1 : 0
                  const path = `M 50 50 L ${x1} ${y1} A 45 45 0 ${large} 1 ${x2} ${y2} Z`
                  start = end
                  return <path key={d.name} d={path} fill={colors[i % colors.length]} aria-label={`${d.name}: ${fmtUsd(d.value)}`} />
                })
              })()}
            </svg>
            <ul className="ib-portfolio-pie-legend">
              {portfolioPieData.map((d, i) => {
                const total = portfolioPieData.reduce((s, x) => s + x.value, 0)
                const pct = total > 0 ? (d.value / total) * 100 : 0
                const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#64748b']
                return (
                  <li key={d.name} className="ib-portfolio-pie-legend-item">
                    <span className="ib-portfolio-pie-legend-dot" style={{ backgroundColor: colors[i % colors.length] }} />
                    <span className="ib-portfolio-pie-legend-label">{d.name}</span>
                    <span className="ib-portfolio-pie-legend-value">{fmtUsd(d.value)}</span>
                    <span className="ib-portfolio-pie-legend-pct">({pct.toFixed(1)}%)</span>
                  </li>
                )
              })}
            </ul>
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
          <div className="ib-summary-card">
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
              <table className="ib-positions-table">
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
                  <p className="ib-positions-empty" style={{ marginTop: '0.5rem', fontWeight: 600 }}>
                    Stock total cost: {fmtUsd(sumTotal)}
                    <span style={{ marginLeft: '1rem' }}>Stock total market: {fmtUsd(sumTotalMarket)}</span>
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
                    <th>Strategy</th>
                    <th>Instance</th>
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
                        <td>{(pos as { strategy_opportunity_name?: string | null }).strategy_opportunity_name?.trim() ?? '—'}</td>
                        <td>{(pos as { strategy_instance_label?: string | null }).strategy_instance_label?.trim() ?? '—'}</td>
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
                      <button
                        type="button"
                        className="btn btn-small"
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
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => { setEditingCategoryId(null); setCategoryError(null) }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{c.name}</span>
                      {c.description && (
                        <span className="section-hint" style={{ fontSize: '0.85rem' }}>{c.description}</span>
                      )}
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => { setEditingCategoryId(c.id); setEditingCategoryName(c.name); setCategoryError(null) }}
                      >
                        Edit
                      </button>
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
