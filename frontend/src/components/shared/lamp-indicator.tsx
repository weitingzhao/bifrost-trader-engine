import { cn } from '@/lib/utils'

export type LampTone = 'green' | 'yellow' | 'red' | 'none'

export function LampIndicator({
  lamp,
  title,
  className,
}: {
  lamp: LampTone
  title?: string
  className?: string
}) {
  return (
    <span
      className={cn('lamp-icon inline-flex', lamp === 'none' ? 'none' : lamp, className)}
      title={title}
      aria-label={title ?? `Status lamp ${lamp}`}
    />
  )
}
