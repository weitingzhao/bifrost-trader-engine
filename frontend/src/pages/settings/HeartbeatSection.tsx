import { InfoTooltip } from '../../components/InfoTooltip'
import { DEFAULT_HEARTBEAT_SEC } from './settingsConstants'

interface HeartbeatSectionProps {
  heartbeatIntervalSec: number
  setHeartbeatIntervalSec: (v: number) => void
}

export function HeartbeatSection({ heartbeatIntervalSec, setHeartbeatIntervalSec }: HeartbeatSectionProps) {
  return (
    <div className="daemon-group" id="settings-heartbeat">
      <div className="daemon-group-header">
        <span className="daemon-group-title">Daemon App</span>
        <InfoTooltip text="Daemon heartbeat write interval (seconds); takes effect on next heartbeat." />
      </div>
      <div className="daemon-group-body">
        <div className="settings-heartbeat-row">
          <label className="settings-heartbeat-label">
            <span className="settings-heartbeat-label-text">Heartbeat Interval</span>
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
      </div>
    </div>
  )
}
