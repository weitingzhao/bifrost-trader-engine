import type { Bar } from '../../types'

export interface KellyMetrics {
  kelly_pct: number
  effective_kelly: number
  is_valid: boolean
}

export interface AtrResult {
  atr14: number
  bars_used: number
}

export interface PositionSizeResult {
  atr14: number
  stop_distance: number
  shares: number
  dollar_risk: number
  risk_pct: number
  stop_loss_long: number
  stop_loss_short: number
  is_valid: boolean
}

export function computeKelly(
  win_rate: number | null | undefined,
  profit_factor: number | null | undefined,
  kellyFraction: number,
): KellyMetrics {
  if (win_rate == null || profit_factor == null || profit_factor <= 0 || win_rate < 0 || win_rate > 1) {
    return { kelly_pct: 0, effective_kelly: 0, is_valid: false }
  }
  const kelly_pct = win_rate - (1 - win_rate) / profit_factor
  const effective_kelly = kelly_pct * kellyFraction
  return { kelly_pct, effective_kelly, is_valid: true }
}

export function computeAtr(bars: Bar[], period = 14): AtrResult {
  if (bars.length < 2) {
    return { atr14: 0, bars_used: 0 }
  }
  const trValues: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (i === 0) {
      trValues.push(b.high - b.low)
    } else {
      const prevClose = bars[i - 1].close
      trValues.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)))
    }
  }
  const slice = trValues.slice(-period)
  const atr14 = slice.reduce((s, v) => s + v, 0) / slice.length
  return { atr14, bars_used: slice.length }
}

export function computePositionSize(
  capital: number,
  currentPrice: number,
  atrResult: AtrResult,
  kellyMetrics: KellyMetrics,
  atrMultiplier: number,
): PositionSizeResult {
  const { atr14 } = atrResult
  const { effective_kelly, is_valid: kellyValid } = kellyMetrics
  const stop_distance = atrMultiplier * atr14

  if (capital <= 0 || atr14 === 0 || !kellyValid || effective_kelly <= 0 || stop_distance === 0) {
    return {
      atr14,
      stop_distance,
      shares: 0,
      dollar_risk: 0,
      risk_pct: 0,
      stop_loss_long: currentPrice - stop_distance,
      stop_loss_short: currentPrice + stop_distance,
      is_valid: false,
    }
  }

  const shares = Math.floor((capital * effective_kelly) / stop_distance)
  const dollar_risk = shares * stop_distance
  const risk_pct = (dollar_risk / capital) * 100

  return {
    atr14,
    stop_distance,
    shares,
    dollar_risk,
    risk_pct,
    stop_loss_long: currentPrice - stop_distance,
    stop_loss_short: currentPrice + stop_distance,
    is_valid: shares > 0,
  }
}
