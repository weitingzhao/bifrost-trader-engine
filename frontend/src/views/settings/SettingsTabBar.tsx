interface TabItem {
  id: string
  label: string
  hash: string
}

interface SettingsTabBarProps {
  tabs: readonly TabItem[]
  activeHash: string
  onTabClick?: (hash: string) => void
}

export function SettingsTabBar({ tabs, activeHash, onTabClick }: SettingsTabBarProps) {
  const normalizedActive = activeHash.startsWith('#') ? activeHash.slice(1) : activeHash

  return (
    <nav className="settings-tab-bar" aria-label="Section navigation">
      {tabs.map((tab) => {
        const isActive = normalizedActive === tab.hash || normalizedActive === tab.id
        return (
          <a
            key={tab.id}
            href={`#${tab.hash}`}
            className={`settings-tab-item${isActive ? ' settings-tab-item--active' : ''}`}
            onClick={(e) => {
              if (onTabClick) {
                e.preventDefault()
                onTabClick(tab.hash)
              }
            }}
            aria-current={isActive ? 'page' : undefined}
          >
            {tab.label}
          </a>
        )
      })}
    </nav>
  )
}

export const API_TABS: TabItem[] = [
  { id: 'api-overview', label: 'Overview', hash: 'settings-api' },
  { id: 'api-architecture', label: 'Architecture', hash: 'settings-api-architecture' },
  { id: 'api-account', label: 'Account', hash: 'settings-api-account' },
  { id: 'api-research', label: 'Research', hash: 'settings-api-research' },
  { id: 'api-massive', label: 'Massive', hash: 'settings-api-massive' },
]

export const COVERAGE_TABS: TabItem[] = [
  { id: 'coverage-summary', label: 'Summary', hash: 'coverage-overview-summary' },
  { id: 'coverage-detail', label: 'Detail', hash: 'coverage-overview-detail' },
  { id: 'coverage-option', label: 'Option', hash: 'coverage-option' },
  { id: 'coverage-stock-ib', label: 'Stock IB', hash: 'coverage-stock' },
  { id: 'coverage-stock-massive', label: 'Stock Massive', hash: 'coverage-massive-stock' },
]

export const FEED_TABS: TabItem[] = [
  { id: 'feed-ib', label: 'Interactive Brokers', hash: 'feed-ib-stock' },
  { id: 'feed-massive-overview', label: 'Massive', hash: 'feed-massive-overview' },
  { id: 'feed-massive-stock', label: 'M. Stock', hash: 'feed-massive-stock' },
  { id: 'feed-massive-option', label: 'M. Option', hash: 'feed-massive-option' },
  { id: 'feed-massive-common', label: 'M. Common', hash: 'feed-massive-common' },
]

export const CONFIG_TABS: TabItem[] = [
  { id: 'config-daemon', label: 'Daemon App', hash: 'settings-heartbeat' },
  { id: 'config-ib', label: 'IB Configure', hash: 'settings-ib-connection' },
]
