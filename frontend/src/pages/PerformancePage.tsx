import { useCallback, useEffect, useState } from 'react'
import type { IbAccountSnapshot, PerformanceResponse, StatusResponse } from '../types'
import { fetchPerformance } from '../api'

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

interface PerformancePageProps {
  status: StatusResponse | null
}

export function PerformancePage({ status }: PerformancePageProps) {
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string>('')
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day')
  const [daysBack, setDaysBack] = useState(90)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const until = Math.floor(Date.now() / 1000)
    const since = until - daysBack * 86400
    try {
      const res = await fetchPerformance({
        since_ts: since,
        until_ts: until,
        account_id: accountId || undefined,
        granularity,
      })
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load performance')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [daysBack, accountId, granularity])

  useEffect(() => {
    load()
  }, [load])

  const accounts: IbAccountSnapshot[] = status?.accounts ?? []
  const summary = data?.summary
  const calendar = data?.calendar ?? []

  return (
    <div className="app-page-stack performance-page">
      <section className="card" aria-label="Performance filters">
        <h2 className="card-title">Performance</h2>
        <p className="section-hint">
          基于账户执行记录的已实现盈亏与交易能力指标（R-M7 / R-H2）。数据来自 GET /executions。
        </p>
        <div className="performance-filters">
          <label className="performance-filter">
            <span>时间范围</span>
            <select
              value={daysBack}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              aria-label="Days back"
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
              <option value={180}>最近 180 天</option>
              <option value={365}>最近 1 年</option>
            </select>
          </label>
          <label className="performance-filter">
            <span>账户</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Account"
            >
              <option value="">全部</option>
              {accounts.map((acc) => (
                <option key={acc.account_id ?? ''} value={acc.account_id ?? ''}>
                  {acc.account_id ?? '—'}
                </option>
              ))}
            </select>
          </label>
          <label className="performance-filter">
            <span>粒度</span>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as 'day' | 'week' | 'month')}
              aria-label="Granularity"
            >
              <option value="day">按日</option>
              <option value="week">按周</option>
              <option value="month">按月</option>
            </select>
          </label>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </section>

      {error && (
        <div className="card card-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {data && summary && (
        <>
          <section className="card" aria-label="Summary metrics">
            <h3 className="card-subtitle">汇总指标</h3>
            <div className="performance-summary-grid">
              <div className="performance-metric">
                <span className="performance-metric-label">净盈亏 (Net PnL)</span>
                <span
                  className={`performance-metric-value tone-${(summary.net_pnl ?? 0) >= 0 ? 'positive' : 'negative'}`}
                >
                  {fmtUsd(summary.net_pnl)}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">已实现 PnL</span>
                <span className="performance-metric-value">{fmtUsd(summary.total_pnl)}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">手续费</span>
                <span className="performance-metric-value">{fmtUsd(summary.total_commission)}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">成交笔数</span>
                <span className="performance-metric-value">{summary.trade_count ?? 0}</span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">胜率</span>
                <span className="performance-metric-value">
                  {summary.win_rate != null ? `${summary.win_rate.toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">Profit Factor</span>
                <span className="performance-metric-value">
                  {summary.profit_factor != null ? summary.profit_factor.toFixed(2) : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">最大回撤</span>
                <span className="performance-metric-value tone-negative">
                  {summary.max_drawdown != null ? fmtUsd(-summary.max_drawdown) : '—'}
                </span>
              </div>
              <div className="performance-metric">
                <span className="performance-metric-label">平均盈利 / 平均亏损</span>
                <span className="performance-metric-value">
                  {fmtUsd(summary.avg_win)} / {fmtUsd(summary.avg_loss)}
                </span>
              </div>
            </div>
          </section>

          <section className="card" aria-label="Calendar PnL">
            <h3 className="card-subtitle">Calendar PnL</h3>
            {calendar.length === 0 ? (
              <p className="section-hint">选定范围内无成交记录。</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table" role="grid">
                  <thead>
                    <tr>
                      <th>周期</th>
                      <th>净盈亏</th>
                      <th>已实现 PnL</th>
                      <th>手续费</th>
                      <th>笔数</th>
                      <th>胜率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendar.map((row) => (
                      <tr key={row.period_label}>
                        <td>{row.period_label}</td>
                        <td className={row.net_pnl >= 0 ? 'tone-positive' : 'tone-negative'}>
                          {fmtUsd(row.net_pnl)}
                        </td>
                        <td>{fmtUsd(row.pnl)}</td>
                        <td>{fmtUsd(row.commission)}</td>
                        <td>{row.trade_count}</td>
                        <td>{row.win_rate != null ? `${row.win_rate.toFixed(1)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
