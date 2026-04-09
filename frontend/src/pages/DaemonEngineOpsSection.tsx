import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import {
  fetchOpsCapabilities,
  fetchOpsHealth,
  fetchMarketIngestServices,
  controlMarketIngest,
  setOpsToken,
  type MarketIngestServiceRow,
  type MarketIngestAction,
  type OpsCapabilities,
} from '../api/ops/ops'
import { OpsHostEnvPillBadge } from '../components/OpsHostEnvPillBadge'
import { ingestRedisHealthLamp, localControlAgentLamp } from '../utils/socketIngestLamp'
import {
  normalizedPageDevProd,
  socketServicesHostColumnDisplay,
} from '../utils/ingestOpsShared'
import { IngestServicesTable, type IngestCategory } from './MarketIngestOpsPage'

function fmtAge(s: number | null | undefined): string {
  if (s == null || Number.isNaN(s)) return '—'
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

type ConfirmState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  error: string | null
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  error: null,
  action: null,
}

export interface DaemonEngineOpsSectionProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

/**
 * Page title row: Daemon — Ops auth + systemd start/stop (POST /ops/market-ingest/control, trading_engine).
 * Renders at the top of the Daemon page; live status panel sits below.
 */
export function DaemonEngineOpsSection({ status, loadStatus }: DaemonEngineOpsSectionProps) {
  const [engineRow, setEngineRow] = useState<MarketIngestServiceRow | null>(null)
  const [opsErr, setOpsErr] = useState<string | null>(null)
  const [engineConfigMissing, setEngineConfigMissing] = useState(false)
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [configProfile, setConfigProfile] = useState<string | null>(null)
  const [localControl, setLocalControl] = useState<string | null>(null)
  const [marketIngestScriptControl, setMarketIngestScriptControl] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState>(INITIAL_CONFIRM)
  const [opsHealth, setOpsHealth] = useState<Awaited<ReturnType<typeof fetchOpsHealth>> | null>(null)

  const statusReceivedAtRef = useRef(Date.now() / 1000)
  const [, setTick] = useState(0)
  useEffect(() => { statusReceivedAtRef.current = Date.now() / 1000 }, [status])
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => (t + 1) & 0xffffff), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Date.now() / 1000 - statusReceivedAtRef.current)

  const refresh = useCallback(async () => {
    try {
      const [svcRes, capRes] = await Promise.all([
        fetchMarketIngestServices(),
        fetchOpsCapabilities(),
      ])
      if (svcRes.ok && Array.isArray(svcRes.services)) {
        const eng = svcRes.services.find(s => s.id === 'trading_engine') ?? null
        setEngineRow(eng)
        setOpsErr(typeof svcRes.error === 'string' && svcRes.error.trim() ? svcRes.error : null)
        setEngineConfigMissing(!eng)
      } else {
        setEngineRow(null)
        setEngineConfigMissing(false)
        setOpsErr(svcRes.error ?? 'Failed to load Ops services')
      }
      if (capRes.ok) setCaps(capRes)
    } catch (e) {
      setOpsErr((e as Error).message)
      setEngineRow(null)
      setEngineConfigMissing(false)
      setCaps(null)
    }
    try {
      const healthRes = await fetchOpsHealth()
      setOpsHealth(healthRes)
      setConfigProfile(healthRes.config_profile ?? null)
      setLocalControl(healthRes.local_control ?? null)
      setMarketIngestScriptControl(healthRes.market_ingest_script_control === true)
    } catch {
      setOpsHealth(null)
      setConfigProfile(null)
      setLocalControl(null)
      setMarketIngestScriptControl(false)
    }
  }, [])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    void refresh()
  }, [tokenInput, refresh])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  const disableIngestActions = localControl === 'subprocess' && marketIngestScriptControl !== true
  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'
  const canOperate = caps?.capabilities?.can_operate === true

  const hostColumn = useMemo(
    () =>
      socketServicesHostColumnDisplay({
        configProfile,
        localControl,
        marketIngestScriptControl,
      }),
    [configProfile, localControl, marketIngestScriptControl],
  )

  const engineRows = useMemo((): { svc: MarketIngestServiceRow; category: IngestCategory }[] => {
    if (!engineRow) return []
    return [{ svc: engineRow, category: 'Engine' }]
  }, [engineRow])

  const engineLamp = useMemo(
    () => ingestRedisHealthLamp('trading_engine', status),
    [status],
  )

  const localAgentPanel = useMemo(() => {
    if ((opsHealth?.executor_mode ?? '').toLowerCase() !== 'agent') {
      return null
    }
    const r = opsHealth?.agent_reachable
    const lamp = localControlAgentLamp(r)
    const socketPath = (opsHealth?.agent_socket ?? '').trim()
    let detail: string
    if (r === true) {
      detail =
        'Reachable. Engine start/stop below is delegated through this socket (systemd on the host).'
    } else if (r === false) {
      detail = opsHealth?.agent_error?.trim()
        ? opsHealth.agent_error
        : 'Unreachable — check bifrost-agent.service, socket permissions, and sudoers.'
    } else {
      detail =
        'Reachability not reported (upgrade Ops or inspect GET /ops/health). Engine control may fail until the agent answers.'
    }
    return { lamp, detail, socketPath }
  }, [opsHealth])

  const logicalSummary = useCallback(
    (svc: MarketIngestServiceRow): string => {
      if (svc.id === 'trading_engine') {
        const hb = status?.daemon?.heartbeat
        if (hb?.daemon_alive && hb.last_ts != null) {
          return `Daemon alive; last heartbeat ${fmtAge(Date.now() / 1000 - hb.last_ts)} ago`
        }
        if (hb?.graceful_shutdown_at != null) {
          return 'Graceful stop recorded (GET /status daemon.heartbeat)'
        }
        return 'Monitor /status heartbeat (not Redis ingest meta)'
      }
      return '—'
    },
    [status],
  )

  const openConfirm = (title: string, message: string, fn: () => Promise<void>) => {
    setConfirmState({
      open: true,
      title,
      message,
      confirming: false,
      error: null,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true, error: null }))
        try {
          await fn()
          setConfirmState(INITIAL_CONFIRM)
          void (async () => {
            await refresh()
            await loadStatus()
          })()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setConfirmState(prev => ({ ...prev, confirming: false, error: msg }))
        }
      },
    })
  }

  const runControl = async (serviceId: string, action: MarketIngestAction) => {
    await controlMarketIngest(serviceId, action)
  }

  const openServiceConfirm = (
    svc: MarketIngestServiceRow,
    action: Exclude<MarketIngestAction, 'reset'>,
    verb: string,
  ) => {
    let message: string
    if (action === 'start') {
      message = `Start ${svc.label}? Launches run_engine.py via systemd (or local Ops subprocess on Mac). Hedging still follows DB suspend/resume.`
    } else if (action === 'stop') {
      message = `Stop ${svc.label}? systemd sends SIGTERM (graceful). On exit the engine updates daemon_heartbeat (e.g. graceful_shutdown_at). This is not the same as Stop Daemon in Trading daemon below (POST /control/stop → daemon_control).`
    } else {
      message = `Restart ${svc.label}? Brief outage; equivalent to stop then start.`
    }
    openConfirm(`${verb} Engine`, message, () => runControl(svc.id, action))
  }

  const openResetConfirm = (svc: MarketIngestServiceRow) => {
    openConfirm(
      'Reset Engine',
      `Reset ${svc.label}? This restarts the Engine process (same end state as Restart).`,
      () => runControl(svc.id, 'reset'),
    )
  }

  return (
    <section className="replay-section" aria-labelledby="daemon-process-page-title">
      <div className="settings-page-header settings-page-header--celery">
        <div className="settings-page-title-group">
          <h2
            id="daemon-process-page-title"
            className="settings-page-title page-title-with-tooltip"
            style={{ flexWrap: 'wrap', rowGap: 'var(--space-2)' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <span
                className={`title-inline-lamp lamp-icon ${engineLamp.lamp}`}
                title={engineLamp.title}
                role="img"
                aria-label={engineLamp.title}
              >
                <SettingsSidebarLampGlyph id="daemon" />
              </span>
              <span>Daemon</span>
              <InfoTooltip text="Ops API: POST /ops/market-ingest/control (service_id trading_engine) for systemd start/stop. Authenticate here or on Settings → Socket; the token is shared." />
            </span>
          </h2>
          <p
            className="massive-api-doc-hint"
            style={{
              marginTop: 'var(--space-2)',
              marginBottom: 0,
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <span title={hostColumn.title}>
              This Ops instance (config / executor)
              <span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
                <OpsHostEnvPillBadge pill={hostColumn.pill} />
              </span>
            </span>
          </p>
        </div>
        <div className="dashboard-auth-bar dashboard-auth-bar--celery-header">
          <div className="dashboard-auth-info">
            <span className={`dashboard-auth-role dashboard-auth-role--${currentRole}`}>
              {currentRole.toUpperCase()}
            </span>
            {caps?.identity.name && caps.identity.name !== 'anonymous' && (
              <span className="dashboard-auth-name">{caps.identity.name}</span>
            )}
            {isAuthenticated && <span className="dashboard-auth-badge">Authenticated</span>}
            {authRequired && !isAuthenticated && (
              <span className="dashboard-auth-badge dashboard-auth-badge--warn">Token required for control</span>
            )}
          </div>
          <div className="dashboard-auth-actions">
            {isAuthenticated ? (
              <button type="button" className="dashboard-console-btn" onClick={handleLogout}>
                Sign out
              </button>
            ) : (
              <button
                type="button"
                className="dashboard-console-btn"
                onClick={() => setAuthPanelOpen(!authPanelOpen)}
              >
                Authenticate
              </button>
            )}
          </div>
          {authPanelOpen && !isAuthenticated && (
            <div className="dashboard-auth-panel dashboard-auth-panel--celery-header">
              <input
                type="password"
                className="dashboard-ctrl-input"
                placeholder="Ops API token…"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && tokenInput.trim()) handleLogin()
                }}
                autoFocus
              />
              <button
                type="button"
                className="btn-resume dashboard-btn dashboard-btn--start"
                onClick={handleLogin}
                disabled={!tokenInput.trim()}
              >
                Connect
              </button>
            </div>
          )}
        </div>
      </div>

      {confirmState.open ? (
        <div
          className="data-reset-modal-overlay"
          onClick={() => {
            if (!confirmState.confirming) setConfirmState(INITIAL_CONFIRM)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="daemon-engine-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="daemon-engine-confirm-title">{confirmState.title}</h3>
            <p>{confirmState.message}</p>
            {confirmState.error ? (
              <p
                className="settings-page-msg settings-page-msg--error"
                style={{ marginTop: 'var(--space-2)' }}
                role="alert"
              >
                {confirmState.error}
              </p>
            ) : null}
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

      {opsErr ? (
        <p className="settings-page-msg settings-page-msg--error" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {opsErr}
        </p>
      ) : null}
      {engineConfigMissing && !opsErr ? (
        <p className="massive-api-doc-hint" style={{ marginTop: 'var(--space-2)' }}>
          No <code>trading_engine</code> row in Ops <code>market_ingest_services</code> (see backend/ops/market_ingest_config.py).
        </p>
      ) : null}

      {localAgentPanel ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
            <span
              className={`title-inline-lamp lamp-icon ${localAgentPanel.lamp}`}
              title={localAgentPanel.detail}
              role="img"
              aria-label={localAgentPanel.detail}
            >
              <SettingsSidebarLampGlyph id="api-ops" />
            </span>
            Local Control Agent
            <InfoTooltip text="If red, systemd Engine control via Ops will fail. Socket Services page shows the same agent status." />
          </h4>
          <p className="massive-api-doc-hint" style={{ marginBottom: 0 }}>
            {localAgentPanel.detail}
            {localAgentPanel.socketPath ? (
              <>
                {' '}
                Socket: <code style={{ fontSize: '0.9em' }}>{localAgentPanel.socketPath}</code>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: 'var(--space-3)' }}>
        <IngestServicesTable
          rows={engineRows}
          status={status}
          elapsed={elapsed}
          pageEnv={normalizedPageDevProd(configProfile)}
          disableIngestScript={disableIngestActions}
          emptyHint="No trading_engine row in Ops config (backend/ops/market_ingest_config.py)."
          logicalSummary={logicalSummary}
          canOperate={canOperate}
          onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
          onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
          onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
          onReset={openResetConfirm}
        />
      </div>
    </section>
  )
}
