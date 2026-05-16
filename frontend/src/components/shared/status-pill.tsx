import { cn } from '@/lib/utils'

const toneClass: Record<'success' | 'warning' | 'danger' | 'neutral' | 'running', string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  danger: 'border-red-500/40 bg-red-500/10 text-red-100',
  neutral: 'border-border bg-muted text-muted-foreground',
}

export function StatusPill({
  label,
  tone = 'neutral',
  className,
}: {
  label: string
  tone?: keyof typeof toneClass
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums',
        toneClass[tone],
        className,
      )}
    >
      {label}
    </span>
  )
}
