/** Hash deep link: Settings → Celery → Queues & Instances tab → select queue (see CeleryControlPage). */
export const CELERY_QUEUE_HASH_PREFIX = 'settings-celery-queue-'

export function celeryQueueHash(celeryQueue: string): string {
  const q = String(celeryQueue).trim()
  return `#${CELERY_QUEUE_HASH_PREFIX}${encodeURIComponent(q)}`
}

export function parseCeleryQueueFromHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h.startsWith(CELERY_QUEUE_HASH_PREFIX)) return null
  try {
    const raw = h.slice(CELERY_QUEUE_HASH_PREFIX.length).trim()
    return raw ? decodeURIComponent(raw) : null
  } catch {
    return null
  }
}
