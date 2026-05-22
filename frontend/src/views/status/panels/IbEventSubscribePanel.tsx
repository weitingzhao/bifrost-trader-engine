import { rl } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Execution, IbPositionRow, StatusResponse, StatusSocketIbAccountAgent } from '../../../types'
import { fetchExecutions, postReleaseTickerSubscriptions } from '../../../api'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { ingestRedisHealthLamp, ingestRedisTruthyConnected } from '../../../utils/socketIngestLamp'
import { ingestLampToBrokerRowLamp } from '../daemonIbBrokerLamp'
import { scheduleMsgClear, setMsg } from '../messageUtils'
import type { LampTone } from '@/components/shared/lamp-indicator'
import { SettingsTitleLamp } from '../../settings/SettingsTitleLamp'

export interface IbEventSubscribePanelProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

type BrokerRowLamp = 'green' | 'yellow' | 'red' | 'none'

type EventSubscribeTab = 'data' | 'redis' | 'services'

function RedisKeyCell({ label }: { label: string }) {
  if (label === '—') {
    return (
      <td className="event-subscribe-redis-paths-key-cell">
        <span className="event-subscribe-redis-path-key-clip">—</span>
      </td>
    )
  }
  return (
    <td className="event-subscribe-redis-paths-key-cell" title={label}>
      <span className="event-subscribe-redis-path-key-clip">
        <code className="event-subscribe-inline-code">{label}</code>
      </span>
    </td>
  )
}

const ACTIVITY_LAMP_SVG = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 12h-4l-3 9L9 3 6 12H2" />
  </svg>
)

function StreamHealthLamp({ lamp, title }: { lamp: BrokerRowLamp; title: string }) {
  return (
    <SettingsTitleLamp lamp={lamp as LampTone} title={title}>
      <span className="ib-broker-service-lamp">{ACTIVITY_LAMP_SVG}</span>
    </SettingsTitleLamp>
  )
}

function rollupSubscribeHeaderLamp(
  ing: ReturnType<typeof ingestRedisHealthLamp>,
  aa: ReturnType<typeof ingestRedisHealthLamp>,
): BrokerRowLamp {
  const a = ingestLampToBrokerRowLamp(ing.lamp)
  const b = ingestLampToBrokerRowLamp(aa.lamp)
  if (a === 'red' || b === 'red') return 'red'
  if (a === 'yellow' || b === 'yellow') return 'yellow'
  return 'green'
}

function formatMsgAgeS(age: number | null | undefined): string {
  if (age == null || typeof age !== 'number' || !Number.isFinite(age)) return '—'
  if (age < 60) return `${Math.round(age)}s ago`
  if (age < 3600) return `${Math.round(age / 60)}m ago`
  return `${Math.round(age / 3600)}h ago`
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return String(n)
}

function fmtConnected(v: unknown): string {
  if (v === undefined || v === null) return '—'
  return ingestRedisTruthyConnected(v) ? 'Yes' : 'No'
}

function fmtProcessInService(aa: StatusSocketIbAccountAgent | null | undefined): string {
  if (aa == null) return '—'
  const hasAliveField =
    (aa.service_alive !== undefined && aa.service_alive !== null)
    || (aa.operator_alive !== undefined && aa.operator_alive !== null)
  if (!hasAliveField) return 'Yes'
  const alive =
    ingestRedisTruthyConnected(aa.service_alive) || ingestRedisTruthyConnected(aa.operator_alive)
  return alive ? 'Yes' : 'No'
}

/**
 * Live-updating message age: takes `last_msg_age_s` from a status poll and adds elapsed seconds since the poll.
 * Ticks every 1s so the display updates between status polls (which happen every ~5s).
 */
function useLiveMsgAge(status: StatusResponse | null, ageAtPoll: number | null | undefined): number | null {
  const snapshotRef = useRef<{ pollMs: number; age: number } | null>(null)
  const [liveAge, setLiveAge] = useState<number | null>(null)

  useEffect(() => {
    if (ageAtPoll == null || !Number.isFinite(Number(ageAtPoll))) {
      snapshotRef.current = null
      setLiveAge(null)
      return
    }
    snapshotRef.current = { pollMs: Date.now(), age: Number(ageAtPoll) }
    setLiveAge(Number(ageAtPoll))
  }, [status, ageAtPoll])

  useEffect(() => {
    const id = setInterval(() => {
      if (snapshotRef.current == null) return
      const elapsed = (Date.now() - snapshotRef.current.pollMs) / 1000
      setLiveAge(snapshotRef.current.age + elapsed)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return liveAge
}

/**
 * Estimate msg/s from health-hash msg_count using consecutive GET /status samples
 * (re-fetch gives a new `status` object even when the counter is unchanged).
 */
function useMsgCountRate(status: StatusResponse | null, msgCount: number | null | undefined): number | null {
  const ref = useRef<{ t: number; v: number } | null>(null)
  const [rate, setRate] = useState<number | null>(null)

  useEffect(() => {
    if (msgCount == null || !Number.isFinite(Number(msgCount))) {
      ref.current = null
      setRate(null)
      return
    }
    const v = Number(msgCount)
    const now = Date.now()
    const prev = ref.current
    ref.current = { t: now, v }
    if (prev == null) {
      setRate(null)
      return
    }
    const dt = (now - prev.t) / 1000
    if (dt < 0.05) return
    const dv = v - prev.v
    if (dv < 0) {
      setRate(null)
      return
    }
    setRate(dv / dt)
  }, [status, msgCount])

  return rate
}

function fmtMsgPerSec(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  if (rate > 0 && rate < 0.01) return '<0.01/s'
  if (rate < 10) return `${rate.toFixed(2)}/s`
  return `${rate.toFixed(1)}/s`
}

function formatPositionUpdated(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function formatExecutionTime(ex: Execution): string {
  if (ex.time != null && Number.isFinite(Number(ex.time))) {
    const d = new Date(Number(ex.time) * 1000)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  }
  if (ex.trade_date) return ex.trade_date
  return '—'
}

function truncateKey(key: string, max = 44): string {
  if (key.length <= max) return key
  return `${key.slice(0, max - 1)}…`
}

function fmtDecimal(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return Number(n).toFixed(digits)
}

export function IbEventSubscribePanel({ status: j, loadStatus }: IbEventSubscribePanelProps) {
  const hb = j?.daemon?.heartbeat
  const [releaseTickerLoading, setReleaseTickerLoading] = useState(false)
  const [syncTickerMsg, setSyncTickerMsg] = useState({ text: '', isErr: false })
  const [execRows, setExecRows] = useState<Execution[]>([])
  const [execError, setExecError] = useState<string | null>(null)
  const [subscribeTab, setSubscribeTab] = useState<EventSubscribeTab>('data')
  const syncTickerMsgClearRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (syncTickerMsgClearRef.current != null) clearTimeout(syncTickerMsgClearRef.current)
    }
  }, [])

  const streamHostAccountId = (j?.config?.ib_client?.account?.event_host ?? '').toString().trim()
  const streamSecondaryAccountId = (j?.config?.ib_client?.account?.event_secondary ?? '').toString().trim()
  const openOrdersList = j?.portfolio?.open_orders ?? []
  const hostOpenOrderCount = streamHostAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamHostAccountId).length
    : openOrdersList.length
  const secondaryOpenOrderCount = streamSecondaryAccountId
    ? openOrdersList.filter(o => (o.account_id ?? '').toString().trim() === streamSecondaryAccountId).length
    : 0

  const hasSecondaryIb = !!(
    j?.config?.ib_client?.client?.secondary_host_ip ?? j?.config?.ib_client?.port?.listener_secondary != null
  )

  const ib = j?.socket?.ib_ingestor
  const aa = j?.socket?.ib_account_agent
  const subscribeChannel = (j?.config?.redis?.subscribe_channel ?? 'ib:ingester:channel').toString()

  const ingLamp = ingestRedisHealthLamp('ib_ingestor', j)
  const aaLamp = ingestRedisHealthLamp('ib_account_agent', j)
  const ingestorMsgRate = useMsgCountRate(j, ib?.msg_count)
  const accountAgentMsgRate = useMsgCountRate(j, aa?.msg_count)
  const tickKeyCount = j?.live_ui?.subscribed_tickers?.length ?? 0
  const headerLamp = rollupSubscribeHeaderLamp(ingLamp, aaLamp)
  const headerTitle =
    headerLamp === 'green'
      ? 'IB Ingestor and Account Agent Redis paths look healthy (see IB services tab).'
      : 'One or more IB stream paths need attention (see IB services tab).'

  const ingTotal = ib?.msg_count
  const aaTotal = aa?.msg_count
  const combinedTotal =
    ingTotal != null && aaTotal != null && Number.isFinite(Number(ingTotal)) && Number.isFinite(Number(aaTotal))
      ? Number(ingTotal) + Number(aaTotal)
      : null
  const combinedRate =
    ingestorMsgRate != null && accountAgentMsgRate != null ? ingestorMsgRate + accountAgentMsgRate : null

  const liveIngAge = useLiveMsgAge(j, ib?.last_msg_age_s)
  const liveAaAge = useLiveMsgAge(j, aa?.last_msg_age_s)

  const aaSecondaryConfigured = aa?.secondary != null && aa.secondary !== undefined
  const hostLabel = streamHostAccountId ? `Host (${streamHostAccountId})` : 'Host'
  const secondaryLabel = streamSecondaryAccountId ? `Secondary (${streamSecondaryAccountId})` : 'Secondary'

  const onReleaseTickers = useCallback(async () => {
    setReleaseTickerLoading(true)
    try {
      const res = await postReleaseTickerSubscriptions()
      if (res.ok) {
        setMsg(setSyncTickerMsg, 'Released; restoring on next heartbeat', false)
        scheduleMsgClear(setSyncTickerMsg, syncTickerMsgClearRef)
        setTimeout(() => loadStatus(), 1500)
      }
      if (!res.ok && res.error) setMsg(setSyncTickerMsg, res.error, true)
    } finally {
      setReleaseTickerLoading(false)
    }
  }, [loadStatus])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await fetchExecutions(undefined, undefined, 20)
        if (cancelled) return
        setExecRows(data.executions ?? [])
        setExecError(null)
      } catch (e) {
        if (!cancelled) {
          setExecRows([])
          setExecError(e instanceof Error ? e.message : 'Failed to load executions')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [j])

  const subscribedTickers = j?.live_ui?.subscribed_tickers ?? []
  const referenceIndices = j?.live_ui?.reference_indices ?? []

  const positionFilterAccountIds = new Set<string>()
  if (streamHostAccountId) positionFilterAccountIds.add(streamHostAccountId)
  if (hasSecondaryIb && streamSecondaryAccountId) positionFilterAccountIds.add(streamSecondaryAccountId)

  const positionRows: { accountId: string; p: IbPositionRow }[] = []
  for (const acc of j?.portfolio?.accounts ?? []) {
    const aid = (acc.account_id ?? '').toString().trim()
    if (positionFilterAccountIds.size > 0 && aid && !positionFilterAccountIds.has(aid)) continue
    for (const p of acc.positions ?? []) {
      positionRows.push({ accountId: aid || (p.account ?? '').toString(), p })
    }
  }
  const showPositionAccountColumn = positionFilterAccountIds.size === 0

  const quoteTickCountLabel = tickKeyCount > 0 ? String(tickKeyCount) : '—'

  return (
    <div className="status-panel-section card-event-subscribe event-subscribe-section">
      <div className="event-subscribe-header-row">
        <h2 className={cn(w9.daemonCardTitle, 'inline-flex', 'flex-wrap', 'items-center', 'gap-2', 'm-0')}>
          <StreamHealthLamp lamp={headerLamp} title={headerTitle} />
          IB Event Subscribe
          <InfoTooltip text="Market and account-domain data reach the stack via Redis: IB Ingestor (quotes notify + tick hashes) and IB Account Agent (snapshot + notify)." />
        </h2>
        <div className="event-subscribe-stream-ages" aria-label="Stream last activity">
          {liveIngAge != null && (
            <span
              className={`event-subscribe-age-badge ${liveIngAge < 10 ? 'age-fresh' : liveIngAge < 60 ? 'age-recent' : liveIngAge < 300 ? 'age-stale' : 'age-old'}`}
              title={`IB Ingestor last message: ${formatMsgAgeS(liveIngAge)}`}
            >
              {ACTIVITY_LAMP_SVG}
              <span className="event-subscribe-age-label">Ingestor</span>
              <span className="event-subscribe-age-value">{formatMsgAgeS(liveIngAge)}</span>
            </span>
          )}
          {liveAaAge != null && (
            <span
              className={`event-subscribe-age-badge ${liveAaAge < 10 ? 'age-fresh' : liveAaAge < 60 ? 'age-recent' : liveAaAge < 300 ? 'age-stale' : 'age-old'}`}
              title={`IB Account Agent last message: ${formatMsgAgeS(liveAaAge)}`}
            >
              {ACTIVITY_LAMP_SVG}
              <span className="event-subscribe-age-label">Account</span>
              <span className="event-subscribe-age-value">{formatMsgAgeS(liveAaAge)}</span>
            </span>
          )}
        </div>
        <div className="event-subscribe-buttons">
          <button
            type="button"
            className="section-header-icon-btn"
            title="Release all ticker subscriptions; daemon restores on next heartbeat"
            aria-label="Release ticker subscriptions"
            disabled={releaseTickerLoading || !hb?.daemon_alive}
            onClick={onReleaseTickers}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18.84 12.25l1.72-1.71h-.02a3 3 0 0 0-.12-4.26 3 3 0 0 0-4.24-.12l-1.72 1.71" />
              <path d="M5.17 11.75l-1.71 1.71a3 3 0 0 0 .12 4.26 3 3 0 0 0 4.24.12l1.71-1.71" />
              <path d="M8 2v4M2 8h4M16 20v-4M20 16h-4" />
            </svg>
          </button>
        </div>
      </div>
      <p className={cn(w9.sectionHint, 'event-subscribe-page-hint')}>
        Redis stream health from Monitor GET /status (<code className="event-subscribe-inline-code">socket</code>). Ticker
        release is a daemon control action (requires engine running).
        <a href="#settings-ws-connector" className="event-subscribe-socket-link">
          Open Socket services
        </a>
      </p>

      <div className="event-subscribe-body">
        <div className={rl.portfolioTabsWrap}>
          <div className={rl.portfolioTabs} role="tablist" aria-label="Subscribe sections">
            <button
              type="button"
              role="tab"
              id="event-subscribe-tab-data"
              className={`system-tab ${subscribeTab === 'data' ? 'active' : ''}`}
              aria-selected={subscribeTab === 'data'}
              aria-controls="event-subscribe-panel-data"
              onClick={() => setSubscribeTab('data')}
            >
              Snapshot
            </button>
            <button
              type="button"
              role="tab"
              id="event-subscribe-tab-redis"
              className={`system-tab ${subscribeTab === 'redis' ? 'active' : ''}`}
              aria-selected={subscribeTab === 'redis'}
              aria-controls="event-subscribe-panel-redis"
              onClick={() => setSubscribeTab('redis')}
            >
              Redis
            </button>
            <button
              type="button"
              role="tab"
              id="event-subscribe-tab-services"
              className={`system-tab ${subscribeTab === 'services' ? 'active' : ''}`}
              aria-selected={subscribeTab === 'services'}
              aria-controls="event-subscribe-panel-services"
              onClick={() => setSubscribeTab('services')}
            >
              IB services
            </button>
          </div>
        </div>

        <div
          id="event-subscribe-panel-data"
          role="tabpanel"
          aria-labelledby="event-subscribe-tab-data"
          className={w9.systemTabPanel}
          hidden={subscribeTab !== 'data'}
        >
          <h3 className="event-subscribe-subheading event-subscribe-tab-panel-first-heading">Host real-time tickers (daemon)</h3>
          <div className="event-subscribe-ticker-block">
            <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')} style={{ marginBottom: '0.35rem' }}>
              Symbols the engine reports as subscribed (GET /status <code className="event-subscribe-inline-code">live_ui</code>
              ). Pub/sub notify channel:{' '}
              <code className="event-subscribe-inline-code">{subscribeChannel}</code>.
            </p>
            {!hb?.daemon_alive ? (
              <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')} style={{ color: 'var(--color-warning)' }}>
                Engine heartbeat is stale; ticker list may be outdated.
              </p>
            ) : null}
            <p className="event-subscribe-summary-line" style={{ marginTop: '0.5rem' }}>
              <span className="event-subscribe-summary-k">Count</span>
              <span>{tickKeyCount > 0 ? String(tickKeyCount) : '—'}</span>
            </p>
            {subscribedTickers.length > 0 ? (
              <div className="event-subscribe-ticker-chips" aria-label="Subscribed tickers">
                {subscribedTickers.map(sym => (
                  <span key={sym} className="event-subscribe-ticker-chip">
                    {sym}
                  </span>
                ))}
              </div>
            ) : (
              <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>No symbols reported (engine off or no active tick subscriptions).</p>
            )}
            {referenceIndices.length > 0 ? (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <p className="event-subscribe-summary-k" style={{ margin: '0 0 0.25rem' }}>
                  Reference indices
                </p>
                <ul className="event-subscribe-ticker-ref-list">
                  {referenceIndices.map((ri, i) => (
                    <li key={`${ri.symbol}-${i}`}>
                      <code className="event-subscribe-inline-code">{ri.symbol}</code>
                      {ri.label ? ` — ${ri.label}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <h3 className="event-subscribe-subheading">Position snapshot (from DB)</h3>
          <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>
            Synced positions written by the daemon (<code className="event-subscribe-inline-code">account_positions</code>); aligns
            with the account stream pipeline, not raw Redis notify payloads.
            {positionFilterAccountIds.size > 0
              ? ` Filtered to configured event account${positionFilterAccountIds.size > 1 ? 's' : ''}.`
              : ' All accounts shown.'}
          </p>
          {positionRows.length === 0 ? (
            <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>No position rows in this status response.</p>
          ) : (
            <div className="event-subscribe-redis-paths-scroll">
              <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-positions-table')}>
                <thead>
                  <tr>
                    {showPositionAccountColumn && <th scope="col">Account</th>}
                    <th scope="col">Symbol</th>
                    <th scope="col">Sec type</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Contract key</th>
                    <th scope="col">Position updated</th>
                  </tr>
                </thead>
                <tbody>
                  {positionRows.map(({ accountId, p }, idx) => {
                    const ck = (p.contract_key ?? '').toString()
                    return (
                      <tr key={`${accountId}-${ck || p.symbol || 'row'}-${idx}`}>
                        {showPositionAccountColumn && <td>{accountId || '—'}</td>}
                        <td>{p.symbol || '—'}</td>
                        <td>{p.secType || '—'}</td>
                        <td>{fmtNum(p.position)}</td>
                        <td className="event-subscribe-contract-cell" title={ck || undefined}>
                          {ck ? truncateKey(ck) : '—'}
                        </td>
                        <td>{formatPositionUpdated(p.updated_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="event-subscribe-subheading">Open orders</h3>
          <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>Counts from this status response&apos;s portfolio snapshot (not Redis health).</p>
          <table className={cn(w9.tableOperations, 'table-event-subscribe', 'table-event-subscribe-horizontal')}>
            <thead>
              <tr>
                <th className="event-subscribe-col-subscription">Source</th>
                <th className="event-subscribe-col-account">Host account</th>
                {hasSecondaryIb && <th className="event-subscribe-col-account">Secondary account</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="event-subscribe-col-subscription">Open orders</td>
                <td>
                  <div className="event-subscribe-status-cell">
                    <SettingsTitleLamp
                      lamp={(!hb?.daemon_alive ? 'red' : hostOpenOrderCount > 0 ? 'green' : 'none') as LampTone}
                      title="Host open orders"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                      </svg>
                    </SettingsTitleLamp>
                    <span className="event-subscribe-status-text">
                      {hb?.daemon_alive ? (
                        <>
                          <span className={w9.countdownNum}>{hostOpenOrderCount}</span>
                          {' open order'}
                          {hostOpenOrderCount === 1 ? '' : 's'}
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>
                </td>
                {hasSecondaryIb && (
                  <td>
                    <div className="event-subscribe-status-cell">
                      <SettingsTitleLamp
                        lamp={(!hb?.daemon_alive ? 'red' : secondaryOpenOrderCount > 0 ? 'green' : 'none') as LampTone}
                        title="Secondary open orders"
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                        </svg>
                      </SettingsTitleLamp>
                      <span className="event-subscribe-status-text">
                        {hb?.daemon_alive ? (
                          <>
                            <span className={w9.countdownNum}>{secondaryOpenOrderCount}</span>
                            {' open order'}
                            {secondaryOpenOrderCount === 1 ? '' : 's'}
                          </>
                        ) : (
                          '—'
                        )}
                      </span>
                    </div>
                  </td>
                )}
              </tr>
            </tbody>
          </table>

          <h3 className="event-subscribe-subheading">Recent executions (DB)</h3>
          <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>
            Fill and commission details from the trading API (<code className="event-subscribe-inline-code">GET /executions</code>
            , persisted rows), not live IB socket frames. Refreshes when status is refetched.
          </p>
          {execError ? (
            <div className="msg err" role="alert">
              {execError}
            </div>
          ) : null}
          {execRows.length === 0 && !execError ? (
            <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>No execution rows returned (empty or trading API unavailable).</p>
          ) : null}
          {execRows.length > 0 ? (
            <div className="event-subscribe-redis-paths-scroll">
              <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-executions-table')}>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Account</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Side</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Price</th>
                    <th scope="col">Commission</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {execRows.map((ex, i) => (
                    <tr key={ex.account_executions_id != null ? `e-${ex.account_executions_id}` : `e-${i}-${ex.exec_id}-${ex.time}`}>
                      <td>{formatExecutionTime(ex)}</td>
                      <td>{ex.account_id ?? '—'}</td>
                      <td>{ex.symbol ?? '—'}</td>
                      <td>{ex.side ?? '—'}</td>
                      <td>{fmtNum(ex.quantity)}</td>
                      <td>{fmtDecimal(ex.price, 4)}</td>
                      <td>{fmtDecimal(ex.commission, 2)}</td>
                      <td>{ex.source ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div
          id="event-subscribe-panel-redis"
          role="tabpanel"
          aria-labelledby="event-subscribe-tab-redis"
          className={w9.systemTabPanel}
          hidden={subscribeTab !== 'redis'}
        >
          <h3 className="event-subscribe-subheading event-subscribe-tab-panel-first-heading">Redis paths</h3>
          <p className={cn(w9.sectionHint, 'event-subscribe-redis-paths-hint')}>
            Total = health hash <code className="event-subscribe-inline-code">msg_count</code> where available. Quote notify / tick
            payload <strong>Count</strong> matches daemon tick keys (<code className="event-subscribe-inline-code">live_ui.subscribed_tickers</code>
            ). Msg/s is estimated from consecutive status polls (often ~2s); idle streams show{' '}
            <code className="event-subscribe-inline-code">0/s</code>. Redis key cells show one line (hover for full key).
          </p>
          <div className="event-subscribe-redis-paths-scroll">
            <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-redis-paths-table')}>
              <colgroup>
                <col className="event-subscribe-redis-col-path" />
                <col className="event-subscribe-redis-col-key" />
                <col className="event-subscribe-redis-col-metric" />
                <col className="event-subscribe-redis-col-metric" />
                <col className="event-subscribe-redis-col-metric" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Redis key</th>
                  <th scope="col">Total</th>
                  <th scope="col">Count</th>
                  <th scope="col">Msg/s</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" title="Ingestor health (Redis hash)">
                    Ingestor health
                  </th>
                  <RedisKeyCell label="bifrost:health:ws_ib_ingestor" />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(ingTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(ingestorMsgRate)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Quote notify (pub/sub channel)">
                    Quote notify
                  </th>
                  <RedisKeyCell label={subscribeChannel} />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(ingTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{quoteTickCountLabel}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(ingestorMsgRate)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Per-contract tick hash keys">
                    Tick payload
                  </th>
                  <RedisKeyCell label="ib:ingester:tick:{contract_key}" />
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{quoteTickCountLabel}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                </tr>
                <tr>
                  <th scope="row" title="Account agent health (Redis hash)">
                    Account agent health
                  </th>
                  <RedisKeyCell label="bifrost:health:ws_ib_account_agent" />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(aaTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(accountAgentMsgRate)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Account snapshot JSON key">
                    Account snapshot
                  </th>
                  <RedisKeyCell label="ib:account:snapshot:v1" />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(aaTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(accountAgentMsgRate)}</td>
                </tr>
                <tr>
                  <th scope="row" title="Account notify (pub/sub)">
                    Account notify
                  </th>
                  <RedisKeyCell label="ib:account:notify" />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(aaTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(accountAgentMsgRate)}</td>
                </tr>
                <tr className="event-subscribe-redis-paths-total-row">
                  <th scope="row" title="Sum of ingestor + account agent health counters">
                    Combined (health counters)
                  </th>
                  <RedisKeyCell label="—" />
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtNum(combinedTotal)}</td>
                  <td className="event-subscribe-redis-paths-metric-cell">—</td>
                  <td className="event-subscribe-redis-paths-metric-cell">{fmtMsgPerSec(combinedRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="event-subscribe-subheading">Ingestor data flow (Redis)</h3>
          <details className="event-subscribe-dataflow">
            <summary>Data flow (Redis)</summary>
            <ul className="event-subscribe-dataflow-list">
              <li>
                Health hash: <code className="event-subscribe-inline-code">bifrost:health:ws_ib_ingestor</code>
              </li>
              <li>
                Quote notify (pub/sub): <code className="event-subscribe-inline-code">{subscribeChannel}</code> (from Monitor
                config; default <code className="event-subscribe-inline-code">ib:ingester:channel</code>)
              </li>
              <li>
                Full tick payload: <code className="event-subscribe-inline-code">ib:ingester:tick:{'{contract_key}'}</code>
              </li>
            </ul>
          </details>

          <h3 className="event-subscribe-subheading">Account agent data flow (Redis)</h3>
          <details className="event-subscribe-dataflow">
            <summary>Data flow (Redis)</summary>
            <ul className="event-subscribe-dataflow-list">
              <li>
                Health hash: <code className="event-subscribe-inline-code">bifrost:health:ws_ib_account_agent</code>
              </li>
              <li>
                Account snapshot JSON: <code className="event-subscribe-inline-code">ib:account:snapshot:v1</code>
              </li>
              <li>
                Notify channel: <code className="event-subscribe-inline-code">ib:account:notify</code>
              </li>
            </ul>
          </details>
        </div>

        <div
          id="event-subscribe-panel-services"
          role="tabpanel"
          aria-labelledby="event-subscribe-tab-services"
          className={w9.systemTabPanel}
          hidden={subscribeTab !== 'services'}
        >
          <h3 className="event-subscribe-subheading event-subscribe-tab-panel-first-heading">Summary</h3>
          <div className="event-subscribe-summary-grid" role="group" aria-label="IB stream summary">
            <div className="event-subscribe-summary-card">
              <div className="event-subscribe-summary-card-head">
                <StreamHealthLamp lamp={ingestLampToBrokerRowLamp(ingLamp.lamp)} title={ingLamp.title} />
                <span className="event-subscribe-summary-label">IB Ingestor</span>
                {liveIngAge != null && (
                  <span className={`event-subscribe-age-badge event-subscribe-age-badge-inline ${liveIngAge < 10 ? 'age-fresh' : liveIngAge < 60 ? 'age-recent' : liveIngAge < 300 ? 'age-stale' : 'age-old'}`}>
                    {formatMsgAgeS(liveIngAge)}
                  </span>
                )}
              </div>
              <p className="event-subscribe-summary-meta">{ingLamp.title}</p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Last activity</span>
                <span>{liveIngAge != null ? formatMsgAgeS(liveIngAge) : formatMsgAgeS(ib?.last_msg_age_s)}</span>
              </p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Health msg total</span>
                <span>{fmtNum(ib?.msg_count)}</span>
              </p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Health msg rate</span>
                <span>{fmtMsgPerSec(ingestorMsgRate)}</span>
              </p>
            </div>
            <div className="event-subscribe-summary-card">
              <div className="event-subscribe-summary-card-head">
                <StreamHealthLamp lamp={ingestLampToBrokerRowLamp(aaLamp.lamp)} title={aaLamp.title} />
                <span className="event-subscribe-summary-label">IB Account Agent</span>
                {liveAaAge != null && (
                  <span className={`event-subscribe-age-badge event-subscribe-age-badge-inline ${liveAaAge < 10 ? 'age-fresh' : liveAaAge < 60 ? 'age-recent' : liveAaAge < 300 ? 'age-stale' : 'age-old'}`}>
                    {formatMsgAgeS(liveAaAge)}
                  </span>
                )}
              </div>
              <p className="event-subscribe-summary-meta">{aaLamp.title}</p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Last activity (agent-wide)</span>
                <span>{liveAaAge != null ? formatMsgAgeS(liveAaAge) : formatMsgAgeS(aa?.last_msg_age_s)}</span>
              </p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Health msg total</span>
                <span>{fmtNum(aa?.msg_count)}</span>
              </p>
              <p className="event-subscribe-summary-line">
                <span className="event-subscribe-summary-k">Health msg rate</span>
                <span>{fmtMsgPerSec(accountAgentMsgRate)}</span>
              </p>
            </div>
          </div>

          <h3 className="event-subscribe-subheading">IB Ingestor</h3>
          <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-metric-table')}>
            <tbody>
              <tr>
                <th scope="row">IB API connected</th>
                <td>{fmtConnected(ib?.connected)}</td>
              </tr>
              <tr>
                <th scope="row">Last message age</th>
                <td>{liveIngAge != null ? formatMsgAgeS(liveIngAge) : formatMsgAgeS(ib?.last_msg_age_s)}</td>
              </tr>
              <tr>
                <th scope="row">Message count (health)</th>
                <td>{fmtNum(ib?.msg_count)}</td>
              </tr>
              <tr>
                <th scope="row">Reconnects</th>
                <td>{fmtNum(ib?.reconnects)}</td>
              </tr>
              <tr>
                <th scope="row">Client ID</th>
                <td>{fmtNum(ib?.client_id)}</td>
              </tr>
            </tbody>
          </table>

          <h3 className="event-subscribe-subheading">IB Account Agent</h3>
          <p className={cn(w9.sectionHint, 'event-subscribe-agent-wide-hint')}>
            Agent-wide metrics are a single Redis health hash (combined across accounts). Per-account rows show connection slots
            only.
          </p>
          <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-metric-table')}>
            <tbody>
              <tr>
                <th scope="row">Process in service</th>
                <td>{fmtProcessInService(aa)}</td>
              </tr>
              <tr>
                <th scope="row">Last message age (agent-wide)</th>
                <td>{liveAaAge != null ? formatMsgAgeS(liveAaAge) : formatMsgAgeS(aa?.last_msg_age_s)}</td>
              </tr>
              <tr>
                <th scope="row">Message count (combined)</th>
                <td>{fmtNum(aa?.msg_count)}</td>
              </tr>
              <tr>
                <th scope="row">Reconnects (health)</th>
                <td>{fmtNum(aa?.reconnects)}</td>
              </tr>
            </tbody>
          </table>

          <table className={cn(w9.tableOperations, 'table-event-subscribe', 'event-subscribe-slots-table')}>
            <thead>
              <tr>
                <th scope="col">Slot</th>
                <th scope="col">IB connected</th>
                <th scope="col">Client ID</th>
                <th scope="col">Reconnects</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{hostLabel}</th>
                <td>{fmtConnected(aa?.host?.connected ?? aa?.connected)}</td>
                <td>{fmtNum(aa?.host?.client_id ?? aa?.client_id)}</td>
                <td>{fmtNum(aa?.host?.reconnects ?? aa?.reconnects)}</td>
              </tr>
              <tr>
                <th scope="row">{secondaryLabel}</th>
                <td>
                  {aaSecondaryConfigured ? fmtConnected(aa?.secondary?.connected) : hasSecondaryIb ? '—' : 'Not configured'}
                </td>
                <td>{aaSecondaryConfigured ? fmtNum(aa?.secondary?.client_id) : '—'}</td>
                <td>{aaSecondaryConfigured ? fmtNum(aa?.secondary?.reconnects) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {syncTickerMsg.text ? (
          <div className={`msg ${syncTickerMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
            {syncTickerMsg.text}
          </div>
        ) : null}
        {hb?.last_control_message ? (
          <div className="msg err" style={{ marginTop: '0.5rem' }} role="alert">
            {hb.last_control_message}
          </div>
        ) : null}
      </div>
    </div>
  )
}
