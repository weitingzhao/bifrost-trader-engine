import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse, AccountTransaction } from '../types'
import { getTransactions, postTransactionsFetch } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'

interface TransferPayPageProps {
  status: StatusResponse | null
  onViewChange?: (view: 'accounts') => void
}

function fmtDate(ts: number | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const sec = Number(ts)
  const d = new Date(sec > 1e12 ? sec : sec * 1000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
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

export function TransferPayPage({ status: _status, onViewChange }: TransferPayPageProps) {
  const [transactions, setTransactions] = useState<AccountTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchLoading, setFetchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchMessage, setFetchMessage] = useState<string | null>(null)

  const loadTransactions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const until = Math.floor(Date.now() / 1000)
      const since = until - 365 * 24 * 3600
      const res = await getTransactions({ since_ts: since, until_ts: until, limit: 500 })
      setTransactions(res.transactions ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transactions')
      setTransactions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTransactions()
  }, [loadTransactions])

  const handleFetchFromIb = async () => {
    setFetchLoading(true)
    setFetchMessage(null)
    try {
      const res = await postTransactionsFetch()
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
          <InfoTooltip text="Data is stored in account_transactions and used for Performance net cash flow. Configure flex.accounts in config.yaml." />
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-resume"
            disabled={fetchLoading}
            onClick={handleFetchFromIb}
            aria-busy={fetchLoading}
            title="Pull cash transactions from IB Flex (last 365 days) and write to account_transactions"
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

      <p className="section-hint">
        Cash transactions (deposits, withdrawals, transfers) from IB Flex. Fetch uses last 365 days from today.
      </p>

      {error != null && <p className="section-hint error-hint" role="alert">{error}</p>}

      <section className="replay-section" aria-label="Cash transactions">
        {loading ? (
          <p className="section-hint">Loading…</p>
        ) : (
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
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      No transactions. Click &quot;Fetch from IB&quot; to pull cash transactions from Flex (last 365 days).
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={`${tx.account_id}-${tx.ts}-${tx.amount}-${tx.type}`}>
                      <td>{fmtDate(tx.ts)}</td>
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
        )}
      </section>
    </div>
  )
}
