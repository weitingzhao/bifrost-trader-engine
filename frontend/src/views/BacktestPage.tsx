import type { StatusResponse } from '../types'
import { w9 } from '@/styles/wave9Classes'
import { PageSection } from '@/components/shared/page-section'
import { SectionPageTitle } from '../components/SectionPageTitle'

interface BacktestPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

export function BacktestPage({ status: _status, onGoToScreener, breadcrumbLabel = 'Backtest' }: BacktestPageProps) {
  return (
    <PageSection>
      <div className="research-page-head">
        <SectionPageTitle
          id="backtest-head"
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onGoToScreener}
          menuNavigateAriaLabel="Research home"
          infoText="Backtest and strategy validation — planned for a later release."
          style={{ margin: 0 }}
        />
      </div>
      <p className={w9.sectionHint}>
        Backtest and strategy validation will be available in a later release.
      </p>
    </PageSection>
  )
}
