/** Unified axis / label font size (user units) for Option Discovery SVG charts — matches IV Smile visual density */
export const OD_CHART_AXIS_FONT = 8

/** Option Analytics trio (IV smile, OI, gamma): axis text — stronger than --color-text-dim for dark theme */
export const OD_ANALYTICS_AXIS_TICK_FILL = 'var(--color-text-muted)'
export const OD_ANALYTICS_AXIS_TITLE_FILL = 'var(--color-text-main)'

/** Max Pain trio (liability / OI / trend): shared viewBox for equal CSS height; large ticks + room for axis titles */
export const OD_MAX_PAIN_VIEWBOX_W = 640
export const OD_MAX_PAIN_VIEWBOX_H = 260
export const OD_MAX_PAIN_AXIS_FONT = 12

/** Padding: left for y-tick numerals; bottom for x-ticks row + axis title row; top for y-axis label */
export const OD_MAX_PAIN_PAD_LIABILITY_OI = { l: 78, r: 26, t: 40, b: 56 } as const
export const OD_MAX_PAIN_PAD_TREND = { l: 78, r: 52, t: 40, b: 56 } as const

/** IV Term Structure & IV Volatility Cone — larger, easier-to-read axis ticks and titles */
export const OD_CHART_AXIS_FONT_IV_TERM = 12

/** Shared viewBox for IV Term + IV Cone (same row → equal rendered height when widths match) */
export const OD_IV_TERM_VIEWBOX_W = 640
export const OD_IV_TERM_VIEWBOX_H = 260

/**
 * Padding inside viewBox. Extra top/bottom keeps axis titles from overlapping tick labels.
 */
export const OD_IV_TERM_PAD = { l: 58, r: 24, t: 28, b: 54 } as const

/** Y-axis title ("ATM IV") baseline Y — top band, clear of top y-tick text */
export const OD_IV_TERM_Y_AXIS_TITLE_Y = 14

/** X-axis tick baselines (Nd) — leave a row below for the axis title */
export function odIvTermXTickY(h: number): number {
  return h - 32
}

/** X-axis title ("Days to Expiration") baseline — bottom row */
export function odIvTermXAxisTitleY(h: number): number {
  return h - 9
}
