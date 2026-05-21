export type StreamTone = 'neutral' | 'positive' | 'negative'
export interface StreamSummaryItem { label: string; value: string; tone: StreamTone }

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
    <section className="card dashboard-strip" aria-label="Dashboard">
      <div className="dashboard-strip-grid">
        <div className="dashboard-open-orders-cluster" aria-label="Open orders summary">
          <button
            type="button"
            className="dashboard-open-orders-btn"
            onClick={onOpenOrdersClick}
            aria-label="Open orders"
            title="View open orders on Live page"
          >
            {openOrdersLamp != null && (
              <span
                className={`lamp-icon ${openOrdersLamp}`}
                aria-hidden
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
              </span>
            )}
            <span className="dashboard-open-orders-label">Open orders</span>
            <span className="dashboard-open-orders-value">{openOrderCount}</span>
          </button>
        </div>
        <div className="dashboard-streams-cluster" aria-label="Market streams summary">
          <button
            type="button"
            className="dashboard-streams-inline dashboard-streams-btn"
            onClick={onStreamClick}
            aria-label="Go to Live page"
            title="Go to Live page"
          >
            <span className={`lamp-icon ${streamLamp}`} aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </span>
            <div className="dashboard-streams-marquee">
              <div className="dashboard-streams-track">
                {tickerItems.map((item, index) => (
                  <span key={`${item.label}-${item.value}-${index}`} className="dashboard-streams-item">
                    <span className="dashboard-streams-item-label">{item.label}</span>
                    <span className={`dashboard-streams-item-value tone-${item.tone}`}>{item.value}</span>
                  </span>
                ))}
              </div>
            </div>
          </button>
        </div>
      </div>
    </section>
  )
}
