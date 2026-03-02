import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Bar,
  Execution,
  IbAccountSnapshot,
  Operation,
  OptExecutionGroup,
  RiskSummaryResponse,
  StatusResponse,
} from '../types'
import {
  fetchBars,
  fetchExecutions,
  fetchRiskSummary,
  postBarsFetch,
  postExecutionsFetch,
} from '../api'

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

function getContractLabelParts(contract_key: string): { symbol: string; rightLabel: string } {
  const parts = contract_key.split('|')
  const symbol = parts[0]?.trim() || ''
  const right = (parts[4] ?? parts[parts.length - 1] ?? '').toString().toUpperCase()
  const rightLabel = right === 'C' ? 'CALL' : right === 'P' ? 'PUT' : right || ''
  return { symbol, rightLabel }
}

interface PositionPnlPageProps {
  status: StatusResponse | null
  operations: Operation[]
}

export function PositionPnlPage({ status, operations }: PositionPnlPageProps) {
  const [riskSummary, setRiskSummary] = useState<RiskSummaryResponse | null>(null)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [bars, setBars] = useState<Bar[]>([])
  const [replayLoading, setReplayLoading] = useState(false)
  const [replaySyncing, setReplaySyncing] = useState(false)
  const [barsSyncing, setBarsSyncing] = useState(false)
  const [replayFetchDays, setReplayFetchDays] = useState<1 | 3 | 7>(1)
  const [replayBarSymbol, setReplayBarSymbol] = useState('')

  const replayBarCandidateSymbols = useMemo(() => {
    const fromStatus = riskSummary?.symbol ? [riskSummary.symbol] : []
    const fromExec = (executions || []).map(e => e.symbol).filter((s): s is string => Boolean(s?.trim()))
    const fromAccounts = (status?.accounts || []).flatMap((acc: IbAccountSnapshot) =>
      (acc.positions || []).map(p => p.symbol).filter((s): s is string => Boolean(s?.trim())),
    )
    return [...new Set([...fromStatus, ...fromExec, ...fromAccounts])]
  }, [riskSummary?.symbol, executions, status?.accounts])

  const optExecutionGroups = useMemo((): OptExecutionGroup[] => {
    const opt = executions.filter(e => (e.sec_type ?? '').toUpperCase() === 'OPT')
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
  }, [executions])

  const loadReplayData = useCallback(async () => {
    setReplayLoading(true)
    try {
      const summary = await fetchRiskSummary()
      setRiskSummary(summary)
      const [execRes, barsRes] = await Promise.all([
        fetchExecutions(undefined, undefined, 100),
        fetchBars(summary?.symbol ?? undefined, '1 D', 100),
      ])
      setExecutions(execRes.executions || [])
      setBars(barsRes.bars || [])
    } catch {
      setRiskSummary(null)
      setExecutions([])
      setBars([])
    } finally {
      setReplayLoading(false)
    }
  }, [])

  useEffect(() => {
    loadReplayData()
  }, [loadReplayData])

  useEffect(() => {
    if (replayBarCandidateSymbols.length > 0 && !replayBarSymbol.trim())
      setReplayBarSymbol(replayBarCandidateSymbols[0])
  }, [replayBarCandidateSymbols.join(','), replayBarSymbol])

  return (
    <div className="card process-section replay-page">
      <h2>头寸盈亏</h2>
      <p className="section-desc">围绕期权及其对冲股票腿的头寸结构与盈亏分析，与实时监控分离。</p>
      <div className="replay-toolbar">
        <label htmlFor="replay-fetch-days" className="replay-fetch-days-label">拉取范围</label>
        <select
          id="replay-fetch-days"
          className="replay-fetch-days-select"
          value={replayFetchDays}
          onChange={e => setReplayFetchDays(Number(e.target.value) as 1 | 3 | 7)}
          disabled={replaySyncing}
          aria-label="执行记录拉取时间范围"
        >
          <option value={1}>当天</option>
          <option value={3}>最近 3 天</option>
          <option value={7}>最近 7 天</option>
        </select>
        <button
          type="button"
          className="btn btn-secondary"
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
          aria-label="从 IB 拉取执行记录并写入数据库"
        >
          {replaySyncing ? '拉取中…' : '刷新复盘数据'}
        </button>
        {replaySyncing && (
          <span className="replay-sync-hint">正在连接 IB 拉取执行记录…</span>
        )}
      </div>

      <section className="replay-section" aria-labelledby="risk-summary-head">
        <h3 id="risk-summary-head">风险评估模型</h3>
        {replayLoading ? (
          <p className="section-hint">加载中…</p>
        ) : riskSummary ? (
          <div className="risk-summary-cards">
            <div className="risk-card">
              <span className="risk-card-label">当日对冲次数</span>
              <span className="risk-card-value">{riskSummary.daily_hedge_count ?? '—'}</span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">当日 PnL (USD)</span>
              <span className="risk-card-value">
                {fmtUsd(riskSummary.daily_pnl)}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">标的现价</span>
              <span className="risk-card-value">
                {fmtUsd(riskSummary.spot)}
              </span>
            </div>
            <div className="risk-card">
              <span className="risk-card-label">近 24h 操作条数</span>
              <span className="risk-card-value">{riskSummary.operations_count_24h ?? 0}</span>
            </div>
          </div>
        ) : (
          <p className="section-hint">无法获取风险评估摘要（请确认 API 与数据库可用）。</p>
        )}
      </section>

      <section className="replay-section" aria-labelledby="trade-records-head">
        <h3 id="trade-records-head">交易记录</h3>
        <h4 className="replay-sub">本程序操作（对冲相关）</h4>
        <p className="section-hint">来自 GET /operations；账户级执行记录（R-A2）在下方「账户执行」中展示。</p>
        <table className="table-operations">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>方向</th>
              <th>数量</th>
              <th>价格</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {operations.length === 0 ? (
              <tr><td colSpan={6}>无</td></tr>
            ) : (
              operations.slice(0, 50).map((op, i) => (
                <tr key={`${op.ts}-${i}`}>
                  <td>{fmtTs(op.ts)}</td>
                  <td>{op.type ?? ''}</td>
                  <td>{op.side ?? ''}</td>
                  <td>{op.quantity ?? ''}</td>
                  <td>{fmtUsd(op.price)}</td>
                  <td>{op.state_reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <h4 className="replay-sub">账户执行（R-A2）</h4>
        {executions.length === 0 ? (
          <p className="section-hint">暂无数据；点击「刷新复盘数据」从 IB 拉取并写入数据库。</p>
        ) : (
          <>
            {optExecutionGroups.length > 0 && (
              <>
                <p className="section-hint">
                  期权按 contract_key 与 strike 分组；Cost/Premium = Size×@×100−Commission（commission 来自 account_execution_commissions）；盈利 = Premium − Cost，按状态着色（已兑现绿、未兑现黄）。
                </p>
                <table className="table-operations replay-opt-groups">
                  <thead>
                    <tr>
                      <th rowSpan={2}>合约</th>
                      <th rowSpan={2}>到期日</th>
                      <th rowSpan={2}>Strike</th>
                      <th colSpan={3}>BUY</th>
                      <th colSpan={3}>SELL</th>
                      <th rowSpan={2}>净持仓</th>
                      <th rowSpan={2}>状态</th>
                      <th rowSpan={2}>盈利</th>
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
                    {optExecutionGroups.map((g, idx) => {
                      const stateLabel = g.net_qty === 0 ? '已兑现' : g.net_qty > 0 ? 'Holding' : 'Selling'
                      return (
                        <tr key={`${g.contract_key}-${g.strike}-${idx}`}>
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
                          <td>{fmtUsd(g.strike)}</td>
                          <td>{g.buy_volume}</td>
                          <td>{fmtUsd(g.buy_avg_price)}</td>
                          <td><span className="replay-cost">{fmtUsd(g.buy_cost)}</span></td>
                          <td>{g.sell_volume}</td>
                          <td>{fmtUsd(g.sell_avg_price)}</td>
                          <td><span className="replay-premium">{fmtUsd(g.sell_premium)}</span></td>
                          <td>{g.net_qty}</td>
                          <td>
                            <span className={g.status === 'realized' ? 'replay-status-realized' : 'replay-status-unrealized'}>
                              {stateLabel}
                            </span>
                          </td>
                          <td>
                            <span className={g.status === 'realized' ? 'replay-pnl-realized' : 'replay-pnl-unrealized'}>
                              {fmtUsd0(g.realized_pnl)}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <h5 className="replay-sub replay-opt-detail-title">期权分组明细（逐笔）</h5>
                <table className="table-operations">
                  <thead>
                    <tr>
                      <th>合约</th>
                      <th>Strike</th>
                      <th>时间</th>
                      <th>方向</th>
                      <th>数量</th>
                      <th>成交价</th>
                      <th>手续费</th>
                      <th>PnL</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optExecutionGroups.flatMap((g, gi) =>
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
                          <tr key={`${gi}-${ti}-${ex.time ?? ti}`}>
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
                            <td>{fmtUsd(g.strike)}</td>
                            <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                            <td>{sideLabel}</td>
                            <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                            <td>{fmtUsd(ex.price)}</td>
                            <td>{fmtUsd(ex.commission)}</td>
                            <td>
                              <span className={pnlClass}>{fmtUsd(pnl)}</span>
                            </td>
                            <td>{ex.source ?? '—'}</td>
                          </tr>
                        )
                      }),
                    )}
                  </tbody>
                </table>
              </>
            )}

            {executions.some(e => (e.sec_type ?? '').toUpperCase() !== 'OPT') && (
              <>
                <h5 className="replay-sub">非期权（股票等）明细</h5>
                <table className="table-operations">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>标的</th>
                      <th>方向</th>
                      <th>数量</th>
                      <th>成交价</th>
                      <th>手续费</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executions
                      .filter(ex => (ex.sec_type ?? '').toUpperCase() !== 'OPT')
                      .map((ex, i) => {
                        const s = (ex.side ?? '').toUpperCase()
                        const sideLabel =
                          s === 'BUY' || s === 'BOT' || s === 'B'
                            ? '买'
                            : s === 'SELL' || s === 'SLD' || s === 'S'
                              ? '卖'
                              : (ex.side ?? '—')
                        return (
                          <tr key={i}>
                            <td>{ex.time != null ? fmtTs(ex.time) : '—'}</td>
                            <td>{ex.symbol ?? '—'}</td>
                            <td>{sideLabel}</td>
                            <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                            <td>{fmtUsd(ex.price)}</td>
                            <td>{fmtUsd(ex.commission)}</td>
                            <td>{ex.source ?? '—'}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </section>

      <section className="replay-section" aria-labelledby="bars-head">
        <h3 id="bars-head">辅助行情（K 线）</h3>
        <p className="section-hint">
          按标的拉取日线，供复盘时结合成交时间查看当时行情。下方可输入标的代码，或从「当前持仓 + 交易记录」汇总的候选中选择。
        </p>
        <div className="replay-bar-symbol-row">
          <label htmlFor="replay-bar-symbol" className="replay-bar-symbol-label">标的</label>
          <input
            id="replay-bar-symbol"
            type="text"
            className="replay-bar-symbol-input"
            placeholder="输入标的代码，如 NVDA"
            value={replayBarSymbol}
            onChange={e => setReplayBarSymbol((e.target.value || '').trim().toUpperCase())}
            aria-label="拉取 K 线的标的代码"
          />
          {replayBarCandidateSymbols.length > 0 && (
            <span className="replay-sync-hint">可拉取：{replayBarCandidateSymbols.join(', ')}</span>
          )}
        </div>
        <div className="replay-toolbar">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={barsSyncing || replayLoading || !(replayBarSymbol.trim() || replayBarCandidateSymbols[0])}
            onClick={async () => {
              const symbol = replayBarSymbol.trim() || replayBarCandidateSymbols[0] || ''
              if (!symbol) return
              setBarsSyncing(true)
              const res = await postBarsFetch(symbol, '1 D', '30 D')
              setBarsSyncing(false)
              if (res.ok) setBars(res.bars ?? [])
            }}
            aria-label="从 IB 拉取 K 线并刷新列表"
          >
            {barsSyncing ? '拉取中…' : '拉取 K 线'}
          </button>
          {barsSyncing && (
            <span className="replay-sync-hint">正在由 API 直接连接 IB 拉取 K 线…</span>
          )}
        </div>
        {bars.length === 0 ? (
          <div className="replay-placeholder">暂无 K 线数据</div>
        ) : (
          <table className="table-operations">
            <thead>
              <tr>
                <th>时间</th>
                <th>开</th>
                <th>高</th>
                <th>低</th>
                <th>收</th>
                <th>量</th>
              </tr>
            </thead>
            <tbody>
              {bars.slice(0, 50).map((b, i) => (
                <tr key={i}>
                  <td>{b.time != null ? fmtTs(b.time) : '—'}</td>
                  <td>{fmtUsd(b.open)}</td>
                  <td>{fmtUsd(b.high)}</td>
                  <td>{fmtUsd(b.low)}</td>
                  <td>{fmtUsd(b.close)}</td>
                  <td>{b.volume != null ? Number(b.volume).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

