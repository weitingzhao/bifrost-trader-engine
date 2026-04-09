import { InfoTooltip } from '../../components/InfoTooltip'
import { DEFAULT_HEARTBEAT_SEC } from './settingsConstants'

export const DEFAULT_ACCOUNT_SYNC_HEARTBEAT_SEC = 5

interface HeartbeatSectionProps {
  heartbeatIntervalSec: number
  setHeartbeatIntervalSec: (v: number) => void
  accountSyncIntervalSec?: number
  setAccountSyncIntervalSec?: (v: number) => void
}

export function HeartbeatSection({
  heartbeatIntervalSec,
  setHeartbeatIntervalSec,
  accountSyncIntervalSec,
  setAccountSyncIntervalSec,
}: HeartbeatSectionProps) {
  return (
    <div className="daemon-group" id="settings-heartbeat">
      <div className="daemon-group-header">
        <span className="daemon-group-title">Daemon App</span>
        <InfoTooltip text="Daemon heartbeat write interval (seconds); takes effect on next heartbeat." />
      </div>
      <div className="daemon-group-body">
        <div className="settings-heartbeat-row">
          <label className="settings-heartbeat-label">
            <span className="settings-heartbeat-label-text">Trading Daemon Heartbeat</span>
            <span className="settings-heartbeat-input-wrap">
              <input
                type="number"
                min={5}
                max={120}
                value={heartbeatIntervalSec}
                onChange={(e) => setHeartbeatIntervalSec(parseInt(e.target.value, 10) || DEFAULT_HEARTBEAT_SEC)}
                className="settings-heartbeat-input"
              />
              <span className="settings-heartbeat-unit">sec</span>
            </span>
          </label>
        </div>
        {setAccountSyncIntervalSec != null && (
          <div className="settings-heartbeat-row" style={{ marginTop: '0.5rem' }}>
            <label className="settings-heartbeat-label">
              <span className="settings-heartbeat-label-text">Account Sync Heartbeat</span>
              <span className="settings-heartbeat-input-wrap">
                <input
                  type="number"
                  min={2}
                  max={60}
                  step={1}
                  value={accountSyncIntervalSec ?? DEFAULT_ACCOUNT_SYNC_HEARTBEAT_SEC}
                  onChange={(e) => setAccountSyncIntervalSec(parseFloat(e.target.value) || DEFAULT_ACCOUNT_SYNC_HEARTBEAT_SEC)}
                  className="settings-heartbeat-input"
                />
                <span className="settings-heartbeat-unit">sec</span>
              </span>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
