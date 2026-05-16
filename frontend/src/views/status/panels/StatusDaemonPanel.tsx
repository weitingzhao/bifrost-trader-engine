import type { ReactNode } from 'react'
import type { DaemonHeartbeat, StatusResponse } from '../../../types'
import { fmtTs } from '../../../utils/format'
import { ingestRedisHealthLamp } from '../../../utils/socketIngestLamp'
import { ingestLampToBrokerRowLamp } from '../daemonIbBrokerLamp'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

/** Same glyph as Heartbeat / IB broker header lamps (stroke/fill). */
const ACTIVITY_LAMP_SVG = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 12h-4l-3 9L9 3 6 12H2" />
  </svg>
)

export function IbBrokerServiceLamp({ lamp, title }: { lamp: Lamp; title: string }) {
  return (
    <span
      className={`title-inline-lamp lamp-icon ib-broker-service-lamp ${lamp}`}
      title={title}
      role="img"
      aria-label={title}
    >
      {ACTIVITY_LAMP_SVG}
    </span>
  )
}

export interface StatusDaemonPanelProps {
  status: StatusResponse | null
  hb: DaemonHeartbeat | null | undefined
  daemonLabel: string
  daemonHint: string
  daemonSelfCheckText: string
  daemonBlockReasons: string
  daemonLamp: Lamp
  heartbeatGroupLamp: Lamp
  ibGroupLamp: Lamp
  ibGroupTitle: string
  secondsUntilNextHeartbeat: number | null
  /** Compact Trading Strategy panel (controls + summary) — core daemon trading surface */
  strategyPanel: ReactNode
  onNavigateToSocket?: () => void
  ctrlMsg: { text: string; isErr: boolean }
  className?: string
}

export function StatusDaemonPanel({
  status: j,
  hb,
  daemonLabel,
  daemonHint,
  daemonSelfCheckText,
  daemonBlockReasons,
  daemonLamp,
  heartbeatGroupLamp,
  ibGroupLamp,
  ibGroupTitle,
  secondsUntilNextHeartbeat,
  strategyPanel,
  onNavigateToSocket,
  ctrlMsg,
  className,
}: StatusDaemonPanelProps) {
  const opLamp = ingestRedisHealthLamp('ib_operator', j)
  const ingLamp = ingestRedisHealthLamp('ib_ingestor', j)
  const aaLamp = ingestRedisHealthLamp('ib_account_agent', j)

  return (
    <div id="system-panel-daemon" role="tabpanel" aria-labelledby="tab-daemon" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <div>
            <h3 id="daemon-panel-head" className="page-title-with-tooltip">
              <span className={`title-inline-lamp lamp-icon ${daemonLamp}`} title="Daemon status lamp" aria-hidden>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
              </span>
              Strategy Trading Daemon
            </h3>
            <div>
              <strong>Status: {j ? (daemonLabel === 'Running' ? 'Running (OK)' : `${daemonLabel} (${daemonSelfCheckText})`) : 'Fetch failed'}</strong>
              {j && daemonBlockReasons && daemonBlockReasons !== 'None' ? ` Block reasons: ${daemonBlockReasons}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="daemon-groups daemon-groups-layout">
          <div className="daemon-group daemon-group-heartbeat">
          <div className="daemon-group-header">
            <span className={`title-inline-lamp lamp-icon ${heartbeatGroupLamp}`} title="Heartbeat status" aria-hidden>
              {ACTIVITY_LAMP_SVG}
            </span>
            <span className="daemon-group-title">Heartbeat</span>
          </div>
          <div className="daemon-group-body">
            {hb?.daemon_alive && hb.last_ts != null ? (
              <p className="section-hint">Last heartbeat: <strong>{fmtTs(hb.last_ts)}</strong></p>
            ) : hb?.graceful_shutdown_at != null ? (
              <p className="section-hint">Gracefully stopped at <strong>{fmtTs(hb.graceful_shutdown_at)}</strong> (SIGTERM/Stop)</p>
            ) : hb?.last_ts != null ? (
              <p className="section-hint">Last heartbeat: <strong>{fmtTs(hb.last_ts)}</strong> (timed out; may have been kill -9 or crash)</p>
            ) : (
              <p className="section-hint">{daemonHint || '—'}</p>
            )}
            {hb?.daemon_alive && secondsUntilNextHeartbeat != null && (
              <p className="section-hint countdown-line">
                Next heartbeat: <span className="countdown-num">{secondsUntilNextHeartbeat}</span> s
              </p>
            )}
          </div>
        </div>
        <div className="daemon-group daemon-group-ib">
          <div className="daemon-group-header">
            <span className={`title-inline-lamp lamp-icon ${ibGroupLamp}`} title={ibGroupTitle} aria-hidden>
              {ACTIVITY_LAMP_SVG}
            </span>
            <span className="daemon-group-title">IB broker</span>
          </div>
          <div className="daemon-group-body">
            <table className="ib-connection-table" aria-label="IB broker path services">
              <thead>
                <tr>
                  <th scope="col" className="ib-connection-th">Service</th>
                  <th scope="col" className="ib-connection-th">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="ib-connection-row-label">IB Operator</th>
                  <td className="ib-connection-cell ib-connection-cell--lamp">
                    <IbBrokerServiceLamp lamp={ingestLampToBrokerRowLamp(opLamp.lamp)} title={opLamp.title} />
                  </td>
                </tr>
                <tr>
                  <th scope="row" className="ib-connection-row-label">IB Ingestor</th>
                  <td className="ib-connection-cell ib-connection-cell--lamp">
                    <IbBrokerServiceLamp lamp={ingestLampToBrokerRowLamp(ingLamp.lamp)} title={ingLamp.title} />
                  </td>
                </tr>
                <tr>
                  <th scope="row" className="ib-connection-row-label">IB Account Agent</th>
                  <td className="ib-connection-cell ib-connection-cell--lamp">
                    <IbBrokerServiceLamp lamp={ingestLampToBrokerRowLamp(aaLamp.lamp)} title={aaLamp.title} />
                  </td>
                </tr>
              </tbody>
            </table>
            <a
              href="#settings-ws-connector"
              className="daemon-ib-broker-socket-link section-hint"
              onClick={e => {
                if (onNavigateToSocket) {
                  e.preventDefault()
                  onNavigateToSocket()
                }
              }}
            >
              Open Socket services…
            </a>
          </div>
        </div>
        <div className="daemon-group daemon-group-strategy">
          <div className="daemon-group-body daemon-group-strategy-body">
            {strategyPanel}
          </div>
        </div>
      </div>

      {ctrlMsg.text ? (
        <div className={`msg ${ctrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
          {ctrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
