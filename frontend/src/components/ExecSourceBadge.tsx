import { rl } from '@/lib/replayLayout'
interface Props {
  source: string | null | undefined
}

const classMap: Record<string, string> = {
  flex_trades: 'exec-source-badge--flex',
  tws_event: 'exec-source-badge--tws',
  tws_client: 'exec-source-badge--tws',
  journal_closed: 'exec-source-badge--journal',
  manual: 'exec-source-badge--manual',
}

const labelMap: Record<string, string> = {
  flex_trades: 'flex',
  tws_event: 'tws',
  tws_client: 'tws-client',
  journal_closed: 'journal',
  manual: 'manual',
}

export default function ExecSourceBadge({ source }: Props) {
  const s = (source ?? '').trim()
  if (!s) return <span className={rl.muted}>—</span>
  const cls = classMap[s] ?? 'exec-source-badge--unknown'
  const label = labelMap[s] ?? s
  const title = s === 'journal_closed' ? 'Manual accounting adjustment (journal entry)' : s
  return <span className={`exec-source-badge ${cls}`} title={title}>{label}</span>
}
