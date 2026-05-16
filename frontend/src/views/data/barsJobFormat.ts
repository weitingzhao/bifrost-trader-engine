import type { BarsJob } from '../../api'

/** Single-line summary for bars job result column (shared with Data jobs table). */
export function formatBarsJobResult(job: { status: string; result?: BarsJob['result'] }): string {
  const { status, result } = job
  if (status === 'done' && result?.count != null) return `${result.count} bars`
  if (status === 'failed' && result?.error) {
    const e = result.error
    return e.length > 40 ? `${e.slice(0, 40)}…` : e
  }
  if (status === 'done' && result?.message != null && result.count == null) {
    const m = result.message
    return m.length > 30 ? `${m.slice(0, 30)}…` : m
  }
  if (!result && status !== 'pending' && status !== 'running') return '—'
  return ''
}

export function barsJobResultTitle(job: { result?: BarsJob['result'] }): string | undefined {
  const e = job.result?.error
  const m = job.result?.message
  if (e) return e
  if (m) return m
  return undefined
}
