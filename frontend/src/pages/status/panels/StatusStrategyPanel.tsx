import type { StatusResponse } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

export interface StatusStrategyPanelProps {
  status: StatusResponse | null
  hedgeLamp: Lamp
  hedgeLabel: string
  hedgeSelfCheckText: string
  hedgeBlockReasons: string
  hedgeHint: string
  statusSummaryItems: { label: string; value: string | number }[]
  onFlatten: () => void
  hedgeCtrlMsg: { text: string; isErr: boolean }
  className?: string
}

export function StatusStrategyPanel({
  status: j,
  hedgeLamp,
  hedgeLabel,
  hedgeSelfCheckText,
  hedgeBlockReasons,
  hedgeHint,
  statusSummaryItems,
  onFlatten,
  hedgeCtrlMsg,
  className,
}: StatusStrategyPanelProps) {
  return (
    <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
        <div className="lamp-wrap-span">
          <div className={`lamp lamp-sm ${hedgeLamp}`} title="Trading strategy status lamp" />
        </div>
        <div>
          <h2 className="daemon-card-title page-title-with-tooltip">
            Trading Strategy
            <InfoTooltip text="Depends on daemon; business logic; may support multiple strategies later." />
          </h2>
          <div>
            <strong>Status: {j ? `${hedgeLabel} (${hedgeSelfCheckText})` : 'Fetch failed'}</strong>
            {j && hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` Block reasons: ${hedgeBlockReasons}` : ''}
          </div>
        </div>
      </div>
      <p className="section-hint">{hedgeHint}</p>
      <div className="statusSummary" style={{ marginTop: '0.5rem' }}>
        {statusSummaryItems.map(({ label, value }) => (
          <div key={label}>
            <span>{label}</span>{' '}
            <span className="status-summary-value">{value}</span>
          </div>
        ))}
      </div>
      <div className="controls" style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          className="btn-flatten"
          title="Hedge process consumes and executes; flattens strategy hedge exposure"
          onClick={onFlatten}
        >
          Flatten exposure
        </button>
      </div>
      {hedgeCtrlMsg.text ? (
        <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
          {hedgeCtrlMsg.text}
        </div>
      ) : null}
    </div>
  )
}
