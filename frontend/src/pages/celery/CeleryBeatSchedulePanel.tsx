import { InfoTooltip } from '../../components/InfoTooltip'
import type { MassiveCeleryBeatEntry } from '../../api/research/research'

function fmtCrontabUtc(c: Record<string, string | number>): string {
  const h = c.hour
  const m = c.minute ?? 0
  return `hour=${String(h)} minute=${String(m)}`
}

export interface CeleryBeatSchedulePanelProps {
  entries: MassiveCeleryBeatEntry[]
  timezone: string | null
  loading: boolean
  error: string | null
}

/**
 * Celery Beat schedule rows (UTC) — mirrors ``MASSIVE_BEAT_SCHEDULE_SPEC`` / ``celery_app`` beat_schedule.
 */
export function CeleryBeatSchedulePanel({ entries, timezone, loading, error }: CeleryBeatSchedulePanelProps) {
  const tz = timezone?.trim() || 'UTC'

  return (
    <section
      className="replay-section dashboard-section dashboard-celery-beat-schedule-panel"
      aria-labelledby="dashboard-celery-beat-schedule-head"
    >
      <h3 id="dashboard-celery-beat-schedule-head" className="page-title-with-tooltip dashboard-celery-beat-schedule-head">
        Scheduled Celery Beat
        <InfoTooltip text="Periodic tasks registered in Celery Beat (same beat_schedule as scripts/systemd Celery Beat). Times are UTC. Execution still requires Beat process and workers consuming the routed queues." />
        <span className="dashboard-celery-beat-schedule-head-tz">Timezone: {tz}</span>
      </h3>
      {error ? (
        <p className="dashboard-inline-alert msg err" role="alert">
          {error}
        </p>
      ) : null}
      {!error && entries.length === 0 && !loading ? (
        <div className="dashboard-empty">No Beat schedule returned from Research API.</div>
      ) : null}
      {loading && entries.length === 0 && !error ? (
        <div className="dashboard-empty">Loading Beat schedule…</div>
      ) : null}
      {!error && entries.length > 0 ? (
        <>
          <div className="dashboard-celery-beat-schedule-table-wrap">
            <table className="table-operations dashboard-celery-beat-schedule-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">Task</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.name}>
                    <td>{e.label}</td>
                    <td className="dashboard-celery-beat-schedule-crontab">{fmtCrontabUtc(e.crontab)}</td>
                    <td>
                      <code className="dashboard-celery-beat-schedule-task">{e.task}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  )
}
