import { useState } from 'react'
import type {
  SepaReadinessSummaryResponse,
  SepaCriteriaStats,
} from '../../api/research/dataReadiness'
import { TECH_COND_LABELS } from './readinessConstants'

// ── SEPA Screening Criteria Checklist ─────────────────────────────────────────

interface SepaCriterionDef {
  id: string
  criteria: string
  condition: string
  explain: string
  dataSource: string
  dataFields: string[]
  minBars?: number
}

const SEPA_TECHNICAL_CRITERIA: SepaCriterionDef[] = [
  {
    id: 'avg_volume',
    criteria: 'Average Volume',
    condition: '50 SMA > 100K',
    explain: 'Decent liquidity',
    dataSource: 'stock_day',
    dataFields: ['volume'],
    minBars: 50,
  },
  {
    id: 'crs',
    criteria: 'CRS',
    condition: '≥ 70',
    explain: 'Solid Relative Strength',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 252,
  },
  {
    id: 'close_vs_low52w',
    criteria: 'Close vs 52W Low',
    condition: 'close ≥ low52Weeks × 1.3',
    explain: 'Current close at least 30% higher than 52-week low',
    dataSource: 'stock_day',
    dataFields: ['close', 'low'],
    minBars: 252,
  },
  {
    id: 'high_vs_high52w',
    criteria: 'High vs 52W High',
    condition: 'high ≥ high52Weeks × 0.75',
    explain: 'Current high within 25% of 52-week high',
    dataSource: 'stock_day',
    dataFields: ['high'],
    minBars: 252,
  },
  {
    id: 'sma50_above_sma150',
    criteria: 'SMA(50) vs SMA(150)',
    condition: 'SMA(50) above SMA(150)',
    explain: 'Short-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 150,
  },
  {
    id: 'sma50_above_sma200',
    criteria: 'SMA(50) vs SMA(200)',
    condition: 'SMA(50) above SMA(200)',
    explain: 'Short-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
  {
    id: 'sma150_above_sma200',
    criteria: 'SMA(150) vs SMA(200)',
    condition: 'SMA(150) above SMA(200)',
    explain: 'Medium-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
  {
    id: 'sma200_rising',
    criteria: 'SMA(200) Rising',
    condition: 'SMA(200) trending up',
    explain: 'Long-term trend bullish',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 220,
  },
  {
    id: 'price_above_sma50',
    criteria: 'Price vs SMA(50)',
    condition: 'Price above SMA(50)',
    explain: 'Short-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 50,
  },
  {
    id: 'price_above_sma150',
    criteria: 'Price vs SMA(150)',
    condition: 'Price above SMA(150)',
    explain: 'Medium-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 150,
  },
  {
    id: 'price_above_sma200',
    criteria: 'Price vs SMA(200)',
    condition: 'Price above SMA(200)',
    explain: 'Long-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
]

const SEPA_FUNDAMENTAL_CRITERIA: SepaCriterionDef[] = [
  {
    id: 'eps_q2q',
    criteria: 'EPS Growth Q2Q',
    condition: '≥ 25%',
    explain: 'Decent earnings growth Q2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (quarterly)'],
  },
  {
    id: 'revenue_q2q',
    criteria: 'Revenue Growth Q2Q',
    condition: '≥ 25%',
    explain: 'Decent revenue growth Q2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (quarterly)'],
  },
  {
    id: 'eps_acc_2q',
    criteria: 'EPS Acceleration',
    condition: 'EPS acc. 2 Qs',
    explain: 'Decent earnings growth acceleration last 2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (≥3 quarters)'],
  },
  {
    id: 'revenue_acc_2q',
    criteria: 'Revenue Acceleration',
    condition: 'Revenue acc. 2 Qs',
    explain: 'Decent revenue growth acceleration last 2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (≥3 quarters)'],
  },
  {
    id: 'eps_3y',
    criteria: 'EPS Growth 3Y',
    condition: '≥ 15%',
    explain: 'Decent earnings growth long-term',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (annual, ≥3 years)'],
  },
  {
    id: 'revenue_3y',
    criteria: 'Revenue Growth 3Y',
    condition: '≥ 15%',
    explain: 'Decent revenue growth long-term',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (annual, ≥3 years)'],
  },
  {
    id: 'eps_acc_fy',
    criteria: 'EPS Acceleration FY',
    condition: 'EPS acc. last FY',
    explain: 'Decent earnings growth acceleration last year',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (annual, ≥2 years)'],
  },
  {
    id: 'revenue_acc_fy',
    criteria: 'Revenue Acceleration FY',
    condition: 'Revenue acc. last FY',
    explain: 'Decent revenue growth acceleration last year',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (annual, ≥2 years)'],
  },
]

type CriterionStatus = 'supported' | 'partial' | 'missing' | 'unknown'

function deriveCriterionStatus(
  criterion: SepaCriterionDef,
  summary: SepaReadinessSummaryResponse | null,
): { status: CriterionStatus; note: string } {
  if (!summary?.ok) return { status: 'unknown', note: 'Summary not loaded' }

  if (criterion.dataSource === 'stock_day') {
    const live = summary.price_readiness_live
    const total = live?.total_symbols ?? 0
    const ready = live?.price_ready ?? 0
    if (total === 0) return { status: 'missing', note: 'No stock_day data' }
    if (ready === 0) return { status: 'missing', note: 'No symbols price_ready' }
    const pct = (ready / total) * 100
    if (pct >= 90) return { status: 'supported', note: `${ready.toLocaleString()} / ${total.toLocaleString()} price_ready` }
    return { status: 'partial', note: `${pct.toFixed(1)}% price_ready (${ready.toLocaleString()} / ${total.toLocaleString()})` }
  }

  if (criterion.dataSource === 'research_sepa_fundamentals_cache') {
    if (summary.fund_cache_view_exists === false) return { status: 'missing', note: 'Fund cache view not created' }
    const valid = summary.fund_cache_valid_count
    if (valid == null) return { status: 'unknown', note: 'Fund cache count unavailable' }
    if (valid === 0) return { status: 'missing', note: 'No valid fund cache rows' }
    const universe = summary.universe_count ?? 0
    if (universe > 0) {
      const pct = (valid / universe) * 100
      if (pct >= 50) return { status: 'supported', note: `${valid.toLocaleString()} symbols cached` }
      return { status: 'partial', note: `${valid.toLocaleString()} / ${universe.toLocaleString()} cached (${pct.toFixed(1)}%)` }
    }
    return { status: 'supported', note: `${valid.toLocaleString()} symbols cached` }
  }

  return { status: 'unknown', note: '' }
}

function criterionStatusDot(status: CriterionStatus): string {
  switch (status) {
    case 'supported': return 'sdp-crit-dot--ok'
    case 'partial': return 'sdp-crit-dot--warn'
    case 'missing': return 'sdp-crit-dot--error'
    default: return 'sdp-crit-dot--unknown'
  }
}

function criterionStatusLabel(status: CriterionStatus): string {
  switch (status) {
    case 'supported': return 'Supported'
    case 'partial': return 'Partial'
    case 'missing': return 'Missing'
    default: return 'Unknown'
  }
}

export function SepaScreeningChecklist({
  summary,
  criteriaStats,
}: {
  summary: SepaReadinessSummaryResponse | null
  criteriaStats: SepaCriteriaStats | null
}) {
  const [activeTab, setActiveTab] = useState<'technical' | 'fundamental'>('technical')
  const techStatuses = SEPA_TECHNICAL_CRITERIA.map((c) => ({
    ...c,
    ...deriveCriterionStatus(c, summary),
  }))
  const fundStatuses = SEPA_FUNDAMENTAL_CRITERIA.map((c) => ({
    ...c,
    ...deriveCriterionStatus(c, summary),
  }))

  const techOk = techStatuses.filter((c) => c.status === 'supported').length
  const fundOk = fundStatuses.filter((c) => c.status === 'supported').length
  const techTotal = techStatuses.length
  const fundTotal = fundStatuses.length
  const allOk = techOk + fundOk
  const allTotal = techTotal + fundTotal

  const overallStatus: CriterionStatus =
    allOk === allTotal ? 'supported' : allOk === 0 ? 'missing' : 'partial'

  return (
    <div className="sdp-criteria-section">
      <div className="sdp-criteria-header">
        <div className="sdp-criteria-header-left">
          <span className="sdp-criteria-title">SEPA Screening Criteria Checklist</span>
          <span className={`sdp-criteria-overall sdp-criteria-overall--${overallStatus}`}>
            {allOk} / {allTotal} supported
          </span>
        </div>
      </div>

      <div className="sdp-criteria-tabs" role="tablist" aria-label="SEPA checklist groups">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'technical'}
          className={`sdp-criteria-tab${activeTab === 'technical' ? ' sdp-criteria-tab--active' : ''}`}
          onClick={() => setActiveTab('technical')}
        >
          TECHNICAL <span className="sdp-criteria-tab-count">{techOk}/{techTotal}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'fundamental'}
          className={`sdp-criteria-tab${activeTab === 'fundamental' ? ' sdp-criteria-tab--active' : ''}`}
          onClick={() => setActiveTab('fundamental')}
        >
          FUNDAMENTAL <span className="sdp-criteria-tab-count">{fundOk}/{fundTotal}</span>
        </button>
      </div>

      <div className="sdp-criteria-groups">
        {activeTab === 'technical' && <div className="sdp-criteria-group">
          <div className="sdp-criteria-group-head">
            <span className="sdp-criteria-group-badge sdp-criteria-group-badge--tech">TECHNICAL</span>
            <span className="sdp-criteria-group-label">Price / Volume / Trend</span>
            <span className="sdp-criteria-group-count">
              {criteriaStats?.technical?.tech_pass_count != null
                ? `${(criteriaStats.technical.tech_pass_count ?? 0).toLocaleString()} pass all 11`
                : `${techOk} / ${techTotal}`}
            </span>
          </div>
          <div className="sdp-criteria-group-sub">
            Data source: <code>stock_readiness_daily.technical_eval</code> (Phase-1 stock_day + CRS percentile rank)
          </div>

          {criteriaStats?.technical?.conditions && criteriaStats.technical.conditions.length > 0 ? (
            <div className="sdp-criteria-rows">
              {criteriaStats.technical.conditions.map((cond) => {
                const denominator = cond.pass + cond.fail
                const pct = denominator > 0 ? Math.round((cond.pass / denominator) * 100) : 0
                const barColor =
                  pct >= 60 ? 'sdp-criteria-bar-fill--ok'
                  : pct >= 30 ? 'sdp-criteria-bar-fill--warn'
                  :             'sdp-criteria-bar-fill--error'
                const label = TECH_COND_LABELS[cond.id] ?? cond.label ?? cond.id
                return (
                  <div key={cond.id} className="sdp-criteria-row">
                    <span className="sdp-criteria-label" title={cond.id}>{label}</span>
                    <div className="sdp-criteria-bar">
                      <div className={`sdp-criteria-bar-fill ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="sdp-criteria-stat">
                      {cond.pass.toLocaleString()} / {denominator.toLocaleString()}
                      <span className="sdp-check-secondary"> ({pct}%)</span>
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <table className="sdp-criteria-table">
              <thead>
                <tr>
                  <th className="sdp-crit-col-status" />
                  <th>Criteria</th>
                  <th>Condition</th>
                  <th>Explain</th>
                  <th className="sdp-crit-col-fields">Required fields</th>
                  <th className="sdp-crit-col-status-label">Status</th>
                </tr>
              </thead>
              <tbody>
                {techStatuses.map((c) => (
                  <tr key={c.id} className={`sdp-crit-row sdp-crit-row--${c.status}`}>
                    <td className="sdp-crit-col-status">
                      <span className={`sdp-crit-dot ${criterionStatusDot(c.status)}`} />
                    </td>
                    <td className="sdp-crit-name">{c.criteria}</td>
                    <td className="sdp-crit-condition"><code>{c.condition}</code></td>
                    <td className="sdp-crit-explain">{c.explain}</td>
                    <td className="sdp-crit-col-fields">
                      <span className="sdp-crit-fields">
                        {c.dataFields.map((f) => (
                          <span key={f} className="sdp-crit-field-chip">{f}</span>
                        ))}
                        {c.minBars != null && (
                          <span className="sdp-crit-field-chip sdp-crit-field-chip--bars">≥{c.minBars}d</span>
                        )}
                      </span>
                    </td>
                    <td className="sdp-crit-col-status-label">
                      <span className={`sdp-crit-status-pill sdp-crit-status-pill--${c.status}`}>
                        {criterionStatusLabel(c.status)}
                      </span>
                      {c.note && <span className="sdp-crit-note">{c.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(!criteriaStats?.technical?.conditions || criteriaStats.technical.conditions.length === 0) && (
            <p className="sdp-check-secondary" style={{ fontSize: 12, marginTop: 8 }}>
              No technical snapshot yet — run "Evaluate & Publish" or POST <code>/research/data/readiness/backfill-technical</code> to populate.
            </p>
          )}

          {/* ── Tier 2: Momentum indicators ── */}
          {criteriaStats?.technical?.momentum_conditions && criteriaStats.technical.momentum_conditions.length > 0 && (
            <>
              <div className="sdp-criteria-group-head" style={{ marginTop: 16 }}>
                <span className="sdp-criteria-group-badge" style={{ background: 'rgba(59,130,246,0.12)', color: '#2563eb' }}>MOMENTUM</span>
                <span className="sdp-criteria-group-label">Scored 0–10 (RSI, MACD, ROC, Relative Strength)</span>
              </div>
              <div className="sdp-criteria-rows">
                {criteriaStats.technical.momentum_conditions.map((cond) => {
                  const denominator = cond.pass + cond.fail
                  const pct = denominator > 0 ? Math.round((cond.pass / denominator) * 100) : 0
                  const barColor =
                    pct >= 60 ? 'sdp-criteria-bar-fill--ok'
                    : pct >= 30 ? 'sdp-criteria-bar-fill--warn'
                    :             'sdp-criteria-bar-fill--error'
                  return (
                    <div key={cond.id} className="sdp-criteria-row">
                      <span className="sdp-criteria-label" title={cond.id}>{cond.label ?? cond.id}</span>
                      <div className="sdp-criteria-bar">
                        <div className={`sdp-criteria-bar-fill ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="sdp-criteria-stat">
                        {cond.pass.toLocaleString()} / {denominator.toLocaleString()}
                        <span className="sdp-check-secondary"> ({pct}%)</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* ── Tier 3: Structure diagnostics ── */}
          {criteriaStats?.technical?.structure_conditions && criteriaStats.technical.structure_conditions.length > 0 && (
            <>
              <div className="sdp-criteria-group-head" style={{ marginTop: 16 }}>
                <span className="sdp-criteria-group-badge" style={{ background: 'rgba(168,85,247,0.12)', color: '#7c3aed' }}>STRUCTURE</span>
                <span className="sdp-criteria-group-label">Volatility Contraction, Trend Strength, Accumulation</span>
              </div>
              <div className="sdp-criteria-rows">
                {criteriaStats.technical.structure_conditions.map((cond) => {
                  const denominator = cond.pass + cond.fail
                  const pct = denominator > 0 ? Math.round((cond.pass / denominator) * 100) : 0
                  const barColor =
                    pct >= 60 ? 'sdp-criteria-bar-fill--ok'
                    : pct >= 30 ? 'sdp-criteria-bar-fill--warn'
                    :             'sdp-criteria-bar-fill--error'
                  return (
                    <div key={cond.id} className="sdp-criteria-row">
                      <span className="sdp-criteria-label" title={cond.id}>{cond.label ?? cond.id}</span>
                      <div className="sdp-criteria-bar">
                        <div className={`sdp-criteria-bar-fill ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="sdp-criteria-stat">
                        {cond.pass.toLocaleString()} / {denominator.toLocaleString()}
                        <span className="sdp-check-secondary"> ({pct}%)</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* ── Tier 4: Sentiment indicators ── */}
          {criteriaStats?.technical?.sentiment_conditions && criteriaStats.technical.sentiment_conditions.length > 0 && (
            <>
              <div className="sdp-criteria-group-head" style={{ marginTop: 16 }}>
                <span className="sdp-criteria-group-badge" style={{ background: 'rgba(249,115,22,0.12)', color: '#ea580c' }}>SENTIMENT</span>
                <span className="sdp-criteria-group-label">Short Interest & Short Volume Signals</span>
              </div>
              <div className="sdp-criteria-rows">
                {criteriaStats.technical.sentiment_conditions.map((cond) => {
                  const denominator = cond.pass + cond.fail
                  const pct = denominator > 0 ? Math.round((cond.pass / denominator) * 100) : 0
                  const barColor =
                    pct >= 60 ? 'sdp-criteria-bar-fill--ok'
                    : pct >= 30 ? 'sdp-criteria-bar-fill--warn'
                    :             'sdp-criteria-bar-fill--error'
                  return (
                    <div key={cond.id} className="sdp-criteria-row">
                      <span className="sdp-criteria-label" title={cond.id}>{cond.label ?? cond.id}</span>
                      <div className="sdp-criteria-bar">
                        <div className={`sdp-criteria-bar-fill ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="sdp-criteria-stat">
                        {cond.pass.toLocaleString()} / {denominator.toLocaleString()}
                        <span className="sdp-check-secondary"> ({pct}%)</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>}

        {activeTab === 'fundamental' && <div className="sdp-criteria-group">
          <div className="sdp-criteria-group-head">
            <span className="sdp-criteria-group-badge sdp-criteria-group-badge--fund">FUNDAMENTAL</span>
            <span className="sdp-criteria-group-label">EPS / Revenue Growth & Acceleration</span>
            <span className="sdp-criteria-group-count">{fundOk} / {fundTotal}</span>
          </div>
          <div className="sdp-criteria-group-sub">
            Data source: <code>stock_readiness_daily.fundamental_eval</code> (evaluated from <code>stock_income_statements</code> by Phase 1)
          </div>
          <table className="sdp-criteria-table">
            <thead>
              <tr>
                <th className="sdp-crit-col-status" />
                <th>Criteria</th>
                <th>Condition</th>
                <th>Explain</th>
                <th className="sdp-crit-col-fields">Required fields</th>
                <th className="sdp-crit-col-status-label">Status</th>
              </tr>
            </thead>
            <tbody>
              {fundStatuses.map((c) => (
                <tr key={c.id} className={`sdp-crit-row sdp-crit-row--${c.status}`}>
                  <td className="sdp-crit-col-status">
                    <span className={`sdp-crit-dot ${criterionStatusDot(c.status)}`} />
                  </td>
                  <td className="sdp-crit-name">{c.criteria}</td>
                  <td className="sdp-crit-condition"><code>{c.condition}</code></td>
                  <td className="sdp-crit-explain">{c.explain}</td>
                  <td className="sdp-crit-col-fields">
                    <span className="sdp-crit-fields">
                      {c.dataFields.map((f) => (
                        <span key={f} className="sdp-crit-field-chip">{f}</span>
                      ))}
                    </span>
                  </td>
                  <td className="sdp-crit-col-status-label">
                    <span className={`sdp-crit-status-pill sdp-crit-status-pill--${c.status}`}>
                      {criterionStatusLabel(c.status)}
                    </span>
                    {c.note && <span className="sdp-crit-note">{c.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>
    </div>
  )
}
