import { useEffect, useMemo, useState } from 'react'
import { fetchBarsBenchmark } from '../api'
import {
  fetchSymbolFundamentalConditions,
  fetchSymbolFundRawData,
  type SymbolFundamentalConditionsResponse,
  type SymbolFundamentalConditionRow,
  type FundRawQuarterRow,
  type FundRawAnnualRow,
  type SymbolFundRawDataResponse,
} from '../api/research/dataReadiness'
import type { LivePositionRow } from '../pages/portfolio/types'
import { fmtPctCompact, fmtUsd } from '../utils/format'
import { StockBarStatsPanel } from './StockBarStatsPanel'
import '../styles/stock-inspector.css'

function fmtMarketValue(position: LivePositionRow): string {
  const q = Number(position.position)
  const px = position.price != null ? Number(position.price) : NaN
  if (!Number.isFinite(q) || !Number.isFinite(px)) return '—'
  return fmtUsd(q * px)
}

/** Display order + labels for the 8 SEPA fundamental conditions. */
const SEPA_COND_ORDER: { id: string; label: string }[] = [
  { id: 'eps_q2q_ge_25pct', label: 'EPS QoQ ≥ 25%' },
  { id: 'rev_q2q_ge_25pct', label: 'Revenue QoQ ≥ 25%' },
  { id: 'eps_acc_2q',       label: 'EPS Accelerating (2Q)' },
  { id: 'rev_acc_2q',       label: 'Revenue Accelerating (2Q)' },
  { id: 'eps_3y_ge_15pct',  label: 'EPS 3-Year CAGR ≥ 15%' },
  { id: 'rev_3y_ge_15pct',  label: 'Revenue 3-Year CAGR ≥ 15%' },
  { id: 'eps_acc_fy',       label: 'EPS Accelerating (FY)' },
  { id: 'rev_acc_fy',       label: 'Revenue Accelerating (FY)' },
]

/** Optional pre-loaded fundamental snapshot passed by the caller (e.g. from a distribution chip). */
export interface FundamentalSeed {
  passCount: number
  /** IDs of conditions known to have passed; remaining are rendered as failed until full fetch resolves. */
  passedConditions?: string[]
  insufficientData?: boolean
}

export function StockInspectorPanel({
  symbol,
  accountId,
  position,
  fundamentalSeed,
  onClose,
}: {
  symbol: string
  accountId?: string
  position?: LivePositionRow
  fundamentalSeed?: FundamentalSeed
  onClose: () => void
}) {
  const symU = (symbol || '').trim().toUpperCase()
  const qty = position ? Number(position.position) : NaN
  const lastPrice =
    position && position.price != null && Number.isFinite(Number(position.price))
      ? Number(position.price)
      : null
  const avgCost =
    position && position.avgCost != null && Number.isFinite(Number(position.avgCost))
      ? Number(position.avgCost)
      : null
  const prevClose =
    position && position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
      ? Number(position.daily_prev_close)
      : null
  const pnl =
    position && position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
      ? Number(position.unrealized_pnl)
      : null
  const sincePct =
    pnl != null && avgCost != null && avgCost !== 0 && Number.isFinite(qty)
      ? (pnl / Math.abs(avgCost * qty)) * 100
      : null
  const dailyPnl =
    lastPrice != null && prevClose != null && Number.isFinite(qty) ? (lastPrice - prevClose) * qty : null
  const dailyPct =
    dailyPnl != null && prevClose != null && prevClose !== 0
      ? ((lastPrice! - prevClose) / prevClose) * 100
      : null

  const [benchClose, setBenchClose] = useState<number | null>(null)
  const [benchLoading, setBenchLoading] = useState(false)

  useEffect(() => {
    if (!symU || !position) return
    let cancelled = false
    setBenchLoading(true)
    fetchBarsBenchmark([symU])
      .then(({ benchmarks }) => {
        if (cancelled) return
        const b = benchmarks[symU]
        const c = b?.close != null && Number.isFinite(b.close) ? b.close : null
        setBenchClose(c)
      })
      .catch(() => {
        if (!cancelled) setBenchClose(null)
      })
      .finally(() => {
        if (!cancelled) setBenchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symU, position])

  // ── SEPA fundamental conditions (today's snapshot) ───────────────────────
  const [fund, setFund] = useState<SymbolFundamentalConditionsResponse | null>(null)
  const [fundLoading, setFundLoading] = useState(false)
  const [fundError, setFundError] = useState<string | null>(null)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setFundLoading(true)
    setFundError(null)
    fetchSymbolFundamentalConditions(symU)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setFundError(res.error ?? 'Failed')
          setFund(null)
        } else {
          setFund(res)
        }
      })
      .catch((e) => {
        if (!cancelled) setFundError(e instanceof Error ? e.message : 'Network error')
      })
      .finally(() => {
        if (!cancelled) setFundLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symU])

  /**
   * Resolved condition list, indexed by canonical 8-entry order:
   *  1) Prefer full API result (with actual/threshold/reason).
   *  2) Otherwise fall back to the caller-supplied seed (just pass/fail derived from `passedConditions`).
   *  3) Otherwise show empty placeholder rows (during initial loading or "not found").
   */
  const displayConditions = useMemo(() => {
    const apiByid = new Map<string, SymbolFundamentalConditionRow>()
    if (fund?.conditions) {
      for (const c of fund.conditions) apiByid.set(c.id, c)
    }
    const seedSet = new Set(fundamentalSeed?.passedConditions ?? [])
    return SEPA_COND_ORDER.map(({ id, label }) => {
      const api = apiByid.get(id)
      if (api) return { id, label, pass: api.pass, actual: api.actual, threshold: api.threshold, reason: api.reason, source: 'api' as const }
      if (fundamentalSeed) return { id, label, pass: seedSet.has(id), actual: null, threshold: null, reason: null, source: 'seed' as const }
      return { id, label, pass: false, actual: null, threshold: null, reason: null, source: 'placeholder' as const }
    })
  }, [fund, fundamentalSeed])

  const resolvedPassCount = fund?.pass_count ?? fundamentalSeed?.passCount ?? null
  const resolvedInsufficient = fund?.insufficient_data ?? fundamentalSeed?.insufficientData ?? false
  const overallPass = fund?.fundamental_pass ?? (resolvedPassCount === 8 ? true : null)
  const hasAnyFundData = fund?.found === true || fundamentalSeed != null

  // ── Raw income statement data ─────────────────────────────────────────────
  const [rawData, setRawData] = useState<SymbolFundRawDataResponse | null>(null)
  const [rawLoading, setRawLoading] = useState(false)

  useEffect(() => {
    if (!symU) return
    let cancelled = false
    setRawLoading(true)
    fetchSymbolFundRawData(symU)
      .then((res) => { if (!cancelled) setRawData(res.ok ? res : null) })
      .catch(() => { if (!cancelled) setRawData(null) })
      .finally(() => { if (!cancelled) setRawLoading(false) })
    return () => { cancelled = true }
  }, [symU])

  // Which condition row the user last clicked (drives data table highlights)
  const [activeCond, setActiveCond] = useState<string | null>(null)

  /** Row-key helpers */
  const qKey = (r: FundRawQuarterRow) => `${r.fiscal_year}-Q${r.fiscal_quarter}`
  const aKey = (r: FundRawAnnualRow) => `${r.fiscal_year}`

  /** Derive which table-rows / column to highlight for the active condition. */
  const highlight = useMemo((): {
    qKeys: Set<string>
    aKeys: Set<string>
    col: 'eps' | 'revenues' | null
  } => {
    const qKeys = new Set<string>()
    const aKeys = new Set<string>()
    if (!activeCond || !rawData) return { qKeys, aKeys, col: null }
    const qRows = rawData.quarterly
    const aRows = rawData.annual

    switch (activeCond) {
      case 'eps_q2q_ge_25pct': {
        if (qRows[0]) {
          qKeys.add(qKey(qRows[0]))
          const prior = qRows.find(r => r.fiscal_year === qRows[0].fiscal_year - 1 && r.fiscal_quarter === qRows[0].fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        }
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_q2q_ge_25pct': {
        if (qRows[0]) {
          qKeys.add(qKey(qRows[0]))
          const prior = qRows.find(r => r.fiscal_year === qRows[0].fiscal_year - 1 && r.fiscal_quarter === qRows[0].fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        }
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_acc_2q': {
        qRows.slice(0, 3).forEach(r => {
          qKeys.add(qKey(r))
          const prior = qRows.find(p => p.fiscal_year === r.fiscal_year - 1 && p.fiscal_quarter === r.fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        })
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_acc_2q': {
        qRows.slice(0, 3).forEach(r => {
          qKeys.add(qKey(r))
          const prior = qRows.find(p => p.fiscal_year === r.fiscal_year - 1 && p.fiscal_quarter === r.fiscal_quarter)
          if (prior) qKeys.add(qKey(prior))
        })
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_3y_ge_15pct': {
        if (aRows[0]) aKeys.add(aKey(aRows[0]))
        if (aRows[3]) aKeys.add(aKey(aRows[3]))
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_3y_ge_15pct': {
        if (aRows[0]) aKeys.add(aKey(aRows[0]))
        if (aRows[3]) aKeys.add(aKey(aRows[3]))
        return { qKeys, aKeys, col: 'revenues' }
      }
      case 'eps_acc_fy': {
        aRows.slice(0, 3).forEach(r => aKeys.add(aKey(r)))
        return { qKeys, aKeys, col: 'eps' }
      }
      case 'rev_acc_fy': {
        aRows.slice(0, 3).forEach(r => aKeys.add(aKey(r)))
        return { qKeys, aKeys, col: 'revenues' }
      }
      default:
        return { qKeys, aKeys, col: null }
    }
  }, [activeCond, rawData])

  function fmtVal(v: number | string | null | undefined): string {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '—'
      // Heuristic: fractions (|v| <= 5) likely % values
      if (Math.abs(v) <= 5) return `${(v * 100).toFixed(2)}%`
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }
    return String(v)
  }

  function passBadgeTone(n: number | null): string {
    if (n == null) return 'sip-pass-badge--unknown'
    if (n === 8) return 'sip-pass-badge--full'
    if (n >= 4) return 'sip-pass-badge--partial'
    return 'sip-pass-badge--poor'
  }

  function fmtEps(v: number | null): string {
    if (v == null) return '—'
    return `$${v.toFixed(2)}`
  }

  function fmtRev(v: number | null): string {
    if (v == null) return '—'
    const abs = Math.abs(v)
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
    return `$${v.toFixed(0)}`
  }

  return (
    <div className="riv-stock-inspector" aria-label="Stock position detail">
      <div className="od-detail-header riv-stock-inspector-header">
        <h3 className="od-detail-title">
          {symU}
          {accountId && <span className="od-detail-expiry"> · {accountId}</span>}
          {resolvedPassCount != null && (
            <span className={`sip-pass-badge ${passBadgeTone(resolvedPassCount)}`}>
              {resolvedPassCount} / 8
            </span>
          )}
        </h3>
        <button type="button" className="od-detail-close" onClick={onClose} aria-label="Close stock inspector">
          ✕
        </button>
      </div>

      <div className="od-contract-detail-stack">
        {position && (
          <section className="od-detail-section" aria-labelledby="riv-stock-sec-position">
            <h4 id="riv-stock-sec-position" className="od-detail-section-title">
              Position
            </h4>
            <div className="od-kv-grid">
              <span className="od-kv-k">Side</span>
              <span className="od-kv-v">{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</span>
              <span className="od-kv-k">Qty</span>
              <span className="od-kv-v">{Number.isFinite(qty) ? String(qty) : '—'}</span>
              <span className="od-kv-k">Avg cost</span>
              <span className="od-kv-v">{fmtUsd(position.avgCost)}</span>
              <span className="od-kv-k">Last</span>
              <span className="od-kv-v">{fmtUsd(position.price)}</span>
              <span className="od-kv-k">Market value</span>
              <span className="od-kv-v">{fmtMarketValue(position)}</span>
              <span className="od-kv-k">Daily $</span>
              <span className={`od-kv-v ${(dailyPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {dailyPnl != null ? fmtUsd(dailyPnl) : '—'}
              </span>
              <span className="od-kv-k">Daily %</span>
              <span className={`od-kv-v ${(dailyPct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {dailyPct != null ? fmtPctCompact(dailyPct) : '—'}
              </span>
              <span className="od-kv-k">Since $</span>
              <span className={`od-kv-v ${(pnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {pnl != null ? fmtUsd(pnl) : '—'}
              </span>
              <span className="od-kv-k">Since %</span>
              <span className={`od-kv-v ${(sincePct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                {sincePct != null ? fmtPctCompact(sincePct) : '—'}
              </span>
            </div>
          </section>
        )}

        {position && (
          <section className="od-detail-section" aria-labelledby="riv-stock-sec-benchmark">
            <h4 id="riv-stock-sec-benchmark" className="od-detail-section-title">
              Daily benchmark
            </h4>
            {benchLoading && <p className="section-hint">Loading stock_day close…</p>}
            {!benchLoading && benchClose != null && (
              <div className="od-kv-grid">
                <span className="od-kv-k">stock_day close</span>
                <span className="od-kv-v">{fmtUsd(benchClose)}</span>
              </div>
            )}
            {!benchLoading && benchClose == null && <p className="section-hint">No benchmark bar for this symbol.</p>}
          </section>
        )}

        {/* SEPA Fundamental Conditions — formerly only in the Stock Screener sidebar */}
        <section className="od-detail-section sip-fund-section" aria-labelledby="riv-stock-sec-fund">
          <h4 id="riv-stock-sec-fund" className="od-detail-section-title sip-fund-title">
            <span>SEPA Fundamental Conditions</span>
            {fund?.as_of_date && (
              <span className="sip-fund-asof" title="as_of_date">
                {fund.as_of_date}
              </span>
            )}
          </h4>

          {fundLoading && !fund && !fundamentalSeed && (
            <p className="section-hint sip-fund-hint">Loading conditions…</p>
          )}

          {fundError && !hasAnyFundData && (
            <p className="section-hint sip-fund-hint sip-fund-hint--err">{fundError}</p>
          )}

          {!fundLoading && !fundError && !hasAnyFundData && (
            <p className="section-hint sip-fund-hint">
              No fundamentals snapshot recorded for this symbol yet.
            </p>
          )}

          {hasAnyFundData && (
            <>
              {resolvedInsufficient && (
                <p className="sip-fund-callout sip-fund-callout--warn">
                  Insufficient data: not all required statements are available.
                </p>
              )}

              {rawData && (
                <p className="sip-raw-hint">Click a condition to highlight the source data below</p>
              )}

              <ul className="sip-cond-list">
                {displayConditions.map((c) => {
                  const isActive = activeCond === c.id
                  return (
                    <li
                      key={c.id}
                      className={`sip-cond-row sip-cond-row--${c.pass ? 'pass' : 'fail'}${isActive ? ' sip-cond-row--active' : ''}${rawData ? ' sip-cond-row--clickable' : ''}`}
                      onClick={() => setActiveCond(isActive ? null : c.id)}
                      role={rawData ? 'button' : undefined}
                      tabIndex={rawData ? 0 : undefined}
                      onKeyDown={rawData ? (e) => { if (e.key === 'Enter' || e.key === ' ') setActiveCond(isActive ? null : c.id) } : undefined}
                      title={rawData ? (isActive ? 'Click to deselect' : 'Click to highlight source data') : undefined}
                    >
                      <span className={`sip-cond-icon sip-cond-icon--${c.pass ? 'pass' : 'fail'}`} aria-hidden>
                        {c.pass ? '✓' : '✕'}
                      </span>
                      <span className="sip-cond-label">{c.label}</span>
                      {c.source === 'api' && (c.actual != null || c.threshold != null) ? (
                        <span className="sip-cond-metric" title={c.reason ?? undefined}>
                          <span className="sip-cond-actual">{fmtVal(c.actual)}</span>
                          <span className="sip-cond-vs"> / </span>
                          <span className="sip-cond-threshold">{fmtVal(c.threshold)}</span>
                        </span>
                      ) : (
                        <span className={`sip-cond-pill ${c.pass ? 'sip-cond-pill--pass' : 'sip-cond-pill--fail'}`}>
                          {c.pass ? 'PASS' : 'FAIL'}
                        </span>
                      )}
                      {rawData && <span className="sip-cond-chevron">{isActive ? '▴' : '▾'}</span>}
                    </li>
                  )
                })}
              </ul>

              {overallPass != null && (
                <div className={`sip-fund-summary ${overallPass ? 'sip-fund-summary--ok' : 'sip-fund-summary--warn'}`}>
                  <span className="sip-fund-summary-label">Overall</span>
                  <span className="sip-fund-summary-value">
                    {overallPass ? 'PASS (8/8)' : `${resolvedPassCount ?? 0} / 8`}
                  </span>
                </div>
              )}
            </>
          )}
        </section>

        {/* Raw income statement data — highlighted by active condition */}
        {(rawData || rawLoading) && (
          <section className="od-detail-section sip-raw-section" aria-labelledby="riv-stock-sec-raw">
            <h4 id="riv-stock-sec-raw" className="od-detail-section-title sip-raw-title">
              Source Data
              {activeCond && highlight.col && (
                <span className="sip-raw-active-label">
                  {' '}— {activeCond.replace(/_/g, ' ')}
                  <span className={`sip-raw-col-badge sip-raw-col-badge--${highlight.col}`}>
                    {highlight.col === 'eps' ? 'EPS' : 'Revenue'}
                  </span>
                </span>
              )}
            </h4>

            {rawLoading && <p className="section-hint">Loading source data…</p>}

            {rawData && rawData.quarterly.length > 0 && (
              <>
                <div className="sip-raw-table-label">Quarterly</div>
                <table className="sip-raw-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th className={highlight.col === 'eps' ? 'sip-raw-th--active' : ''}>EPS</th>
                      <th className={highlight.col === 'revenues' ? 'sip-raw-th--active' : ''}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawData.quarterly.map((r) => {
                      const k = qKey(r)
                      const rowHit = highlight.qKeys.has(k)
                      return (
                        <tr key={k} className={rowHit ? 'sip-raw-row--hit' : ''}>
                          <td className="sip-raw-period">Q{r.fiscal_quarter}-{r.fiscal_year}</td>
                          <td className={rowHit && highlight.col === 'eps' ? 'sip-raw-cell--highlight' : ''}>
                            {fmtEps(r.eps)}
                          </td>
                          <td className={rowHit && highlight.col === 'revenues' ? 'sip-raw-cell--highlight' : ''}>
                            {fmtRev(r.revenues)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}

            {rawData && rawData.annual.length > 0 && (
              <>
                <div className="sip-raw-table-label" style={{ marginTop: 12 }}>Annual</div>
                <table className="sip-raw-table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th className={highlight.col === 'eps' ? 'sip-raw-th--active' : ''}>EPS</th>
                      <th className={highlight.col === 'revenues' ? 'sip-raw-th--active' : ''}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawData.annual.map((r) => {
                      const k = aKey(r)
                      const rowHit = highlight.aKeys.has(k)
                      return (
                        <tr key={k} className={rowHit ? 'sip-raw-row--hit' : ''}>
                          <td className="sip-raw-period">FY{r.fiscal_year}</td>
                          <td className={rowHit && highlight.col === 'eps' ? 'sip-raw-cell--highlight' : ''}>
                            {fmtEps(r.eps)}
                          </td>
                          <td className={rowHit && highlight.col === 'revenues' ? 'sip-raw-cell--highlight' : ''}>
                            {fmtRev(r.revenues)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}

            {rawData && rawData.quarterly.length === 0 && rawData.annual.length === 0 && (
              <p className="section-hint">No income statement data found for this symbol.</p>
            )}
          </section>
        )}

        {/* BarStats (price action / chart / massive sync) only depends on `symbol`,
            so it renders on both Positions (with persistence context) and the
            Stock Screener (where there is no LivePositionRow). */}
        {symU && <StockBarStatsPanel symbol={symU} embedded />}
      </div>
    </div>
  )
}
