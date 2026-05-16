import { fetchMarketTradingDay } from '../../api'
import { addCalendarDaysNy, nyCalendarDateIso } from '../massive/customBarsTimePresets'

/** Walk backward up to 15 calendar days for a NY trading day (Massive intraday window). */
export async function findLastNyTradingDayForBarsSync(): Promise<string | null> {
  let ymd = nyCalendarDateIso()
  for (let i = 0; i < 15; i++) {
    const r = await fetchMarketTradingDay(ymd)
    if (r.is_trading_day) return ymd
    ymd = addCalendarDaysNy(ymd, -1)
  }
  return null
}
