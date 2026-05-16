import type { ReactNode } from 'react'

interface SettingsShellProps {
  sidebar?: ReactNode
  children: ReactNode
}

/**
 * Settings layout shell.
 * Navigation now lives in the main app sidebar; this shell provides
 * consistent padding and max-width for Settings content pages.
 */
export function SettingsShell({ children }: SettingsShellProps) {
  return (
    <div className="settings-page settings-page--no-sidebar">
      <div className="settings-main">
        {children}
      </div>
    </div>
  )
}
