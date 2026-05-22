import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { DraggableModal } from '../components/DraggableModal'
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
import {
  aggregateDaemonProcessesHealthFromStatus,
  aggregateIngestRedisHealthLamp,
  localControlAgentLamp,
} from '../utils/socketIngestLamp'
import {
  normalizedPageDevProd,
  socketServicesHostColumnDisplay,
} from '../utils/ingestOpsShared'
import { IngestServicesTable, type IngestCategory } from './MarketIngestOpsPage'
import { SettingsSection } from './settings/SettingsSection'
import {
  SettingsPageHeader,
  SettingsPageTitle,
} from './settings/SettingsPageHeader'
import { SettingsTitleLamp } from './settings/SettingsTitleLamp'
import { SettingsStatusMessage } from './settings/SettingsStatusMessage'
import { Button } from '@/components/ui/button'
import type { LampTone } from '@/components/shared/lamp-indicator'

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

/** Richer Ops error text when Account Sync Daemon start/stop fails (subprocess or systemd). */
function formatAccountSyncOpsError(raw: string): string {
  const m = raw.trim()
  if (m.includes('exited immediately')) {
    return `${m} Open logs/account-sync-daemon.log or logs/account-sync-daemon-dev.log under the project. Typical causes: PostgreSQL or Redis URL wrong, IB Account Agent stream unavailable, or import/config errors.`
  }
  if (m.includes('ingest_already_running')) {
    return `${m} Use Stop first, or Restart instead of Start.`
  }
  if (m.includes('not found at') && m.includes('run_account_sync_daemon')) {
    return `${m} Ensure you run Ops from the repo root and scripts/systemd/run_account_sync_daemon.py exists.`
  }
  if (m.includes('sudo') && m.includes('NOPASSWD')) {
    return `${m} Linux Ops needs passwordless sudo for systemctl. On macOS, enable script-based control (GET /ops/health market_ingest_script_control) or start the daemon manually.`
  }
  return m
}

export interface DaemonEngineOpsSectionProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

/**
 * Page title row: Daemon — Ops auth + systemd start/stop (POST /ops/market-ingest/control).
 * Title lamp rolls up all process rows below (Strategy Engine + Account Sync when in Ops config).
 */
export function DaemonEngineOpsSection({ status, loadStatus }: DaemonEngineOpsSectionProps) {
  const [engineRow, setEngineRow] = useState<MarketIngestServiceRow | null>(null)
  const [accountSyncRow, setAccountSyncRow] = useState<MarketIngestServiceRow | null>(null)
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
        const asd = svcRes.services.find(s => s.id === 'account_sync_daemon') ?? null
        setEngineRow(eng)
        setAccountSyncRow(asd)
        setOpsErr(typeof svcRes.error === 'string' && svcRes.error.trim() ? svcRes.error : null)
        setEngineConfigMissing(!eng)
      } else {
        setEngineRow(null)
        setAccountSyncRow(null)
        setEngineConfigMissing(false)
        setOpsErr(svcRes.error ?? 'Failed to load Ops services')
      }
      if (capRes.ok) setCaps(capRes)
    } catch (e) {
      setOpsErr((e as Error).message)
      setEngineRow(null)
      setAccountSyncRow(null)
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
    const out: { svc: MarketIngestServiceRow; category: IngestCategory }[] = []
    if (engineRow) out.push({ svc: engineRow, category: 'Engine' })
    if (accountSyncRow) out.push({ svc: accountSyncRow, category: 'Engine' })
    return out
  }, [engineRow, accountSyncRow])

  /** Title lamp: worst-of rows below; before Ops rows load, same canonical two-process roll-up as App menu. */
  const daemonPageRollup = useMemo(() => {
    if (engineRows.length > 0) return aggregateIngestRedisHealthLamp(engineRows, status)
    return aggregateDaemonProcessesHealthFromStatus(status)
  }, [engineRows, status])

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
      if (svc.id === 'account_sync_daemon') {
        const hb = (status as { account_sync_daemon?: { heartbeat?: { daemon_alive?: boolean; last_ts?: number } } })
          ?.account_sync_daemon?.heartbeat
        if (hb?.daemon_alive && hb.last_ts != null) {
          return `Alive; last sync heartbeat ${fmtAge(Date.now() / 1000 - hb.last_ts)} ago`
        }
        return 'GET /status account_sync_daemon (PostgreSQL heartbeat)'
      }
      return '—'
    },
    [status],
  )

  const openConfirm = (
    title: string,
    message: string,
    fn: () => Promise<void>,
    options?: { formatError?: (msg: string) => string },
  ) => {
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
          const errOut = options?.formatError ? options.formatError(msg) : msg
          setConfirmState(prev => ({ ...prev, confirming: false, error: errOut }))
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
    if (svc.id === 'account_sync_daemon') {
      if (action === 'start') {
        message = `Start ${svc.label}? Launches scripts/systemd/run_account_sync_daemon.py via systemd; syncs IB account stream to PostgreSQL.`
      } else if (action === 'stop') {
        message = `Stop ${svc.label}? systemd sends SIGTERM. Account sync pauses until started again.`
      } else {
        message = `Restart ${svc.label}? Brief gap in account/position sync.`
      }
    } else if (action === 'start') {
      message = `Start ${svc.label}? Launches run_engine.py via systemd (or local Ops subprocess on Mac). Hedging still follows DB suspend/resume.`
    } else if (action === 'stop') {
      message = `Stop ${svc.label}? systemd sends SIGTERM (graceful). On exit the engine updates daemon_heartbeat (e.g. graceful_shutdown_at). This is not the same as Stop Daemon in Strategy Trading Daemon below (POST /control/stop → daemon_control).`
    } else {
      message = `Restart ${svc.label}? Brief outage; equivalent to stop then start.`
    }
    openConfirm(`${verb} ${svc.label}`, message, () => runControl(svc.id, action), {
      formatError: svc.id === 'account_sync_daemon' ? formatAccountSyncOpsError : undefined,
    })
  }

  const openResetConfirm = (svc: MarketIngestServiceRow) => {
    const body =
      svc.id === 'account_sync_daemon'
        ? `Reset ${svc.label}? Restarts the Account Sync process (same end state as Restart).`
        : `Reset ${svc.label}? This restarts the Engine process (same end state as Restart).`
    openConfirm(`Reset ${svc.label}`, body, () => runControl(svc.id, 'reset'), {
      formatError: svc.id === 'account_sync_daemon' ? formatAccountSyncOpsError : undefined,
    })
  }

  return (
    <SettingsSection aria-labelledby="daemon-process-page-title">
      <SettingsPageHeader
        celeryLayout
        actions={
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
              <Button type="button" size="sm" onClick={handleLogin} disabled={!tokenInput.trim()}>
                Connect
              </Button>
            </div>
          )}
        </div>
        }
      >
        <SettingsPageTitle id="daemon-process-page-title" className="flex-wrap" style={{ rowGap: 'var(--space-2)' }}>
          <SettingsTitleLamp lamp={daemonPageRollup.lamp as LampTone} title={daemonPageRollup.title}>
            <SettingsSidebarLampGlyph id="daemon" />
          </SettingsTitleLamp>
          Daemon
          <InfoTooltip text="Ops API: POST /ops/market-ingest/control for systemd start/stop (trading_engine, account_sync_daemon, …). Authenticate here or on Settings → Socket; the token is shared." />
        </SettingsPageTitle>
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
      </SettingsPageHeader>

      <DraggableModal
        open={confirmState.open}
        onBackdropClick={() => {
          if (!confirmState.confirming) setConfirmState(INITIAL_CONFIRM)
        }}
        backdropLocked={confirmState.confirming}
        title={confirmState.title}
        titleId="daemon-engine-confirm-title"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmState(INITIAL_CONFIRM)}
              disabled={confirmState.confirming}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => confirmState.action?.()}
              disabled={confirmState.confirming}
            >
              {confirmState.confirming ? 'Executing…' : 'Confirm'}
            </Button>
          </div>
        }
      >
        <p>{confirmState.message}</p>
        {confirmState.error ? (
          <SettingsStatusMessage error className="mt-2 block">
            {confirmState.error}
          </SettingsStatusMessage>
        ) : null}
      </DraggableModal>

      {opsErr ? (
        <SettingsStatusMessage error className="mt-2 block">
          {opsErr}
        </SettingsStatusMessage>
      ) : null}
      {engineConfigMissing && !opsErr ? (
        <p className="massive-api-doc-hint" style={{ marginTop: 'var(--space-2)' }}>
          No <code>trading_engine</code> row in Ops <code>market_ingest_services</code> (see backend/ops/market_ingest_config.py).
          {accountSyncRow ? (
            <>
              {' '}
              <code>account_sync_daemon</code> is available below.
            </>
          ) : null}
        </p>
      ) : null}

      {localAgentPanel ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <h4 className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
            <SettingsTitleLamp lamp={localAgentPanel.lamp as LampTone} title={localAgentPanel.detail}>
              <SettingsSidebarLampGlyph id="api-ops" />
            </SettingsTitleLamp>
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
          emptyHint="No trading_engine or account_sync_daemon rows in Ops config (backend/ops/market_ingest_config.py)."
          logicalSummary={logicalSummary}
          canOperate={canOperate}
          onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
          onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
          onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
          onReset={openResetConfirm}
        />
      </div>
    </SettingsSection>
  )
}
