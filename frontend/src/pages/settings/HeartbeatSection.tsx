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
        <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <label>
            Heartbeat Interval (sec):
            <input
              type="number"
              min={5}
              max={120}
              value={heartbeatIntervalSec}
              onChange={(e) => setHeartbeatIntervalSec(parseInt(e.target.value, 10) || DEFAULT_HEARTBEAT_SEC)}
              style={{ width: '3.5rem', marginLeft: '0.25rem' }}
            />
          </label>
        </div>
      </div>
    </div>
  )
}
