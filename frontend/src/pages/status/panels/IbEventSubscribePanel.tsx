import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../../../types'
import { postReleaseTickerSubscriptions } from '../../../api'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { scheduleMsgClear, setMsg } from '../messageUtils'
export interface IbEventSubscribePanelProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

export function IbEventSubscribePanel({ status: j, loadStatus }: IbEventSubscribePanelProps) {
  const hb = j?.daemon?.heartbeat
  const [releaseTickerLoading, setReleaseTickerLoading] = useState(false)
  const [syncTickerMsg, setSyncTickerMsg] = useState({ text: '', isErr: false })
  const syncTickerMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
    }
  }, [])

  const streamHostAccountId = (j?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (j?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
  const openOrdersList = j?.portfolio?.open_orders ?? []
  const hostOpenOrderCount = streamHostAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamHostAccountId).length
    : openOrdersList.length
  const secondaryOpenOrderCount = streamSecondaryAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamSecondaryAccountId).length
    : 0

  const hasSecondary = !!(
    j?.config?.ib_client?.client?.secondary_host_ip ?? j?.config?.ib_client?.port?.listener_secondary != null
  )

  const onReleaseTickers = useCallback(async () => {
    setReleaseTickerLoading(true)
    try {
      const res = await postReleaseTickerSubscriptions()
      if (res.ok) {
        setMsg(setSyncTickerMsg, 'Released; restoring on next heartbeat', false)
        scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
        setTimeout(() => loadStatus(), 1500)
      }
      if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
    } finally {
      setReleaseTickerLoading(false)
    }
  }, [loadStatus])

  return (
    <div className="status-panel-section card-event-subscribe event-subscribe-section">
      <div className="event-subscribe-header-row">
        <h2 className="daemon-card-title page-title-with-tooltip" style={{ margin: 0 }}>
          <span
            className="title-inline-lamp lamp-icon none"
            title="Daemon does not publish IB event subscription state"
            aria-hidden
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 12h-4l-3 9L9 3 6 12H2" />
            </svg>
          </span>
          IB Event Subscribe
          <InfoTooltip text="Legacy table: daemon heartbeat no longer updates subscription flags. Use Daemon → IB broker and Socket services for Ingestor/Account Agent health." />
        </h2>
        <div className="event-subscribe-buttons">
          <button
            type="button"
            className="section-header-icon-btn"
            title="Release all ticker subscriptions; daemon restores on next heartbeat"
            aria-label="Release ticker subscriptions"
            disabled={releaseTickerLoading || !hb?.daemon_alive}
            onClick={onReleaseTickers}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18.84 12.25l1.72-1.71h-.02a3 3 0 0 0-.12-4.26 3 3 0 0 0-4.24-.12l-1.72 1.71" />
              <path d="M5.17 11.75l-1.71 1.71a3 3 0 0 0 .12 4.26 3 3 0 0 0 4.24.12l1.71-1.71" />
              <path d="M8 2v4M2 8h4M16 20v-4M20 16h-4" />
            </svg>
          </button>
        </div>
      </div>
      <p className="section-hint" style={{ marginBottom: 'var(--space-3)' }}>
        The daemon focuses on consuming Redis (Ingestor/Account Agent) for trading; it does not report IB event subscription status here.
      </p>
      <div className="event-subscribe-body">
        <table className="table-operations table-event-subscribe table-event-subscribe-horizontal">
          <thead>
            <tr>
              <th className="event-subscribe-col-subscription">Subscription</th>
              <th className="event-subscribe-col-account">Host account</th>
              {hasSecondary && <th className="event-subscribe-col-account">Secondary account</th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="event-subscribe-col-subscription">Real-time ticker (Host only)</td>
              <td>
                <div className="event-subscribe-status-cell">
                  <span
                    className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.event_subscribe_ticker ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`}
                    aria-hidden
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  <span
                    className="event-subscribe-status-text"
                    title={
                      hb?.daemon_alive &&
                      hb?.event_subscribe_ticker &&
                      (j?.live_ui?.subscribed_tickers?.length ?? 0) > 0
                        ? `Subscribed symbols: ${(j?.live_ui?.subscribed_tickers ?? []).join(', ')}`
                        : undefined
                    }
                  >
                    {hb?.daemon_alive && hb?.event_subscribe_ticker ? (
                      <>
                        <span className="countdown-num">{j?.live_ui?.subscribed_tickers?.length ?? 0}</span>
                        {' ticker'}
                        {(j?.live_ui?.subscribed_tickers?.length ?? 0) === 1 ? '' : 's'}
                      </>
                    ) : hb?.daemon_alive ? (
                      'Not subscribed'
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
              </td>
              {hasSecondary && (
                <td>
                  <span className="event-subscribe-status-text event-subscribe-no-need">No need</span>
                </td>
              )}
            </tr>
            <tr>
              <td className="event-subscribe-col-subscription">Open orders</td>
              <td>
                <div className="event-subscribe-status-cell">
                  <span
                    className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : hostOpenOrderCount > 0 ? 'green' : 'none'}`}
                    aria-hidden
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                    </svg>
                  </span>
                  <span className="event-subscribe-status-text">
                    {hb?.daemon_alive ? (
                      <>
                        <span className="countdown-num">{hostOpenOrderCount}</span>
                        {' open order'}
                        {hostOpenOrderCount === 1 ? '' : 's'}
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
              </td>
              {hasSecondary && (
                <td>
                  <div className="event-subscribe-status-cell">
                    <span
                      className={`title-inline-lamp lamp-icon ${!hb?.daemon_alive ? 'red' : secondaryOpenOrderCount > 0 ? 'green' : 'none'}`}
                      aria-hidden
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                      </svg>
                    </span>
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive ? (
                        <>
                          <span className="countdown-num">{secondaryOpenOrderCount}</span>
                          {' open order'}
                          {secondaryOpenOrderCount === 1 ? '' : 's'}
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>
                </td>
              )}
            </tr>
            {(['positions', 'fills', 'commission'] as const).map(kind => {
              const labels: Record<string, string> = {
                positions: 'Position updates',
                fills: 'Fill / execution report',
                commission: 'Commission report',
              }
              const hostKey = `event_subscribe_${kind}` as keyof typeof hb
              const secKey = `event_subscribe_${kind}_ib2` as keyof typeof hb
              return (
                <tr key={kind}>
                  <td className="event-subscribe-col-subscription">{labels[kind]}</td>
                  <td>
                    <div className="event-subscribe-status-cell">
                      <span
                        className={`title-inline-lamp lamp-icon ${hb?.daemon_alive && hb?.[hostKey] ? 'green' : hb?.daemon_alive ? 'red' : 'none'}`}
                        aria-hidden
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                        </svg>
                      </span>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive && hb?.[hostKey] ? 'Subscribed' : hb?.daemon_alive ? 'Not subscribed' : '—'}
                      </span>
                    </div>
                  </td>
                  {hasSecondary && (
                    <td>
                      <div className="event-subscribe-status-cell">
                        <span
                          className={`title-inline-lamp lamp-icon ${hb?.listener_2_connected && hb?.[secKey] ? 'green' : hb?.listener_2_connected ? 'red' : 'none'}`}
                          aria-hidden
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                          </svg>
                        </span>
                        <span className="event-subscribe-status-text">
                          {hb?.listener_2_connected && hb?.[secKey]
                            ? 'Subscribed'
                            : hb?.listener_2_connected
                              ? 'Not subscribed'
                              : '—'}
                        </span>
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {syncTickerMsg.text ? (
          <div className={`msg ${syncTickerMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {syncTickerMsg.text}
          </div>
        ) : null}
        {hb?.last_control_message ? (
          <div className="msg err" style={{ marginTop: '0.5rem' }} role="alert">
            {hb.last_control_message}
          </div>
        ) : null}
      </div>
    </div>
  )
}
