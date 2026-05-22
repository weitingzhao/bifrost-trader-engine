import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { lampToneClassName, type LampToneExtended } from '@/lib/lampToneStyles'

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
  if (lamp === 'none') {
    return (
      <span
        className={cn('inline-block size-2.5 shrink-0 rounded-full bg-muted-foreground/40', className)}
        title={title}
        aria-label={title ?? 'Status lamp none'}
      />
    )
  }
  return (
    <span
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full shadow-sm',
        lamp === 'green' && 'bg-[var(--color-lamp-green)]',
        lamp === 'yellow' && 'bg-[var(--color-lamp-yellow)]',
        lamp === 'red' && 'bg-[var(--color-lamp-red)]',
        className,
      )}
      title={title}
      aria-label={title ?? `Status lamp ${lamp}`}
    />
  )
}

/** Icon + lamp tone for menus (replaces title-inline-lamp + lamp-icon on glyphs). */
export function LampGlyphSlot({
  lamp,
  children,
  className,
  title,
}: {
  lamp: LampToneExtended
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex size-[1.1rem] shrink-0 items-center justify-center',
        '[&_svg]:stroke-current [&_svg]:fill-current [&_svg[fill=none]]:fill-none',
        lampToneClassName(lamp),
        className,
      )}
      title={title}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {children}
    </span>
  )
}
