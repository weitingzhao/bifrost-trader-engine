import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { StatusResponse } from '../types'
import { fetchMassiveStatus, postMassiveStocksApiCoverageSync } from '../api'
import type { MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import stockChecklistRows from './massiveStockFeedChecklistRows'
import type { ChecklistRow } from './massiveStockFeedChecklistRows'
import { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER, type CapabilityGroup } from './massiveStockFeedChecklistRows'
import { feedMassiveStockSvcAnchorId } from './massive/feedMassiveStockTabUtils'
import { parseFeedMassiveStockSvcFromHash, parseFeedMassiveStockTabFromHash } from './massive/feedMassiveStockTabUtils'
import {
  checklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus,
  groupedStockChecklistRows,
  shortServiceLabel,
  stockCapabilityGroupForRowId,
  tierOkForRow,
  tradesOkForRow,
  type EffectiveServiceStatus,
} from './massive/massiveStockChecklistStatus'
import { FeedMassiveServiceBlock } from './massive/FeedMassiveServiceBlock'

// ── Helpers ────────────────────────────────────────────────────────────────

function overviewDotClass(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
}

const REST_SECTION_ORDER = [
  'stock-reference',
  'stock-aggregates',
  'stock-snapshots',
  'stock-trades-quotes',
  'stock-technical-indicators',
  'stock-market-ops',
] as const

const REST_SECTION_LABELS: Record<string, string> = {
  'stock-reference': 'Reference Data',
  'stock-aggregates': 'Aggregate Bars (OHLC)',
  'stock-snapshots': 'Snapshots',
  'stock-trades-quotes': 'Trades & Quotes',
  'stock-technical-indicators': 'Technical Indicators',
  'stock-market-ops': 'Market Operations',
}

// ── Capability Panel (mirrors FeedMassiveCapabilityPanel from Options page) ─

interface StockCapabilityPanelProps {
  capId: string
  checklistRow: ChecklistRow
  effectiveStatus: EffectiveServiceStatus
  expanded: boolean
  onToggle: () => void
  highlight: boolean
  ariaLabel: string
  children: ReactNode
}

function StockCapabilityPanel({
  capId,
  checklistRow,
  effectiveStatus,
  expanded,
  onToggle,
  highlight,
  ariaLabel,
  children,
}: StockCapabilityPanelProps) {
  const statusWords = checklistEffectiveStatusLabel(effectiveStatus)
  return (
    <section
      id={feedMassiveStockSvcAnchorId(capId)}
      className={`feed-massive-card feed-massive-cap-section${expanded ? ' feed-massive-cap-section--expanded' : ' feed-massive-cap-section--collapsed'}${highlight ? ' feed-massive-card--cap-active' : ''}`}
      aria-label={ariaLabel}
    >
      <div className="feed-massive-cap-panel-header">
        <button
          type="button"
          className="feed-massive-cap-panel-toggle"
          aria-expanded={expanded}
          aria-controls={`feed-massive-stock-cap-body-${capId}`}
          id={`feed-massive-stock-cap-head-${capId}`}
          onClick={onToggle}
        >
          <span
            className={`feed-massive-cap-panel-chevron${expanded ? ' feed-massive-cap-panel-chevron--open' : ''}`}
            aria-hidden
          />
          <span className="feed-massive-cap-panel-title">{shortServiceLabel(checklistRow)}</span>
          <span
            className={overviewDotClass(effectiveStatus)}
            title={statusWords}
            aria-label={`Status: ${statusWords}`}
          />
        </button>
      </div>
      {expanded ? (
        <div
          id={`feed-massive-stock-cap-body-${capId}`}
          className="feed-massive-cap-panel-body"
          role="region"
          aria-labelledby={`feed-massive-stock-cap-head-${capId}`}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

// ── Page props ─────────────────────────────────────────────────────────────

interface FeedMassiveStockPageProps {
  status: StatusResponse | null
  onGoToFeed?: () => void
  breadcrumbLabel?: string
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function FeedMassiveStockPage({
  status: _status,
  onGoToFeed,
  breadcrumbLabel = 'Massive Stock',
}: FeedMassiveStockPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [highlightedCapabilityId, setHighlightedCapabilityId] = useState<string | null>(null)
  const [capNavGroupExpanded, setCapNavGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce((acc, g) => { acc[g] = true; return acc }, {} as Record<CapabilityGroup, boolean>),
  )
  const [capExpanded, setCapExpanded] = useState<Record<string, boolean>>({})

  const [apiCoverageOpen, setApiCoverageOpen] = useState(false)
  const [apiCoverageSyncBusy, setApiCoverageSyncBusy] = useState(false)
  const [apiCoverageSyncMsg, setApiCoverageSyncMsg] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try { setMassiveStatus(await fetchMassiveStatus()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const toggleCap = useCallback((id: string) => {
    setCapExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    setCapExpanded(prev => ({ ...prev, [id]: true }))
    const g = stockCapabilityGroupForRowId(id)
    if (g) setCapNavGroupExpanded(prev => prev[g] ? prev : { ...prev, [g]: true })
    setTimeout(() => {
      document.getElementById(feedMassiveStockSvcAnchorId(id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }, [])

  useEffect(() => {
    const resolveId = (hash: string): string | null => {
      const fromTab = parseFeedMassiveStockTabFromHash(hash)
      if (fromTab && stockChecklistRows.some(r => r.id === fromTab)) return fromTab
      const fromSvc = parseFeedMassiveStockSvcFromHash(hash)
      if (fromSvc && stockChecklistRows.some(r => r.id === fromSvc)) return fromSvc
      return null
    }
    const onHashChange = () => {
      const id = resolveId(window.location.hash)
      if (id) scrollToSection(id)
      else setHighlightedCapabilityId(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [scrollToSection])

  useEffect(() => {
    const id =
      parseFeedMassiveStockTabFromHash(window.location.hash) ??
      parseFeedMassiveStockSvcFromHash(window.location.hash)
    if (id && stockChecklistRows.some(r => r.id === id)) {
      requestAnimationFrame(() => scrollToSection(id))
    }
  }, [scrollToSection])

  useEffect(() => {
    if (!highlightedCapabilityId) return
    const t = setTimeout(() => setHighlightedCapabilityId(null), 2200)
    return () => clearTimeout(t)
  }, [highlightedCapabilityId])

  const configured = Boolean(massiveStatus?.configured)

  // ── Derive per-row effective status ──────────────────────────────────────
  function rowEff(row: ChecklistRow): EffectiveServiceStatus {
    return effectiveChecklistProjectStatus(
      row, configured,
      tierOkForRow(row, massiveStatus, configured),
      tradesOkForRow(row, massiveStatus),
    )
  }

  function rowById(id: string): ChecklistRow {
    const r = stockChecklistRows.find(x => x.id === id)
    if (!r) throw new Error(`Stock checklist row not found: ${id}`)
    return r
  }

  // ── Evidence helper ───────────────────────────────────────────────────────
  function evidenceFor(row: ChecklistRow): ReactNode {
    if (row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          Shared implementation via Massive Option page. Use the existing UI with stock tickers.
        </span>
      )
    }
    return (
      <span className="feed-massive-svc-evidence-pending">
        Not yet implemented for stocks. See coverage sheet for target endpoints.
      </span>
    )
  }

  // ── Render a single capability section ───────────────────────────────────
  function renderCap(id: string) {
    const row = rowById(id)
    const eff = rowEff(row)
    return (
      <StockCapabilityPanel
        key={id}
        capId={id}
        checklistRow={row}
        effectiveStatus={eff}
        expanded={capExpanded[id] === true}
        onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id}
        ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <h3>{row.service}</h3>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>
      </StockCapabilityPanel>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="card process-section feed-massive-option-page">

      {/* Title */}
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
            <InfoTooltip text="Massive (Polygon) Stocks API coverage sheet and capability status. Shared endpoints (Technical Indicators, Market Ops, Corporate Actions) already work via Massive Option. Stock-specific endpoints are planned." />
          </h2>
          {configured && (
            <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
              Delayed feed
            </span>
          )}
        </div>
      </div>

      {/* Status strip */}
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
            <span className="feed-massive-status-key">Source</span>
            <span className="feed-massive-status-value">Polygon / Massive Stocks</span>
          </div>
        </div>
        {massiveStatus?.delay_notice ? (
          <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p>
        ) : null}
      </section>

      {/* Coverage Sheet banner */}
      <section
        className="feed-massive-api-coverage-banner"
        id="feed-massive-stock-api-coverage"
        aria-label="Massive Stocks API coverage sheet"
      >
        <div className="feed-massive-api-coverage-banner-row">
          <div className="feed-massive-api-coverage-copy">
            <div className="feed-massive-api-coverage-title">Official Stocks API vs project coverage</div>
            <p className="feed-massive-api-coverage-desc">
              Massive / Polygon Stocks endpoints, use cases, checklist mapping, and implementation status.
              Same viewer is available under MkDocs Research → Massive Stocks API coverage.
            </p>
          </div>
          <div className="feed-massive-api-coverage-actions">
            <a
              href="/plans/massive_stocks_api_coverage.html"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
            >
              Open in new tab
            </a>
            <button
              type="button"
              className="btn-secondary"
              disabled={apiCoverageSyncBusy}
              onClick={async () => {
                setApiCoverageSyncBusy(true)
                setApiCoverageSyncMsg(null)
                try {
                  const res = await postMassiveStocksApiCoverageSync()
                  setApiCoverageSyncMsg(res.ok ? 'Synced stocks coverage HTML to frontend/public/plans.' : (res.error ?? 'Sync failed'))
                } catch (e) {
                  setApiCoverageSyncMsg(e instanceof Error ? e.message : 'Sync failed')
                } finally {
                  setApiCoverageSyncBusy(false)
                }
              }}
            >
              {apiCoverageSyncBusy ? 'Syncing…' : 'Sync HTML'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setApiCoverageOpen(v => !v)}
              aria-expanded={apiCoverageOpen}
            >
              {apiCoverageOpen ? 'Hide embedded viewer' : 'Show embedded viewer'}
            </button>
          </div>
        </div>
        {apiCoverageSyncMsg ? <p className="feed-massive-api-coverage-sync-msg">{apiCoverageSyncMsg}</p> : null}
        {apiCoverageOpen ? (
          <div className="feed-massive-api-coverage-frame-wrap">
            <iframe
              title="Massive Stocks API coverage sheet"
              src="/plans/massive_stocks_api_coverage.html?embed=1"
              className="feed-massive-api-coverage-iframe"
            />
          </div>
        ) : null}
      </section>

      {/* Sticky nav with capability chips */}
      <nav className="feed-massive-tab-nav-section feed-massive-cap-nav-sticky" aria-label="Massive Stock capabilities">
        <div className="feed-massive-cap-sheet">
          <p className="feed-massive-cap-hint">
            Capabilities grouped by delivery channel. Click a group header to show or hide chips; click a chip to jump and expand that section.
          </p>
          {groupedStockChecklistRows().map(({ group, rows: groupRows }) => {
            const navOpen = capNavGroupExpanded[group]
            const groupHasHighlight = groupRows.some(row => highlightedCapabilityId === row.id)
            return (
              <div key={group} className="feed-massive-cap-group">
                <button
                  type="button"
                  className={`feed-massive-cap-group-toggle${groupHasHighlight ? ' feed-massive-cap-group-toggle--active' : ''}`}
                  aria-expanded={navOpen}
                  aria-controls={`feed-massive-stock-cap-group-panel-${group}`}
                  id={`feed-massive-stock-cap-group-head-${group}`}
                  onClick={() => setCapNavGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))}
                >
                  <span className={`feed-massive-cap-group-chevron${navOpen ? ' feed-massive-cap-group-chevron--open' : ''}`} aria-hidden>▼</span>
                  <span className="feed-massive-cap-group-label">{CAPABILITY_GROUP_LABELS[group]}</span>
                </button>
                <div
                  id={`feed-massive-stock-cap-group-panel-${group}`}
                  className="feed-massive-cap-group-panel"
                  hidden={!navOpen}
                  role="region"
                  aria-labelledby={`feed-massive-stock-cap-group-head-${group}`}
                >
                  <div className="feed-massive-cap-summary">
                    {groupRows.map(row => {
                      const eff = rowEff(row)
                      return (
                        <a
                          key={row.id}
                          href={`#${feedMassiveStockSvcAnchorId(row.id)}`}
                          className={`feed-massive-tab-chip${highlightedCapabilityId === row.id ? ' feed-massive-tab-chip--active' : ''}`}
                          aria-current={highlightedCapabilityId === row.id ? 'location' : undefined}
                          onClick={e => { e.preventDefault(); scrollToSection(row.id) }}
                        >
                          <span className={overviewDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
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

      {/* Not configured warning */}
      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config. Shared capabilities (Technical Indicators, Market Ops) are already functional via Massive Option.
        </p>
      )}

      {/* Main capability panels */}
      <div className="feed-massive-tab-panel">

        {/* REST API */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-rest">REST API</h3>

        {REST_SECTION_ORDER.map(id => {
          const row = stockChecklistRows.find(r => r.id === id)
          if (!row) return null
          return (
            <div key={id}>
              <h4 className="feed-massive-section-header">{REST_SECTION_LABELS[id]}</h4>
              {renderCap(id)}
            </div>
          )
        })}

        {/* WebSocket */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-ws">WebSocket</h3>
        {stockChecklistRows
          .filter(r => r.group === 'ws')
          .map(row => renderCap(row.id))}

        {/* Flat Files */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-flat">Flat Files</h3>
        {stockChecklistRows
          .filter(r => r.group === 'flat')
          .map(row => renderCap(row.id))}

        {/* Project */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-project">Project</h3>
        {stockChecklistRows
          .filter(r => r.group === 'project')
          .map(row => renderCap(row.id))}

      </div>
    </div>
  )
}
