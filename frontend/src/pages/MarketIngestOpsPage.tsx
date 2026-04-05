import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import {
  fetchMassiveWsLogs,
  subscribeMassiveWsLogs,
  clearMassiveWsLogs,
  fetchIbOperatorLogs,
  subscribeIbOperatorLogs,
  clearIbOperatorLogs,
  fetchIbMarketLogs,
  subscribeIbMarketLogs,
  clearIbMarketLogs,
} from '../api/monitor/logs'
import {
  fetchOpsCapabilities,
  fetchOpsHealth,
  fetchMarketIngestServices,
  controlMarketIngest,
  type MarketIngestServiceRow,
  type MarketIngestAction,
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
  disableIngestActions: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onReset: () => void
}) {
  const { svc, logicalText, canAdmin, disableIngestActions, onStart, onStop, onRestart, onReset } = props
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
        {canAdmin && !disableIngestActions ? (
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
            <button type="button" className="btn btn-secondary btn-sm" onClick={onReset}>
              Reset
            </button>
          </div>
        ) : (
          <span className="massive-api-doc-hint">
            {disableIngestActions
              ? 'Control disabled: subprocess Ops without ingest script support (upgrade Ops or use Linux systemd).'
              : 'Admin role required (Ops token).'}
          </span>
        )}
      </td>
    </tr>
  )
}

function ServicesTable(props: {
  rows: MarketIngestServiceRow[]
  emptyHint: string
  logicalSummary: (svc: MarketIngestServiceRow) => string
  canAdmin: boolean
  disableIngestActions: boolean
  onStart: (svc: MarketIngestServiceRow) => void
  onStop: (svc: MarketIngestServiceRow) => void
  onRestart: (svc: MarketIngestServiceRow) => void
  onReset: (svc: MarketIngestServiceRow) => void
}) {
  const { rows, emptyHint, logicalSummary, canAdmin, disableIngestActions, onStart, onStop, onRestart, onReset } =
    props
  if (rows.length === 0) {
    return <p className="massive-api-doc-hint">{emptyHint}</p>
  }
  return (
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
        {rows.map(svc => (
          <ServiceRow
            key={svc.id}
            svc={svc}
            logicalText={logicalSummary(svc)}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={() => onStart(svc)}
            onStop={() => onStop(svc)}
            onRestart={() => onRestart(svc)}
            onReset={() => onReset(svc)}
          />
        ))}
      </tbody>
    </table>
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
  const [marketIngestScriptControl, setMarketIngestScriptControl] = useState(false)
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

  const fetchIbLogs = useCallback((tail?: number) => fetchIbMarketLogs(tail ?? 80), [])
  const subscribeIbLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeIbMarketLogs(onLine, onError),
    [],
  )
  const clearIbLogs = useCallback(() => clearIbMarketLogs(), [])
  const ibMarketConsole = useLogConsole({
    fetchLogs: fetchIbLogs,
    subscribeLogs: subscribeIbLogs,
    clearLogs: clearIbLogs,
    initialMaxLines: 500,
    enabled: true,
  })

  const fetchIbOpLogs = useCallback((tail?: number) => fetchIbOperatorLogs(tail ?? 80), [])
  const subscribeIbOpLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeIbOperatorLogs(onLine, onError),
    [],
  )
  const clearIbOpLogs = useCallback(() => clearIbOperatorLogs(), [])
  const ibOperatorConsole = useLogConsole({
    fetchLogs: fetchIbOpLogs,
    subscribeLogs: subscribeIbOpLogs,
    clearLogs: clearIbOpLogs,
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
      setMarketIngestScriptControl(healthRes.market_ingest_script_control === true)
    } catch (e) {
      setOpsErr((e as Error).message)
      setServices([])
      setMarketIngestScriptControl(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  const massive = status?.massive
  const ibMarket = status?.ib_market
  const disableIngestActions = localControl === 'subprocess' && marketIngestScriptControl !== true

  const { massiveServices, ibServices, otherServices } = useMemo(() => {
    const massiveServices: MarketIngestServiceRow[] = []
    const ibServices: MarketIngestServiceRow[] = []
    const otherServices: MarketIngestServiceRow[] = []
    for (const s of services) {
      if (s.id === 'massive_ws') {
        massiveServices.push(s)
      } else if (s.id === 'ib_market' || s.id === 'ib_operator') {
        ibServices.push(s)
      } else {
        otherServices.push(s)
      }
    }
    return { massiveServices, ibServices, otherServices }
  }, [services])

  const logicalSummary = (svc: MarketIngestServiceRow): string => {
    if (svc.id === 'massive_ws' && massive) {
      const ws = massive.ws_connected ? 'connected' : 'disconnected'
      const rc = massive.ws_reconnects != null ? String(massive.ws_reconnects) : '—'
      return `WS ${ws}; last msg ${fmtAge(massive.last_msg_age_s ?? null)}; reconnects ${rc}`
    }
    if (svc.id === 'ib_market' && ibMarket) {
      const c = ibMarket.connected ? 'connected' : 'disconnected'
      const rc = ibMarket.reconnects != null ? String(ibMarket.reconnects) : '—'
      const mc = ibMarket.msg_count != null ? String(ibMarket.msg_count) : '—'
      return `IB ${c}; last msg ${fmtAge(ibMarket.last_msg_age_s ?? null)}; reconnects ${rc}; msgs ${mc}`
    }
    if (svc.id === 'ib_operator') {
      return `Operator health Redis key: ${svc.redis_meta_key}`
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

  const runControl = async (serviceId: string, action: MarketIngestAction) => {
    const r = await controlMarketIngest(serviceId, action)
    if (!r.ok) {
      throw new Error(r.error ?? 'Control request failed')
    }
  }

  const openServiceConfirm = (svc: MarketIngestServiceRow, action: Exclude<MarketIngestAction, 'reset'>, verb: string) => {
    const messages: Record<Exclude<MarketIngestAction, 'reset'>, string> = {
      start: `Start ${svc.label}? Quotes may resume after the process connects.`,
      stop: `Stop ${svc.label}? Redis quotes for this feed may go stale until restarted.`,
      restart: `Restart ${svc.label}? There will be a short disconnect.`,
    }
    openConfirm(`${verb} service`, messages[action], () => runControl(svc.id, action))
  }

  const openResetConfirm = (svc: MarketIngestServiceRow) => {
    const isIb = svc.id === 'ib_operator' || svc.id === 'ib_market'
    const message = isIb
      ? `Reset ${svc.label}? This will restart the service and disconnect IB clients (TWS).`
      : `Reset ${svc.label}? This restarts the ingest process (same end state as Restart).`
    openConfirm('Reset service', message, () => runControl(svc.id, 'reset'))
  }

  const cardClass = embeddedInSettings
    ? 'settings-page-card dashboard-page dashboard-page--embedded'
    : 'settings-page-card dashboard-page'

  return (
    <div id="settings-ws-connector" className={cardClass}>
      {confirmState.open ? (
        <div
          className="data-reset-modal-overlay"
          onClick={() => {
            if (!confirmState.confirming) setConfirmState(INITIAL_CONFIRM)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-connector-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="ws-connector-confirm-title">{confirmState.title}</h3>
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
            WS Connector
            <InfoTooltip text="Massive (Polygon) WebSocket ingest and IB market data ingest. Status from Monitor /status and Redis; systemd control via Ops API (admin)." />
          </h2>
          <p className="settings-page-subtitle">
            Logical health from Monitor /status; process state from Ops. Feeds write to Redis.
          </p>
        </div>
      </div>

      {opsErr ? (
        <p className="settings-page-msg settings-page-msg--error" role="alert">
          {opsErr}
        </p>
      ) : null}

      {localControl === 'subprocess' ? (
        <p className="massive-api-doc-hint" role="note">
          Ops <code>local_control=subprocess</code>: Celery workers use <code>run_celery.py</code>. Ingest services
          (Massive WS, IB Operator, IB market ingest) are started with <code>scripts/run_*.py</code> on this host when{' '}
          <code>market_ingest_script_control</code> is true (see <code>GET /ops/health</code>). Production Linux still
          recommends <code>systemd</code> or <code>executor_mode=agent</code> on the ingest host.
        </p>
      ) : null}

      <section className="replay-section" aria-labelledby="ws-connector-massive-group">
        <h3 id="ws-connector-massive-group" className="page-title-with-tooltip">
          Massive (Polygon)
          <InfoTooltip text="Options WebSocket feed from Polygon (Massive). Separate from Interactive Brokers." />
        </h3>
        <p className="settings-page-subtitle" style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>
          Services and console for Massive WebSocket ingest.
        </p>
        <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Services
        </h4>
        {!opsErr ? (
          <ServicesTable
            rows={massiveServices}
            emptyHint="No Massive service row in Ops config (e.g. massive_ws)."
            logicalSummary={logicalSummary}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
            onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
            onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
            onReset={openResetConfirm}
          />
        ) : null}

        <div style={{ marginTop: 'var(--space-5)' }}>
          <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
            WebSocket log
          </h4>
          <LogConsolePanel
            controller={wsConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or Monitor not running)."
            emptyText="No log lines yet. Start: python scripts/run_massive_ws.py"
            infoTooltipText="WS Connector — Massive WebSocket ingest (bifrost:massive_ws_console)."
            resizeAriaLabel="Resize Massive WebSocket console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </div>
      </section>

      <section className="replay-section" aria-labelledby="ws-connector-ib-group">
        <h3 id="ws-connector-ib-group" className="page-title-with-tooltip">
          IB
          <InfoTooltip text="Interactive Brokers market data ingest (host TWS). Uses dedicated client_id; not Massive." />
        </h3>
        <p className="settings-page-subtitle" style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>
          IB Operator (cmd RPC) and IB market ingest. Reset disconnects IB clients before restart where applicable.
        </p>
        <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Services
        </h4>
        {!opsErr ? (
          <ServicesTable
            rows={ibServices}
            emptyHint="No IB service rows in Ops config (ib_operator, ib_market)."
            logicalSummary={logicalSummary}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
            onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
            onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
            onReset={openResetConfirm}
          />
        ) : null}

        <div style={{ marginTop: 'var(--space-5)' }}>
          <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
            IB Operator log
          </h4>
          <LogConsolePanel
            controller={ibOperatorConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or Monitor not running)."
            emptyText="No log lines yet. Start: python scripts/run_ib_operator.py"
            infoTooltipText="WS Connector — IB Operator cmd RPC only (bifrost:ib_operator_console). Separate from IB market ingest."
            resizeAriaLabel="Resize IB Operator console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </div>

        <div style={{ marginTop: 'var(--space-5)' }}>
          <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
            IB market ingest log
          </h4>
          <LogConsolePanel
            controller={ibMarketConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or Monitor not running)."
            emptyText="No log lines yet. Start: python scripts/run_ib_market_ingest.py"
            infoTooltipText="WS Connector — IB market ingest only (bifrost:ib_market_console). Not IB Operator."
            resizeAriaLabel="Resize IB market ingest console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </div>
      </section>

      {otherServices.length > 0 ? (
        <section className="replay-section" aria-labelledby="ws-connector-other-group">
          <h3 id="ws-connector-other-group" className="page-title-with-tooltip">
            Other services
            <InfoTooltip text="Rows from Ops market_ingest_services not classified as Massive or IB." />
          </h3>
          <ServicesTable
            rows={otherServices}
            emptyHint=""
            logicalSummary={logicalSummary}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
            onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
            onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
            onReset={openResetConfirm}
          />
        </section>
      ) : null}
    </div>
  )
}
