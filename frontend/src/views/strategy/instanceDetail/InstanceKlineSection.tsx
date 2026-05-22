import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { w9 } from '@/styles/wave9Classes'
import type { Bar, Execution } from '../../../types'
import { fetchBars, fetchOptionBars, fetchOptionSnapshot, postMassiveSync } from '../../../api'
import { fmtExpiry, parseOptionContractKey } from '../../../utils/format'
import { buildPolygonOptionsTicker } from '../../../utils/polygonOptionsTicker'
import {
  klineOptionTabKey,
  normalizeOptionExpiryDigits,
  normalizeOptionRightChar,
} from './instanceKlineTabKey'

export type InstanceKlineNavRequest = { key: string; nonce: number } | null

// SVG layout constants (viewBox coordinates)
const VW = 820
const VH = 320
const LEFT = 62     // Y-axis label zone
const RIGHT = VW - 8
const TOP = 8
const CHART_H = 220  // main candlestick area bottom
const VOL_TOP = CHART_H + 10
const VOL_BOT = CHART_H + 38
const X_Y = VH - 6  // x-axis label baseline

type KlineTab =
  | { kind: 'stock'; symbol: string; label: string }
  | { kind: 'option'; symbol: string; expiry: string; strike: number; option_right: string; label: string }

interface Marker {
  barIdx: number
  price: number
  side: 'BUY' | 'SELL'
  qty: number
  timeLabel: string
}

interface TooltipInfo {
  svgX: number
  lines: string[]
}

function dayTs(unixSec: number): number {
  const d = new Date(unixSec * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000
}

function fmtDateShort(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC',
  })
}

function fmtDateAxis(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

function fmtP(p: number): string {
  return p >= 100 ? p.toFixed(1) : p < 10 ? p.toFixed(3) : p.toFixed(2)
}

function triPath(cx: number, cy: number, size: number, up: boolean): string {
  const h = size * 0.87
  return up
    ? `M${cx},${cy - h * 0.67} L${cx - size * 0.5},${cy + h * 0.33} L${cx + size * 0.5},${cy + h * 0.33}Z`
    : `M${cx},${cy + h * 0.67} L${cx - size * 0.5},${cy - h * 0.33} L${cx + size * 0.5},${cy - h * 0.33}Z`
}

/** Resolve expiry/strike/option_right from direct fields, falling back to contract_key parsing. */
function resolveOptFields(e: Execution): { expiry: string; strike: number; option_right: string } | null {
  let expiry = e.expiry
  let strike = e.strike
  let option_right = e.option_right

  if ((!expiry || strike == null || !option_right) && e.contract_key) {
    const parsed = parseOptionContractKey(e.contract_key)
    if (!expiry && parsed.expiry !== '—') expiry = parsed.expiry
    if (strike == null && parsed.strike !== '—') {
      const s = parseFloat(parsed.strike)
      if (!isNaN(s)) strike = s
    }
    if (!option_right && parsed.right !== '—') option_right = parsed.right
  }

  if (!expiry || strike == null || !option_right) return null
  const expN = normalizeOptionExpiryDigits(expiry)
  if (!expN) return null
  const r = normalizeOptionRightChar(option_right)
  const k = Number(strike)
  if (!Number.isFinite(k)) return null
  return { expiry: expN, strike: k, option_right: r }
}

function deriveTabs(executions: Execution[], symbol: string): KlineTab[] {
  const tabs: KlineTab[] = []
  const hasStock = executions.some(e => (e.sec_type ?? '').toUpperCase() === 'STK')
  if (hasStock) tabs.push({ kind: 'stock', symbol, label: `Stock ${symbol}` })

  const seen = new Map<string, KlineTab>()
  for (const e of executions) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    const fields = resolveOptFields(e)
    if (!fields) continue
    const { expiry, strike, option_right } = fields
    const key = klineOptionTabKey(expiry, strike, option_right)
    if (!seen.has(key)) {
      const rightLabel = option_right === 'P' ? 'PUT' : 'CALL'
      seen.set(key, {
        kind: 'option',
        symbol,
        expiry,
        strike,
        option_right,
        label: `${rightLabel} $${strike} ${fmtExpiry(expiry)}`,
      })
    }
  }
  tabs.push(...seen.values())
  return tabs
}

function execsForTab(tab: KlineTab, executions: Execution[]): Execution[] {
  if (tab.kind === 'stock') return executions.filter(e => (e.sec_type ?? '').toUpperCase() === 'STK')
  const tabKey = klineOptionTabKey(tab.expiry, tab.strike, tab.option_right)
  return executions.filter(e => {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') return false
    const fields = resolveOptFields(e)
    if (!fields) return false
    return klineOptionTabKey(fields.expiry, fields.strike, fields.option_right) === tabKey
  })
}

function buildMarkers(bars: Bar[], tabExecs: Execution[]): Marker[] {
  const markers: Marker[] = []
  for (const e of tabExecs) {
    if (!e.time || !e.price) continue
    const execDay = dayTs(e.time)
    let bestIdx = -1
    let bestDiff = Infinity
    for (let i = 0; i < bars.length; i++) {
      const diff = Math.abs(bars[i].time - execDay)
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i }
    }
    if (bestIdx < 0 || bestDiff > 5 * 86400) continue
    const rawSide = (e.side ?? '').toUpperCase()
    const side: 'BUY' | 'SELL' =
      rawSide === 'BUY' || rawSide === 'BOT' || rawSide === 'B' ? 'BUY' : 'SELL'
    markers.push({
      barIdx: bestIdx,
      price: e.price,
      side,
      qty: Math.abs(Number(e.quantity) || 0),
      timeLabel: fmtDateShort(e.time),
    })
  }
  return markers
}

export function InstanceKlineSection({
  symbol,
  executions,
  strategyInstanceId,
  klineNav = null,
  onKlineNavApplied,
}: {
  symbol: string
  executions: Execution[]
  strategyInstanceId: number
  klineNav?: InstanceKlineNavRequest
  onKlineNavApplied?: () => void
}) {
  const tabs = useMemo(() => deriveTabs(executions, symbol), [executions, symbol])
  const [tabIdx, setTabIdx] = useState(0)
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const cancelRef = useRef(0)
  const snapshotAttemptedRef = useRef(new Set<string>())

  const selectedTab = tabs[tabIdx] ?? null

  const load = useCallback(async (tab: KlineTab) => {
    const token = ++cancelRef.current
    setLoading(true)
    setError(null)
    setBars([])
    try {
      let res: { bars: Bar[] }
      if (tab.kind === 'stock') {
        res = await fetchBars(tab.symbol, '1 D', 250)
      } else {
        const pullOptionBars = async () => {
          let optionRes = await fetchOptionBars({
            symbol: tab.symbol,
            expiry: tab.expiry,
            strike: tab.strike,
            option_right: tab.option_right,
            period: '1 D',
            limit: 250,
            source: 'massive',
          })
          if (!optionRes.bars.length) {
            optionRes = await fetchOptionBars({
              symbol: tab.symbol,
              expiry: tab.expiry,
              strike: tab.strike,
              option_right: tab.option_right,
              period: '1 D',
              limit: 250,
              source: 'ib',
            })
          }
          return optionRes
        }

        res = await pullOptionBars()
        if (!res.bars.length) {
          const key = klineOptionTabKey(tab.expiry, tab.strike, tab.option_right)
          if (!snapshotAttemptedRef.current.has(key)) {
            snapshotAttemptedRef.current.add(key)
            // No historical bar yet: trigger Massive contract snapshot + IB snapshot once, then retry bars.
            const optionContract = buildPolygonOptionsTicker(tab.symbol, tab.expiry, tab.strike, tab.option_right)
            await postMassiveSync(
              'feed_option_snapshots',
              {
                mode: 'contract',
                underlying: tab.symbol,
                option_contract: optionContract,
                persist: true,
              },
              { priority: 'high' },
            )
            await fetchOptionSnapshot(tab.symbol, tab.expiry, [tab.strike])
            res = await pullOptionBars()
          }
        }
      }
      if (cancelRef.current !== token) return
      const sorted = [...(res.bars ?? [])].sort((a, b) => a.time - b.time)
      setBars(sorted)
    } catch (e) {
      if (cancelRef.current !== token) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (cancelRef.current === token) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedTab) return
    void load(selectedTab)
  }, [selectedTab, load])

  useEffect(() => {
    setTabIdx(0)
  }, [strategyInstanceId])

  useEffect(() => {
    if (klineNav == null) return
    const idx = tabs.findIndex(
      (t) => t.kind === 'option' && klineOptionTabKey(t.expiry, t.strike, t.option_right) === klineNav.key,
    )
    if (idx >= 0) {
      setTabIdx(idx)
      window.requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
    onKlineNavApplied?.()
  }, [klineNav, tabs, onKlineNavApplied])

  const tabExecs = useMemo(
    () => (selectedTab ? execsForTab(selectedTab, executions) : []),
    [selectedTab, executions],
  )

  // Windowed bars: keep a range that shows all executions + padding
  const windowedBars = useMemo(() => {
    if (bars.length === 0) return bars
    const execTimes = tabExecs.map(e => e.time ?? 0).filter(t => t > 0)
    if (execTimes.length === 0) return bars.slice(-120)
    const minDay = dayTs(Math.min(...execTimes))
    const maxDay = dayTs(Math.max(...execTimes))
    const startIdx = Math.max(0, bars.findIndex(b => b.time >= minDay) - 20)
    let lastIdx = bars.length - 1
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].time <= maxDay) { lastIdx = i; break } }
    const endIdx = Math.min(bars.length - 1, lastIdx + 15)
    return bars.slice(startIdx, endIdx + 1)
  }, [bars, tabExecs])

  const markers = useMemo(() => buildMarkers(windowedBars, tabExecs), [windowedBars, tabExecs])

  // Chart scales
  const { priceMin, priceMax, maxVol } = useMemo(() => {
    if (windowedBars.length === 0) return { priceMin: 0, priceMax: 1, maxVol: 1 }
    let lo = Math.min(...windowedBars.map(b => b.low))
    let hi = Math.max(...windowedBars.map(b => b.high))
    for (const m of markers) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price) }
    const pad = (hi - lo) * 0.05
    const vol = Math.max(...windowedBars.map(b => b.volume ?? 0), 1)
    return { priceMin: lo - pad, priceMax: hi + pad, maxVol: vol }
  }, [windowedBars, markers])

  const n = windowedBars.length
  const mapY = (p: number) => n === 0 ? TOP : TOP + (1 - (p - priceMin) / (priceMax - priceMin)) * (CHART_H - TOP)
  const mapX = (i: number) => n === 0 ? LEFT : LEFT + (i + 0.5) / n * (RIGHT - LEFT)
  const barW = n === 0 ? 4 : Math.max(1.5, (RIGHT - LEFT) / n * 0.72)
  const mapVolY = (v: number) => VOL_BOT - (v / maxVol) * (VOL_BOT - VOL_TOP)

  // Y-axis grid prices
  const yGrid = useMemo<number[]>(() => {
    if (priceMax <= priceMin) return []
    const count = 5
    return Array.from({ length: count }, (_, i) => priceMin + (priceMax - priceMin) * i / (count - 1))
  }, [priceMin, priceMax])

  // X-axis label indices
  const xLabelIdxs = useMemo<number[]>(() => {
    if (n === 0) return []
    const step = Math.max(1, Math.round(n / 7))
    const idxs: number[] = []
    for (let i = 0; i < n; i += step) idxs.push(i)
    return idxs
  }, [n])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || n === 0) return
    const rect = svg.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * VW
    const relX = svgX - LEFT
    const chartWidth = RIGHT - LEFT
    if (relX < 0 || relX > chartWidth) { setTooltip(null); return }
    const rawIdx = Math.floor(relX / chartWidth * n)
    const idx = Math.max(0, Math.min(n - 1, rawIdx))
    const bar = windowedBars[idx]
    if (!bar) { setTooltip(null); return }
    const lines = [
      fmtDateAxis(bar.time),
      `O ${fmtP(bar.open)}  H ${fmtP(bar.high)}`,
      `L ${fmtP(bar.low)}  C ${fmtP(bar.close)}`,
    ]
    if (bar.volume) lines.push(`Vol ${bar.volume.toLocaleString()}`)
    const mkrs = markers.filter(m => m.barIdx === idx)
    for (const mk of mkrs) {
      lines.push(`${mk.side} ${mk.qty} @ ${fmtP(mk.price)} (${mk.timeLabel})`)
    }
    setTooltip({ svgX: mapX(idx), lines })
  }, [n, windowedBars, markers, mapX])

  if (tabs.length === 0) return null

  return (
    <section ref={sectionRef} className="detail-block instance-detail-kline-section">
      <h3 className="instance-detail-section-title">K-line Chart</h3>

      {/* Tab selector */}
      {tabs.length > 1 && (
        <div className="instance-detail-exec-tabs" style={{ marginBottom: '0.6rem' }}>
          {tabs.map((tab, i) => (
            <button
              key={tab.label}
              type="button"
              className={`instance-detail-exec-tab${i === tabIdx ? ' instance-detail-exec-tab--active' : ''}`}
              onClick={() => setTabIdx(i)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {tabs.length === 1 && (
        <p className={w9.sectionHint} style={{ marginBottom: '0.4rem', marginTop: 0 }}>
          {tabs[0].label}
        </p>
      )}

      {/* Chart area */}
      {loading && <p className={w9.sectionHint}>Loading bars…</p>}
      {error && <p className={w9.sectionHint} style={{ color: 'var(--color-lamp-red)' }}>{error}</p>}
      {!loading && !error && bars.length === 0 && (
        <p className={w9.sectionHint}>No bar data available for this contract.</p>
      )}
      {!loading && !error && windowedBars.length > 0 && (
        <div style={{ position: 'relative' }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VW} ${VH}`}
            width="100%"
            style={{ display: 'block', cursor: 'crosshair', userSelect: 'none' }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setTooltip(null)}
          >
            {/* Y-axis grid lines + labels */}
            {yGrid.map((p, i) => {
              const y = mapY(p)
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={RIGHT} y2={y}
                    stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} strokeDasharray="3,3" />
                  <text x={LEFT - 4} y={y + 3.5} textAnchor="end"
                    fontSize={9.5} fill="rgba(255,255,255,0.4)">
                    {fmtP(p)}
                  </text>
                </g>
              )
            })}

            {/* X-axis labels */}
            {xLabelIdxs.map(idx => (
              <text key={idx} x={mapX(idx)} y={X_Y} textAnchor="middle"
                fontSize={9} fill="rgba(255,255,255,0.38)">
                {fmtDateAxis(windowedBars[idx].time)}
              </text>
            ))}

            {/* Separator between main chart and volume */}
            <line x1={LEFT} y1={CHART_H + 2} x2={RIGHT} y2={CHART_H + 2}
              stroke="rgba(255,255,255,0.1)" strokeWidth={0.8} />

            {/* Candlesticks + volume bars */}
            {windowedBars.map((bar, i) => {
              const x = mapX(i)
              const bullish = bar.close >= bar.open
              const bodyColor = bullish ? '#22c55e' : '#ef4444'
              const bodyTop = mapY(Math.max(bar.open, bar.close))
              const bodyBot = mapY(Math.min(bar.open, bar.close))
              const bodyH = Math.max(1, bodyBot - bodyTop)
              const wickTop = mapY(bar.high)
              const wickBot = mapY(bar.low)
              const volH = bar.volume ? VOL_BOT - mapVolY(bar.volume) : 0
              return (
                <g key={i}>
                  {/* Wick */}
                  <line x1={x} y1={wickTop} x2={x} y2={wickBot}
                    stroke={bodyColor} strokeWidth={Math.max(0.8, barW * 0.15)} strokeOpacity={0.7} />
                  {/* Body */}
                  <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH}
                    fill={bodyColor} fillOpacity={0.85} />
                  {/* Volume */}
                  {bar.volume ? (
                    <rect x={x - barW / 2} y={VOL_BOT - volH} width={barW} height={volH}
                      fill={bodyColor} fillOpacity={0.35} />
                  ) : null}
                </g>
              )
            })}

            {/* Execution markers */}
            {markers.map((m, i) => {
              const x = mapX(m.barIdx)
              const y = mapY(m.price)
              const isBuy = m.side === 'BUY'
              const color = isBuy ? '#4ade80' : '#f87171'
              const offset = isBuy ? 10 : -10
              const cy = y + offset
              return (
                <g key={i}>
                  {/* Vertical dotted line from marker to bar */}
                  <line x1={x} y1={cy + (isBuy ? -9 : 9)} x2={x} y2={mapY(isBuy ? windowedBars[m.barIdx]?.low ?? m.price : windowedBars[m.barIdx]?.high ?? m.price)}
                    stroke={color} strokeWidth={0.8} strokeOpacity={0.4} strokeDasharray="2,2" />
                  <path d={triPath(x, cy, 9, isBuy)}
                    fill={color} fillOpacity={0.9}
                    stroke={color} strokeWidth={0.5} />
                  {/* Price label */}
                  <text x={x + 7} y={cy + 3.5}
                    fontSize={8.5} fill={color} fontWeight="600">
                    {fmtP(m.price)}
                  </text>
                </g>
              )
            })}

            {/* Crosshair + tooltip */}
            {tooltip && (
              <g>
                <line x1={tooltip.svgX} y1={TOP} x2={tooltip.svgX} y2={CHART_H}
                  stroke="rgba(255,255,255,0.25)" strokeWidth={0.8} strokeDasharray="3,2" />
                {(() => {
                  const boxW = 130
                  const boxH = tooltip.lines.length * 14 + 10
                  const bx = Math.min(tooltip.svgX + 8, RIGHT - boxW - 4)
                  const by = TOP + 4
                  return (
                    <g>
                      <rect x={bx} y={by} width={boxW} height={boxH} rx={4}
                        fill="rgba(15,20,30,0.88)" stroke="rgba(255,255,255,0.15)" strokeWidth={0.8} />
                      {tooltip.lines.map((line, i) => (
                        <text key={i} x={bx + 7} y={by + 14 + i * 14}
                          fontSize={9.5} fill={i === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.55)'}>
                          {line}
                        </text>
                      ))}
                    </g>
                  )
                })()}
              </g>
            )}
          </svg>

          {/* Status line */}
          <p className={w9.sectionHint} style={{ marginTop: '0.25rem' }}>
            {windowedBars.length} bars
            {markers.filter(m => m.side === 'BUY').length > 0 && (
              <span style={{ marginLeft: 10, color: '#4ade80' }}>
                ▲ {markers.filter(m => m.side === 'BUY').length} buy
              </span>
            )}
            {markers.filter(m => m.side === 'SELL').length > 0 && (
              <span style={{ marginLeft: 8, color: '#f87171' }}>
                ▼ {markers.filter(m => m.side === 'SELL').length} sell
              </span>
            )}
            {bars.length > windowedBars.length && (
              <span style={{ marginLeft: 8, opacity: 0.55 }}>
                (windowed from {bars.length} total)
              </span>
            )}
          </p>
        </div>
      )}
    </section>
  )
}
