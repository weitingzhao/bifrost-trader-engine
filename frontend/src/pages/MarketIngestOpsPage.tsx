import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import {
  fetchMassiveWsLogs,
  subscribeMassiveWsLogs,
  clearMassiveWsLogs,
} from '../api/monitor/logs'
import {
  fetchOpsCapabilities,
  fetchOpsHealth,
  fetchMarketIngestServices,
  controlMarketIngest,
  type MarketIngestServiceRow,
  type BrokerAction,
} from '../api/ops/ops'

export interface MarketIngestOpsPageProps {
  embeddedInSettings?: boolean
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

type ConfirmState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  action: null,
}

function fmtAge(s: number | null | undefined): string {
  if (s == null || Number.isNaN(s)) return '—'
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function ServiceRow(props: {
  svc: MarketIngestServiceRow
  logicalText: string
  canAdmin: boolean
  subprocessMode: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}) {
  const { svc, logicalText, canAdmin, subprocessMode, onStart, onStop, onRestart } = props
  return (
    <tr>
      <td className="massive-api-kv-label">
        {svc.label}
        <div className="massive-api-doc-hint" style={{ marginTop: 4 }}>
          <code>{svc.systemd_unit}</code>
        </div>
      </td>
      <td>{svc.process_active}</td>
      <td>{logicalText}</td>
      <td>
        {canAdmin && !subprocessMode ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStart}>
              Start
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStop}>
              Stop
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRestart}>
              Restart
            </button>
          </div>
        ) : (
          <span className="massive-api-doc-hint">
            {subprocessMode
              ? 'Control disabled in subprocess Ops mode.'
              : 'Admin role required (Ops token).'}
          </span>
        )}
      </td>
    </tr>
  )
}

export function MarketIngestOpsPage({
  embeddedInSettings,
  status,
  loadStatus,
}: MarketIngestOpsPageProps) {
  const [services, setServices] = useState<MarketIngestServiceRow[]>([])
  const [opsErr, setOpsErr] = useState<string | null>(null)
  const [canAdmin, setCanAdmin] = useState(false)
  const [localControl, setLocalControl] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState>(INITIAL_CONFIRM)

  const fetchLogs = useCallback((tail?: number) => fetchMassiveWsLogs(tail ?? 80), [])
  const subscribeLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeMassiveWsLogs(onLine, onError),
    [],
  )
  const clearLogs = useCallback(() => clearMassiveWsLogs(), [])
  const wsConsole = useLogConsole({
    fetchLogs,
    subscribeLogs,
    clearLogs,
    initialMaxLines: 500,
    enabled: true,
  })

  const refresh = useCallback(async () => {
    try {
      const [svcRes, capRes, healthRes] = await Promise.all([
        fetchMarketIngestServices(),
        fetchOpsCapabilities(),
        fetchOpsHealth(),
      ])
      if (svcRes.ok && Array.isArray(svcRes.services)) {
        setServices(svcRes.services)
        setOpsErr(svcRes.error ?? null)
      } else {
        setServices([])
        setOpsErr(svcRes.error ?? 'Failed to load services')
      }
      setCanAdmin(capRes.capabilities?.can_admin === true)
      setLocalControl(healthRes.local_control ?? null)
    } catch (e) {
      setOpsErr((e as Error).message)
      setServices([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  const massive = status?.massive
  const subprocessMode = localControl === 'subprocess'

  const logicalSummary = (svc: MarketIngestServiceRow): string => {
    if (svc.id === 'massive_ws' && massive) {
      const ws = massive.ws_connected ? 'connected' : 'disconnected'
      const rc = massive.ws_reconnects != null ? String(massive.ws_reconnects) : '—'
      return `WS ${ws}; last msg ${fmtAge(massive.last_msg_age_s ?? null)}; reconnects ${rc}`
    }
    if (svc.redis_meta_key) return `Meta: ${svc.redis_meta_key}`
    return '—'
  }

  const openConfirm = (title: string, message: string, fn: () => Promise<void>) => {
    setConfirmState({
      open: true,
      title,
      message,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        try {
          await fn()
          await refresh()
          await loadStatus()
        } finally {
          setConfirmState(INITIAL_CONFIRM)
        }
      },
    })
  }

  const runControl = async (serviceId: string, action: BrokerAction) => {
    const r = await controlMarketIngest(serviceId, action)
    if (!r.ok) {
      throw new Error(r.error ?? 'Control request failed')
    }
  }

  const cardClass = embeddedInSettings
    ? 'settings-page-card dashboard-page dashboard-page--embedded'
    : 'settings-page-card dashboard-page'

  return (
    <div id="settings-market-ingest" className={cardClass}>
      {confirmState.open ? (
        <div
          className="data-reset-modal-overlay"
          onClick={() => {
            if (!confirmState.confirming) setConfirmState(INITIAL_CONFIRM)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="market-ingest-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="market-ingest-confirm-title">{confirmState.title}</h3>
            <p>{confirmState.message}</p>
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmState(INITIAL_CONFIRM)}
                disabled={confirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-shutdown-all"
                onClick={() => confirmState.action?.()}
                disabled={confirmState.confirming}
              >
                {confirmState.confirming ? 'Executing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            Market ingest
            <InfoTooltip text="Long-running processes that maintain external market data connections (e.g. Massive WebSocket). Status from Redis meta + systemd; control via Ops API (admin)." />
          </h2>
          <p className="settings-page-subtitle">
            Logical health from Monitor /status; process state from Ops. Consumers use Redis only.
          </p>
        </div>
      </div>

      {opsErr ? (
        <p className="settings-page-msg settings-page-msg--error" role="alert">
          {opsErr}
        </p>
      ) : null}

      {subprocessMode ? (
        <p className="massive-api-doc-hint" role="note">
          Ops <code>local_control=subprocess</code>: start/stop/restart uses run_celery-style subprocess only for
          workers. Ingest units need Linux <code>systemd</code> or <code>executor_mode=agent</code> on the ingest host.
          Process detection for Massive WS may still show <code>active</code> via pgrep on this machine.
        </p>
      ) : null}

      <div className="replay-section" aria-labelledby="market-ingest-services-head">
        <h3 id="market-ingest-services-head" className="page-title-with-tooltip">
          Services
        </h3>
        {services.length === 0 && !opsErr ? (
          <p className="massive-api-doc-hint">No services configured.</p>
        ) : (
          <table className="massive-api-kv-table">
            <thead>
              <tr>
                <th className="massive-api-kv-label">Service</th>
                <th>Process (systemd)</th>
                <th>Redis / logical</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {services.map(svc => (
                <ServiceRow
                  key={svc.id}
                  svc={svc}
                  logicalText={logicalSummary(svc)}
                  canAdmin={canAdmin}
                  subprocessMode={subprocessMode}
                  onStart={() => {
                    openConfirm(
                      'Start ingest service',
                      `Start ${svc.label}? Quotes may resume after the process connects.`,
                      () => runControl(svc.id, 'start'),
                    )
                  }}
                  onStop={() => {
                    openConfirm(
                      'Stop ingest service',
                      `Stop ${svc.label}? Redis quotes for this feed may go stale until restarted.`,
                      () => runControl(svc.id, 'stop'),
                    )
                  }}
                  onRestart={() => {
                    openConfirm(
                      'Restart ingest service',
                      `Restart ${svc.label}? There will be a short disconnect.`,
                      () => runControl(svc.id, 'restart'),
                    )
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <section className="replay-section" aria-labelledby="market-ingest-ws-log-head">
        <h3 id="market-ingest-ws-log-head" className="page-title-with-tooltip">
          Massive WS ingest log
          <InfoTooltip text="Redis stream bifrost:massive_ws_console from scripts/run_massive_ws.py (same pattern as System → Server)." />
        </h3>
        <LogConsolePanel
          controller={wsConsole}
          loadingText="Connecting…"
          errorText="Unable to load (Redis may be down or Monitor not running)."
          emptyText="No log lines yet. Start: python scripts/run_massive_ws.py"
          infoTooltipText="Massive WebSocket ingest process log."
          resizeAriaLabel="Resize Massive WS console height"
          clearTitle="Clear displayed log and Redis stream"
        />
      </section>
    </div>
  )
}
