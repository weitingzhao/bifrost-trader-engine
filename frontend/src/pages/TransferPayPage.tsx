import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse, AccountTransaction } from '../types'
import { getTransactions, postTransactionsFetch } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtDate, fmtUsd, fmtUsd0 } from '../utils/format'

interface TransferPayPageProps {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

type SummaryMode = 'year' | 'quarter' | 'month'

type SummaryTypeKey = 'deposit' | 'withdrawal' | 'dividend' | 'other'

export type RangePreset =
  | 'last_365'
  | 'mtd'
  | 'qtd'
  | 'ytd'
  | 'last_month'
  | 'last_quarter'
  | 'last_30'
  | 'last_business_day'

/** Same options as Accounts "Fetch from IB Flex" Range dropdown; used in Settings Default Flex Query range. */
export const FLEX_RANGE_PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: 'last_365', label: 'Last 365 calendar days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'qtd', label: 'Quarter to date' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'last_30', label: 'Last 30 calendar days' },
  { value: 'last_business_day', label: 'Last business day' },
]

function getSummaryType(raw: string | null | undefined): SummaryTypeKey {
  const t = (raw || '').toLowerCase()
  if (t === 'deposit') return 'deposit'
  if (t === 'withdrawal') return 'withdrawal'
  if (t === 'dividend') return 'dividend'
  return 'other'
}

function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${y}${String(m).padStart(2, '0')}${String(day).padStart(2, '0')}`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, delta: number): Date {
  const nd = new Date(d)
  nd.setDate(nd.getDate() + delta)
  return nd
}

export function getRangeForPreset(preset: RangePreset): {
  fromDate: string | undefined
  toDate: string | undefined
  sinceTs: number | undefined
  untilTs: number | undefined
} {
  const now = new Date()
  const today = startOfDay(now)
  let from = today
  let to = today

  const y = today.getFullYear()
  const m = today.getMonth() // 0-based

  if (preset === 'last_365') {
    from = addDays(today, -365)
    to = today
  } else if (preset === 'mtd') {
    from = new Date(y, m, 1)
    to = today
  } else if (preset === 'qtd') {
    const qStartMonth = Math.floor(m / 3) * 3
    from = new Date(y, qStartMonth, 1)
    to = today
  } else if (preset === 'ytd') {
    from = new Date(y, 0, 1)
    to = today
  } else if (preset === 'last_month') {
    const firstThisMonth = new Date(y, m, 1)
    const lastPrevMonth = addDays(firstThisMonth, -1)
    from = new Date(lastPrevMonth.getFullYear(), lastPrevMonth.getMonth(), 1)
    to = lastPrevMonth
  } else if (preset === 'last_quarter') {
    const currentQuarter = Math.floor(m / 3)
    const prevQuarter = (currentQuarter + 3 - 1) % 4
    const yearForPrev = currentQuarter === 0 ? y - 1 : y
    const prevStartMonth = prevQuarter * 3
    const prevStart = new Date(yearForPrev, prevStartMonth, 1)
    const currQuarterStart = new Date(y, currentQuarter * 3, 1)
    const prevEnd = addDays(currQuarterStart, -1)
    from = prevStart
    to = prevEnd
  } else if (preset === 'last_30') {
    from = addDays(today, -30)
    to = today
  } else if (preset === 'last_business_day') {
    // Previous business day (ignoring market holidays, only skipping weekend)
    const dow = today.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
    let prev: Date
    if (dow === 1) {
      // Monday -> previous Friday
      prev = addDays(today, -3)
    } else if (dow === 0) {
      // Sunday -> previous Friday
      prev = addDays(today, -2)
    } else {
      prev = addDays(today, -1)
    }
    from = prev
    to = prev
  }

  const fromDate = formatYmd(from)
  const toDate = formatYmd(to)
  const sinceTs = Math.floor(from.getTime() / 1000)
  const untilTs = Math.floor(addDays(to, 1).getTime() / 1000) // end of 'to' day

  return { fromDate, toDate, sinceTs, untilTs }
}

/** Same as getRangeForPreset but for Flex API: Last 365 uses toDate=yesterday, fromDate=yesterday-365 (yyyyMMdd), matching IB XML fromDate/toDate so report is available. */
export function getFlexRangeForPreset(preset: RangePreset): {
  fromDate: string
  toDate: string
  sinceTs: number
  untilTs: number
} {
  const now = new Date()
  const today = startOfDay(now)
  if (preset === 'last_365') {
    const yesterday = addDays(today, -1)
    const from = addDays(yesterday, -365)
    return {
      fromDate: formatYmd(from),
      toDate: formatYmd(yesterday),
      sinceTs: Math.floor(from.getTime() / 1000),
      untilTs: Math.floor(addDays(yesterday, 1).getTime() / 1000),
    }
  }
  const r = getRangeForPreset(preset)
  const from = r.fromDate ?? formatYmd(today)
  const to = r.toDate ?? formatYmd(today)
  return {
    fromDate: from,
    toDate: to,
    sinceTs: r.sinceTs ?? Math.floor(today.getTime() / 1000),
    untilTs: r.untilTs ?? Math.floor(addDays(today, 1).getTime() / 1000),
  }
}

function getPeriodKey(ts: number | string, mode: SummaryMode): string {
  const sec = Number(ts)
  if (!Number.isFinite(sec)) return ''
  const d = new Date(sec > 1e12 ? sec : sec * 1000)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() // 0-based
  if (Number.isNaN(y) || Number.isNaN(m)) return ''
  if (mode === 'year') return String(y)
  if (mode === 'month') return `${y}-${String(m + 1).padStart(2, '0')}`
  const q = Math.floor(m / 3) + 1
  return `${y} Q${q}`
}

export function TransferPayPage({ status: _status, onViewChange }: TransferPayPageProps) {
  const [transactions, setTransactions] = useState<AccountTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchLoading, setFetchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchMessage, setFetchMessage] = useState<string | null>(null)
  const [activeAccountId, setActiveAccountId] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<Set<SummaryTypeKey>>(() => new Set<SummaryTypeKey>(['deposit', 'withdrawal', 'dividend', 'other']))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(15)
  const [summaryMode, setSummaryMode] = useState<SummaryMode>('year')
  const [rangePreset, setRangePreset] = useState<RangePreset>('last_365')

  const loadTransactions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { sinceTs, untilTs } = getRangeForPreset(rangePreset)
      const res = await getTransactions({
        since_ts: sinceTs,
        until_ts: untilTs,
        limit: 500,
      })
      setTransactions(res.transactions ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transactions')
      setTransactions([])
    } finally {
      setLoading(false)
    }
  }, [rangePreset])

  useEffect(() => {
    loadTransactions()
  }, [loadTransactions])

  const handleFetchFromIb = async () => {
    setFetchLoading(true)
    setFetchMessage(null)
    try {
      const { fromDate, toDate } = getRangeForPreset(rangePreset)
      // Last 365 calendar days: do not send dates so Flex uses query default period (avoids IB 1001/1003).
      const payload =
        rangePreset === 'last_365'
          ? {}
          : { from_date: fromDate, to_date: toDate }
      const res = await postTransactionsFetch(payload)
      if (res.ok) {
        setFetchMessage(res.message ?? `Fetched ${res.count ?? 0} transaction(s).`)
        await loadTransactions()
      } else {
        setFetchMessage(res.error ?? 'Fetch failed')
      }
    } catch (e) {
      setFetchMessage(e instanceof Error ? e.message : 'Fetch failed')
    } finally {
      setFetchLoading(false)
    }
  }

  // Reset pagination when filter or pageSize changes
  useEffect(() => {
    setPage(1)
  }, [activeAccountId, transactions.length, pageSize])

  const accountIds = Array.from(
    new Set(
      transactions
        .map((tx) => tx.account_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    )
  ).sort()

  const visibleTransactions =
    activeAccountId === 'all'
      ? transactions
      : transactions.filter((tx) => tx.account_id === activeAccountId)

  const filteredTransactions = visibleTransactions.filter((tx) => {
    const key = getSummaryType((tx as any).type as string | null | undefined)
    return typeFilter.has(key)
  })

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pagedTransactions = filteredTransactions.slice((safePage - 1) * pageSize, safePage * pageSize)

  const totalAmount = filteredTransactions.reduce((sum, tx) => {
    const v = typeof tx.amount === 'number' && Number.isFinite(tx.amount) ? tx.amount : 0
    return sum + v
  }, 0)

  // Summary by period (year / quarter / month) and account
  const summaryByPeriod: Record<string, Record<string, number>> = {}
  const summaryByType: Record<string, Record<SummaryTypeKey, number>> = {}
  const allSummaryAccounts = accountIds.length > 0 ? accountIds : []
  for (const tx of transactions) {
    if (!tx || !tx.account_id) continue
    const amt = Number(tx.amount)
    const tsSec = Number(tx.ts)
    if (!Number.isFinite(amt) || !Number.isFinite(tsSec)) continue
    const key = getPeriodKey(tsSec, summaryMode)
    if (!key) continue
    const acc = tx.account_id
    if (!summaryByPeriod[key]) summaryByPeriod[key] = {}
    summaryByPeriod[key][acc] = (summaryByPeriod[key][acc] ?? 0) + amt
    const tKey = getSummaryType((tx as any).type as string | null | undefined)
    if (!summaryByType[key]) {
      summaryByType[key] = { deposit: 0, withdrawal: 0, dividend: 0, other: 0 }
    }
    summaryByType[key][tKey] = (summaryByType[key][tKey] ?? 0) + amt
  }

  // Compute change vs previous period in chronological order, then display in reverse (latest first)
  const chronologicalKeys = Object.keys(summaryByPeriod).sort() // oldest -> newest
  const changeTotalByKey: Record<string, number | null> = {}
  const changeDepByKey: Record<string, number | null> = {}
  const changeWdrByKey: Record<string, number | null> = {}
  const changeDivByKey: Record<string, number | null> = {}
  const changeOthByKey: Record<string, number | null> = {}

  for (let i = 0; i < chronologicalKeys.length; i += 1) {
    const pk = chronologicalKeys[i]
    const row = summaryByPeriod[pk] || {}
    const typeRow = summaryByType[pk] || { deposit: 0, withdrawal: 0, dividend: 0, other: 0 }
    const total = allSummaryAccounts.reduce((sum, acc) => sum + (row[acc] ?? 0), 0)
    const dep = typeRow.deposit ?? 0
    const wdr = typeRow.withdrawal ?? 0
    const div = typeRow.dividend ?? 0
    const oth = typeRow.other ?? 0

    if (i === 0) {
      changeTotalByKey[pk] = null
      changeDepByKey[pk] = null
      changeWdrByKey[pk] = null
      changeDivByKey[pk] = null
      changeOthByKey[pk] = null
      continue
    }

    const prevPk = chronologicalKeys[i - 1]
    const prevRow = summaryByPeriod[prevPk] || {}
    const prevTypeRow = summaryByType[prevPk] || { deposit: 0, withdrawal: 0, dividend: 0, other: 0 }
    const prevTotal = allSummaryAccounts.reduce((sum, acc) => sum + (prevRow[acc] ?? 0), 0)
    const prevDep = prevTypeRow.deposit ?? 0
    const prevWdr = prevTypeRow.withdrawal ?? 0
    const prevDiv = prevTypeRow.dividend ?? 0
    const prevOth = prevTypeRow.other ?? 0

    changeTotalByKey[pk] = total !== 0 ? ((total - prevTotal) / Math.abs(total)) * 100 : null
    changeDepByKey[pk] = dep !== 0 ? ((dep - prevDep) / Math.abs(dep)) * 100 : null
    changeWdrByKey[pk] = wdr !== 0 ? ((wdr - prevWdr) / Math.abs(wdr)) * 100 : null
    changeDivByKey[pk] = div !== 0 ? ((div - prevDiv) / Math.abs(div)) * 100 : null
    changeOthByKey[pk] = oth !== 0 ? ((oth - prevOth) / Math.abs(oth)) * 100 : null
  }

  // Display latest period first
  const periodKeys = [...chronologicalKeys].reverse()

  return (
    <div className="card process-section transfer-pay-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 id="transfer-pay-head" style={{ margin: 0 }} className="page-title-with-tooltip">
          <button
            type="button"
            className="page-title-breadcrumb-link"
            onClick={() => onViewChange?.('accounts')}
          >
            Portfolio
          </button>
          {' / Transfer & Pay'}
          <InfoTooltip text="Data is stored in account_transactions and used for Performance net cash flow. Configure in Settings → IB Connection → Flex." />
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <fieldset
            className="performance-filter"
            style={{ border: 'none', padding: 0, margin: 0 }}
            aria-label="IB Flex fetch range"
          >
            <span className="performance-filter-legend-inline">Range</span>
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as RangePreset)}
              aria-label="IB Flex date range for fetch"
            >
              <option value="last_365">Last 365 calendar days</option>
              <option value="mtd">Month to date</option>
              <option value="qtd">Quarter to date</option>
              <option value="ytd">Year to date</option>
              <option value="last_month">Last month</option>
              <option value="last_quarter">Last quarter</option>
              <option value="last_30">Last 30 calendar days</option>
              <option value="last_business_day">Last business day</option>
            </select>
          </fieldset>
          <button
            type="button"
            className="btn-resume"
            disabled={fetchLoading}
            onClick={handleFetchFromIb}
            aria-busy={fetchLoading}
            title="Pull cash transactions from IB Flex for selected range and write to account_transactions"
          >
            {fetchLoading ? 'Fetching…' : 'Fetch from IB'}
          </button>
        </div>
      </div>

      {fetchMessage != null && (
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: 0, color: (fetchMessage.startsWith('Fetched') || fetchMessage.includes('Upserted')) ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {fetchMessage}
        </p>
      )}

      {error != null && <p className="section-hint error-hint" role="alert">{error}</p>}

      <section className="replay-section" aria-label="Cash transactions">
        {loading ? (
          <p className="section-hint">Loading…</p>
        ) : (
          <>
            <div className="replay-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <div className="app-tabs" aria-label="Account tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeAccountId === 'all'}
                  className={`app-tab ${activeAccountId === 'all' ? 'active' : ''}`}
                  onClick={() => setActiveAccountId('all')}
                >
                  All accounts
                </button>
                {accountIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={activeAccountId === id}
                    className={`app-tab ${activeAccountId === id ? 'active' : ''}`}
                    onClick={() => setActiveAccountId(id)}
                  >
                    {id}
                  </button>
                ))}
              </div>
              <fieldset className="transferpay-types-filter" aria-label="Transaction types">
                <span className="transferpay-types-legend">Types</span>
                <div className="transferpay-types-pills">
                  <label className={`transferpay-type-pill ${typeFilter.size === 4 ? 'active' : ''}`}>
                    <input
                      type="checkbox"
                      className="transferpay-type-pill-input"
                      checked={typeFilter.size === 4}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setTypeFilter(new Set<SummaryTypeKey>(['deposit', 'withdrawal', 'dividend', 'other']))
                        } else {
                          setTypeFilter(new Set<SummaryTypeKey>())
                        }
                      }}
                      aria-label="All transaction types"
                    />
                    <span className="transferpay-type-pill-label">All</span>
                  </label>
                  {(['deposit', 'withdrawal', 'dividend', 'other'] as SummaryTypeKey[]).map((t) => (
                    <label
                      key={t}
                      className={`transferpay-type-pill ${typeFilter.has(t) ? 'active' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="transferpay-type-pill-input"
                        checked={typeFilter.has(t)}
                        onChange={() => {
                          setTypeFilter((prev) => {
                            const next = new Set(prev)
                            if (next.has(t)) {
                              next.delete(t)
                            } else {
                              next.add(t)
                            }
                            return next
                          })
                        }}
                        aria-label={t === 'other' ? 'Other' : t.charAt(0).toUpperCase() + t.slice(1)}
                      />
                      <span className="transferpay-type-pill-label">
                        {t === 'deposit'
                          ? 'Deposit'
                          : t === 'withdrawal'
                          ? 'Withdrawal'
                          : t === 'dividend'
                          ? 'Dividend'
                          : 'Other'}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
                <label className="section-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span>Rows:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value) || 30)}
                    style={{ minWidth: '4.25rem' }}
                    aria-label="Rows per page"
                  >
                    <option value={10}>10</option>
                    <option value={15}>15</option>
                    <option value={30}>30</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
                <span className="section-hint">
                  Net cash:{' '}
                  <span style={{ fontWeight: 600 }}>
                    {fmtUsd(totalAmount)}
                  </span>
                </span>
                {visibleTransactions.length > 0 && (
                  <div className="table-pagination" aria-label="Transaction pages">
                    <button
                      type="button"
                      className="btn btn-small btn-secondary"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      Prev
                    </button>
                    <span className="table-pagination-info" style={{ whiteSpace: 'nowrap' }}>
                      Page {safePage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small btn-secondary"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="table-wrap">
              <table className="system-table" aria-label="Cash transactions">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Currency</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedTransactions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty-cell">
                        No transactions for this selection.
                      </td>
                    </tr>
                  ) : (
                    pagedTransactions.map((tx) => (
                      <tr key={`${tx.account_id}-${tx.ts}-${tx.amount}-${tx.type}`}>
                        <td>{fmtDate(tx.ts, { locale: 'en-CA' })}</td>
                        <td>{tx.account_id ?? '—'}</td>
                        <td>{tx.type ?? '—'}</td>
                        <td className={tx.amount >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                          {fmtUsd(tx.amount)}
                        </td>
                        <td>{tx.currency ?? '—'}</td>
                        <td title={tx.description ?? ''}>{tx.description ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="replay-section" aria-label="Cash flow summary">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem', marginBottom: '0.25rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem' }} className="page-title-with-tooltip">
            Summary by period
            <InfoTooltip text="Net cash flow per account and in total, grouped by year / quarter / month for the loaded range (last 365 days or current fetch window)." />
          </h3>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <span className="section-hint" style={{ fontSize: '0.8rem' }}>View:</span>
            <div className="app-tabs" role="tablist" aria-label="Summary period">
              {(['year', 'quarter', 'month'] as SummaryMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={summaryMode === mode}
                  className={`app-tab ${summaryMode === mode ? 'active' : ''}`}
                  onClick={() => setSummaryMode(mode)}
                >
                  {mode === 'year' ? 'Year' : mode === 'quarter' ? 'Quarter' : 'Month'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {transactions.length === 0 ? (
          <p className="section-hint">No transactions yet. Fetch from IB to see summary.</p>
        ) : periodKeys.length === 0 ? (
          <p className="section-hint">No summary available for the selected period.</p>
        ) : (
          <div className="table-wrap">
            <table className="system-table" aria-label="Cash flow summary">
              <thead>
                <tr>
                  <th>Period</th>
                  {allSummaryAccounts.map((id) => (
                    <th key={id}>{id}</th>
                  ))}
                  <th>Total</th>
                  <th>Deposit</th>
                  <th>Withdrawal</th>
                  <th>Dividend</th>
                  <th>Other</th>
                </tr>
              </thead>
              <tbody>
                {periodKeys.map((pk) => {
                  const row = summaryByPeriod[pk] || {}
                  const total = allSummaryAccounts.reduce((sum, acc) => sum + (row[acc] ?? 0), 0)
                  const typeRow = summaryByType[pk] || { deposit: 0, withdrawal: 0, dividend: 0, other: 0 }
                  const dep = typeRow.deposit ?? 0
                  const wdr = typeRow.withdrawal ?? 0
                  const div = typeRow.dividend ?? 0
                  const oth = typeRow.other ?? 0
                  const changeVsPrevTotal = changeTotalByKey[pk] ?? null
                  const changeVsPrevDep = changeDepByKey[pk] ?? null
                  const changeVsPrevWdr = changeWdrByKey[pk] ?? null
                  const changeVsPrevDiv = changeDivByKey[pk] ?? null
                  const changeVsPrevOth = changeOthByKey[pk] ?? null
                  return (
                    <tr key={pk}>
                      <td>{pk}</td>
                      {allSummaryAccounts.map((id) => {
                        const v = row[id] ?? 0
                        return (
                          <td key={id} className={v >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                            {fmtUsd(v)}
                          </td>
                        )
                      })}
                      <td className={total >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                        <span>{fmtUsd0(total)}</span>
                        <br />
                        <span className="section-hint">
                          {changeVsPrevTotal != null && Number.isFinite(changeVsPrevTotal) ? (
                            <>
                              {changeVsPrevTotal >= 0 ? '+' : ''}
                              {changeVsPrevTotal.toFixed(1)}% vs prev
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </td>
                      <td className={dep >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                        <span>{fmtUsd0(dep)}</span>
                        <br />
                        <span className="section-hint">
                          {changeVsPrevDep != null && Number.isFinite(changeVsPrevDep) ? (
                            <>
                              {changeVsPrevDep >= 0 ? '+' : ''}
                              {changeVsPrevDep.toFixed(1)}% vs prev
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </td>
                      <td className={wdr >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                        <span>{fmtUsd0(wdr)}</span>
                        <br />
                        <span className="section-hint">
                          {changeVsPrevWdr != null && Number.isFinite(changeVsPrevWdr) ? (
                            <>
                              {changeVsPrevWdr >= 0 ? '+' : ''}
                              {changeVsPrevWdr.toFixed(1)}% vs prev
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </td>
                      <td className={div >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                        <span>{fmtUsd0(div)}</span>
                        <br />
                        <span className="section-hint">
                          {changeVsPrevDiv != null && Number.isFinite(changeVsPrevDiv) ? (
                            <>
                              {changeVsPrevDiv >= 0 ? '+' : ''}
                              {changeVsPrevDiv.toFixed(1)}% vs prev
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </td>
                      <td className={oth >= 0 ? 'replay-pnl-detail-positive' : 'replay-pnl-detail-negative'}>
                        <span>{fmtUsd0(oth)}</span>
                        <br />
                        <span className="section-hint">
                          {changeVsPrevOth != null && Number.isFinite(changeVsPrevOth) ? (
                            <>
                              {changeVsPrevOth >= 0 ? '+' : ''}
                              {changeVsPrevOth.toFixed(1)}% vs prev
                            </>
                          ) : (
                            '—'
                          )}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
