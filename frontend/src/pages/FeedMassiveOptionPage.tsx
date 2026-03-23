import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveStatus,
  postMassiveSync,
  fetchMassiveJobsList,
  subscribeMassiveJobEvents,
  fetchOptionSnapshotsPg,
  fetchCorporateActions,
  fetchOptionExpirations,
  fetchResearchOptionOi,
  fetchResearchOptionTrades,
} from '../api'
import type { MassiveStatusResponse, MassiveJobApiRow, OptionSnapshotRow, CorporateActionRow } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtTs } from '../utils/format'
import checklistRows from './massiveFeedChecklistRows'
import type { ChecklistRow } from './massiveFeedChecklistRows'
import { feedMassiveSvcAnchorId } from './massive/feedMassiveAnchors'
import {
  checklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus,
  shortServiceLabel,
  tierOkForRow,
  tradesOkForRow,
} from './massive/massiveChecklistStatus'
import { FeedMassiveServiceBlock } from './massive/FeedMassiveServiceBlock'
import type { EffectiveServiceStatus } from './massive/FeedMassiveServiceBlock'
import {
  parseFeedMassiveSvcFromHash,
  parseFeedMassiveTabFromHash,
} from './massive/feedMassiveTabUtils'

const WS_VERIFY_CMD = 'python scripts/verify_massive_options_ws.py --config config/config.dev.yaml'

function checklistRowById(id: string): ChecklistRow {
  const r = checklistRows.find(x => x.id === id)
  if (!r) throw new Error(`checklist row ${id}`)
  return r
}

function latestJobForKind(jobs: MassiveJobApiRow[], kind: string): MassiveJobApiRow | undefined {
  const k = kind.toLowerCase()
  return jobs.find(j => (j.kind || '').toLowerCase() === k)
}

function jobEvidenceLine(j: MassiveJobApiRow | undefined): string {
  if (!j) return 'No recent job of this kind in the list (refresh Job queue).'
  return `Last job #${j.job_id}: ${j.status ?? '—'} — ${fmtJobResult(j)}`
}

interface FeedMassiveOptionPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  onGoToFeed?: () => void
  breadcrumbLabel?: string
}

function fmtJobResult(j: MassiveJobApiRow): string {
  const r = j.result as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return '—'
  const err = r.error
  if (typeof err === 'string') return err
  if (r.rows_written != null) return `rows ${String(r.rows_written)}`
  if (r.rows_upserted != null) return `upserted ${String(r.rows_upserted)}`
  if (r.bars_upserted != null) return `bars ${String(r.bars_upserted)}`
  if (r.message != null) return String(r.message)
  return '—'
}

function jobStatusBadgeClass(st: string | undefined): string {
  const s = (st || '').toLowerCase()
  if (s === 'done') return 'feed-massive-badge feed-massive-badge--done'
  if (s === 'failed') return 'feed-massive-badge feed-massive-badge--fail'
  if (s === 'running') return 'feed-massive-badge feed-massive-badge--run'
  return 'feed-massive-badge feed-massive-badge--pending'
}

function feedMassiveOverviewDotClass(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
}

function CardIconSnapshot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l9 4.5v9L12 21l-9-4.5v-9L12 3z" />
      <path d="M12 12l9-4.5M12 12v9M12 12L3 7.5" />
    </svg>
  )
}

function CardIconBars() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

function CardIconOi() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}

function CardIconCorpAction() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 7V5a4 4 0 0 0-8 0v2" />
    </svg>
  )
}

function CardIconJobs() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function CardIconVerify() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

/** Massive option sync: Celery jobs, PostgreSQL snapshots (delayed chain data). */
export function FeedMassiveOptionPage({
  status: _status,
  onGoToScreener,
  onGoToFeed,
  breadcrumbLabel = 'Massive Option',
}: FeedMassiveOptionPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [jobs, setJobs] = useState<MassiveJobApiRow[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsError, setJobsError] = useState<string | null>(null)
  /** Which capability section is focused after chip click or hash deep-link (border highlight). */
  const [highlightedCapabilityId, setHighlightedCapabilityId] = useState<string | null>(null)

  const [snapSymbol, setSnapSymbol] = useState('NVDA')
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapErr, setSnapErr] = useState<string | null>(null)

  const [aggTicker, setAggTicker] = useState('')
  const [aggSymbol, setAggSymbol] = useState('')
  const [aggExpiry, setAggExpiry] = useState('')
  const [aggStrike, setAggStrike] = useState('')
  const [aggRight, setAggRight] = useState<'C' | 'P'>('C')
  const [aggStartMs, setAggStartMs] = useState('')
  const [aggEndMs, setAggEndMs] = useState('')
  const [aggTimespan, setAggTimespan] = useState('minute')
  const [aggMult, setAggMult] = useState('1')
  const [aggBusy, setAggBusy] = useState(false)
  const [aggErr, setAggErr] = useState<string | null>(null)

  const [oiBusy, setOiBusy] = useState(false)
  const [oiErr, setOiErr] = useState<string | null>(null)

  const [corpSymbol, setCorpSymbol] = useState('AAPL')
  const [corpBusy, setCorpBusy] = useState(false)
  const [corpErr, setCorpErr] = useState<string | null>(null)
  const [corpRows, setCorpRows] = useState<CorporateActionRow[]>([])
  const [corpDbLoading, setCorpDbLoading] = useState(false)

  const [verifySymbol, setVerifySymbol] = useState('')
  const [verifyExp, setVerifyExp] = useState('')
  const [verifyStrikes, setVerifyStrikes] = useState('')
  const [verifyRows, setVerifyRows] = useState<OptionSnapshotRow[]>([])
  const [verifyUnderlying, setVerifyUnderlying] = useState<number | undefined>(undefined)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyErr, setVerifyErr] = useState<string | null>(null)

  const [refSymbol, setRefSymbol] = useState('NVDA')
  const [refTestBusy, setRefTestBusy] = useState(false)
  const [refTestMsg, setRefTestMsg] = useState<string | null>(null)

  const [tradeSym, setTradeSym] = useState('NVDA')
  const [tradeCheckBusy, setTradeCheckBusy] = useState(false)
  const [tradeCheckMsg, setTradeCheckMsg] = useState<string | null>(null)

  const [oiFetchSym, setOiFetchSym] = useState('NVDA')
  const [oiFetchBusy, setOiFetchBusy] = useState(false)
  const [oiFetchMsg, setOiFetchMsg] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    setJobsLoading(true)
    setJobsError(null)
    try {
      const res = await fetchMassiveJobsList({ limit: 40 })
      if (!res.ok) {
        setJobsError(res.error ?? 'Failed to load jobs')
        setJobs([])
        return
      }
      setJobs(res.jobs)
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : 'Failed to load jobs')
      setJobs([])
    } finally {
      setJobsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => {
        if (!cancelled) setMassiveStatus(s)
      })
      .catch(() => {
        if (!cancelled) setMassiveStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    const el = document.getElementById(feedMassiveSvcAnchorId(id))
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      const next = `${window.location.pathname}${window.location.search}#${feedMassiveSvcAnchorId(id)}`
      window.history.replaceState(null, '', next)
    }
  }, [])

  useEffect(() => {
    const resolveIdFromHash = (hash: string): string | null => {
      const fromTab = parseFeedMassiveTabFromHash(hash)
      if (fromTab && checklistRows.some(r => r.id === fromTab)) return fromTab
      const fromSvc = parseFeedMassiveSvcFromHash(hash)
      if (fromSvc && checklistRows.some(r => r.id === fromSvc)) return fromSvc
      return null
    }
    const onHashChange = () => {
      const id = resolveIdFromHash(window.location.hash)
      if (id) scrollToSection(id)
      else setHighlightedCapabilityId(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [scrollToSection])

  useEffect(() => {
    const id =
      parseFeedMassiveTabFromHash(window.location.hash) ??
      parseFeedMassiveSvcFromHash(window.location.hash)
    if (id && checklistRows.some(r => r.id === id)) {
      requestAnimationFrame(() => scrollToSection(id))
    }
  }, [scrollToSection])

  const runRefExpirationsTest = useCallback(async () => {
    const sym = refSymbol.trim().toUpperCase()
    if (!sym) {
      setRefTestMsg('Symbol required')
      return
    }
    setRefTestBusy(true)
    setRefTestMsg(null)
    try {
      const r = await fetchOptionExpirations(sym, 'massive')
      if (r.error) setRefTestMsg(r.error)
      else {
        setRefTestMsg(
          `OK: ${r.expirations.length} expirations${r.strikes?.length ? `, ${r.strikes.length} strikes` : ''}.`,
        )
      }
    } catch (err) {
      setRefTestMsg(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setRefTestBusy(false)
    }
  }, [refSymbol])

  const runGreeksSample = useCallback(async () => {
    setVerifyErr(null)
    setVerifyLoading(true)
    try {
      const ex = await fetchOptionExpirations('NVDA', 'massive')
      const raw = ex.expirations[0]
      if (!raw || ex.error) {
        setVerifyErr(ex.error ?? 'No expirations from Massive')
        setVerifyRows([])
        return
      }
      const expNorm = raw.length >= 8 ? raw.replace(/-/g, '').slice(0, 8) : raw
      setVerifySymbol('NVDA')
      setVerifyExp(expNorm)
      const res = await fetchOptionSnapshotsPg('NVDA', expNorm, undefined, 'massive')
      setVerifyRows(res.rows)
      setVerifyUnderlying(res.underlying_price)
      if (res.error) setVerifyErr(res.error)
    } catch (err) {
      setVerifyErr(err instanceof Error ? err.message : 'Failed')
      setVerifyRows([])
    } finally {
      setVerifyLoading(false)
    }
  }, [])

  const runTradeApiCheck = useCallback(async () => {
    const s = tradeSym.trim().toUpperCase()
    if (!s) {
      setTradeCheckMsg('Symbol required')
      return
    }
    setTradeCheckBusy(true)
    setTradeCheckMsg(null)
    try {
      const r = await fetchResearchOptionTrades(s, { limit: 5 })
      if (r.status === 403) {
        setTradeCheckMsg(r.message ?? 'HTTP 403 — trades disabled (expected on Starter or when trades_enabled is off).')
      } else if (!r.ok) {
        setTradeCheckMsg(r.error ?? r.message ?? 'Request failed')
      } else {
        setTradeCheckMsg(`HTTP ${r.status}: ${r.trades.length} trade row(s) returned.`)
      }
    } catch (err) {
      setTradeCheckMsg(err instanceof Error ? err.message : 'Failed')
    } finally {
      setTradeCheckBusy(false)
    }
  }, [tradeSym])

  const runOiApiFetch = useCallback(async () => {
    const s = oiFetchSym.trim().toUpperCase()
    if (!s) {
      setOiFetchMsg('Symbol required')
      return
    }
    setOiFetchBusy(true)
    setOiFetchMsg(null)
    try {
      const r = await fetchResearchOptionOi(s, { limit: 5 })
      if (r.error) setOiFetchMsg(r.error)
      else setOiFetchMsg(`OK: ${r.rows.length} row(s) from GET /research/option-oi.`)
    } catch (err) {
      setOiFetchMsg(err instanceof Error ? err.message : 'Failed')
    } finally {
      setOiFetchBusy(false)
    }
  }, [oiFetchSym])

  const copyWsCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(WS_VERIFY_CMD)
    } catch {
      /* ignore */
    }
  }, [])

  const trackJob = useCallback((jobId: string, onDone: () => void) => {
    const sub = subscribeMassiveJobEvents(
      jobId,
      ev => {
        if (!ev.ok) {
          onDone()
          return
        }
        const st = ev.job?.status
        if (st === 'done' || st === 'failed') {
          onDone()
        }
      },
      { timeoutSec: 240 },
    )
    return sub
  }, [])

  const runSnapshot = useCallback(async () => {
    const u = snapSymbol.trim().toUpperCase()
    if (!u) {
      setSnapErr('Underlying symbol required')
      return
    }
    setSnapErr(null)
    setSnapBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { underlying: u })
      if (!res.ok) {
        setSnapErr(res.error ?? res.message ?? 'Enqueue failed')
        setSnapBusy(false)
        return
      }
      if (!res.job_id) {
        setSnapErr('No job_id')
        setSnapBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setSnapBusy(false)
        loadJobs()
      })
    } catch (e) {
      setSnapErr(e instanceof Error ? e.message : 'Failed')
      setSnapBusy(false)
    }
  }, [snapSymbol, loadJobs, trackJob])

  const runAggregates = useCallback(async () => {
    setAggErr(null)
    setAggBusy(true)
    try {
      const payload: Record<string, unknown> = {
        options_ticker: aggTicker.trim(),
        symbol: aggSymbol.trim().toUpperCase(),
        expiry: aggExpiry.trim(),
        strike: parseFloat(aggStrike),
        option_right: aggRight,
        timespan: aggTimespan.trim() || 'minute',
        multiplier: parseInt(aggMult, 10) || 1,
        start_ms: parseInt(aggStartMs, 10),
        end_ms: parseInt(aggEndMs, 10),
      }
      const res = await postMassiveSync('aggregates', payload)
      if (!res.ok) {
        setAggErr(res.error ?? res.message ?? 'Enqueue failed')
        setAggBusy(false)
        return
      }
      if (!res.job_id) {
        setAggErr('No job_id')
        setAggBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setAggBusy(false)
        loadJobs()
      })
    } catch (e) {
      setAggErr(e instanceof Error ? e.message : 'Failed')
      setAggBusy(false)
    }
  }, [
    aggTicker,
    aggSymbol,
    aggExpiry,
    aggStrike,
    aggRight,
    aggTimespan,
    aggMult,
    aggStartMs,
    aggEndMs,
    loadJobs,
    trackJob,
  ])

  const runOi = useCallback(async () => {
    setOiErr(null)
    setOiBusy(true)
    try {
      const res = await postMassiveSync('oi', {})
      if (!res.ok) {
        setOiErr(res.error ?? res.message ?? 'Enqueue failed')
        setOiBusy(false)
        return
      }
      if (!res.job_id) {
        setOiErr('No job_id')
        setOiBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setOiBusy(false)
        loadJobs()
      })
    } catch (e) {
      setOiErr(e instanceof Error ? e.message : 'Failed')
      setOiBusy(false)
    }
  }, [loadJobs, trackJob])

  const runCorpAction = useCallback(async () => {
    const sym = corpSymbol.trim().toUpperCase()
    if (!sym) { setCorpErr('Symbol required'); return }
    setCorpErr(null)
    setCorpBusy(true)
    try {
      const res = await postMassiveSync('corporate_action', { symbol: sym })
      if (!res.ok) {
        setCorpErr(res.error ?? res.message ?? 'Enqueue failed')
        setCorpBusy(false)
        return
      }
      if (!res.job_id) {
        setCorpErr('No job_id')
        setCorpBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setCorpBusy(false)
        loadJobs()
      })
    } catch (e) {
      setCorpErr(e instanceof Error ? e.message : 'Failed')
      setCorpBusy(false)
    }
  }, [corpSymbol, loadJobs, trackJob])

  const loadCorpFromDb = useCallback(async () => {
    const sym = corpSymbol.trim().toUpperCase()
    if (!sym) { setCorpErr('Symbol required'); return }
    setCorpDbLoading(true)
    setCorpErr(null)
    try {
      const res = await fetchCorporateActions(sym, { limit: 50 })
      if (!res.ok) { setCorpErr(res.error ?? 'Load failed'); setCorpRows([]); return }
      setCorpRows(res.rows)
    } catch (e) {
      setCorpErr(e instanceof Error ? e.message : 'Load failed')
      setCorpRows([])
    } finally {
      setCorpDbLoading(false)
    }
  }, [corpSymbol])

  const runVerify = useCallback(async () => {
    const s = verifySymbol.trim().toUpperCase()
    const e = verifyExp.trim()
    if (!s || !e) {
      setVerifyErr('Symbol and expiration required')
      return
    }
    setVerifyErr(null)
    setVerifyLoading(true)
    try {
      const res = await fetchOptionSnapshotsPg(s, e, verifyStrikes.trim() || undefined, 'massive')
      setVerifyRows(res.rows)
      setVerifyUnderlying(res.underlying_price)
      if (res.error) setVerifyErr(res.error)
    } catch (err) {
      setVerifyErr(err instanceof Error ? err.message : 'Load failed')
      setVerifyRows([])
    } finally {
      setVerifyLoading(false)
    }
  }, [verifySymbol, verifyExp, verifyStrikes])

  const configured = massiveStatus?.configured

  const rRef = checklistRowById('reference')
  const effRef = effectiveChecklistProjectStatus(
    rRef,
    Boolean(configured),
    tierOkForRow(rRef, massiveStatus, Boolean(configured)),
    tradesOkForRow(rRef, massiveStatus),
  )
  const rSnap = checklistRowById('snapshot')
  const effSnap = effectiveChecklistProjectStatus(
    rSnap,
    Boolean(configured),
    tierOkForRow(rSnap, massiveStatus, Boolean(configured)),
    tradesOkForRow(rSnap, massiveStatus),
  )
  const rAgg = checklistRowById('aggregates')
  const effAgg = effectiveChecklistProjectStatus(
    rAgg,
    Boolean(configured),
    tierOkForRow(rAgg, massiveStatus, Boolean(configured)),
    tradesOkForRow(rAgg, massiveStatus),
  )
  const rGk = checklistRowById('greeks-iv')
  const effGk = effectiveChecklistProjectStatus(
    rGk,
    Boolean(configured),
    tierOkForRow(rGk, massiveStatus, Boolean(configured)),
    tradesOkForRow(rGk, massiveStatus),
  )
  const rOi = checklistRowById('daily-oi')
  const effOi = effectiveChecklistProjectStatus(
    rOi,
    Boolean(configured),
    tierOkForRow(rOi, massiveStatus, Boolean(configured)),
    tradesOkForRow(rOi, massiveStatus),
  )
  const rTr = checklistRowById('trades')
  const effTr = effectiveChecklistProjectStatus(
    rTr,
    Boolean(configured),
    tierOkForRow(rTr, massiveStatus, Boolean(configured)),
    tradesOkForRow(rTr, massiveStatus),
  )
  const rCorp = checklistRowById('corporate-actions')
  const effCorp = effectiveChecklistProjectStatus(
    rCorp,
    Boolean(configured),
    tierOkForRow(rCorp, massiveStatus, Boolean(configured)),
    tradesOkForRow(rCorp, massiveStatus),
  )
  const rWs = checklistRowById('websocket')
  const effWs = effectiveChecklistProjectStatus(
    rWs,
    Boolean(configured),
    tierOkForRow(rWs, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWs, massiveStatus),
  )
  const rCel = checklistRowById('celery-queue')
  const effCel = effectiveChecklistProjectStatus(
    rCel,
    Boolean(configured),
    tierOkForRow(rCel, massiveStatus, Boolean(configured)),
    tradesOkForRow(rCel, massiveStatus),
  )

  const greeksEvidence =
    verifyRows.length === 0
      ? 'No rows loaded. Use Test → Load sample or enter Symbol / Expiration in Verify below.'
      : verifyRows.some(x => x.iv != null || x.delta != null)
        ? 'IV or greeks present in at least one loaded row.'
        : 'Loaded rows have no IV/greeks — provider may omit them for these contracts.'

  const celeryEvidence = (() => {
    const cw = _status?.celery_workers
    if (!cw?.length) {
      return 'No Celery workers reported by status API. Start a worker with -Q massive.'
    }
    return `Status workers: ${cw.join(', ')}`
  })()

  const pendingJobCount = jobs.filter(j => {
    const s = (j.status || '').toLowerCase()
    return s === 'pending' || s === 'running'
  }).length

  const capCardClass = (capId: string) =>
    `feed-massive-card${highlightedCapabilityId === capId ? ' feed-massive-card--cap-active' : ''}`

  return (
    <div className="card process-section feed-massive-option-page">
      <div className="feed-massive-title-block">
        <div className="feed-massive-title-main">
          <h2 className="page-title-with-tooltip" style={{ marginBottom: 0 }}>
            {onGoToFeed ? (
              <>
                <button
                  type="button"
                  className="page-title-breadcrumb-link"
                  onClick={onGoToFeed}
                  aria-label="Go to Feed"
                >
                  Feed
                </button>
                {' / '}
              </>
            ) : onGoToScreener ? (
              <>
                <button
                  type="button"
                  className="page-title-breadcrumb-link"
                  onClick={onGoToScreener}
                  aria-label="Go to Screener"
                >
                  Research
                </button>
                {' / '}
              </>
            ) : null}
            {breadcrumbLabel}{' '}
            <InfoTooltip text="Enqueue Massive REST sync on the Celery `massive` queue; quotes are delayed (tier-dependent). Verify reads latest rows from PostgreSQL option_snapshots (source=massive). Worker implements snapshot, aggregates, and oi placeholder; other kinds may fail until implemented." />
          </h2>
          {configured && (
            <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
              Delayed feed
            </span>
          )}
        </div>
      </div>

      <section className="feed-massive-status-strip" aria-label="Connection status">
        <div className="feed-massive-status-strip-grid">
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">API</span>
            <span className={configured ? 'feed-massive-status-value feed-massive-status-value--ok' : 'feed-massive-status-value feed-massive-status-value--bad'}>
              {configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Tier</span>
            <span className="feed-massive-status-value">{massiveStatus?.tier ?? '—'}</span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Option trades</span>
            <span className="feed-massive-status-value">
              {massiveStatus?.trades_enabled ? 'On' : 'Off'}
            </span>
          </div>
        </div>
        {massiveStatus?.delay_notice ? (
          <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p>
        ) : null}
      </section>

      <nav className="feed-massive-tab-nav-section feed-massive-cap-nav-sticky" aria-label="Massive capabilities">
        <div className="feed-massive-cap-sheet">
          <p className="feed-massive-cap-hint">
            All capabilities are shown below. Click a chip to jump to its section.
            {_status?.celery_workers && _status.celery_workers.length > 0
              ? ''
              : ' No Celery workers detected — start a worker with -Q massive to process sync tasks.'}
          </p>
          <div className="feed-massive-cap-summary">
            {checklistRows.map(row => {
              const tierOk = tierOkForRow(row, massiveStatus, Boolean(configured))
              const tradesOk = tradesOkForRow(row, massiveStatus)
              const eff = effectiveChecklistProjectStatus(row, Boolean(configured), tierOk, tradesOk)
              return (
                <a
                  key={row.id}
                  href={`#${feedMassiveSvcAnchorId(row.id)}`}
                  className={`feed-massive-tab-chip${highlightedCapabilityId === row.id ? ' feed-massive-tab-chip--active' : ''}`}
                  aria-current={highlightedCapabilityId === row.id ? 'location' : undefined}
                  onClick={e => {
                    e.preventDefault()
                    scrollToSection(row.id)
                  }}
                >
                  <span className={feedMassiveOverviewDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
                  <span className="feed-massive-tab-chip-label">{shortServiceLabel(row)}</span>
                  {row.id === 'celery-queue' && pendingJobCount > 0 ? (
                    <span className="feed-massive-tab-badge" title="Pending or running jobs">
                      {pendingJobCount > 99 ? '99+' : pendingJobCount}
                    </span>
                  ) : null}
                </a>
              )
            })}
          </div>
        </div>
      </nav>

      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config.
        </p>
      )}

      <div className="feed-massive-tab-panel">

        {/* 1. Reference / contracts */}
        <section className={capCardClass('reference')} aria-label="Reference contracts">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('reference')}
            effectiveStatus={effRef}
            checklistRow={rRef}
            evidence={refTestMsg ?? (configured ? 'Run Test to fetch expirations via Massive REST.' : 'Configure Massive API key first.')}
            testArea={
              <div className="feed-massive-inline-actions" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Symbol</span>
                  <input
                    className="form-input"
                    value={refSymbol}
                    onChange={e => setRefSymbol(e.target.value)}
                    disabled={refTestBusy || !configured}
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={refTestBusy || !configured}
                  onClick={() => runRefExpirationsTest()}
                >
                  {refTestBusy ? 'Running…' : 'Run expirations test'}
                </button>
                {onGoToScreener ? (
                  <button type="button" className="btn btn-secondary" onClick={onGoToScreener}>
                    Open Option Discovery
                  </button>
                ) : null}
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <h3>Reference / contracts</h3>
            </div>
            <p className="feed-massive-card-lead">
              Massive-backed expirations and strikes (same API as Research → Option Discovery when using Massive).
            </p>
          </FeedMassiveServiceBlock>
        </section>

        {/* 2. Chain snapshot */}
        <section className={capCardClass('snapshot')} aria-label="Underlying snapshot">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('snapshot')}
            effectiveStatus={effSnap}
            checklistRow={rSnap}
            evidence={jobEvidenceLine(latestJobForKind(jobs, 'snapshot'))}
            testArea={
              <div className="feed-massive-inline-actions">
                <label className="feed-massive-field">
                  <span className="form-label">Underlying</span>
                  <input
                    className="form-input"
                    value={snapSymbol}
                    onChange={e => setSnapSymbol(e.target.value)}
                    disabled={snapBusy || !configured}
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={snapBusy || !configured}
                  onClick={() => runSnapshot()}
                >
                  {snapBusy ? 'Running…' : 'Enqueue snapshot'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconSnapshot />
                </span>
                <h3>Chain snapshot</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Pull a full option chain snapshot for one underlying and persist rows into{' '}
              <code style={{ fontSize: '0.85em' }}>option_snapshots</code>.
            </p>
          </FeedMassiveServiceBlock>
          {snapErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {snapErr}
            </p>
          ) : null}
        </section>

        {/* 3. Option aggregates */}
        <section className={capCardClass('aggregates')} aria-label="Option aggregates">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('aggregates')}
            effectiveStatus={effAgg}
            checklistRow={rAgg}
            evidence={jobEvidenceLine(latestJobForKind(jobs, 'aggregates'))}
            testArea={
              <button
                type="button"
                className="btn btn-secondary"
                disabled={aggBusy || !configured}
                onClick={() => runAggregates()}
              >
                {aggBusy ? 'Running…' : 'Enqueue aggregates'}
              </button>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconBars />
                </span>
                <h3>Option aggregates</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Per-contract bars from Massive; requires options ticker and a Unix ms window.
            </p>
          </FeedMassiveServiceBlock>
          <label className="feed-massive-field" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="form-label">Options ticker</span>
            <input
              className="form-input"
              style={{ maxWidth: '100%' }}
              value={aggTicker}
              onChange={e => setAggTicker(e.target.value)}
              disabled={aggBusy || !configured}
              placeholder="O:…"
              autoComplete="off"
            />
          </label>
          <div className="feed-massive-form-grid">
            <label className="feed-massive-field">
              <span className="form-label">Symbol</span>
              <input
                className="form-input"
                value={aggSymbol}
                onChange={e => setAggSymbol(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Expiry</span>
              <input
                className="form-input"
                value={aggExpiry}
                onChange={e => setAggExpiry(e.target.value)}
                disabled={aggBusy || !configured}
                placeholder="YYYYMMDD"
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Strike</span>
              <input
                className="form-input"
                value={aggStrike}
                onChange={e => setAggStrike(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Right</span>
              <select
                className="form-input"
                value={aggRight}
                onChange={e => setAggRight(e.target.value as 'C' | 'P')}
                disabled={aggBusy || !configured}
              >
                <option value="C">Call</option>
                <option value="P">Put</option>
              </select>
            </label>
          </div>
          <div className="feed-massive-form-grid feed-massive-form-grid--wide">
            <label className="feed-massive-field">
              <span className="form-label">Start (ms)</span>
              <input
                className="form-input"
                value={aggStartMs}
                onChange={e => setAggStartMs(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">End (ms)</span>
              <input
                className="form-input"
                value={aggEndMs}
                onChange={e => setAggEndMs(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Timespan</span>
              <input
                className="form-input"
                value={aggTimespan}
                onChange={e => setAggTimespan(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Multiplier</span>
              <input
                className="form-input"
                value={aggMult}
                onChange={e => setAggMult(e.target.value)}
                disabled={aggBusy || !configured}
              />
            </label>
          </div>
          {aggErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {aggErr}
            </p>
          ) : null}
        </section>

        {/* 4. Greeks / IV (moved here to match checklistRows order) */}
        <section className={capCardClass('greeks-iv')} aria-label="Verify from database">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('greeks-iv')}
            effectiveStatus={effGk}
            checklistRow={rGk}
            evidence={greeksEvidence}
            testArea={
              <button type="button" className="btn btn-secondary" disabled={verifyLoading} onClick={() => runGreeksSample()}>
                {verifyLoading ? 'Loading…' : 'Load sample (NVDA)'}
              </button>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconVerify />
                </span>
                <h3>Greeks / IV &amp; verify in PostgreSQL</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Read latest stored Massive snapshot rows; check IV and greeks when the provider returned them. Empty strikes use ATM ladder when daily last exists.
            </p>
          </FeedMassiveServiceBlock>
          <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end' }}>
            <label className="feed-massive-field">
              <span className="form-label">Symbol</span>
              <input
                className="form-input"
                value={verifySymbol}
                onChange={e => setVerifySymbol(e.target.value)}
                disabled={verifyLoading}
                autoComplete="off"
              />
            </label>
            <label className="feed-massive-field">
              <span className="form-label">Expiration</span>
              <input
                className="form-input"
                value={verifyExp}
                onChange={e => setVerifyExp(e.target.value)}
                placeholder="YYYYMMDD"
                disabled={verifyLoading}
              />
            </label>
            <label className="feed-massive-field" style={{ flex: '1 1 12rem', minWidth: '10rem' }}>
              <span className="form-label">Strikes (CSV)</span>
              <input
                className="form-input"
                value={verifyStrikes}
                onChange={e => setVerifyStrikes(e.target.value)}
                disabled={verifyLoading}
                placeholder="Optional"
              />
            </label>
            <button type="button" className="btn btn-primary" disabled={verifyLoading} onClick={() => runVerify()}>
              {verifyLoading ? 'Loading…' : 'Load'}
            </button>
          </div>
          {verifyUnderlying != null ? (
            <div className="feed-massive-verify-meta">
              Underlying (row / fallback): <strong>{verifyUnderlying.toFixed(2)}</strong>
            </div>
          ) : null}
          {verifyErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {verifyErr}
            </p>
          ) : null}
          {verifyRows.length > 0 ? (
            <div className="feed-massive-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Strike</th>
                    <th scope="col">Right</th>
                    <th scope="col">Bid</th>
                    <th scope="col">Ask</th>
                    <th scope="col">Last</th>
                    <th scope="col">Mid</th>
                    <th scope="col">IV</th>
                    <th scope="col">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {verifyRows.map((row, i) => (
                    <tr key={`${row.strike}-${row.right}-${i}`}>
                      <td>{row.strike}</td>
                      <td>{row.right}</td>
                      <td>{row.bid ?? '—'}</td>
                      <td>{row.ask ?? '—'}</td>
                      <td>{row.last ?? '—'}</td>
                      <td>{row.mid ?? '—'}</td>
                      <td>{row.iv != null && Number.isFinite(row.iv) ? row.iv.toFixed(4) : '—'}</td>
                      <td>{row.delta != null && Number.isFinite(row.delta) ? row.delta.toFixed(4) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        {/* 5. Daily open interest */}
        <section className={capCardClass('daily-oi')} aria-label="Open interest">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('daily-oi')}
            effectiveStatus={effOi}
            checklistRow={rOi}
            evidence={oiFetchMsg ?? jobEvidenceLine(latestJobForKind(jobs, 'oi'))}
            testArea={
              <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Symbol</span>
                  <input
                    className="form-input"
                    value={oiFetchSym}
                    onChange={e => setOiFetchSym(e.target.value)}
                    disabled={oiFetchBusy}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn btn-secondary" disabled={oiFetchBusy} onClick={() => runOiApiFetch()}>
                  {oiFetchBusy ? 'Loading…' : 'GET option-oi'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconOi />
                </span>
                <h3>Open interest</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Placeholder job; prefer chain snapshot for OI when available. Use GET option-oi to read stored daily OI rows.
            </p>
          </FeedMassiveServiceBlock>
          <div className="feed-massive-actions-row">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={oiBusy || !configured}
              onClick={() => runOi()}
            >
              {oiBusy ? 'Running…' : 'Enqueue OI job'}
            </button>
          </div>
          {oiErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {oiErr}
            </p>
          ) : null}
        </section>

        {/* 6. Option trades */}
        <section className={capCardClass('trades')} aria-label="Option trades API">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('trades')}
            effectiveStatus={effTr}
            checklistRow={rTr}
            evidence={tradeCheckMsg ?? 'Use Test to call GET /research/option-trades (403 expected when trades are off).'}
            testArea={
              <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Symbol</span>
                  <input
                    className="form-input"
                    value={tradeSym}
                    onChange={e => setTradeSym(e.target.value)}
                    disabled={tradeCheckBusy}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn btn-primary" disabled={tradeCheckBusy} onClick={() => runTradeApiCheck()}>
                  {tradeCheckBusy ? 'Loading…' : 'Check API'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <h3>Option trades</h3>
            </div>
            <p className="feed-massive-card-lead">
              Tick-level trades require Developer tier and trades_enabled. Starter returns 403 by design.
            </p>
          </FeedMassiveServiceBlock>
        </section>

        {/* 7. Corporate actions */}
        <section className={capCardClass('corporate-actions')} aria-label="Corporate actions">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('corporate-actions')}
            effectiveStatus={effCorp}
            checklistRow={rCorp}
            evidence={
              corpRows.length > 0
                ? `${corpRows.length} row(s) loaded from DB for current query. ${jobEvidenceLine(latestJobForKind(jobs, 'corporate_action'))}`
                : jobEvidenceLine(latestJobForKind(jobs, 'corporate_action'))
            }
            testArea={
              <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Underlying</span>
                  <input
                    className="form-input"
                    value={corpSymbol}
                    onChange={e => setCorpSymbol(e.target.value)}
                    disabled={corpBusy || !configured}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn btn-secondary" disabled={corpBusy || !configured} onClick={() => runCorpAction()}>
                  {corpBusy ? 'Running…' : 'Enqueue sync'}
                </button>
                <button type="button" className="btn btn-primary" disabled={corpDbLoading} onClick={() => loadCorpFromDb()}>
                  {corpDbLoading ? 'Loading…' : 'Load from DB'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconCorpAction />
                </span>
                <h3>Corporate actions</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Dividends and stock splits via Massive REST. Enter a stock ticker, sync from API, then load persisted rows from PostgreSQL.
            </p>
          </FeedMassiveServiceBlock>
          {corpErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {corpErr}
            </p>
          ) : null}
          {corpRows.length > 0 ? (
            <div className="feed-massive-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Type</th>
                    <th scope="col">Ex date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Ratio</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {corpRows.map((r, i) => (
                    <tr key={`${r.symbol}-${r.action_type}-${r.ex_date}-${i}`}>
                      <td>{r.symbol}</td>
                      <td><span className={r.action_type === 'dividend' ? 'feed-massive-badge feed-massive-badge--done' : 'feed-massive-badge feed-massive-badge--run'}>{r.action_type}</span></td>
                      <td>{r.ex_date ?? '—'}</td>
                      <td>{r.amount != null ? r.amount.toFixed(4) : '—'}</td>
                      <td>{r.ratio_from != null && r.ratio_to != null ? `${r.ratio_from}:${r.ratio_to}` : '—'}</td>
                      <td style={{ maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description ?? undefined}>
                        {r.description ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        {/* 8. WebSocket streaming */}
        <section className={capCardClass('websocket')} aria-label="WebSocket verification">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('websocket')}
            effectiveStatus={effWs}
            checklistRow={rWs}
            evidence={
              configured
                ? 'API key configured. Proof is via CLI (see Test); browser does not open a WS.'
                : 'Configure Massive API key first.'
            }
            testArea={
              <div>
                <pre className="feed-massive-ws-cmd">{WS_VERIFY_CMD}</pre>
                <button type="button" className="btn btn-secondary" onClick={() => copyWsCommand()}>
                  Copy command
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <h3>WebSocket streaming</h3>
            </div>
            <p className="feed-massive-card-lead">
              Verify connectivity with the standalone script (delayed/real-time host per plan). No persistent bridge in this app.
            </p>
          </FeedMassiveServiceBlock>
        </section>

        {/* 9. Celery massive queue */}
        <section className={capCardClass('celery-queue')} aria-label="Recent jobs">
          <FeedMassiveServiceBlock
            anchorId={feedMassiveSvcAnchorId('celery-queue')}
            effectiveStatus={effCel}
            checklistRow={rCel}
            evidence={celeryEvidence}
            testArea={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => loadJobs()}
                disabled={jobsLoading}
              >
                {jobsLoading ? 'Loading…' : 'Refresh job list'}
              </button>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconJobs />
                </span>
                <h3>Job queue</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Latest Massive sync tasks (newest first).{' '}
              <a href="#feed-celery">See all Celery queues (Feed → Celery)</a>.
            </p>
          </FeedMassiveServiceBlock>
          {jobsError ? (
            <p className="status-page-msg err" role="alert">
              {jobsError}
            </p>
          ) : null}
          <div className="feed-massive-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 && !jobsLoading ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="feed-massive-empty">No jobs yet.</div>
                    </td>
                  </tr>
                ) : (
                  jobs.map(j => (
                    <tr key={j.job_id}>
                      <td>
                        <span className="feed-massive-job-id">{j.job_id}</span>
                      </td>
                      <td>{j.kind ?? '—'}</td>
                      <td>
                        <span className={jobStatusBadgeClass(j.status)}>{j.status ?? '—'}</span>
                      </td>
                      <td>{j.created_ts != null ? fmtTs(j.created_ts) : '—'}</td>
                      <td style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fmtJobResult(j)}>
                        {fmtJobResult(j)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  )
}
