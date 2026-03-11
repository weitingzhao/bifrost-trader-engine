export const BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 min', label: '1 min' },
  { value: '5 mins', label: '5 min' },
  { value: '1 hour', label: '1 hour' },
] as const

/** All period values for Reset/Pull multi-select; derived from BAR_PERIODS. */
export const ALL_BAR_PERIOD_VALUES = BAR_PERIODS.map((p) => p.value)

export const INSPECT_BARS_LIMIT_BY_PERIOD: Record<string, number> = {
  '1 D': 126,
  '1 min': 390,
  '5 mins': 390,
  '1 hour': 160,
}
