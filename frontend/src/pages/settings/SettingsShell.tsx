import type { ReactNode } from 'react'

interface SettingsShellProps {
  sidebar: ReactNode
  children: ReactNode
}

/**
 * Two-column Settings layout enforcing the layout contract
 * documented in styles/settings-celery.css.
 *
 * sidebar  → .settings-sidebar  (fixed-width, sticky)
 * children → .settings-main     (flex:1, overflow-x:hidden)
 */
export function SettingsShell({ sidebar, children }: SettingsShellProps) {
  return (
    <div className="settings-page">
      <nav className="settings-sidebar" aria-label="Settings sections">
        {sidebar}
      </nav>
      <div className="settings-main">
        {children}
      </div>
    </div>
  )
}
