/** How the instance hold-time anchor was chosen (English UI). */
export type HoldingAnchorKind = 'opened_at_epoch' | 'opened_at_field' | 'oldest_fill'

export function buildHoldingPeriodTooltip(anchor: HoldingAnchorKind): string {
  const notReportDiff =
    'This value is NOT the difference between Buy and Sell report dates, nor the span between two fills on the ledger. '
  const windowExplain =
    'Hold time is elapsed calendar time from a single anchor (instance open) through now — the instance lifetime for annualization. '
  const anchors: Record<HoldingAnchorKind, string> = {
    opened_at_epoch:
      'Anchor: strategy instance Opened at (Unix epoch from server). Prefer setting Opened in Overview if it should reflect your intended start.',
    opened_at_field:
      'Anchor: strategy instance Opened at (parsed from the Opened at date field).',
    oldest_fill:
      'Anchor: oldest attributed execution time in the performance book (Opened at was unset or unparsable).',
  }
  return notReportDiff + windowExplain + anchors[anchor]
}
