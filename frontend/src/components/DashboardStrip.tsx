import { PageSection } from '@/components/shared/page-section'
import { LampGlyphSlot } from '@/components/shared/lamp-indicator'
import { cn } from '@/lib/utils'

export type StreamTone = 'neutral' | 'positive' | 'negative'
export interface StreamSummaryItem { label: string; value: string; tone: StreamTone }

const toneClass: Record<StreamTone, string> = {
  neutral: 'text-muted-foreground',
  positive: 'text-[var(--color-lamp-green)]',
  negative: 'text-[var(--color-lamp-red)]',
}

export function DashboardStrip({
  streamLamp,
  streamItems,
  onStreamClick,
  openOrderCount,
  onOpenOrdersClick,
  openOrdersLamp,
  openOrdersLampTitle,
}: {
  streamLamp: 'green' | 'yellow' | 'red' | 'none'
  streamItems: StreamSummaryItem[]
  onStreamClick?: () => void
  openOrderCount: number
  onOpenOrdersClick?: () => void
  openOrdersLamp?: 'green' | 'yellow' | 'red' | 'none'
  openOrdersLampTitle?: string
}) {
  const tickerItems =
    streamItems.length > 0
      ? [...streamItems, ...streamItems]
      : [
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
        ]

  return (
    <PageSection className="dashboard-strip gap-3 p-3 md:p-4" aria-label="Dashboard">
      <div className="dashboard-strip-grid grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
        <div className="dashboard-open-orders-cluster min-w-0" aria-label="Open orders summary">
          <button
            type="button"
            className="dashboard-open-orders-btn flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
            onClick={onOpenOrdersClick}
            aria-label="Open orders"
            title="View open orders on Live page"
          >
            {openOrdersLamp != null && (
              <LampGlyphSlot
                lamp={openOrdersLamp}
                className="size-3.5"
                title={
                  openOrdersLampTitle != null && openOrdersLampTitle !== ''
                    ? openOrdersLampTitle
                    : openOrdersLamp === 'green'
                      ? 'Open orders: Account Sync Daemon healthy (DB sync).'
                      : 'Open orders: Account Sync Daemon degraded or unknown.'
                }
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
              </LampGlyphSlot>
            )}
            <span className="dashboard-open-orders-label text-sm font-medium text-foreground">Open orders</span>
            <span className="dashboard-open-orders-value ml-auto text-sm font-bold tabular-nums text-foreground">{openOrderCount}</span>
          </button>
        </div>
        <div className="dashboard-streams-cluster min-w-0" aria-label="Market streams summary">
          <button
            type="button"
            className="dashboard-streams-inline dashboard-streams-btn flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/50"
            onClick={onStreamClick}
            aria-label="Go to Live page"
            title="Go to Live page"
          >
            <LampGlyphSlot lamp={streamLamp} className="size-3.5 shrink-0">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </LampGlyphSlot>
            <div className="dashboard-streams-marquee min-w-0 flex-1 overflow-hidden">
              <div className="dashboard-streams-track">
                {tickerItems.map((item, index) => (
                  <span key={`${item.label}-${item.value}-${index}`} className="dashboard-streams-item inline-flex gap-1.5 text-xs">
                    <span className="dashboard-streams-item-label text-muted-foreground">{item.label}</span>
                    <span className={cn('dashboard-streams-item-value font-semibold tabular-nums', toneClass[item.tone])}>{item.value}</span>
                  </span>
                ))}
              </div>
            </div>
          </button>
        </div>
      </div>
    </PageSection>
  )
}
