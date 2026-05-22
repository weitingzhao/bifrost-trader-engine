import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { INSTANCE_DETAIL_SIDEBAR_WIDTH_PX } from '@/constants/instanceDetailSidebar'

/**
 * Fixed right-hand inspector: backdrop does not capture pointer events so the page
 * behind (e.g. option chain, positions table) stays interactive.
 */
export function RightInspectorDrawer({
  open,
  ariaLabel = 'Inspector',
  children,
  /** Match Strategy Instances `DetailSidebar` width for embedded instance detail. */
  variant = 'default',
}: {
  open: boolean
  ariaLabel?: string
  children: ReactNode
  variant?: 'default' | 'instance-detail'
}) {
  if (!open) return null

  const panelWidth =
    variant === 'instance-detail'
      ? `min(${INSTANCE_DETAIL_SIDEBAR_WIDTH_PX}px, 100vw)`
      : 'min(72rem, 96vw)'

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[200] flex items-stretch justify-end bg-transparent"
      role="presentation"
    >
      <aside
        className={cn(
          'pointer-events-auto flex min-h-0 max-w-full flex-col border-l border-border bg-background shadow-[-4px_0_24px_rgba(0,0,0,0.15)]',
        )}
        style={{ width: panelWidth }}
        role="dialog"
        aria-modal="false"
        aria-label={ariaLabel}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </aside>
    </div>
  )
}
