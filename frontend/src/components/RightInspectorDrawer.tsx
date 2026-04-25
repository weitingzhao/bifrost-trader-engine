import type { ReactNode } from 'react'

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

  const panelClass =
    variant === 'instance-detail'
      ? 'riv-inspector-panel riv-inspector-panel--instance-detail'
      : 'riv-inspector-panel'

  return (
    <div className="riv-inspector-backdrop" role="presentation">
      <aside className={panelClass} role="dialog" aria-modal="false" aria-label={ariaLabel}>
        <div className="riv-inspector-inner">{children}</div>
      </aside>
    </div>
  )
}
