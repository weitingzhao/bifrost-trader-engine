import { useEffect, useState } from 'react'

/**
 * Delay non-critical network work so the page shell can paint first.
 */
export function useDeferredStart(delayMs = 220): boolean {
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const id = window.setTimeout(() => setStarted(true), Math.max(0, delayMs))
    return () => window.clearTimeout(id)
  }, [delayMs])

  return started
}
