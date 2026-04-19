/** Align with Option Discovery contract chart — values match option_min.period in PostgreSQL. */

export const OPTION_BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 hour', label: '1 hour' },
  { value: '5 mins', label: '5 min' },
  { value: '1 min', label: '1 min' },
] as const

export type OptionBarPeriodValue = (typeof OPTION_BAR_PERIODS)[number]['value']

export const OPTION_MIN_INTRADAY_PERIODS = OPTION_BAR_PERIODS.filter(p => p.value !== '1 D')

/** Intraday values only — matches Data Overview option_min period selector. */
export type OptionMinIntradayPeriodValue = (typeof OPTION_MIN_INTRADAY_PERIODS)[number]['value']

export const DEFAULT_OPTION_MIN_PERIOD: OptionMinIntradayPeriodValue = '5 mins'
