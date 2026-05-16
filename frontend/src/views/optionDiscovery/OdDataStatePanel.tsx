import type { ReactNode } from 'react'

export type OdDataStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export function OdDataStatePanel({
  status,
  title,
  hint,
  action,
}: {
  status: OdDataStatus
  title?: string
  hint: string
  action?: ReactNode
}) {
  if (status === 'ready') return null
  return (
    <div
      className={`od-data-state od-data-state--${status}`}
      role={status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {title ? <span className="od-data-state-title">{title}</span> : null}
      <p className="section-hint od-data-state-hint">{hint}</p>
      {action}
    </div>
  )
}
