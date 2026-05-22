import type { ReactNode } from 'react'
import { PageSection } from '@/components/shared/page-section'
import { cn } from '@/lib/utils'
import { fm, feedMassiveStatusValueClass } from './feedMassiveStyles'

interface FeedMassiveShellProps {
  children: ReactNode
  className?: string
}

/** Outer page wrapper for Feed → Massive pages. */
export function FeedMassiveShell({ children, className }: FeedMassiveShellProps) {
  return <PageSection className={cn(fm.page, className)}>{children}</PageSection>
}

interface FeedMassiveTitleBlockProps {
  children: ReactNode
  className?: string
}

export function FeedMassiveTitleBlock({ children, className }: FeedMassiveTitleBlockProps) {
  return (
    <div className={cn(fm.titleBlock, className)}>
      <div className={fm.titleMain}>{children}</div>
    </div>
  )
}

interface FeedMassiveDelayPillProps {
  title?: string
  children?: ReactNode
}

export function FeedMassiveDelayPill({ title, children = 'Delayed feed' }: FeedMassiveDelayPillProps) {
  return (
    <span className={fm.delayPill} title={title}>
      {children}
    </span>
  )
}

export interface FeedMassiveStatusItemData {
  key: string
  value: ReactNode
  ok?: boolean
}

interface FeedMassiveStatusStripProps {
  items: FeedMassiveStatusItemData[]
  note?: string | null
  className?: string
  'aria-label'?: string
}

export function FeedMassiveStatusStrip({
  items,
  note,
  className,
  'aria-label': ariaLabel = 'Connection status',
}: FeedMassiveStatusStripProps) {
  return (
    <section className={cn(fm.statusStrip, className)} aria-label={ariaLabel}>
      <div className={fm.statusStripGrid}>
        {items.map(item => (
          <div key={item.key} className={fm.statusItem}>
            <span className={fm.statusKey}>{item.key}</span>
            <span
              className={
                item.ok === undefined ? fm.statusValue : feedMassiveStatusValueClass(item.ok)
              }
            >
              {item.value}
            </span>
          </div>
        ))}
      </div>
      {note ? <p className={fm.statusNote}>{note}</p> : null}
    </section>
  )
}

interface FeedMassiveCapNavProps {
  children: ReactNode
  className?: string
  'aria-label'?: string
}

/** Sticky capability chip navigation strip. */
export function FeedMassiveCapNav({
  children,
  className,
  'aria-label': ariaLabel,
}: FeedMassiveCapNavProps) {
  return (
    <nav className={cn(fm.tabNavSection, fm.capNavSticky, className)} aria-label={ariaLabel}>
      <div className={fm.capSheet}>{children}</div>
    </nav>
  )
}

interface FeedMassiveCapHintProps {
  children: ReactNode
}

export function FeedMassiveCapHint({ children }: FeedMassiveCapHintProps) {
  return <p className={fm.capHint}>{children}</p>
}

interface FeedMassiveTabPanelProps {
  children: ReactNode
  className?: string
}

export function FeedMassiveTabPanel({ children, className }: FeedMassiveTabPanelProps) {
  return <div className={cn(fm.tabPanel, className)}>{children}</div>
}

interface FeedMassiveDeliveryTabsProps {
  children: ReactNode
  className?: string
}

export function FeedMassiveDeliveryTabs({ children, className }: FeedMassiveDeliveryTabsProps) {
  return <div className={cn(fm.deliveryTabs, className)}>{children}</div>
}

interface FeedMassiveDeliveryTablistProps {
  children: ReactNode
  'aria-label'?: string
}

export function FeedMassiveDeliveryTablist({ children, 'aria-label': ariaLabel }: FeedMassiveDeliveryTablistProps) {
  return (
    <div className={fm.deliveryTablist} role="tablist" aria-label={ariaLabel}>
      {children}
    </div>
  )
}

interface FeedMassiveDeliveryTabProps {
  active: boolean
  children: ReactNode
  id?: string
  onClick: () => void
}

export function FeedMassiveDeliveryTab({ active, children, id, onClick }: FeedMassiveDeliveryTabProps) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      className={cn(fm.deliveryTab, active && fm.deliveryTabActive)}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface FeedMassiveAggTabsWrapProps {
  children: ReactNode
  className?: string
}

export function FeedMassiveAggTabsWrap({ children, className }: FeedMassiveAggTabsWrapProps) {
  return <div className={cn(fm.aggTabsWrap, className)}>{children}</div>
}

interface FeedMassiveAggTabProps {
  active: boolean
  children: ReactNode
  id?: string
  onClick: () => void
  badge?: ReactNode
}

export function FeedMassiveAggTab({ active, children, id, onClick, badge }: FeedMassiveAggTabProps) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      className={cn(fm.aggTab, active && fm.aggTabActive)}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
    >
      {children}
      {badge != null ? <span className={fm.aggTabBadge}>{badge}</span> : null}
    </button>
  )
}

interface FeedMassiveTabChipProps {
  active?: boolean
  children: ReactNode
  className?: string
  href?: string
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void
  'aria-current'?: 'location' | undefined
}

export function FeedMassiveTabChip({
  active,
  children,
  className,
  href,
  onClick,
  'aria-current': ariaCurrent,
}: FeedMassiveTabChipProps) {
  return (
    <a
      href={href}
      className={cn(fm.tabChip, active && fm.tabChipActive, className)}
      aria-current={ariaCurrent}
      onClick={onClick}
    >
      {children}
    </a>
  )
}

export { fm, feedMassiveTabDotClass } from './feedMassiveStyles'
