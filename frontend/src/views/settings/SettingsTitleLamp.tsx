import type { ReactNode } from 'react'
import { LampGlyphSlot, type LampTone } from '@/components/shared/lamp-indicator'

/** Page/section title with sidebar-style glyph lamp (replaces title-inline-lamp + lamp-icon). */
export function SettingsTitleLamp({
  lamp,
  title,
  children,
}: {
  lamp: LampTone
  title?: string
  children: ReactNode
}) {
  return (
    <span title={title} role="img" aria-label={title}>
      <LampGlyphSlot lamp={lamp}>{children}</LampGlyphSlot>
    </span>
  )
}
