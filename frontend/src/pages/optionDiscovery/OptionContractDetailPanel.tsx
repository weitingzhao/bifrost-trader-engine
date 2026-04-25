import { bsComputeDetail } from '../../utils/bsCalc'
import type { GreeksCoverageResponse, LiquiditySummaryResponse, RelativeValueResponse, OptionSnapshotRow } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtUsd } from '../../utils/format'
import { OptionDiscoveryContractChartPanel } from './OptionDiscoveryContractChartPanel'
import { IvSmileChart, IvSmileLegend } from './OptionDiscoveryAnalytics'
import { OdChartExpandOnHover } from './OdChartExpandOnHover'
import { expirationDaysFromToday, parseExpirationDateParts } from './expirationMeta'
import {
  computeRelativeValue,
  computeScenarios,
  computeTradabilityScore,
  effectiveQuotePremium,
  fmtIV,
  fmtOptNum,
  type DerivedMetrics,
} from './optionContractMetrics'

export interface OptionContractDetailPanelProps {
  symbol: string
  expiration: string
  underlyingPrice: number | null
  selectedRow: OptionSnapshotRow
  selectedDerived: DerivedMetrics
  snapshotRows: OptionSnapshotRow[]
  greeksCoverage: GreeksCoverageResponse | null
  eventContextWarnings: string[]
  greeksSource: 'snapshot' | 'bs'
  onGreeksSourceChange: (v: 'snapshot' | 'bs') => void
  liquidityLastTrade: Record<string, unknown> | null
  liquidityQuoteCount: number | null
  liquidityLoading: boolean
  serverLiquidity: LiquiditySummaryResponse | null
  serverRelativeValue: RelativeValueResponse | null
  onClose: () => void
  onAddToWatchlist: () => void
  onAddToCompare: () => void
}

export function OptionContractDetailPanel({
  symbol,
  expiration,
  underlyingPrice,
  selectedRow,
  selectedDerived,
  snapshotRows,
  greeksCoverage,
  eventContextWarnings,
  greeksSource,
  onGreeksSourceChange,
  liquidityLastTrade,
  liquidityQuoteCount,
  liquidityLoading,
  serverLiquidity,
  serverRelativeValue,
  onClose,
  onAddToWatchlist,
  onAddToCompare,
}: OptionContractDetailPanelProps) {
  return (
    <>
      {eventContextWarnings.length > 0 && (
        <div className="od-event-warnings od-event-warnings--drawer" role="alert">
          {eventContextWarnings.map((w, i) => (
            <div key={i} className="od-event-warning-item">
              {w}
            </div>
          ))}
        </div>
      )}

      <div className="od-contract-detail od-contract-detail--drawer" aria-label="Contract detail">
        <div className="od-detail-header">
          <h3 className="od-detail-title">
            {symbol}{' '}
            {selectedRow.right === 'C' ? 'Call' : 'Put'} {selectedRow.strike.toFixed(2)}
            <span className="od-detail-expiry">
              {expiration} · {expirationDaysFromToday(expiration)} DTE
            </span>{' '}
            <span className={`od-moneyness-badge od-moneyness-badge--${selectedDerived.moneynessLabel.toLowerCase()}`}>
              {selectedDerived.moneynessLabel}
            </span>
          </h3>
          <button
            type="button"
            className="section-header-icon-btn od-detail-action-icon-btn"
            onClick={() => void onAddToWatchlist()}
            aria-label={`Add ${selectedRow.right === 'C' ? 'Call' : 'Put'} ${selectedRow.strike} to Watchlist`}
            title={`Add ${selectedRow.right === 'C' ? 'Call' : 'Put'} ${selectedRow.strike} to Watchlist`}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
          <button
            type="button"
            className="section-header-icon-btn od-detail-action-icon-btn"
            onClick={onAddToCompare}
            aria-label="Add current contract to compare"
            title="Add current contract to compare"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 4v16" />
              <path d="M18 4v16" />
              <path d="M9 7h6" />
              <path d="M9 12h6" />
              <path d="M9 17h6" />
            </svg>
          </button>
          <span className="od-detail-delayed">Massive · 15 min delayed</span>
          <button type="button" className="od-detail-close" onClick={onClose} aria-label="Close contract detail">
            ✕
          </button>
        </div>

        <div className="od-contract-detail-stack">
          <section className="od-detail-section" aria-labelledby="od-contract-sec-overview">
            <h4 id="od-contract-sec-overview" className="od-detail-section-title">
              Overview
            </h4>
            <div>
              <div className="od-card-grid">
                <div className="od-card-section">
                  <div className="od-card-section-title od-card-section-title--with-hint">
                    Price
                    <span className="od-card-section-source">Day</span>
                    <InfoTooltip text="Day bar OHLC from Massive (chain snapshot, 15 min delayed). Underlying spot for decomposition uses stock_day daily close when available." />
                  </div>
                  <div className="od-kv-grid">
                    {selectedRow.snapshot_ts && (
                      <>
                        <span className="od-kv-k">As of</span>
                        <span className="od-kv-v od-kv-dim">{new Date(selectedRow.snapshot_ts).toLocaleString()}</span>
                      </>
                    )}
                    <span className="od-kv-k">Open</span>
                    <span className="od-kv-v">{selectedRow.day_open != null ? fmtUsd(selectedRow.day_open) : '—'}</span>
                    <span className="od-kv-k">High</span>
                    <span className="od-kv-v">{selectedRow.day_high != null ? fmtUsd(selectedRow.day_high) : '—'}</span>
                    <span className="od-kv-k">Low</span>
                    <span className="od-kv-v">{selectedRow.day_low != null ? fmtUsd(selectedRow.day_low) : '—'}</span>
                    <span className="od-kv-k">Close</span>
                    <span className="od-kv-v">{selectedRow.day_close != null ? fmtUsd(selectedRow.day_close) : '—'}</span>
                    {selectedRow.day_volume != null && (
                      <>
                        <span className="od-kv-k">Vol</span>
                        <span className="od-kv-v">{selectedRow.day_volume.toLocaleString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title">Value Decomposition</div>
                  <div className="od-kv-grid">
                    <span className="od-kv-k">Intrinsic</span>
                    <span className="od-kv-v">{selectedDerived.intrinsic != null ? fmtUsd(selectedDerived.intrinsic) : '—'}</span>
                    <span className="od-kv-k">Extrinsic</span>
                    <span className="od-kv-v">{selectedDerived.extrinsic != null ? fmtUsd(selectedDerived.extrinsic) : '—'}</span>
                    <span className="od-kv-k">Breakeven</span>
                    <span className="od-kv-v">{selectedDerived.breakeven != null ? fmtUsd(selectedDerived.breakeven) : '—'}</span>
                    <span className="od-kv-k">Moneyness</span>
                    <span className="od-kv-v">
                      {selectedDerived.moneyness != null
                        ? `${selectedDerived.moneyness > 0 ? '+' : ''}${selectedDerived.moneyness.toFixed(2)}%`
                        : '—'}
                    </span>
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title">Underlying</div>
                  <div className="od-kv-grid">
                    <span className="od-kv-k">Symbol</span>
                    <span className="od-kv-v">{symbol}</span>
                    <span className="od-kv-k">Price</span>
                    <span className="od-kv-v">{underlyingPrice != null ? fmtUsd(underlyingPrice) : '—'}</span>
                    <span className="od-kv-k">Strike</span>
                    <span className="od-kv-v">{fmtUsd(selectedRow.strike)}</span>
                    <span className="od-kv-k">DTE</span>
                    <span className="od-kv-v">{expirationDaysFromToday(expiration)}</span>
                  </div>
                </div>
                <div className="od-card-section">
                  <div className="od-card-section-title od-card-section-title--with-hint">
                    Greeks
                    <span className="od-greeks-source-toggle">
                      <button
                        type="button"
                        className={`od-greeks-source-btn${greeksSource === 'snapshot' ? ' od-greeks-source-btn--active' : ''}`}
                        onClick={() => onGreeksSourceChange('snapshot')}
                        title="Show IV & Greeks from Massive snapshot data"
                      >
                        Snapshot
                      </button>
                      <button
                        type="button"
                        className={`od-greeks-source-btn${greeksSource === 'bs' ? ' od-greeks-source-btn--active' : ''}`}
                        onClick={() => onGreeksSourceChange('bs')}
                        title="Show IV & Greeks computed locally via Black-Scholes"
                      >
                        BS
                      </button>
                    </span>
                  </div>
                  {(() => {
                    if (greeksSource === 'snapshot') {
                      return (
                        <div className="od-kv-grid">
                          <span className="od-kv-k">IV</span>
                          <span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                          <span className="od-kv-k">Delta</span>
                          <span className="od-kv-v">{fmtOptNum(selectedRow.delta, 4)}</span>
                          <span className="od-kv-k">Gamma</span>
                          <span className="od-kv-v">{fmtOptNum(selectedRow.gamma, 4)}</span>
                          <span className="od-kv-k">Theta</span>
                          <span className="od-kv-v">{fmtOptNum(selectedRow.theta, 4)}</span>
                          <span className="od-kv-k">Vega</span>
                          <span className="od-kv-v">{fmtOptNum(selectedRow.vega, 4)}</span>
                          <span className="od-kv-k">OI</span>
                          <span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                        </div>
                      )
                    }
                    const bsParts = parseExpirationDateParts(expiration)
                    const bsDteDays = bsParts
                      ? Math.max(
                          0,
                          Math.round(
                            (new Date(bsParts.y, bsParts.m, bsParts.d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) /
                              86400000,
                          ),
                        )
                      : 0
                    const bsMktPrice = effectiveQuotePremium(selectedRow)
                    const bsD =
                      underlyingPrice != null && bsMktPrice != null && bsDteDays > 0
                        ? bsComputeDetail({
                            marketPrice: bsMktPrice,
                            S: underlyingPrice,
                            K: selectedRow.strike,
                            tYears: bsDteDays / 365,
                            r: 0.045,
                            right: selectedRow.right,
                          })
                        : null
                    if (bsD == null || bsD.iv == null) {
                      return (
                        <div className="od-kv-grid">
                          <span className="od-kv-k od-kv-dim" style={{ gridColumn: '1/-1', fontSize: '0.75rem' }}>
                            {bsDteDays === 0 ? '已到期，无法计算' : underlyingPrice == null ? '标的价格未知' : 'IV 求解失败'}
                          </span>
                          <span className="od-kv-k">OI</span>
                          <span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                        </div>
                      )
                    }
                    return (
                      <div className="od-kv-grid">
                        <span className="od-kv-k">IV</span>
                        <span className="od-kv-v">{bsD.iv != null ? (bsD.iv * 100).toFixed(2) + '%' : '—'}</span>
                        <span className="od-kv-k">Delta</span>
                        <span className="od-kv-v">{bsD.delta != null ? bsD.delta.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Gamma</span>
                        <span className="od-kv-v">{bsD.gamma != null ? bsD.gamma.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Theta</span>
                        <span className="od-kv-v">{bsD.thetaPerDay != null ? bsD.thetaPerDay.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">Vega/1%</span>
                        <span className="od-kv-v">{bsD.vegaPer1Pct != null ? bsD.vegaPer1Pct.toFixed(4) : '—'}</span>
                        <span className="od-kv-k">OI</span>
                        <span className="od-kv-v">{selectedRow.open_interest != null ? String(selectedRow.open_interest) : '—'}</span>
                      </div>
                    )
                  })()}
                </div>
              </div>

              {greeksCoverage?.ok && greeksCoverage.total != null && greeksCoverage.total > 0 && (
                <div className="od-quality-badge">
                  <span className="od-quality-badge-title">Data Quality</span>
                  <span className="od-quality-item" title="Percentage of contracts with IV data">
                    IV {greeksCoverage.coverage?.iv_pct ?? 0}%
                  </span>
                  <span className="od-quality-item" title="Percentage with full greeks (Δ,Γ,Θ,ν)">
                    Greeks {greeksCoverage.coverage?.full_greeks_pct ?? 0}%
                  </span>
                  {greeksCoverage.freshness?.newest_ts && (
                    <span className="od-quality-item" title="Most recent snapshot timestamp">
                      Fresh: {new Date(greeksCoverage.freshness.newest_ts).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>

          {(() => {
            const parts = parseExpirationDateParts(expiration)
            if (!parts) return null
            const { y, m, d } = parts
            const expDate = new Date(y, m, d)
            expDate.setHours(0, 0, 0, 0)
            const todayMs = new Date()
            todayMs.setHours(0, 0, 0, 0)
            const dteDays = Math.max(0, Math.round((expDate.getTime() - todayMs.getTime()) / 86400000))
            if (dteDays === 0) return null
            const mktPrice = effectiveQuotePremium(selectedRow)
            if (mktPrice == null || underlyingPrice == null) return null

            const bsDetail = bsComputeDetail({
              marketPrice: mktPrice,
              S: underlyingPrice,
              K: selectedRow.strike,
              tYears: dteDays / 365,
              r: 0.045,
              right: selectedRow.right,
            })

            function diffPct(local: number | null, snap: number | null): number | null {
              if (local == null || snap == null || snap === 0) return null
              return ((local - snap) / Math.abs(snap)) * 100
            }
            function diffClass(pct: number | null): string {
              if (pct == null) return ''
              const abs = Math.abs(pct)
              if (abs < 3) return 'od-bs-diff--ok'
              if (abs < 10) return 'od-bs-diff--warn'
              return 'od-bs-diff--alert'
            }
            function fmtDiff(pct: number | null): string {
              if (pct == null) return '—'
              return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%'
            }

            const ivDiff = diffPct(bsDetail.iv, selectedRow.iv ?? null)
            const deltaDiff = diffPct(bsDetail.delta, selectedRow.delta ?? null)
            const gammaDiff = diffPct(bsDetail.gamma, selectedRow.gamma ?? null)
            const thetaDiff = diffPct(bsDetail.thetaPerDay, selectedRow.theta ?? null)
            const vegaDiff = diffPct(bsDetail.vegaPer1Pct, selectedRow.vega ?? null)

            let mktSrc = 'mark'
            if (selectedRow.mark != null) mktSrc = 'mark/day_close'
            else if (selectedRow.mid != null) mktSrc = 'mid'
            else if (selectedRow.bid != null && selectedRow.ask != null) mktSrc = '(bid+ask)/2'
            else if (selectedRow.last != null) mktSrc = 'last'
            else if (selectedRow.day_close != null) mktSrc = 'day_close'

            return (
              <section className="od-detail-section od-bs-compare" aria-labelledby="od-contract-sec-bs">
                <h4 id="od-contract-sec-bs" className="od-detail-section-title">
                  BS vs Snapshot
                  <span className="od-bs-compare__note"> · Black-Scholes 欧式近似（美式期权，ATM 误差通常 &lt;3%）</span>
                </h4>
                <div className="od-bs-compare__meta">
                  S={`$${underlyingPrice.toFixed(2)}`} · K=${selectedRow.strike.toFixed(2)} · DTE={dteDays} · 市场价=${mktPrice.toFixed(4)} ({mktSrc}) · r=4.50%
                </div>
                {bsDetail.iv == null ? (
                  <div className="od-bs-compare__noiv">BS IV 求解失败（价格异常或深度 ITM/OTM）</div>
                ) : (
                  <table className="od-bs-compare__table">
                    <thead>
                      <tr>
                        <th>指标</th>
                        <th>Snapshot (Massive)</th>
                        <th>BS 计算</th>
                        <th>差值 %</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>IV</td>
                        <td>{selectedRow.iv != null ? (selectedRow.iv * 100).toFixed(2) + '%' : '—'}</td>
                        <td>{(bsDetail.iv * 100).toFixed(2)}%</td>
                        <td className={`od-bs-diff ${diffClass(ivDiff)}`}>{fmtDiff(ivDiff)}</td>
                      </tr>
                      <tr>
                        <td>Delta</td>
                        <td>{selectedRow.delta != null ? selectedRow.delta.toFixed(4) : '—'}</td>
                        <td>{bsDetail.delta != null ? bsDetail.delta.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(deltaDiff)}`}>{fmtDiff(deltaDiff)}</td>
                      </tr>
                      <tr>
                        <td>Gamma</td>
                        <td>{selectedRow.gamma != null ? selectedRow.gamma.toFixed(4) : '—'}</td>
                        <td>{bsDetail.gamma != null ? bsDetail.gamma.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(gammaDiff)}`}>{fmtDiff(gammaDiff)}</td>
                      </tr>
                      <tr>
                        <td>Theta/日</td>
                        <td>{selectedRow.theta != null ? selectedRow.theta.toFixed(4) : '—'}</td>
                        <td>{bsDetail.thetaPerDay != null ? bsDetail.thetaPerDay.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(thetaDiff)}`}>{fmtDiff(thetaDiff)}</td>
                      </tr>
                      <tr>
                        <td>
                          <span title="Vega per 1% IV change. Massive may report per 1 vol point (same unit). If ×100 gap appears, Massive uses per-unit convention.">
                            Vega/1%
                          </span>
                        </td>
                        <td>{selectedRow.vega != null ? selectedRow.vega.toFixed(4) : '—'}</td>
                        <td>{bsDetail.vegaPer1Pct != null ? bsDetail.vegaPer1Pct.toFixed(4) : '—'}</td>
                        <td className={`od-bs-diff ${diffClass(vegaDiff)}`}>
                          {fmtDiff(vegaDiff)}
                          {vegaDiff != null && Math.abs(vegaDiff) > 80 && <span className="od-bs-diff__hint"> 单位?</span>}
                        </td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} className="od-bs-compare__legend">
                          <span className="od-bs-diff od-bs-diff--ok">■</span> &lt;3%&nbsp;&nbsp;
                          <span className="od-bs-diff od-bs-diff--warn">■</span> 3–10%&nbsp;&nbsp;
                          <span className="od-bs-diff od-bs-diff--alert">■</span> &gt;10%
                          &nbsp;·&nbsp;NR {bsDetail.iterCount} 次迭代 {bsDetail.converged ? '✓' : '(未收敛)'}
                          &nbsp;·&nbsp;BS 理论价={bsDetail.bsModelPrice != null ? `$${bsDetail.bsModelPrice.toFixed(4)}` : '—'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>
            )
          })()}

          <section className="od-detail-section" aria-labelledby="od-contract-sec-chart">
            <h4 id="od-contract-sec-chart" className="od-detail-section-title">
              Chart (K-line)
            </h4>
            <p className="section-hint od-detail-chart-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
              OHLC below uses contract history. If the chart is empty, click Backfill from Massive (Celery worker on the massive queue required).
            </p>
            <OptionDiscoveryContractChartPanel
              symbol={symbol}
              expiration={expiration}
              strike={selectedRow.strike}
              optionRight={selectedRow.right === 'P' ? 'P' : 'C'}
            />
          </section>

          {(() => {
            const lastTradeTs =
              liquidityLastTrade?.sip_timestamp != null ? Number(liquidityLastTrade.sip_timestamp) / 1e9 : null
            const lastTradeAge = lastTradeTs != null ? Date.now() / 1000 - lastTradeTs : null
            const tradability = computeTradabilityScore(selectedRow, snapshotRows, lastTradeAge, liquidityQuoteCount)
            const spreadRows = snapshotRows
              .filter(r => {
                if (r.right !== selectedRow.right) return false
                const m = effectiveQuotePremium(r)
                return r.bid != null && r.ask != null && m != null && m > 0
              })
              .map(r => {
                const m = effectiveQuotePremium(r)!
                return ((r.ask! - r.bid!) / m) * 100
              })
              .sort((a, b) => a - b)
            const curSpreadPct = selectedDerived?.spreadPct
            let spreadPercentile: number | null = null
            if (curSpreadPct != null && spreadRows.length > 1) {
              const rank = spreadRows.filter(s => s <= curSpreadPct).length
              spreadPercentile = (rank / spreadRows.length) * 100
            }
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-liquidity">
                <h4 id="od-contract-sec-liquidity" className="od-detail-section-title">
                  Liquidity
                </h4>
                {liquidityLoading && <p className="section-hint">Loading liquidity data…</p>}
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">Tradability Score</div>
                    <div className="od-tradability-score">
                      <span
                        className={`od-tradability-value od-tradability-${tradability.score >= 60 ? 'good' : tradability.score >= 30 ? 'fair' : 'poor'}`}
                      >
                        {tradability.score}
                      </span>
                      <span className="od-tradability-label">/ 100</span>
                    </div>
                    <div className="od-tradability-factors">
                      {tradability.factors.map(f => (
                        <div key={f.label} className="od-tradability-factor">
                          <span className="od-kv-k">{f.label}</span>
                          <span className="od-kv-v">
                            +{f.contribution} <span className="od-kv-dim">({f.detail})</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Spread Analysis</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Spread ($)</span>
                      <span className="od-kv-v">{selectedDerived?.spread != null ? fmtUsd(selectedDerived.spread) : '—'}</span>
                      <span className="od-kv-k">Spread (%)</span>
                      <span className="od-kv-v">
                        {serverLiquidity?.spread_pct != null
                          ? `${serverLiquidity.spread_pct.toFixed(1)}%`
                          : selectedDerived?.spreadPct != null
                            ? `${selectedDerived.spreadPct.toFixed(1)}%`
                            : '—'}
                      </span>
                      <span className="od-kv-k">Percentile</span>
                      <span className="od-kv-v">
                        {serverLiquidity?.spread_percentile != null
                          ? `${serverLiquidity.spread_percentile.toFixed(0)}th`
                          : spreadPercentile != null
                            ? `${spreadPercentile.toFixed(0)}th`
                            : '—'}
                        <span className="od-kv-dim"> (vs {serverLiquidity?.contracts_compared ?? spreadRows.length} same-side contracts)</span>
                      </span>
                      <span className="od-kv-k">OI</span>
                      <span className="od-kv-v">
                        {serverLiquidity?.oi != null
                          ? String(serverLiquidity.oi)
                          : selectedRow.open_interest != null
                            ? String(selectedRow.open_interest)
                            : '—'}
                      </span>
                      {serverLiquidity?.oi_percentile != null && (
                        <>
                          <span className="od-kv-k">OI Percentile</span>
                          <span className="od-kv-v">{serverLiquidity.oi_percentile.toFixed(0)}th</span>
                        </>
                      )}
                      {serverLiquidity?.snapshot_ts && (
                        <>
                          <span className="od-kv-k">Snapshot</span>
                          <span className="od-kv-v od-kv-dim">{new Date(serverLiquidity.snapshot_ts).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Last Trade</div>
                    {liquidityLastTrade ? (
                      <div className="od-kv-grid">
                        <span className="od-kv-k">Price</span>
                        <span className="od-kv-v">{fmtUsd(Number(liquidityLastTrade.price))}</span>
                        <span className="od-kv-k">Size</span>
                        <span className="od-kv-v">{String(liquidityLastTrade.size ?? '—')}</span>
                        <span className="od-kv-k">Age</span>
                        <span className="od-kv-v">
                          {lastTradeAge != null
                            ? lastTradeAge < 3600
                              ? `${Math.round(lastTradeAge / 60)}m ago`
                              : `${(lastTradeAge / 3600).toFixed(1)}h ago`
                            : '—'}
                        </span>
                        <span className="od-kv-k">Exchange</span>
                        <span className="od-kv-v">{String(liquidityLastTrade.exchange ?? '—')}</span>
                      </div>
                    ) : (
                      <p className="section-hint">{liquidityLoading ? 'Loading…' : 'No last trade data available.'}</p>
                    )}
                  </div>
                  <div className="od-card-section">
                    <div className="od-card-section-title">Quote Activity</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Recent Quotes</span>
                      <span className="od-kv-v">{liquidityQuoteCount != null ? `${liquidityQuoteCount} updates` : '—'}</span>
                    </div>
                  </div>
                </div>

                <div className="od-exec-guidance">
                  <span className="od-exec-guidance-title">Execution Notes</span>
                  {selectedDerived?.spreadPct != null && selectedDerived.spreadPct > 10 && (
                    <span className="od-exec-chip od-exec-chip--warn">Wide spread — use limit near mid</span>
                  )}
                  {selectedDerived?.spreadPct != null && selectedDerived.spreadPct <= 3 && (
                    <span className="od-exec-chip od-exec-chip--ok">Tight spread</span>
                  )}
                  {(selectedRow.open_interest == null || selectedRow.open_interest < 10) && (
                    <span className="od-exec-chip od-exec-chip--warn">Low OI — thin liquidity</span>
                  )}
                  {lastTradeAge != null && lastTradeAge > 3600 && (
                    <span className="od-exec-chip od-exec-chip--warn">Stale tape — last trade &gt;1h</span>
                  )}
                  {selectedRow.bid == null && selectedRow.ask == null && effectiveQuotePremium(selectedRow) != null && (
                    <span className="od-exec-chip od-exec-chip--warn">No live NBBO — mark uses mid/day-bar fallback (not a live quote)</span>
                  )}
                  {selectedRow.bid == null && selectedRow.ask == null && effectiveQuotePremium(selectedRow) == null && (
                    <span className="od-exec-chip od-exec-chip--danger">No bid/ask or day bar — illiquid or no data</span>
                  )}
                  {tradability.score >= 60 && selectedDerived?.spreadPct != null && selectedDerived.spreadPct <= 5 && (
                    <span className="od-exec-chip od-exec-chip--ok">Good tradability</span>
                  )}
                </div>
              </section>
            )
          })()}

          {(() => {
            const scenarios = computeScenarios(selectedRow, underlyingPrice)
            const hasGreeks = selectedRow.delta != null && Number.isFinite(selectedRow.delta!)
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-risk">
                <h4 id="od-contract-sec-risk" className="od-detail-section-title">
                  Risk
                </h4>
                {!hasGreeks && (
                  <p className="section-hint">Greeks not available for this contract. Risk scenarios require at least delta.</p>
                )}
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">Greeks (per contract)</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Delta (Δ)</span>
                      <span className="od-kv-v">{fmtOptNum(selectedRow.delta, 4)}</span>
                      <span className="od-kv-k">Gamma (Γ)</span>
                      <span className="od-kv-v">{fmtOptNum(selectedRow.gamma, 4)}</span>
                      <span className="od-kv-k">Theta (Θ)</span>
                      <span className="od-kv-v">{fmtOptNum(selectedRow.theta, 4)}</span>
                      <span className="od-kv-k">Vega (ν)</span>
                      <span className="od-kv-v">{fmtOptNum(selectedRow.vega, 4)}</span>
                      <span className="od-kv-k">IV</span>
                      <span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                    </div>
                  </div>
                  {scenarios.length > 0 && (
                    <div className="od-card-section">
                      <div className="od-card-section-title">Scenario Analysis (1 contract = 100 shares)</div>
                      <table className="od-scenario-table">
                        <thead>
                          <tr>
                            <th>Scenario</th>
                            <th>Est. PnL</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scenarios.map(s => (
                            <tr key={s.label}>
                              <td>{s.label}</td>
                              <td className={s.pnl != null && s.pnl >= 0 ? 'od-pnl-pos' : 'od-pnl-neg'}>
                                {s.pnl != null ? `${s.pnl >= 0 ? '+' : ''}${fmtUsd(s.pnl)}` : '—'}
                              </td>
                              <td className="od-kv-dim">{s.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="od-card-section">
                    <div className="od-card-section-title">Exposure Summary</div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Delta $ (per 1 lot)</span>
                      <span className="od-kv-v">
                        {selectedRow.delta != null && underlyingPrice != null
                          ? fmtUsd(selectedRow.delta * underlyingPrice * 100)
                          : '—'}
                      </span>
                      <span className="od-kv-k">Theta $ / day</span>
                      <span className="od-kv-v">{selectedRow.theta != null ? fmtUsd(selectedRow.theta * 100) : '—'}</span>
                      <span className="od-kv-k">Vega $ / 1pt IV</span>
                      <span className="od-kv-v">{selectedRow.vega != null ? fmtUsd(selectedRow.vega * 100 * 0.01) : '—'}</span>
                    </div>
                  </div>
                </div>
              </section>
            )
          })()}

          {(() => {
            const clientRv = computeRelativeValue(selectedRow, snapshotRows)
            const hasServer = serverRelativeValue?.ok && serverRelativeValue.label != null
            const rvLabel = hasServer ? serverRelativeValue!.label! : clientRv.label
            const rvZScore = hasServer ? serverRelativeValue!.iv_zscore : clientRv.ivZScore
            const rvAvgIv = hasServer ? serverRelativeValue!.avg_iv : clientRv.neighborAvgIv
            const rvCount = hasServer ? serverRelativeValue!.contracts_compared : clientRv.neighborCount
            const sameRight = snapshotRows.filter(r => r.right === selectedRow.right && r.iv != null && Number.isFinite(r.iv!))
            return (
              <section className="od-detail-section" aria-labelledby="od-contract-sec-relative">
                <h4 id="od-contract-sec-relative" className="od-detail-section-title">
                  Relative Value
                </h4>
                <div className="od-card-grid">
                  <div className="od-card-section">
                    <div className="od-card-section-title">
                      IV Relative Value {hasServer && <span className="od-kv-dim">(server)</span>}
                    </div>
                    <div className="od-kv-grid">
                      <span className="od-kv-k">Label</span>
                      <span className={`od-kv-v od-rv-label od-rv-label--${rvLabel.toLowerCase()}`}>{rvLabel}</span>
                      <span className="od-kv-k">IV z-score</span>
                      <span className="od-kv-v">{rvZScore != null ? Number(rvZScore).toFixed(2) : '—'}</span>
                      <span className="od-kv-k">This IV</span>
                      <span className="od-kv-v">{fmtIV(selectedRow.iv)}</span>
                      <span className="od-kv-k">Avg IV (same side)</span>
                      <span className="od-kv-v">{rvAvgIv != null ? Number(rvAvgIv).toFixed(4) : '—'}</span>
                      {serverRelativeValue?.std_iv != null && (
                        <>
                          <span className="od-kv-k">Std IV</span>
                          <span className="od-kv-v">{Number(serverRelativeValue.std_iv).toFixed(4)}</span>
                        </>
                      )}
                      <span className="od-kv-k">Contracts compared</span>
                      <span className="od-kv-v">{rvCount ?? 0}</span>
                    </div>
                  </div>
                  {sameRight.length >= 3 && (
                    <div className="od-card-section">
                      <div className="od-card-section-title">
                        IV Smile (same expiry, {selectedRow.right === 'C' ? 'Calls' : 'Puts'})
                      </div>
                      <OdChartExpandOnHover title={`IV Smile (same expiry, ${selectedRow.right === 'C' ? 'Calls' : 'Puts'})`}>
                        <>
                          <IvSmileLegend side={selectedRow.right === 'C' ? 'call' : 'put'} underlying={underlyingPrice} />
                          <IvSmileChart rows={sameRight} underlying={underlyingPrice} side={selectedRow.right === 'C' ? 'call' : 'put'} />
                        </>
                      </OdChartExpandOnHover>
                    </div>
                  )}
                </div>

                {greeksCoverage?.ok && greeksCoverage.total != null && greeksCoverage.total > 0 && (
                  <div className="od-quality-badge">
                    <span className="od-quality-badge-title">Data Quality</span>
                    <span className="od-quality-item">IV {greeksCoverage.coverage?.iv_pct ?? 0}%</span>
                    <span className="od-quality-item">Greeks {greeksCoverage.coverage?.full_greeks_pct ?? 0}%</span>
                    <span className="od-quality-item">OI {greeksCoverage.coverage?.with_oi ?? 0} contracts</span>
                  </div>
                )}
              </section>
            )
          })()}
        </div>
      </div>
    </>
  )
}
