/** Per-request ceiling for Settings → API Health probes (unreachable host must not hang the UI). */
export const API_HEALTH_FETCH_TIMEOUT_MS = 8_000

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const id = window.setTimeout(() => {
    ctrl.abort()
  }, timeoutMs)
  try {
    return await fetch(input, { ...init, signal: ctrl.signal })
  } finally {
    window.clearTimeout(id)
  }
}
