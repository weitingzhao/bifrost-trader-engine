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
  /** Suspend/Resume (moved from Event); when set, show Suspend/Resume in Trading Strategy section */
  suspended?: boolean
  onSuspend?: () => void
  onResume?: () => void
  className?: string
  /** Compact layout for Stream Event (1/4 width) */
  compact?: boolean
  /** Phase A: active structure name for display */
  activeStructureName?: string | null
  /** Phase A: active gate safety set name for display */
  activeGateSafetyName?: string | null
  /** Navigate to Research → Strategy (Manage) */
  onManage?: () => void
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
  suspended = false,
  onSuspend,
  onResume,
  className,
  compact = false,
  activeStructureName,
  activeGateSafetyName,
  onManage,
}: StatusStrategyPanelProps) {
  const panelClass = `system-tab-panel ${className ?? ''} ${compact ? 'strategy-panel-compact' : ''}`.trim()

  if (compact) {
    return (
      <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={panelClass}>
        <div className="strategy-compact-header">
          <span className={`title-inline-lamp lamp-icon ${hedgeLamp}`} title="Trading strategy status" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
          </span>
          <span className="strategy-compact-title">Trading Strategy</span>
        </div>
        <div className="strategy-compact-status">
          {j ? `${hedgeLabel}` : 'Fetch failed'}
          {j && hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` · ${hedgeBlockReasons}` : ''}
        </div>
        {(activeStructureName != null || activeGateSafetyName != null) && (
          <div className="strategy-active-names">
            <span>Structure: {activeStructureName ?? '—'}</span>
            <span>Gate safety: {activeGateSafetyName ?? '—'}</span>
          </div>
        )}
        <div className="strategy-compact-summary">
          {statusSummaryItems
            .filter(({ label }) => label !== 'Updated at' && label !== 'Daemon state')
            .map(({ label, value }) => (
              <span key={label} className="strategy-compact-summary-item">
                <span className="strategy-compact-label">{label}</span>
                <span className="status-summary-value">{value}</span>
              </span>
            ))}
        </div>
        <div className="controls strategy-compact-controls">
          {onManage && (
            <button
              type="button"
              className="section-header-icon-btn strategy-btn-manage"
              title="Open Strategy management"
              aria-label="Manage strategy"
              onClick={onManage}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          {onSuspend != null && onResume != null && (
            <>
              <button
                type="button"
                className="section-header-icon-btn strategy-btn-resume"
                disabled={!suspended}
                title={!suspended ? 'Already running' : 'Set from monitor; daemon resumes hedging on next heartbeat'}
                aria-label="Resume"
                onClick={onResume}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
              </button>
              <button
                type="button"
                className="section-header-icon-btn strategy-btn-suspend"
                disabled={suspended}
                title={suspended ? 'Already suspended' : 'Set from monitor; daemon pauses new hedges on next heartbeat'}
                aria-label="Suspend"
                onClick={onSuspend}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-flatten"
            title="Flattens strategy hedge exposure"
            onClick={onFlatten}
          >
            Flatten
          </button>
        </div>
        {hedgeCtrlMsg.text ? (
          <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'} strategy-compact-msg`}>
            {hedgeCtrlMsg.text}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={panelClass}>
      <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
        <div>
          <h2 className="daemon-card-title page-title-with-tooltip">
            <span className={`title-inline-lamp lamp-icon ${hedgeLamp}`} title="Trading strategy status lamp" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
            </span>
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
      {(activeStructureName != null || activeGateSafetyName != null) && (
        <div className="strategy-active-names" style={{ marginTop: '0.5rem' }}>
          <div><strong>Active structure:</strong> {activeStructureName ?? '—'}</div>
          <div><strong>Active gate safety:</strong> {activeGateSafetyName ?? '—'}</div>
        </div>
      )}
      <div className="statusSummary" style={{ marginTop: '0.5rem' }}>
        {statusSummaryItems.map(({ label, value }) => (
          <div key={label}>
            <span>{label}</span>{' '}
            <span className="status-summary-value">{value}</span>
          </div>
        ))}
      </div>
      <div className="controls" style={{ marginTop: '0.5rem' }}>
        {onManage && (
          <button
            type="button"
            className="section-header-icon-btn strategy-btn-manage"
            title="Open Strategy management"
            aria-label="Manage strategy"
            onClick={onManage}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        {onSuspend != null && onResume != null && (
          <>
            <button
              type="button"
              className="section-header-icon-btn strategy-btn-resume"
              disabled={!suspended}
              title={!suspended ? 'Already running' : 'Set from monitor; daemon resumes hedging on next heartbeat'}
              aria-label="Resume"
              onClick={onResume}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
            </button>
            <button
              type="button"
              className="section-header-icon-btn strategy-btn-suspend"
              disabled={suspended}
              title={suspended ? 'Already suspended' : 'Set from monitor; daemon pauses new hedges on next heartbeat'}
              aria-label="Suspend"
              onClick={onSuspend}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
            </button>
          </>
        )}
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
