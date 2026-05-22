import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { lampToneClassName, type LampToneExtended } from '@/lib/lampToneStyles'

/** Colored lamp slot for Settings sidebar glyphs in the app header (replaces title-inline-lamp). */
export function HeaderLampGlyph({
  lamp,
  children,
  className,
}: {
  lamp: LampToneExtended
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex size-[1.125rem] shrink-0 items-center justify-center pointer-events-none',
        '[&_svg]:stroke-current [&_svg]:fill-current [&_svg[fill=none]]:fill-none',
        lampToneClassName(lamp),
        className,
      )}
      aria-hidden
    >
      {children}
    </span>
  )
}
