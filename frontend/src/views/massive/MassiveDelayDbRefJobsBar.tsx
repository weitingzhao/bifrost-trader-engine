import { Button } from '@/components/ui/button'
import { w9 } from '@/styles/wave9Classes'
import { useMassiveRefJobSession } from './MassiveRefJobSessionContext'

/** Reference section header: open the shared Massive DB jobs sheet (ticker reference + stock OHLC). */
export function MassiveDelayDbRefJobsBar() {
  const refJobSession = useMassiveRefJobSession()
  return (
    <div className={w9.massiveDelayRefHeadingActions}>
      {refJobSession.activeJobCount > 0 ? (
        <span className="ref-jobs-active-pill" aria-live="polite">
          {refJobSession.activeJobCount} active
        </span>
      ) : null}
      <Button type="button" variant="secondary" onClick={() => refJobSession.openJobsSheet()}>
        Jobs
      </Button>
    </div>
  )
}
