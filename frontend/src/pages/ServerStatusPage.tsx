import { useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  postMonitorStop,
  postMonitorReleaseIb,
  postMonitorConnect,
  fetchHealth,
  fetchServerLogs,
  subscribeServerLogs,
  clearServerLogs,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'
import {
  MONITOR_REASON_LABELS,
  MONITOR_SELF_CHECK_LABELS,
} from './status/statusLabels'
import { useControlAction } from './status/useControlAction'
import { StatusMonitorPanel } from './status/panels'

export interface ServerStatusPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

export function ServerStatusPage({
  status,
  loadStatus,
  embeddedInSettings,
}: ServerStatusPageProps) {
  const [monitorCtrlMsg, setMonitorCtrlMsg] = useState({ text: '', isErr: false })
  const [lastHealthAt, setLastHealthAt] = useState<number | null>(null)
  const [healthTick, setHealthTick] = useState(0)
  const deferredStart = useDeferredStart()
  const monitorCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serverConsole = useLogConsole({
    fetchLogs: fetchServerLogs,
    subscribeLogs: subscribeServerLogs,
    clearLogs: clearServerLogs,
    enabled: deferredStart,
  })

  const runMonitorAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, { onSuccess: loadStatus })
  const runMonitorStopAction = useControlAction(setMonitorCtrlMsg, monitorCtrlMsgClearRef, {})

  useEffect(() => {
    return () => {
      if (monitorCtrlMsgClearRef.current != null) clearTimeout(monitorCtrlMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!deferredStart) return
    fetchHealth()
      .then(() => setLastHealthAt(Date.now() / 1000))
      .catch(() => setLastHealthAt(null))
  }, [deferredStart])

  useEffect(() => {
    if (lastHealthAt == null) return
    const id = setInterval(() => {
      const now = Date.now() / 1000
      setHealthTick(n => n + 1)
      if (now - lastHealthAt >= 60) {
        fetchHealth()
          .then(() => setLastHealthAt(Date.now() / 1000))
          .catch(() => setLastHealthAt(null))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [lastHealthAt])

  void healthTick

  const j = status
  const monitorEnabled = j?.monitor_enabled !== false
  const monitorStatus = (j?.monitor_ib_status as any) || {}
  const monitorOperator = monitorStatus.operator as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorAccount2 = monitorStatus.account2 as { connected?: boolean; client_id?: number; last_error?: string } | undefined
  const monitorHasError = Boolean(monitorOperator?.last_error || monitorAccount2?.last_error)
  const hasAccount2 = monitorAccount2 !== undefined
  const allMonitorClientsConnected = hasAccount2
    ? Boolean(monitorOperator?.connected && monitorAccount2?.connected)
    : Boolean(monitorOperator?.connected)
  const anyMonitorClientConnected = Boolean(monitorOperator?.connected || monitorAccount2?.connected)
  const monitorLamp =
    !monitorEnabled
      ? 'red'
      : monitorHasError
        ? 'yellow'
        : hasAccount2 && !allMonitorClientsConnected
          ? anyMonitorClientConnected ? 'yellow' : 'yellow'
          : monitorOperator?.connected && (!hasAccount2 || monitorAccount2?.connected)
            ? 'green'
            : 'yellow'
  const monitorSelfCheckText =
    MONITOR_SELF_CHECK_LABELS[j?.monitor_self_check ?? ''] ?? j?.monitor_self_check ?? '--'
  const monitorBlockReasons = (j?.monitor_block_reasons ?? [])
    .map(r => MONITOR_REASON_LABELS[r] ?? r)
    .join('; ') || 'None'
  const monitorIbGroupLamp =
    !monitorEnabled
      ? 'none'
      : allMonitorClientsConnected
        ? 'green'
        : anyMonitorClientConnected
          ? 'yellow'
          : 'red'
  const healthElapsedSec = lastHealthAt != null ? Math.floor(Date.now() / 1000 - lastHealthAt) : null
  const healthCountdownSec =
    lastHealthAt != null ? Math.max(0, 60 - (healthElapsedSec! % 60)) : null
  const apiHealthLamp = lastHealthAt != null ? 'green' : 'red'

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'server-status-page server-status-page--embedded' : 'server-status-page'}`}>
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="server-panel-head">
          <StatusMonitorPanel
            status={j}
            monitorLamp={monitorLamp}
            monitorEnabled={monitorEnabled}
            monitorSelfCheckText={monitorSelfCheckText}
            monitorBlockReasons={monitorBlockReasons}
            apiHealthLamp={apiHealthLamp}
            healthCountdownSec={healthCountdownSec}
            monitorIbGroupLamp={monitorIbGroupLamp}
            monitorOperator={monitorOperator}
            monitorAccount2={monitorAccount2}
            onMonitorStop={() => runMonitorStopAction(postMonitorStop, { loading: 'Stopping monitor service…', success: 'Monitor service stopped. Server has exited; refresh the page after restarting.' })}
            onMonitorConnect={() => runMonitorAction(postMonitorConnect, { loading: 'Establishing monitor IB connection…', success: 'Monitor IB connect requested; check status bar for result.' })}
            onMonitorReleaseIb={() => runMonitorAction(postMonitorReleaseIb, { loading: 'Releasing monitor IB connections…', success: 'Monitor IB connections released. Use Connect to reconnect.' })}
            monitorCtrlMsg={monitorCtrlMsg}
          />
        </section>

        <section className="replay-section" aria-labelledby="server-console-head">
          <h3 id="server-console-head" className="page-title-with-tooltip">
            Application log
            <InfoTooltip text="Real-time log from run_server.py (Redis stream)." />
          </h3>
          <LogConsolePanel
            controller={serverConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down)."
            emptyText="No log lines yet. Start server: python scripts/run_server.py"
            infoTooltipText="Real-time server log (Redis Stream)."
            resizeAriaLabel="Resize server console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>
      </div>
    </div>
  )
}
