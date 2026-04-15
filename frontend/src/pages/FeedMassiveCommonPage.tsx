import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveStatus,
  fetchMassiveMarketConditions,
  fetchMassiveMarketExchanges,
  fetchMassiveMarketHolidays,
  fetchMassiveMarketStatus,
  fetchTechnicalIndicator,
} from '../api'
import type {
  MassiveStatusResponse,
  MassiveMarketHolidaysResponse,
  TechnicalIndicatorResponse,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import checklistRows from './massiveFeedChecklistRows'
import type { ChecklistRow } from './massiveFeedChecklistRows'
import { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER, type CapabilityGroup } from './massiveFeedChecklistRows'
import { feedMassiveCommonSvcAnchorId, parseFeedMassiveCommonSvcFromHash } from './massive/feedMassiveCommonTabUtils'
import {
  capabilityGroupForRowId,
  checklistEffectiveStatusLabel,
  commonFeedChecklistRows,
  effectiveChecklistProjectStatus,
  groupedCommonFeedChecklistRows,
  shortServiceLabel,
  tierOkForRow,
  tradesOkForRow,
} from './massive/massiveChecklistStatus'
import { FeedMassiveServiceBlock } from './massive/FeedMassiveServiceBlock'
import type { EffectiveServiceStatus } from './massive/FeedMassiveServiceBlock'

const TI_TAB_ORDER = ['sma', 'ema', 'macd', 'rsi'] as const
type TiSubTabKey = (typeof TI_TAB_ORDER)[number]
const TI_DOC_PAGE_LABEL: Record<TiSubTabKey, string> = {
  sma: 'Simple Moving Average (SMA)',
  ema: 'Exponential Moving Average (EMA)',
  macd: 'Moving Average Convergence/Divergence (MACD)',
  rsi: 'Relative Strength Index (RSI)',
}

const MO_TAB_ORDER = ['exchanges', 'market_holidays', 'market_status', 'conditions'] as const
type MoSubTabKey = (typeof MO_TAB_ORDER)[number]
const MO_TAB_LABEL: Record<MoSubTabKey, string> = {
  exchanges: 'Exchanges',
  market_holidays: 'Market Holidays',
  market_status: 'Market Status',
  conditions: 'Condition Codes',
}

function checklistRowById(id: string): ChecklistRow {
  const r = checklistRows.find(x => x.id === id)
  if (!r) throw new Error(`checklist row ${id}`)
  return r
}

function feedMassiveOverviewDotClass(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
}

interface FeedMassiveCommonCapabilityPanelProps {
  capId: string
  checklistRow: ChecklistRow
  effectiveStatus: EffectiveServiceStatus
  expanded: boolean
  onToggle: () => void
  highlight: boolean
  ariaLabel: string
  children: ReactNode
}

function FeedMassiveCommonCapabilityPanel({
  capId,
  checklistRow,
  effectiveStatus,
  expanded,
  onToggle,
  highlight,
  ariaLabel,
  children,
}: FeedMassiveCommonCapabilityPanelProps) {
  const statusWords = checklistEffectiveStatusLabel(effectiveStatus)
  return (
    <section
      id={feedMassiveCommonSvcAnchorId(capId)}
      className={`feed-massive-card feed-massive-cap-section${expanded ? ' feed-massive-cap-section--expanded' : ' feed-massive-cap-section--collapsed'}${highlight ? ' feed-massive-card--cap-active' : ''}`}
      aria-label={ariaLabel}
    >
      <div className="feed-massive-cap-panel-header">
        <button
          type="button"
          className="feed-massive-cap-panel-toggle"
          aria-expanded={expanded}
          aria-controls={`feed-massive-common-cap-body-${capId}`}
          id={`feed-massive-common-cap-head-${capId}`}
          onClick={onToggle}
        >
          <span
            className={`feed-massive-cap-panel-chevron${expanded ? ' feed-massive-cap-panel-chevron--open' : ''}`}
            aria-hidden
          />
          <span className="feed-massive-cap-panel-title">{shortServiceLabel(checklistRow)}</span>
          <span
            className={feedMassiveOverviewDotClass(effectiveStatus)}
            title={statusWords}
            aria-label={`Status: ${statusWords}`}
          />
        </button>
      </div>
      {expanded ? (
        <div
          id={`feed-massive-common-cap-body-${capId}`}
          className="feed-massive-cap-panel-body"
          role="region"
          aria-labelledby={`feed-massive-common-cap-head-${capId}`}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

interface FeedMassiveCommonPageProps {
  status: StatusResponse | null
  onGoToFeed?: () => void
  breadcrumbLabel?: string
}

export function FeedMassiveCommonPage({
  status: _status,
  onGoToFeed,
  breadcrumbLabel = 'Massive Common',
}: FeedMassiveCommonPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [highlightedCapabilityId, setHighlightedCapabilityId] = useState<string | null>(null)
  const [capNavGroupExpanded, setCapNavGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce(
      (acc, g) => {
        acc[g] = true
        return acc
      },
      {} as Record<CapabilityGroup, boolean>,
    ),
  )
  const [capExpanded, setCapExpanded] = useState<Record<string, boolean>>({})

  const [moSubTab, setMoSubTab] = useState<MoSubTabKey>('exchanges')
  const [moCondAsset, setMoCondAsset] = useState('')
  const [moCondDataType, setMoCondDataType] = useState('')
  const [moCondBusy, setMoCondBusy] = useState(false)
  const [moCondErr, setMoCondErr] = useState<string | null>(null)
  const [moCondResults, setMoCondResults] = useState<Record<string, unknown>[] | null>(null)
  const [moExchAsset, setMoExchAsset] = useState('')
  const [moExchLocale, setMoExchLocale] = useState('')
  const [moExchBusy, setMoExchBusy] = useState(false)
  const [moExchErr, setMoExchErr] = useState<string | null>(null)
  const [moExchResults, setMoExchResults] = useState<Record<string, unknown>[] | null>(null)
  const [moHolBusy, setMoHolBusy] = useState(false)
  const [moHolErr, setMoHolErr] = useState<string | null>(null)
  const [moHolData, setMoHolData] = useState<MassiveMarketHolidaysResponse | null>(null)
  const [moStatusBusy, setMoStatusBusy] = useState(false)
  const [moStatusErr, setMoStatusErr] = useState<string | null>(null)
  const [moStatusData, setMoStatusData] = useState<Record<string, unknown> | null>(null)

  const [tiSubTab, setTiSubTab] = useState<TiSubTabKey>('sma')
  const [tiTicker, setTiTicker] = useState('O:SPY251219C00600000')
  const [tiWindow, setTiWindow] = useState('14')
  const [tiTimespan, setTiTimespan] = useState('day')
  const [tiSeriesType, setTiSeriesType] = useState('close')
  const [tiLimit, setTiLimit] = useState('50')
  const [tiMacdShort, setTiMacdShort] = useState('12')
  const [tiMacdLong, setTiMacdLong] = useState('26')
  const [tiMacdSignal, setTiMacdSignal] = useState('9')
  const [tiBusy, setTiBusy] = useState(false)
  const [tiErr, setTiErr] = useState<string | null>(null)
  const [tiResult, setTiResult] = useState<TechnicalIndicatorResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => {
        if (!cancelled) setMassiveStatus(s)
      })
      .catch(() => {
        if (!cancelled) setMassiveStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleCap = useCallback((id: string) => {
    setCapExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const commonRowIds = useMemo(() => commonFeedChecklistRows().map(r => r.id), [])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    setCapExpanded(prev => ({ ...prev, [id]: true }))
    const g = capabilityGroupForRowId(id)
    if (g) {
      setCapNavGroupExpanded(prev => (prev[g] ? prev : { ...prev, [g]: true }))
    }
    const el = document.getElementById(feedMassiveCommonSvcAnchorId(id))
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      const next = `${window.location.pathname}${window.location.search}#${feedMassiveCommonSvcAnchorId(id)}`
      window.history.replaceState(null, '', next)
    }
  }, [])

  useEffect(() => {
    const resolveIdFromHash = (hash: string): string | null => {
      const fromSvc = parseFeedMassiveCommonSvcFromHash(hash)
      if (fromSvc && commonRowIds.includes(fromSvc)) return fromSvc
      return null
    }
    const onHashChange = () => {
      const id = resolveIdFromHash(window.location.hash)
      if (id) scrollToSection(id)
      else setHighlightedCapabilityId(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [scrollToSection, commonRowIds])

  useEffect(() => {
    const id = parseFeedMassiveCommonSvcFromHash(window.location.hash)
    if (id && commonRowIds.includes(id)) {
      requestAnimationFrame(() => scrollToSection(id))
    }
  }, [scrollToSection, commonRowIds])

  const runMoConditions = useCallback(async () => {
    setMoCondBusy(true); setMoCondErr(null)
    try {
      const res = await fetchMassiveMarketConditions({
        asset_class: moCondAsset || undefined,
        data_type: moCondDataType || undefined,
      })
      if (!res.ok) { setMoCondErr(res.error ?? 'Failed'); return }
      setMoCondResults(res.results)
    } catch (e: unknown) { setMoCondErr(e instanceof Error ? e.message : String(e)) }
    finally { setMoCondBusy(false) }
  }, [moCondAsset, moCondDataType])

  const runMoExchanges = useCallback(async () => {
    setMoExchBusy(true); setMoExchErr(null)
    try {
      const res = await fetchMassiveMarketExchanges({
        asset_class: moExchAsset || undefined,
        locale: moExchLocale || undefined,
      })
      if (!res.ok) { setMoExchErr(res.error ?? 'Failed'); return }
      setMoExchResults(res.results)
    } catch (e: unknown) { setMoExchErr(e instanceof Error ? e.message : String(e)) }
    finally { setMoExchBusy(false) }
  }, [moExchAsset, moExchLocale])

  const runMoHolidays = useCallback(async () => {
    setMoHolBusy(true); setMoHolErr(null)
    try {
      const res = await fetchMassiveMarketHolidays()
      if (!res.ok) { setMoHolErr(res.error ?? 'Failed'); return }
      setMoHolData(res)
    } catch (e: unknown) { setMoHolErr(e instanceof Error ? e.message : String(e)) }
    finally { setMoHolBusy(false) }
  }, [])

  const runMoStatus = useCallback(async () => {
    setMoStatusBusy(true); setMoStatusErr(null)
    try {
      const res = await fetchMassiveMarketStatus()
      if (!res.ok) { setMoStatusErr(res.error ?? 'Failed'); return }
      setMoStatusData(res.status ?? null)
    } catch (e: unknown) { setMoStatusErr(e instanceof Error ? e.message : String(e)) }
    finally { setMoStatusBusy(false) }
  }, [])

  const runTiIndicator = useCallback(async () => {
    setTiBusy(true); setTiErr(null); setTiResult(null)
    try {
      const p: Record<string, unknown> = {
        ticker: tiTicker.trim(),
        indicator: tiSubTab,
        timespan: tiTimespan,
        window: Number(tiWindow) || 14,
        series_type: tiSeriesType,
        limit: Number(tiLimit) || 50,
      }
      if (tiSubTab === 'macd') {
        p.short_window = Number(tiMacdShort) || 12
        p.long_window = Number(tiMacdLong) || 26
        p.signal_window = Number(tiMacdSignal) || 9
      }
      const res = await fetchTechnicalIndicator(p as unknown as Parameters<typeof fetchTechnicalIndicator>[0])
      if (!res.ok) { setTiErr(res.error ?? 'Failed'); return }
      setTiResult(res)
    } catch (e: unknown) { setTiErr(e instanceof Error ? e.message : String(e)) }
    finally { setTiBusy(false) }
  }, [tiTicker, tiSubTab, tiTimespan, tiWindow, tiSeriesType, tiLimit, tiMacdShort, tiMacdLong, tiMacdSignal])

  const configured = Boolean(massiveStatus?.configured)

  const rMo = checklistRowById('market-ops')
  const effMo = effectiveChecklistProjectStatus(
    rMo,
    Boolean(configured),
    tierOkForRow(rMo, massiveStatus, Boolean(configured)),
    tradesOkForRow(rMo, massiveStatus),
  )

  const marketOpsEvidence = (() => {
    if (moExchResults && moExchResults.length > 0) return `Exchanges: ${moExchResults.length} result(s).`
    if (moHolData?.ok) return `Massive holidays: ${moHolData.massive_count ?? 0}, local: ${moHolData.local_count ?? 0}.`
    if (moStatusData) return `Market status loaded.`
    if (moCondResults && moCondResults.length > 0) return `Condition Codes: ${moCondResults.length} result(s).`
    return 'No data loaded. Use any tab to fetch.'
  })()

  const rTi = checklistRowById('technical-indicators')
  const effTi = effectiveChecklistProjectStatus(
    rTi,
    Boolean(configured),
    tierOkForRow(rTi, massiveStatus, Boolean(configured)),
    tradesOkForRow(rTi, massiveStatus),
  )

  const tiEvidence = (() => {
    if (tiResult?.ok && tiResult.count != null) {
      const label = TI_DOC_PAGE_LABEL[tiSubTab]
      return `${label} — ${tiResult.ticker}: ${tiResult.count} data point(s).`
    }
    return 'No indicator data loaded. Select a tab and fetch.'
  })()

  return (
    <div className="card process-section feed-massive-option-page">
      <div className="feed-massive-title-block">
        <div className="feed-massive-title-main">
          <h2 className="page-title-with-tooltip" style={{ marginBottom: 0 }}>
            {onGoToFeed ? (
              <>
                <button type="button" className="page-title-breadcrumb-link" onClick={onGoToFeed} aria-label="Go to Feed">
                  Feed
                </button>
                {' / '}
              </>
            ) : null}
            {breadcrumbLabel}{' '}
            <InfoTooltip text="Shared Massive REST capabilities for both options and stocks: Technical Indicators and Market Operations." />
          </h2>
          {configured && (
            <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
              Delayed feed
            </span>
          )}
        </div>
      </div>

      <section className="feed-massive-status-strip" aria-label="Connection status">
        <div className="feed-massive-status-strip-grid">
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">API</span>
            <span className={configured ? 'feed-massive-status-value feed-massive-status-value--ok' : 'feed-massive-status-value feed-massive-status-value--bad'}>
              {configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Tier</span>
            <span className="feed-massive-status-value">{massiveStatus?.tier ?? '—'}</span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Scope</span>
            <span className="feed-massive-status-value">Options &amp; stocks</span>
          </div>
        </div>
        {massiveStatus?.delay_notice ? (
          <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p>
        ) : null}
      </section>

      <nav className="feed-massive-tab-nav-section feed-massive-cap-nav-sticky" aria-label="Massive Common capabilities">
        <div className="feed-massive-cap-sheet">
          <p className="feed-massive-cap-hint">
            Shared REST endpoints. Click a group header to show or hide chips; click a chip to jump and expand that section.
          </p>
          {groupedCommonFeedChecklistRows().map(({ group, rows: groupRows }) => {
            const navOpen = capNavGroupExpanded[group]
            const groupHasHighlight = groupRows.some(row => highlightedCapabilityId === row.id)
            return (
              <div key={group} className="feed-massive-cap-group">
                <button
                  type="button"
                  className={`feed-massive-cap-group-toggle${groupHasHighlight ? ' feed-massive-cap-group-toggle--active' : ''}`}
                  aria-expanded={navOpen}
                  aria-controls={`feed-massive-common-cap-group-panel-${group}`}
                  id={`feed-massive-common-cap-group-head-${group}`}
                  onClick={() => setCapNavGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))}
                >
                  <span className={`feed-massive-cap-group-chevron${navOpen ? ' feed-massive-cap-group-chevron--open' : ''}`} aria-hidden>
                    ▼
                  </span>
                  <span className="feed-massive-cap-group-label">{CAPABILITY_GROUP_LABELS[group]}</span>
                </button>
                <div
                  id={`feed-massive-common-cap-group-panel-${group}`}
                  className="feed-massive-cap-group-panel"
                  hidden={!navOpen}
                  role="region"
                  aria-labelledby={`feed-massive-common-cap-group-head-${group}`}
                >
                  <div className="feed-massive-cap-summary">
                    {groupRows.map(row => {
                      const tierOk = tierOkForRow(row, massiveStatus, Boolean(configured))
                      const tradesOk = tradesOkForRow(row, massiveStatus)
                      const eff = effectiveChecklistProjectStatus(row, Boolean(configured), tierOk, tradesOk)
                      return (
                        <a
                          key={row.id}
                          href={`#${feedMassiveCommonSvcAnchorId(row.id)}`}
                          className={`feed-massive-tab-chip${highlightedCapabilityId === row.id ? ' feed-massive-tab-chip--active' : ''}`}
                          aria-current={highlightedCapabilityId === row.id ? 'location' : undefined}
                          onClick={e => {
                            e.preventDefault()
                            scrollToSection(row.id)
                          }}
                        >
                          <span className={feedMassiveOverviewDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
                          <span className="feed-massive-tab-chip-label">{shortServiceLabel(row)}</span>
                        </a>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </nav>

      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config.
        </p>
      )}

      <div className="feed-massive-svc-main">
        <h4 className="feed-massive-section-header" id="feed-massive-common-section-tech-indicators">Technical Indicators</h4>

        <FeedMassiveCommonCapabilityPanel
          capId="technical-indicators"
          checklistRow={rTi}
          effectiveStatus={effTi}
          expanded={capExpanded['technical-indicators'] === true}
          onToggle={() => toggleCap('technical-indicators')}
          highlight={highlightedCapabilityId === 'technical-indicators'}
          ariaLabel={rTi.service}
        >
          <FeedMassiveServiceBlock effectiveStatus={effTi} evidence={tiEvidence} checklistRow={rTi}>
            <div className="feed-massive-card-head">
              <h3>{rTi.service}</h3>
            </div>
            <p className="feed-massive-card-lead">{rTi.description}</p>
            <div className="feed-massive-agg-tabs-wrap">
              <div className="feed-massive-agg-tabs" role="tablist" aria-label="Technical Indicators REST DocPage rows">
                {TI_TAB_ORDER.map(t => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tiSubTab === t}
                    className={`feed-massive-agg-tab${tiSubTab === t ? ' active' : ''}`}
                    onClick={() => setTiSubTab(t)}
                  >
                    {TI_DOC_PAGE_LABEL[t]}
                    <span className="feed-massive-agg-tab-badge">REST</span>
                  </button>
                ))}
              </div>

              <div className="feed-massive-agg-tab-panels">
                <div className="feed-massive-agg-tab-panel" role="tabpanel">
                  <div className="feed-massive-agg-sub-doc">
                    {tiSubTab === 'sma' ? (
                      <>
                        <p><strong>Use case:</strong> Compute Simple Moving Average over a custom window for any ticker. Smooths price data to identify trends. Works with both option tickers (<code>O:</code> prefix) and stock/index tickers.</p>
                        <p style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: 'var(--space-1)' }}><strong>Option applicability:</strong> Directly supported for option tickers. Also useful for underlying stock analysis to inform option strategy decisions.</p>
                        <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v1/indicators/sma/&#123;ticker&#125;</code></p>
                      </>
                    ) : tiSubTab === 'ema' ? (
                      <>
                        <p><strong>Use case:</strong> Compute Exponential Moving Average, which weights recent prices more heavily than SMA. Reacts faster to price changes, useful for momentum-based strategies.</p>
                        <p style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: 'var(--space-1)' }}><strong>Option applicability:</strong> Directly supported for option tickers. Commonly applied to underlying equities to generate entry/exit signals for option trades.</p>
                        <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v1/indicators/ema/&#123;ticker&#125;</code></p>
                      </>
                    ) : tiSubTab === 'rsi' ? (
                      <>
                        <p><strong>Use case:</strong> Relative Strength Index measures speed and magnitude of price movements on a 0–100 scale. Values above 70 suggest overbought; below 30 suggest oversold.</p>
                        <p style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: 'var(--space-1)' }}><strong>Option applicability:</strong> Directly supported for option tickers. Often used on underlying equities to time option entry (e.g. selling puts when RSI is oversold).</p>
                        <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v1/indicators/rsi/&#123;ticker&#125;</code></p>
                      </>
                    ) : (
                      <>
                        <p><strong>Use case:</strong> MACD (Moving Average Convergence/Divergence) tracks the relationship between two EMAs. The signal line crossover identifies momentum shifts. Customizable short/long/signal windows.</p>
                        <p style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: 'var(--space-1)' }}><strong>Option applicability:</strong> Directly supported for option tickers. Primarily used on underlying equities to identify trend reversals for directional option strategies.</p>
                        <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v1/indicators/macd/&#123;ticker&#125;</code></p>
                      </>
                    )}
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Ticker</span>
                      <input className="form-input" value={tiTicker} onChange={e => setTiTicker(e.target.value)} disabled={tiBusy || !configured} placeholder="O:SPY251219C00600000 or AAPL" autoComplete="off" />
                    </label>
                    {tiSubTab !== 'macd' ? (
                      <label className="feed-massive-field">
                        <span className="form-label">Window</span>
                        <input className="form-input" type="number" min={1} max={500} value={tiWindow} onChange={e => setTiWindow(e.target.value)} disabled={tiBusy} />
                      </label>
                    ) : (
                      <>
                        <label className="feed-massive-field">
                          <span className="form-label">Short window</span>
                          <input className="form-input" type="number" min={1} value={tiMacdShort} onChange={e => setTiMacdShort(e.target.value)} disabled={tiBusy} />
                        </label>
                        <label className="feed-massive-field">
                          <span className="form-label">Long window</span>
                          <input className="form-input" type="number" min={1} value={tiMacdLong} onChange={e => setTiMacdLong(e.target.value)} disabled={tiBusy} />
                        </label>
                        <label className="feed-massive-field">
                          <span className="form-label">Signal window</span>
                          <input className="form-input" type="number" min={1} value={tiMacdSignal} onChange={e => setTiMacdSignal(e.target.value)} disabled={tiBusy} />
                        </label>
                      </>
                    )}
                    <label className="feed-massive-field">
                      <span className="form-label">Timespan</span>
                      <select className="form-input" value={tiTimespan} onChange={e => setTiTimespan(e.target.value)} disabled={tiBusy}>
                        <option value="minute">Minute</option>
                        <option value="hour">Hour</option>
                        <option value="day">Day</option>
                        <option value="week">Week</option>
                        <option value="month">Month</option>
                      </select>
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Series type</span>
                      <select className="form-input" value={tiSeriesType} onChange={e => setTiSeriesType(e.target.value)} disabled={tiBusy}>
                        <option value="close">Close</option>
                        <option value="open">Open</option>
                        <option value="high">High</option>
                        <option value="low">Low</option>
                      </select>
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Limit</span>
                      <input className="form-input" type="number" min={1} max={5000} value={tiLimit} onChange={e => setTiLimit(e.target.value)} disabled={tiBusy} />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={tiBusy || !configured || !tiTicker.trim()} onClick={runTiIndicator}>
                      {tiBusy ? 'Loading\u2026' : `Fetch ${TI_DOC_PAGE_LABEL[tiSubTab]}`}
                    </button>
                  </div>
                  {tiErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tiErr}</p> : null}
                  {tiResult?.ok && tiResult.results?.values ? (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <p style={{ fontSize: '0.82rem', marginBottom: 'var(--space-2)' }}>
                        <strong>{tiResult.count}</strong> data point(s) for <strong>{tiResult.ticker}</strong>
                      </p>
                      <div style={{ maxHeight: '22rem', overflow: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 'var(--radius-sm)' }}>
                        <table className="feed-massive-table" style={{ width: '100%', fontSize: '0.78rem' }}>
                          <thead>
                            <tr>
                              <th>Timestamp</th>
                              {tiSubTab === 'macd' ? (
                                <><th>Value</th><th>Signal</th><th>Histogram</th></>
                              ) : (
                                <th>Value</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {(tiResult.results.values as Record<string, unknown>[]).map((v, i) => (
                              <tr key={i}>
                                <td>{String(v.timestamp ?? '')}</td>
                                {tiSubTab === 'macd' ? (
                                  <>
                                    <td>{v.value != null ? Number(v.value).toFixed(4) : '—'}</td>
                                    <td>{v.signal != null ? Number(v.signal).toFixed(4) : '—'}</td>
                                    <td>{v.histogram != null ? Number(v.histogram).toFixed(4) : '—'}</td>
                                  </>
                                ) : (
                                  <td>{v.value != null ? Number(v.value).toFixed(4) : '—'}</td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCommonCapabilityPanel>

        <h4 className="feed-massive-section-header" id="feed-massive-common-section-market-ops">Market Operations</h4>

        <FeedMassiveCommonCapabilityPanel
          capId="market-ops"
          checklistRow={rMo}
          effectiveStatus={effMo}
          expanded={capExpanded['market-ops'] === true}
          onToggle={() => toggleCap('market-ops')}
          highlight={highlightedCapabilityId === 'market-ops'}
          ariaLabel={rMo.service}
        >
          <FeedMassiveServiceBlock effectiveStatus={effMo} evidence={marketOpsEvidence} checklistRow={rMo}>
            <div className="feed-massive-card-head">
              <h3>{rMo.service}</h3>
            </div>
            <p className="feed-massive-card-lead">{rMo.description}</p>
            <div className="feed-massive-agg-tabs-wrap">
              <div className="feed-massive-agg-tabs" role="tablist" aria-label="Market Operations REST DocPage rows">
                {MO_TAB_ORDER.map(t => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={moSubTab === t}
                    className={`feed-massive-agg-tab${moSubTab === t ? ' active' : ''}`}
                    onClick={() => setMoSubTab(t)}
                  >
                    {MO_TAB_LABEL[t]}
                    <span className="feed-massive-agg-tab-badge">REST</span>
                  </button>
                ))}
              </div>

              <div className="feed-massive-agg-tab-panels">

                {moSubTab === 'exchanges' ? (
                  <div className="feed-massive-agg-tab-panel" role="tabpanel">
                    <div className="feed-massive-agg-sub-doc">
                      <p><strong>Use case:</strong> List known exchanges and their metadata (MIC, type, locale). Useful for understanding where trades and quotes originate.</p>
                      <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v3/reference/exchanges</code></p>
                    </div>
                    <div className="feed-massive-form-grid">
                      <label className="feed-massive-field">
                        <span className="form-label">Asset class</span>
                        <select className="form-input" value={moExchAsset} onChange={e => setMoExchAsset(e.target.value)} disabled={moExchBusy}>
                          <option value="">All</option>
                          <option value="stocks">Stocks</option>
                          <option value="options">Options</option>
                          <option value="crypto">Crypto</option>
                          <option value="fx">FX</option>
                        </select>
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">Locale</span>
                        <select className="form-input" value={moExchLocale} onChange={e => setMoExchLocale(e.target.value)} disabled={moExchBusy}>
                          <option value="">All</option>
                          <option value="us">US</option>
                          <option value="global">Global</option>
                        </select>
                      </label>
                    </div>
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <button type="button" className="btn btn-secondary" disabled={moExchBusy || !configured} onClick={runMoExchanges}>
                        {moExchBusy ? 'Loading\u2026' : 'Fetch Exchanges'}
                      </button>
                    </div>
                    {moExchErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{moExchErr}</p> : null}
                    {moExchResults ? (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <p style={{ fontSize: '0.82rem', marginBottom: 'var(--space-2)' }}><strong>{moExchResults.length}</strong> exchange(s) returned</p>
                        <div style={{ maxHeight: '22rem', overflow: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 'var(--radius-sm)' }}>
                          <table className="feed-massive-table" style={{ width: '100%', fontSize: '0.78rem' }}>
                            <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>MIC</th><th>Asset Class</th><th>Locale</th><th>URL</th></tr></thead>
                            <tbody>
                              {moExchResults.map((ex, i) => (
                                <tr key={i}>
                                  <td>{String(ex.id ?? '')}</td>
                                  <td>{String(ex.name ?? '')}</td>
                                  <td>{String(ex.type ?? '')}</td>
                                  <td>{String(ex.mic ?? '')}</td>
                                  <td>{String(ex.asset_class ?? '')}</td>
                                  <td>{String(ex.locale ?? '')}</td>
                                  <td style={{ maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.url ? <a href={String(ex.url)} target="_blank" rel="noreferrer" style={{ fontSize: '0.76rem' }}>{String(ex.url)}</a> : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {moSubTab === 'market_holidays' ? (
                  <div className="feed-massive-agg-tab-panel" role="tabpanel">
                    <div className="feed-massive-agg-sub-doc">
                      <p><strong>Use case:</strong> Retrieve upcoming market holidays from the official API and compare with locally stored holidays. Helps verify that the local holiday calendar is in sync with the market schedule.</p>
                      <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v3/reference/market/holidays</code></p>
                    </div>
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <button type="button" className="btn btn-secondary" disabled={moHolBusy || !configured} onClick={runMoHolidays}>
                        {moHolBusy ? 'Loading\u2026' : 'Fetch & Compare Holidays'}
                      </button>
                    </div>
                    {moHolErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{moHolErr}</p> : null}
                    {moHolData?.ok ? (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                          <div>
                            <h4 style={{ fontSize: '0.85rem', marginBottom: 'var(--space-2)' }}>Massive holidays ({moHolData.massive_count ?? 0})</h4>
                            <div style={{ maxHeight: '18rem', overflow: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 'var(--radius-sm)' }}>
                              <table className="feed-massive-table" style={{ width: '100%', fontSize: '0.78rem' }}>
                                <thead><tr><th>Date</th><th>Exchange</th><th>Name</th><th>Status</th></tr></thead>
                                <tbody>
                                  {(moHolData.massive_holidays || []).map((h, i) => (
                                    <tr key={i}>
                                      <td>{String(h.date ?? '')}</td>
                                      <td>{String(h.exchange ?? '')}</td>
                                      <td>{String(h.name ?? '')}</td>
                                      <td>{String(h.status ?? '')}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                          <div>
                            <h4 style={{ fontSize: '0.85rem', marginBottom: 'var(--space-2)' }}>Local holidays ({moHolData.local_count ?? 0})</h4>
                            <div style={{ maxHeight: '18rem', overflow: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 'var(--radius-sm)' }}>
                              <table className="feed-massive-table" style={{ width: '100%', fontSize: '0.78rem' }}>
                                <thead><tr><th>Date</th><th>Exchange</th><th>Label</th></tr></thead>
                                <tbody>
                                  {(moHolData.local_holidays || []).map((h, i) => (
                                    <tr key={i}>
                                      <td>{String(h.holiday_date ?? '')}</td>
                                      <td>{String(h.exchange ?? '')}</td>
                                      <td>{String(h.label ?? '')}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                        {moHolData.comparison ? (
                          <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2, #f5f5f5)', fontSize: '0.82rem' }}>
                            <strong>Comparison summary</strong>
                            <ul style={{ margin: 'var(--space-2) 0 0 var(--space-4)', padding: 0 }}>
                              <li>In both: <strong>{moHolData.comparison.in_both.length}</strong> date(s)</li>
                              <li>Massive only: <strong>{moHolData.comparison.in_massive_only.length}</strong>{moHolData.comparison.in_massive_only.length > 0 ? ` — ${moHolData.comparison.in_massive_only.join(', ')}` : ''}</li>
                              <li>Local only: <strong>{moHolData.comparison.in_local_only.length}</strong>{moHolData.comparison.in_local_only.length > 0 ? ` — ${moHolData.comparison.in_local_only.join(', ')}` : ''}</li>
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {moSubTab === 'market_status' ? (
                  <div className="feed-massive-agg-tab-panel" role="tabpanel">
                    <div className="feed-massive-agg-sub-doc">
                      <p><strong>Use case:</strong> Check current real-time trading status across all Massive-tracked markets (equities, options, forex, crypto). Useful for verifying market open/close state before triggering data pipelines.</p>
                      <p className="feed-massive-agg-sub-endpoint">
                        <code>GET /v1/marketstatus/now</code>
                        {' '}
                        <span style={{ fontSize: '0.78rem', opacity: 0.75 }}>
                          — MassiveClient; app proxy GET /research/massive/market-ops/status.
                        </span>
                      </p>
                    </div>
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <button type="button" className="btn btn-secondary" disabled={moStatusBusy || !configured} onClick={runMoStatus}>
                        {moStatusBusy ? 'Loading\u2026' : 'Fetch Market Status'}
                      </button>
                    </div>
                    {moStatusErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{moStatusErr}</p> : null}
                    {moStatusData ? (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))', gap: 'var(--space-3)' }}>
                          {Object.entries(moStatusData).filter(([k]) => k !== 'serverTime' && k !== 'server_time').map(([key, val]) => (
                            <div key={key} style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color, #ddd)', background: 'var(--surface-2, #f5f5f5)' }}>
                              <div style={{ fontSize: '0.78rem', opacity: 0.65, marginBottom: 'var(--space-1)' }}>{key.replace(/_/g, ' ')}</div>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '—')}</div>
                            </div>
                          ))}
                        </div>
                        {(moStatusData.serverTime || moStatusData.server_time) ? (
                          <p style={{ marginTop: 'var(--space-3)', fontSize: '0.78rem', opacity: 0.6 }}>Server time: {String(moStatusData.serverTime ?? moStatusData.server_time ?? '')}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {moSubTab === 'conditions' ? (
                  <div className="feed-massive-agg-tab-panel" role="tabpanel">
                    <div className="feed-massive-agg-sub-doc">
                      <p><strong>Use case:</strong> Look up trade/quote condition codes and their meanings across asset classes. Essential for interpreting raw trade & quote data flags.</p>
                      <p className="feed-massive-agg-sub-endpoint"><code>REST: GET /v3/reference/conditions</code></p>
                    </div>
                    <div className="feed-massive-form-grid">
                      <label className="feed-massive-field">
                        <span className="form-label">Asset class</span>
                        <select className="form-input" value={moCondAsset} onChange={e => setMoCondAsset(e.target.value)} disabled={moCondBusy}>
                          <option value="">All</option>
                          <option value="stocks">Stocks</option>
                          <option value="options">Options</option>
                          <option value="crypto">Crypto</option>
                          <option value="fx">FX</option>
                        </select>
                      </label>
                      <label className="feed-massive-field">
                        <span className="form-label">Data type</span>
                        <select className="form-input" value={moCondDataType} onChange={e => setMoCondDataType(e.target.value)} disabled={moCondBusy}>
                          <option value="">All</option>
                          <option value="trade">Trade</option>
                          <option value="bbo">BBO</option>
                          <option value="nbbo">NBBO</option>
                        </select>
                      </label>
                    </div>
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <button type="button" className="btn btn-secondary" disabled={moCondBusy || !configured} onClick={runMoConditions}>
                        {moCondBusy ? 'Loading\u2026' : 'Fetch Condition Codes'}
                      </button>
                    </div>
                    {moCondErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{moCondErr}</p> : null}
                    {moCondResults ? (
                      <div style={{ marginTop: 'var(--space-3)' }}>
                        <p style={{ fontSize: '0.82rem', marginBottom: 'var(--space-2)' }}><strong>{moCondResults.length}</strong> condition(s) returned</p>
                        <div style={{ maxHeight: '22rem', overflow: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 'var(--radius-sm)' }}>
                          <table className="feed-massive-table" style={{ width: '100%', fontSize: '0.78rem' }}>
                            <thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Asset Class</th><th>Data Types</th><th>Description</th></tr></thead>
                            <tbody>
                              {moCondResults.map((c, i) => (
                                <tr key={i}>
                                  <td>{String(c.id ?? '')}</td>
                                  <td>{String(c.type ?? '')}</td>
                                  <td>{String(c.name ?? '')}</td>
                                  <td>{String(c.asset_class ?? '')}</td>
                                  <td>{Array.isArray(c.data_types) ? (c.data_types as string[]).join(', ') : String(c.data_types ?? '')}</td>
                                  <td style={{ maxWidth: '24rem', whiteSpace: 'normal' }}>{String(c.description ?? '')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

              </div>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCommonCapabilityPanel>
      </div>
    </div>
  )
}
