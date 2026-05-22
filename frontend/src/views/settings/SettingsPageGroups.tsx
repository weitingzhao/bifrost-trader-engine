import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SETTINGS_GROUP_CARD } from './settingsUi'

/** Column stack for Settings configuration cards (replaces `.settings-page-groups`). */
export function SettingsPageGroups({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col flex-nowrap gap-[var(--settings-section-gap)]',
        `[&>.${SETTINGS_GROUP_CARD}]:relative [&>.${SETTINGS_GROUP_CARD}]:rounded-xl [&>.${SETTINGS_GROUP_CARD}]:border [&>.${SETTINGS_GROUP_CARD}]:border-border [&>.${SETTINGS_GROUP_CARD}]:bg-[var(--color-surface)] [&>.${SETTINGS_GROUP_CARD}]:p-5 [&>.${SETTINGS_GROUP_CARD}]:transition-[border-color,box-shadow] [&>.${SETTINGS_GROUP_CARD}]:before:absolute [&>.${SETTINGS_GROUP_CARD}]:before:left-0 [&>.${SETTINGS_GROUP_CARD}]:before:top-4 [&>.${SETTINGS_GROUP_CARD}]:before:h-[calc(100%-2rem)] [&>.${SETTINGS_GROUP_CARD}]:before:w-[3px] [&>.${SETTINGS_GROUP_CARD}]:before:rounded-r-sm [&>.${SETTINGS_GROUP_CARD}]:before:bg-[var(--color-accent)] [&>.${SETTINGS_GROUP_CARD}]:before:opacity-50 [&>.${SETTINGS_GROUP_CARD}]:before:content-[""] hover:[&>.${SETTINGS_GROUP_CARD}]:border-[var(--color-border-strong)] hover:[&>.${SETTINGS_GROUP_CARD}]:shadow-[0_4px_20px_rgba(0,0,0,0.15)] hover:[&>.${SETTINGS_GROUP_CARD}]:before:opacity-100`,
        `[&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:relative [&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:rounded-xl [&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:border [&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:border-border [&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:bg-[var(--color-surface)] [&>.settings-ib-connection-group>.${SETTINGS_GROUP_CARD}]:p-5`,
        className,
      )}
    >
      {children}
    </div>
  )
}
