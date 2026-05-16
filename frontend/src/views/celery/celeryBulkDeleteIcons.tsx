/**
 * Shared SVGs for Celery queue bulk actions (Queues toolbar + Queue summary Actions).
 * Keep in sync: same paths and stroke as the job-queue toolbar.
 */

const CELERY_QUEUE_ICON_PX = 15
const CELERY_QUEUE_ICON_STROKE = 1.5

export function CeleryQueueTrashIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

/** Circle + X (failed rows purge). */
export function CeleryQueueDeleteFailedIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  )
}

/** Circle + activity bars (running rows purge). */
export function CeleryQueueDeleteRunningIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="8" x2="8" y1="15" y2="11" />
      <line x1="12" x2="12" y1="15" y2="8" />
      <line x1="16" x2="16" y1="15" y2="10" />
    </svg>
  )
}

/** Clock in circle — pending rows purge. */
export function CeleryQueueDeletePendingIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export function CeleryQueueRefreshIcon({ size = CELERY_QUEUE_ICON_PX }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CELERY_QUEUE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}
