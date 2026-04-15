import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchMassiveStatus } from '../api'
import type { MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { CAPABILITY_GROUP_LABELS, type CapabilityGroup, type ChecklistRow } from './massiveFeedChecklistRows'
import {
  checklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus,
  groupedCommonFeedChecklistRows,
  groupedOptionFeedChecklistRows,
  shortServiceLabel,
  tierOkForRow,
  tradesOkForRow,
} from './massive/massiveChecklistStatus'
import {
  checklistEffectiveStatusLabel as stockChecklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus as stockEffectiveStatus,
  groupedStockChecklistRows,
  shortServiceLabel as stockShortServiceLabel,
  tierOkForRow as stockTierOkForRow,
  tradesOkForRow as stockTradesOkForRow,
} from './massive/massiveStockChecklistStatus'
import {
  FEED_MASSIVE_COMMON_ID,
  FEED_MASSIVE_OPTION_ID,
  FEED_MASSIVE_OVERVIEW_ID,
  FEED_MASSIVE_STOCK_ID,
} from './settings/settingsConstants'

interface FeedMassiveOverviewPageProps {
  status: StatusResponse | null
  onGoToFeed?: () => void
}

function statusDotClass(eff: string): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
}

export function FeedMassiveOverviewPage({ status: _status, onGoToFeed }: FeedMassiveOverviewPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)

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

  const configured = Boolean(massiveStatus?.configured)

  function renderOptionCommonColumn(
    title: string,
    feedId: string,
    grouped: { group: CapabilityGroup; rows: ChecklistRow[] }[],
    openLabel: string,
  ) {
    return (
      <section className="feed-massive-overview-column" aria-labelledby={`feed-massive-overview-${feedId}-h`}>
        <h3 id={`feed-massive-overview-${feedId}-h`} className="feed-massive-overview-column-title">
          {title}
        </h3>
        <p className="feed-massive-overview-column-lead">
          {grouped.reduce((n, g) => n + g.rows.length, 0)} capabilities across {grouped.length} channel group(s).
        </p>
        <ul className="feed-massive-overview-groups">
          {grouped.map(({ group, rows }) => (
            <li key={group} className="feed-massive-overview-group">
              <div className="feed-massive-overview-group-label">{CAPABILITY_GROUP_LABELS[group]}</div>
              <ul className="feed-massive-overview-rows">
                {rows.map(row => {
                  const tierOk = tierOkForRow(row, massiveStatus, configured)
                  const tradesOk = tradesOkForRow(row, massiveStatus)
                  const eff = effectiveChecklistProjectStatus(row, configured, tierOk, tradesOk)
                  return (
                    <li key={row.id} className="feed-massive-overview-row">
                      <span className={statusDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
                      <span className="feed-massive-overview-row-label">{shortServiceLabel(row)}</span>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="feed-massive-overview-actions">
          <a className="btn btn-secondary" href={`#${feedId}`}>
            {openLabel}
          </a>
        </div>
      </section>
    )
  }

  const stockGrouped = groupedStockChecklistRows()
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
            Massive Overview{' '}
            <InfoTooltip text="Summary of Polygon / Massive capabilities for Stocks, Options, and shared Common REST (Technical Indicators, Market Operations). Use the links below to open each feed page." />
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
        </div>
        {massiveStatus?.delay_notice ? <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p> : null}
      </section>

      <p className="feed-massive-overview-intro">
        Capabilities are organized by feed: <strong>Stocks</strong> (Massive Stocks REST), <strong>Options</strong> (Massive Options REST / WS / Flat Files / Project), and <strong>Common</strong> (shared REST for indicators and market reference).
      </p>

      <div className="feed-massive-overview-grid">
        <section className="feed-massive-overview-column" aria-labelledby="feed-massive-overview-stock-h">
          <h3 id="feed-massive-overview-stock-h" className="feed-massive-overview-column-title">
            Stocks
          </h3>
          <p className="feed-massive-overview-column-lead">
            {stockGrouped.reduce((n, g) => n + g.rows.length, 0)} capabilities across {stockGrouped.length} channel group(s).
          </p>
          <ul className="feed-massive-overview-groups">
            {stockGrouped.map(({ group, rows }) => (
              <li key={group} className="feed-massive-overview-group">
                <div className="feed-massive-overview-group-label">{CAPABILITY_GROUP_LABELS[group]}</div>
                <ul className="feed-massive-overview-rows">
                  {rows.map(row => {
                    const tierOk = stockTierOkForRow(row, massiveStatus, configured)
                    const tradesOk = stockTradesOkForRow(row, massiveStatus)
                    const eff = stockEffectiveStatus(row, configured, tierOk, tradesOk)
                    return (
                      <li key={row.id} className="feed-massive-overview-row">
                        <span className={statusDotClass(eff)} title={stockChecklistEffectiveStatusLabel(eff)} aria-hidden />
                        <span className="feed-massive-overview-row-label">{stockShortServiceLabel(row)}</span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <div className="feed-massive-overview-actions">
            <a className="btn btn-secondary" href={`#${FEED_MASSIVE_STOCK_ID}`}>
              Open Massive Stock
            </a>
          </div>
        </section>

        {renderOptionCommonColumn('Options', FEED_MASSIVE_OPTION_ID, groupedOptionFeedChecklistRows(), 'Open Massive Option')}
        {renderOptionCommonColumn('Common', FEED_MASSIVE_COMMON_ID, groupedCommonFeedChecklistRows(), 'Open Massive Common')}
      </div>

      <p className="feed-massive-overview-footnote">
        Bookmark this overview: <code>#{FEED_MASSIVE_OVERVIEW_ID}</code>
      </p>
    </div>
  )
}
