/** Tables shown in By symbol matrix / Focus dataset (9 option datasets, Massive-scoped API). */
export const OPTIONS_FOCUS_TABLE_IDS = [
  'option_contracts',
  'option_snapshots',
  'option_day',
  'option_min',
  'option_snapshots_with_underlying_day',
  'option_expiration_cache',
  'option_open_interest_daily',
  'report_option_atm_iv_daily',
  'report_option_max_pain_daily',
] as const

export type OptionsFocusTableId = (typeof OPTIONS_FOCUS_TABLE_IDS)[number]

/** Focus: all, a layer (fundamental / staging / report), or one table. */
export type OptionsFocusDataset =
  | 'all'
  | 'fundamental'
  | 'staging'
  | 'report'
  | OptionsFocusTableId

export const OPTIONS_DATASET_COUNT = OPTIONS_FOCUS_TABLE_IDS.length

const FUNDAMENTAL_TABLES: OptionsFocusTableId[] = [
  'option_contracts',
  'option_snapshots',
  'option_day',
  'option_min',
]

const STAGING_TABLES: OptionsFocusTableId[] = [
  'option_snapshots_with_underlying_day',
  'option_expiration_cache',
  'option_open_interest_daily',
]

const REPORT_TABLES: OptionsFocusTableId[] = ['report_option_atm_iv_daily', 'report_option_max_pain_daily']

export function showFocusTable(focus: OptionsFocusDataset, table: OptionsFocusTableId): boolean {
  if (focus === 'all') return true
  if (focus === 'fundamental') return FUNDAMENTAL_TABLES.includes(table)
  if (focus === 'staging') return STAGING_TABLES.includes(table)
  if (focus === 'report') return REPORT_TABLES.includes(table)
  return focus === table
}
