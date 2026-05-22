import type { LampTone } from '@/components/shared/lamp-indicator'

export type LampToneExtended = LampTone | 'gray'

/** Tailwind classes for status lamp glyphs (replaces .title-inline-lamp / .lamp-icon). */
export function lampToneClassName(tone: LampToneExtended): string {
  switch (tone) {
    case 'green':
      return 'text-[var(--color-lamp-green)] drop-shadow-[0_0_5px_var(--color-lamp-green)]'
    case 'yellow':
      return 'text-[var(--color-lamp-yellow)] drop-shadow-[0_0_5px_var(--color-lamp-yellow)]'
    case 'red':
      return 'text-[var(--color-lamp-red)] drop-shadow-[0_0_5px_var(--color-lamp-red)]'
    case 'gray':
      return 'text-[var(--color-lamp-gray)]'
    case 'none':
    default:
      return 'text-[var(--color-lamp-none)]'
  }
}
