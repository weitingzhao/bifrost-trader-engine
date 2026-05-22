import { useCallback, useMemo, useState } from 'react'
import type { StatusResponse } from '../../../types'
import { DraggableModal } from '../../../components/DraggableModal'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { Button } from '@/components/ui/button'
import type { LampTone } from '@/components/shared/lamp-indicator'
import { SettingsStatusMessage } from '../../settings/SettingsStatusMessage'
import { SettingsTitleLamp } from '../../settings/SettingsTitleLamp'
import { STRATEGY_METRIC_LABEL_COMPACT } from '../statusLabels'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

const FLATTEN_ALERT_SVG = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

export interface StatusStrategyPanelProps {
  status: StatusResponse | null
  hedgeLamp: Lamp
  hedgeLabel: string
  hedgeSelfCheckText: string
  hedgeBlockReasons: string
  /** Compact strip: short hedge line (Daemon card). Full text stays in title tooltip. */
  hedgeStatusCompact?: string
  /** Compact strip: abbreviated block reasons (omit when empty). */
  hedgeBlockReasonsCompact?: string
  hedgeHint: string
  statusSummaryItems: { label: string; value: string | number }[]
  /** Invoked after user confirms in the emergency flatten dialog; may be async (e.g. monitor API). */
  onFlatten: () => void | Promise<void>
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
  hedgeStatusCompact,
  hedgeBlockReasonsCompact,
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

  const compactMetricItems = useMemo(
    () =>
      statusSummaryItems.filter(
        ({ label }) => label !== 'Updated at' && label !== 'Daemon state',
      ),
    [statusSummaryItems],
  )

  const [flattenDialogOpen, setFlattenDialogOpen] = useState(false)
  const [flattenDialogBusy, setFlattenDialogBusy] = useState(false)

  const openFlattenDialog = useCallback(() => setFlattenDialogOpen(true), [])

  const confirmFlatten = useCallback(async () => {
    setFlattenDialogBusy(true)
    try {
      await Promise.resolve(onFlatten())
      setFlattenDialogOpen(false)
    } finally {
      setFlattenDialogBusy(false)
    }
  }, [onFlatten])

  const flattenModal = (
    <DraggableModal
      open={flattenDialogOpen}
      onBackdropClick={() => {
        if (!flattenDialogBusy) setFlattenDialogOpen(false)
      }}
      backdropLocked={flattenDialogBusy}
      title="Emergency flatten"
      titleId="strategy-flatten-confirm-title"
      footer={
        <div className="data-reset-modal-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setFlattenDialogOpen(false)}
            disabled={flattenDialogBusy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void confirmFlatten()}
            disabled={flattenDialogBusy}
          >
            {flattenDialogBusy ? 'Sending…' : 'Confirm'}
          </Button>
        </div>
      }
    >
      <p>
        You are about to request a <strong>flatten</strong> of strategy hedge exposure. The monitor writes{' '}
        <code>flatten</code> to the daemon control channel; the daemon is meant to consume it and work toward
        closing or reducing hedge exposure (actual execution depends on daemon and broker state).
      </p>
      <SettingsStatusMessage error className="mt-2">
        High risk — only confirm in a real emergency when you accept possible market and account impact.
      </SettingsStatusMessage>
    </DraggableModal>
  )

  const emergencyFlattenButton = (
    <button
      type="button"
      className="strategy-flatten-emergency-btn"
      title="Emergency: request flatten of hedge exposure (opens confirmation)"
      aria-label="Emergency flatten exposure"
      onClick={openFlattenDialog}
    >
      {FLATTEN_ALERT_SVG}
    </button>
  )

  if (compact) {
    return (
      <>
      <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={panelClass}>
        <div className="strategy-compact-header">
          <SettingsTitleLamp lamp={hedgeLamp as LampTone} title="Trading strategy status">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
          </SettingsTitleLamp>
          <span className="strategy-compact-title">Trading Strategy</span>
        </div>
        <div className="strategy-compact-meta-row">
          <div
            className="strategy-compact-status"
            title={
              j
                ? `${hedgeLabel}${hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` · ${hedgeBlockReasons}` : ''}`
                : 'Fetch failed'
            }
          >
            {j && hedgeStatusCompact != null ? (
              <>
                <span className="strategy-compact-status-k">{hedgeStatusCompact}</span>
                {hedgeBlockReasonsCompact ? (
                  <span className="strategy-compact-status-blocks"> · {hedgeBlockReasonsCompact}</span>
                ) : null}
              </>
            ) : j ? (
              <>
                {hedgeLabel}
                {hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` · ${hedgeBlockReasons}` : ''}
              </>
            ) : (
              'Fetch failed'
            )}
          </div>
          <div className="strategy-compact-summary strategy-compact-summary--inline" role="list" aria-label="Trading metrics">
            {compactMetricItems.map(({ label, value }) => (
              <span key={label} className="strategy-compact-summary-item" role="listitem">
                <span className="strategy-compact-label">
                  {STRATEGY_METRIC_LABEL_COMPACT[label] ?? label}
                </span>
                <span className="status-summary-value">{value}</span>
              </span>
            ))}
          </div>
        </div>
        {(activeStructureName != null || activeGateSafetyName != null) && (
          <div className="strategy-active-names strategy-active-names--compact">
            <span title="Active structure">S:{activeStructureName ?? '—'}</span>
            <span title="Active gate safety set">G:{activeGateSafetyName ?? '—'}</span>
          </div>
        )}
        <div className="controls strategy-compact-controls strategy-controls-primary-row">
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
            suspended ? (
              <button
                type="button"
                className="section-header-icon-btn strategy-btn-resume"
                title="Resume — daemon continues hedging on next heartbeat"
                aria-label="Resume hedging"
                onClick={onResume}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
              </button>
            ) : (
              <button
                type="button"
                className="section-header-icon-btn strategy-btn-suspend"
                title="Suspend — daemon pauses new hedges on next heartbeat"
                aria-label="Suspend hedging"
                onClick={onSuspend}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
              </button>
            )
          )}
        </div>
        <div className="strategy-emergency-bar" role="group" aria-label="Emergency trading actions">
          <span className="strategy-emergency-bar-label">
            Emergency
            <InfoTooltip text="Flatten requests the daemon control channel to close or reduce hedge exposure. Confirm in the dialog; use only when you understand the risk." />
          </span>
          {emergencyFlattenButton}
        </div>
        {hedgeCtrlMsg.text ? (
          <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'} strategy-compact-msg`}>
            {hedgeCtrlMsg.text}
          </div>
        ) : null}
      </div>
      {flattenModal}
      </>
    )
  }

  return (
    <>
    <div id="system-panel-strategy" role="tabpanel" aria-labelledby="tab-strategy" className={panelClass}>
      <div className="daemon-header-with-lamp" style={{ marginBottom: '0.5rem' }}>
        <div>
          <h2 className="daemon-card-title inline-flex flex-wrap items-center gap-2 m-0">
            <SettingsTitleLamp lamp={hedgeLamp as LampTone} title="Trading strategy status lamp">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
            </SettingsTitleLamp>
            Trading Strategy
            <InfoTooltip text="Depends on daemon; business logic; may support multiple strategies later." />
          </h2>
        </div>
      </div>
      <div className="strategy-full-meta-row">
        <div className="strategy-full-meta-primary">
          <strong>Status: {j ? `${hedgeLabel} (${hedgeSelfCheckText})` : 'Fetch failed'}</strong>
          {j && hedgeBlockReasons && hedgeBlockReasons !== 'None' ? ` Block reasons: ${hedgeBlockReasons}` : ''}
        </div>
        <div
          className="strategy-compact-summary strategy-compact-summary--inline strategy-compact-summary--full"
          role="list"
          aria-label="Trading metrics"
        >
          {statusSummaryItems.map(({ label, value }) => (
            <span key={label} className="strategy-compact-summary-item" role="listitem">
              <span className="strategy-compact-label">{label}</span>
              <span className="status-summary-value">{value}</span>
            </span>
          ))}
        </div>
      </div>
      <p className="section-hint">{hedgeHint}</p>
      {(activeStructureName != null || activeGateSafetyName != null) && (
        <div className="strategy-active-names" style={{ marginTop: '0.5rem' }}>
          <div><strong>Active structure:</strong> {activeStructureName ?? '—'}</div>
          <div><strong>Active gate safety:</strong> {activeGateSafetyName ?? '—'}</div>
        </div>
      )}
      <div className="controls strategy-controls-primary-row" style={{ marginTop: '0.5rem' }}>
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
          suspended ? (
            <button
              type="button"
              className="section-header-icon-btn strategy-btn-resume"
              title="Resume — daemon continues hedging on next heartbeat"
              aria-label="Resume hedging"
              onClick={onResume}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
            </button>
          ) : (
            <button
              type="button"
              className="section-header-icon-btn strategy-btn-suspend"
              title="Suspend — daemon pauses new hedges on next heartbeat"
              aria-label="Suspend hedging"
              onClick={onSuspend}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
            </button>
          )
        )}
      </div>
      <div className="strategy-emergency-bar" role="group" aria-label="Emergency trading actions">
        <span className="strategy-emergency-bar-label">
          Emergency
          <InfoTooltip text="Flatten requests the daemon control channel to close or reduce hedge exposure. Confirm in the dialog; use only when you understand the risk." />
        </span>
        {emergencyFlattenButton}
      </div>
      {hedgeCtrlMsg.text ? (
        <div className={`msg ${hedgeCtrlMsg.isErr ? 'err' : 'ok'}`}>
          {hedgeCtrlMsg.text}
        </div>
      ) : null}
    </div>
    {flattenModal}
    </>
  )
}
