import { useCallback, useEffect, useRef, useState } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import {
  fetchSepaReadinessSummary,
  fetchSepaPriceGaps,
  postSepaGroupedHistoryBackfill,
  postSepaReadinessSnapshot,
  postSepaStockUnifiedSnapshot,
  postSepaPriceGapBackfill,
  postSepaSyncHolidays,
  type SepaReadinessCatalogEntry,
  type SepaReadinessSummaryResponse,
  type SepaPriceGapItem,
  type SepaSnapshotByTypeRow,
  type SepaSyncHolidaysResponse,
} from '../api/research/sepaReadiness'
import { fetchQueueSummary, type QueueSummaryRow } from '../api/ops/ops'
import { formatQueueLabel } from '../utils/celeryQueueLabels'
import {
  MassiveRefJobSessionProvider,
  useMassiveRefJobSession,
} from './massive/MassiveRefJobSessionContext'

export interface SepaDataReadyPageProps {
  onBreadcrumbResearch?: () => void
  breadcrumbLabel?: string
  onOpenCelerySettings?: () => void
  onOpenFeedMassiveStock?: () => void
  onOpenDataCoverageSummary?: () => void
}

function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}

function fmtPct(num: number, denom: number): string {
  if (!denom) return '—'
  return ((num / denom) * 100).toFixed(1) + '%'
}

function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(ms / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  } catch {
    return '—'
  }
}

/** Derive tag type from catalog object name */
function sourceTag(entry: SepaReadinessCatalogEntry): { label: string; cls: string } {
  const obj = entry.object.toLowerCase()
  if (obj.includes('sepa_universe_readiness_daily')) return { label: 'SNAPSHOT', cls: 'sdp-source-tag--snapshot' }
  if (obj.includes('cache_stock_snapshot')) return { label: 'CACHE', cls: 'sdp-source-tag--snapshot' }
  if (obj.startsWith('public.v_') || obj.startsWith('v_')) return { label: 'VIEW', cls: 'sdp-source-tag--view' }
  return { label: 'TABLE', cls: 'sdp-source-tag--table' }
}

/** Split "public.some_table" into [schema, name] for styled display */
function splitObject(obj: string): [string, string] {
  const dot = obj.indexOf('.')
  if (dot === -1) return ['', obj]
  return [obj.slice(0, dot + 1), obj.slice(dot + 1)]
}

// ── Snapshot by-type breakdown (Step 2) ─────────────────────────────────────

function SnapshotByTypeBreakdown({ rows }: { rows: SepaSnapshotByTypeRow[] | null }) {
  if (rows == null) return null
  if (rows.length === 0) {
    return (
      <div className="sdp-step-aside-empty">
        No instrument-type breakdown yet — refresh once to populate{' '}
        <code>cache_stock_snapshot</code>.
      </div>
    )
  }
  const totalSnap = rows.reduce((s, r) => s + (r.snapshot_row_count || 0), 0)
  const totalUni = rows.reduce((s, r) => s + (r.universe_ticker_count || 0), 0)
  return (
    <div className="sdp-step-aside">
      <div className="sdp-step-aside-title">
        Instrument types in <code>cache_stock_snapshot</code>{' '}
        <span className="sdp-step-aside-meta">
          {rows.length} types · {fmt(totalSnap)} snapshot rows · {fmt(totalUni)} universe tickers
        </span>
      </div>
      <div className="sdp-step-aside-table-scroll">
        <table className="sdp-snap-by-type-table">
          <thead>
            <tr>
              <th className="sdp-snap-by-type-code">Code</th>
              <th>Description</th>
              <th className="sdp-snap-by-type-num">Snapshot rows</th>
              <th className="sdp-snap-by-type-num">Universe tickers</th>
              <th className="sdp-snap-by-type-num">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const coverage =
                r.universe_ticker_count > 0
                  ? (r.snapshot_row_count / r.universe_ticker_count) * 100
                  : null
              const lowCoverage = coverage != null && coverage < 90
              return (
                <tr key={r.code}>
                  <td className="sdp-snap-by-type-code">
                    <code>{r.code}</code>
                  </td>
                  <td>{r.description ?? <span className="sdp-step-aside-dim">—</span>}</td>
                  <td className="sdp-snap-by-type-num">{fmt(r.snapshot_row_count)}</td>
                  <td className="sdp-snap-by-type-num sdp-step-aside-dim">
                    {fmt(r.universe_ticker_count)}
                  </td>
                  <td
                    className={`sdp-snap-by-type-num${lowCoverage ? ' sdp-snap-by-type-low' : ''}`}
                  >
                    {coverage == null ? '—' : `${coverage.toFixed(1)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Check Strip ──────────────────────────────────────────────────────────────

type CheckStatus = 'ok' | 'warn' | 'error' | 'loading' | 'unknown'

function StepCheckStrip({
  hasChecked = true,
  loading,
  status,
  primary,
  primaryLabel,
  secondary,
  gap,
  gapUnit,
  target,
  note,
}: {
  hasChecked?: boolean
  loading: boolean
  status: CheckStatus
  primary?: string | null
  primaryLabel?: string
  secondary?: string | null
  gap?: number | null
  gapUnit?: string
  target?: string
  note?: string | null
}) {
  if (!hasChecked) {
    return (
      <div className="sdp-check-strip sdp-check-strip--notchecked">
        <div className="sdp-check-row">
          <span className="sdp-check-dot sdp-check-dot--unknown" />
          <span className="sdp-check-text sdp-check-text--dim">Click Check to verify data readiness</span>
        </div>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="sdp-check-strip sdp-check-strip--loading">
        <span className="sdp-check-dot sdp-check-dot--loading" />
        <span className="sdp-check-text sdp-check-text--dim">Checking…</span>
      </div>
    )
  }
  return (
    <div className={`sdp-check-strip sdp-check-strip--${status}`}>
      <div className="sdp-check-row">
        <span className={`sdp-check-dot sdp-check-dot--${status}`} />
        <span className="sdp-check-primary">
          {primary ?? '—'}
          {primaryLabel && <span className="sdp-check-primary-label">{primaryLabel}</span>}
        </span>
        {secondary && <span className="sdp-check-secondary">{secondary}</span>}
        {gap != null && gap > 0 && (
          <span className={`sdp-check-gap ${status === 'error' ? 'sdp-check-gap--error' : 'sdp-check-gap--warn'}`}>
            Gap: {fmt(gap)} {gapUnit}
          </span>
        )}
        {gap === 0 && (
          <span className="sdp-check-gap sdp-check-gap--ok">No gap</span>
        )}
      </div>
      {(target || note) && (
        <div className="sdp-check-meta">
          {target && <span className="sdp-check-target">Target: {target}</span>}
          {note && <span className="sdp-check-note">{note}</span>}
        </div>
      )}
    </div>
  )
}

// ── Data Source Card ──────────────────────────────────────────────────────────

function DataSourceCard({
  entry,
  variant,
}: {
  entry: SepaReadinessCatalogEntry
  variant: 'raw' | 'computed'
}) {
  const tag = sourceTag(entry)
  const [schema, name] = splitObject(entry.object)
  return (
    <div className={`sdp-source-card sdp-source-card--${variant}`}>
      <div className={`sdp-source-accent sdp-source-accent--${variant}`} />
      <div className="sdp-source-inner">
        <div className="sdp-source-header">
          <div className="sdp-source-object">
            {schema && <span className="sdp-source-schema">{schema}</span>}
            {name}
          </div>
          <span className={`sdp-source-tag ${tag.cls}`}>{tag.label}</span>
        </div>

        <div className="sdp-source-role">{entry.role}</div>

        {entry.typical_ingest && (
          <div className="sdp-source-meta">
            <span className="sdp-source-meta-key">Typical ingest</span>
            <span className="sdp-source-meta-val">{entry.typical_ingest}</span>
          </div>
        )}

        {entry.depends_on && entry.depends_on.length > 0 && (
          <div className="sdp-source-meta">
            <span className="sdp-source-meta-key">Depends on</span>
            <div className="sdp-source-depends">
              {entry.depends_on.map((d) => (
                <span key={d} className="sdp-dep-chip">{d}</span>
              ))}
            </div>
          </div>
        )}

        <div className="sdp-dps-section">
          <div className="sdp-dps-header">Supported data points</div>
          <div className="sdp-dps-list">
            {entry.data_points.map((dp) => (
              <span key={dp} className="sdp-dp">{dp}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Catalog Tabs ──────────────────────────────────────────────────────────────

const CATALOG_TABS = [
  {
    key: 'raw' as const,
    label: 'RAW',
    title: 'Raw data sources',
    description:
      'Tables populated by ingest jobs or writer services. These are the authoritative inputs consumed by readiness views and snapshot logic.',
  },
  {
    key: 'computed' as const,
    label: 'COMPUTED',
    title: 'Computed readiness layers',
    description:
      'Views and snapshot tables derived from raw sources. The KPI metrics below read from this layer. Each entry lists its raw-source dependencies.',
  },
]

function CatalogTabs({ catalog }: { catalog: { raw_sources?: SepaReadinessCatalogEntry[]; computed_layers?: SepaReadinessCatalogEntry[] } }) {
  const [activeTab, setActiveTab] = useState<'raw' | 'computed'>('raw')

  const entries = activeTab === 'raw' ? catalog.raw_sources : catalog.computed_layers
  const meta = CATALOG_TABS.find((t) => t.key === activeTab)!

  return (
    <div className="sdp-catalog-block">
      <div className="sdp-catalog-tabs" role="tablist" aria-label="Data catalog">
        {CATALOG_TABS.map((tab) => {
          const count = (tab.key === 'raw' ? catalog.raw_sources : catalog.computed_layers)?.length ?? 0
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`sdp-catalog-tab sdp-catalog-tab--${tab.key}${activeTab === tab.key ? ' sdp-catalog-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className={`sdp-catalog-badge sdp-catalog-badge--${tab.key}`}>{tab.label}</span>
              <span className="sdp-catalog-tab-title">{tab.title}</span>
              {count > 0 && <span className="sdp-catalog-tab-count">{count}</span>}
            </button>
          )
        })}
      </div>
      <p className="sdp-catalog-desc">{meta.description}</p>
      <div className="sdp-catalog-grid">
        {entries?.map((e) => (
          <DataSourceCard key={e.id} entry={e} variant={activeTab} />
        ))}
      </div>
    </div>
  )
}

// ── Gaps Drawer ───────────────────────────────────────────────────────────────

function buildLlmText(items: SepaPriceGapItem[], totalGapCount: number, checkedAt: string): string {
  const ts = checkedAt ? new Date(checkedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—'

  // Reason breakdown (server-computed reason per symbol)
  const reasonCounts: Record<string, number> = {}
  for (const item of items) {
    const key = item.reason || 'unknown'
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
  }
  const reasonLines = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `  ${n.toLocaleString().padStart(6)}  ${r}`)
    .join('\n')

  // Compact fixed-width table — cap at 200 rows to keep LLM context manageable
  const SHOW = 200
  const sample = items.slice(0, SHOW)
  const fmtPx = (x: number | null | undefined) =>
    x == null || Number.isNaN(x) ? '—' : String(Math.round(x * 10000) / 10000)
  const colW = {
    sym: Math.max(6, ...sample.map(r => r.symbol.length)),
    bars: 4,
    vnd: 10,
    mx: 10,
    l420: 10,
    csd: 10,
    ssn: 10,
  }
  const hdr = [
    'SYMBOL'.padEnd(colW.sym),
    'BARS'.padStart(colW.bars),
    'VENDOR_NY'.padEnd(colW.vnd),
    'MAX_DAILY'.padEnd(colW.mx),
    'LAST420'.padEnd(colW.l420),
    'DAY_CLOSE'.padEnd(colW.csd),
    'SESS_CLOSE'.padEnd(colW.ssn),
    'REASON',
  ].join('  ')
  const sep = '-'.repeat(hdr.length)
  const rows = sample.map(it =>
    [
      it.symbol.padEnd(colW.sym),
      String(it.bar_rows).padStart(colW.bars),
      (it.vendor_day ?? '—').padEnd(colW.vnd),
      (it.last_bar_max_date ?? '—').padEnd(colW.mx),
      (it.last_bar_date ?? '—').padEnd(colW.l420),
      fmtPx(it.last_stock_day_close).padEnd(colW.csd),
      fmtPx(it.session_close).padEnd(colW.ssn),
      it.reason,
    ].join('  ')
  ).join('\n')
  const truncNote = totalGapCount > SHOW
    ? `\n... ${(totalGapCount - SHOW).toLocaleString()} more symbols not shown (total ${totalGapCount.toLocaleString()})`
    : ''

  return `\
==================================================
SEPA Price Gap Report
==================================================
Checked at  : ${ts}
Source      : public.v_sepa_us_equity_universe
              LEFT JOIN public.cache_stock_snapshot (last_minute_updated → NY date)
              LEFT JOIN max(public.stock_day.bar_time) per symbol, source=massive
              LEFT JOIN public.v_sepa_symbol_price_readiness (fallback)
Filter      : require cache row + non-null session_close; (vendor date gap + close mismatch) OR (no last_minute_updated AND NOT price_ready); exclude WARRANT
Total gaps  : ${totalGapCount.toLocaleString()} symbols
Returned    : ${items.length.toLocaleString()} symbols
Note        : LAST420 = last bar in 420d window; MAX_DAILY = all-time max bar date; CLOSE = latest daily close vs cache.session_close

BREAKDOWN BY REASON
--------------------------------------------------
${reasonLines}

TOP ${Math.min(SHOW, items.length)} SYMBOLS (vendor gaps first, then bar_rows asc)
--------------------------------------------------
${hdr}
${sep}
${rows}${truncNote}
==================================================`
}

function copyTextFallback(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    // ignore
  }
  document.body.removeChild(ta)
  return ok
}

interface GapsDrawerProps {
  open: boolean
  onClose: () => void
  priceGap: number | null
  onRunBackfill: () => void
  backfillBusy: boolean
  backfillMsg: string | null
  backfillOk: boolean | null
  onRunBackfillSelected: (symbols: string[]) => void
  backfillSelectedBusy: boolean
  backfillSelectedMsg: string | null
  backfillSelectedOk: boolean | null
}

function GapsDrawer({
  open,
  onClose,
  priceGap,
  onRunBackfill,
  backfillBusy,
  backfillMsg,
  backfillOk,
  onRunBackfillSelected,
  backfillSelectedBusy,
  backfillSelectedMsg,
  backfillSelectedOk,
}: GapsDrawerProps) {
  const [items, setItems] = useState<SepaPriceGapItem[]>([])
  const [totalGapCount, setTotalGapCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set())
  const checkedAtRef = useRef<string>('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setSelectedSymbols(new Set())
    checkedAtRef.current = new Date().toISOString()
    fetchSepaPriceGaps()
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? 'Failed to load gap data')
          return
        }
        setItems(res.items ?? [])
        setTotalGapCount(res.total_gap_count ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => setLoading(false))
  }, [open])

  const filtered = searchQ.trim()
    ? items.filter((it) => it.symbol.toLowerCase().includes(searchQ.trim().toLowerCase()))
    : items

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((it) => selectedSymbols.has(it.symbol))
  const someFilteredSelected = filtered.some((it) => selectedSymbols.has(it.symbol))

  const toggleSymbol = (symbol: string) => {
    setSelectedSymbols((prev) => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  const toggleAllFiltered = () => {
    setSelectedSymbols((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        filtered.forEach((it) => next.delete(it.symbol))
      } else {
        filtered.forEach((it) => next.add(it.symbol))
      }
      return next
    })
  }

  const handleBackfillSelected = () => {
    const syms = Array.from(selectedSymbols)
    if (syms.length === 0) return
    onRunBackfillSelected(syms)
  }

  const handleCopyLlm = async () => {
    const text = buildLlmText(items, totalGapCount ?? items.length, checkedAtRef.current)
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = copyTextFallback(text)
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } else {
      setCopyError(true)
      setTimeout(() => setCopyError(false), 3000)
    }
  }

  const reasonCounts: Record<string, number> = {}
  for (const item of items) {
    const key = item.bar_rows === 0 || item.last_bar_date === null
      ? 'no bars in 420d window'
      : item.bar_rows < 240
      ? 'insufficient bars'
      : item.null_close_rows > 0 || item.null_volume_rows > 0
      ? 'null data'
      : 'stale last bar'
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
  }

  return (
    <>
      {open && <div className="sdp-drawer-backdrop" onClick={onClose} aria-hidden />}
      <aside className={`sdp-drawer${open ? ' sdp-drawer--open' : ''}`} aria-label="Price gap details" role="complementary">
        <div className="sdp-drawer-header">
          <div className="sdp-drawer-title">
            <span className="sdp-drawer-title-icon">⚠</span>
            Per-symbol gaps
            {totalGapCount != null && (
              <span className="sdp-drawer-badge">{totalGapCount.toLocaleString()}</span>
            )}
          </div>
          <button type="button" className="sdp-drawer-close" onClick={onClose} aria-label="Close gap panel">×</button>
        </div>

        <div className="sdp-drawer-sub">
          Symbols in <code>v_sepa_us_equity_universe</code> where <code>price_ready = false</code>
        </div>

        {/* Reason breakdown pills */}
        {!loading && !error && Object.keys(reasonCounts).length > 0 && (
          <div className="sdp-drawer-reasons">
            {Object.entries(reasonCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <span key={reason} className="sdp-gap-reason-pill">
                  <span className="sdp-gap-reason-count">{count}</span>
                  <span className="sdp-gap-reason-label">{reason}</span>
                </span>
              ))}
          </div>
        )}

        {/* Actions */}
        <div className="sdp-drawer-actions">
          <button
            type="button"
            className="sdp-btn-primary"
            onClick={onRunBackfill}
            disabled={backfillBusy || backfillSelectedBusy || priceGap === 0}
            title="Backfill all gap symbols (bulk)"
          >
            {backfillBusy ? 'Dispatching…' : 'Backfill all gaps'}
          </button>
          {selectedSymbols.size > 0 && (
            <button
              type="button"
              className="sdp-btn-backfill-selected"
              onClick={handleBackfillSelected}
              disabled={backfillSelectedBusy || backfillBusy}
              title={`Backfill ${selectedSymbols.size} selected symbol${selectedSymbols.size === 1 ? '' : 's'}`}
            >
              {backfillSelectedBusy
                ? 'Dispatching…'
                : `Backfill selected (${selectedSymbols.size.toLocaleString()})`}
            </button>
          )}
          <button
            type="button"
            className={`sdp-btn-copy-llm${copied ? ' sdp-btn-copy-llm--ok' : copyError ? ' sdp-btn-copy-llm--err' : ''}`}
            onClick={() => void handleCopyLlm()}
            disabled={loading || items.length === 0}
            title="Copy LLM-readable gap report to clipboard"
          >
            {copied ? '✓ Copied' : copyError ? '⚠ Copy failed' : 'Copy LLM report'}
          </button>
        </div>
        {backfillMsg && (
          <div className={`sdp-feedback sdp-msg--${backfillOk ? 'ok' : 'err'}`} style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillMsg}
          </div>
        )}
        {backfillSelectedMsg && (
          <div className={`sdp-feedback sdp-msg--${backfillSelectedOk ? 'ok' : 'err'}`} style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillSelectedMsg}
          </div>
        )}

        {/* Search */}
        <div className="sdp-drawer-search">
          <input
            type="text"
            className="sdp-drawer-search-input"
            placeholder="Filter by symbol…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            aria-label="Filter gap symbols"
          />
          {searchQ && (
            <button type="button" className="sdp-drawer-search-clear" onClick={() => setSearchQ('')} aria-label="Clear filter">×</button>
          )}
          {!loading && !error && (
            <span className="sdp-drawer-search-count">
              {filtered.length.toLocaleString()} / {(totalGapCount ?? items.length).toLocaleString()}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="sdp-drawer-body">
          {loading && (
            <div className="sdp-drawer-loading">
              <span className="sdp-check-dot sdp-check-dot--loading" />
              Loading gap data…
            </div>
          )}
          {error && !loading && (
            <div className="sdp-drawer-error">{error}</div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="sdp-drawer-empty">
              {searchQ
                ? 'No symbols match the filter.'
                : 'No gap symbols — every universe symbol either has no cache row, passes vendor/date/close checks, or readiness fallback is clear.'}
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="sdp-gap-table">
              <thead>
                <tr>
                  <th className="sdp-gap-col-check">
                    <input
                      type="checkbox"
                      className="sdp-gap-checkbox"
                      checked={allFilteredSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected
                      }}
                      onChange={toggleAllFiltered}
                      aria-label="Select all filtered symbols"
                    />
                  </th>
                  <th>Symbol</th>
                  <th>Bars</th>
                  <th>Vendor NY</th>
                  <th>Max daily</th>
                  <th>Last bar (420d)</th>
                  <th>Day close</th>
                  <th>Session close</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => {
                  const checked = selectedSymbols.has(it.symbol)
                  return (
                    <tr
                      key={it.symbol}
                      className={checked ? 'sdp-gap-row--selected' : ''}
                      onClick={() => toggleSymbol(it.symbol)}
                    >
                      <td className="sdp-gap-col-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="sdp-gap-checkbox"
                          checked={checked}
                          onChange={() => toggleSymbol(it.symbol)}
                          aria-label={`Select ${it.symbol}`}
                        />
                      </td>
                      <td className="sdp-gap-symbol">{it.symbol}</td>
                      <td className={`sdp-gap-bars${it.bar_rows < 240 ? ' sdp-gap-bars--low' : ''}`}>{it.bar_rows}</td>
                      <td className="sdp-gap-date">{it.vendor_day ?? '—'}</td>
                      <td className="sdp-gap-date">{it.last_bar_max_date ?? '—'}</td>
                      <td className="sdp-gap-date">{it.last_bar_date ?? '—'}</td>
                      <td className="sdp-gap-date">
                        {it.last_stock_day_close != null && Number.isFinite(it.last_stock_day_close)
                          ? String(Math.round(it.last_stock_day_close * 10000) / 10000)
                          : '—'}
                      </td>
                      <td className="sdp-gap-date">
                        {it.session_close != null && Number.isFinite(it.session_close)
                          ? String(Math.round(it.session_close * 10000) / 10000)
                          : '—'}
                      </td>
                      <td className="sdp-gap-reason">{it.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loading && !error && totalGapCount != null && totalGapCount > items.length && (
          <div className="sdp-drawer-truncated">
            Showing first {items.length.toLocaleString()} of {totalGapCount.toLocaleString()} symbols.
          </div>
        )}
      </aside>
    </>
  )
}

// ── Inner Page ────────────────────────────────────────────────────────────────

/** Inner page: consumes MassiveRefJobSessionContext for job tracking. */
function SepaDataReadyPageInner({
  onBreadcrumbResearch,
  breadcrumbLabel = 'SEPA Data Ready',
  onOpenCelerySettings,
  onOpenFeedMassiveStock,
  onOpenDataCoverageSummary,
}: SepaDataReadyPageProps) {
  const refJobSession = useMassiveRefJobSession()

  const [summary, setSummary] = useState<SepaReadinessSummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryErr, setSummaryErr] = useState<string | null>(null)
  const summaryLoadedAtRef = useRef<string | null>(null)
  const [activeRunStep, setActiveRunStep] = useState<1 | 2 | 3 | 4 | 5>(1)

  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null)
  const [snapshotOk, setSnapshotOk] = useState<boolean | null>(null)

  const [unifiedSnapBusy, setUnifiedSnapBusy] = useState(false)
  const [unifiedSnapMsg, setUnifiedSnapMsg] = useState<string | null>(null)
  const [unifiedSnapOk, setUnifiedSnapOk] = useState<boolean | null>(null)

  const [universeErr, setUniverseErr] = useState<string | null>(null)

  const [holidaysSyncBusy, setHolidaysSyncBusy] = useState(false)
  const [holidaysSyncMsg, setHolidaysSyncMsg] = useState<string | null>(null)
  const [holidaysSyncOk, setHolidaysSyncOk] = useState<boolean | null>(null)
  const [holidaysSyncResult, setHolidaysSyncResult] = useState<SepaSyncHolidaysResponse | null>(null)

  const [groupedHistoryBusy, setGroupedHistoryBusy] = useState(false)
  const [groupedHistoryMsg, setGroupedHistoryMsg] = useState<string | null>(null)
  const [groupedHistoryOk, setGroupedHistoryOk] = useState<boolean | null>(null)

  const [priceGapBusy, setPriceGapBusy] = useState(false)
  const [priceGapMsg, setPriceGapMsg] = useState<string | null>(null)
  const [priceGapOk, setPriceGapOk] = useState<boolean | null>(null)

  const [fixGapsBusy, setFixGapsBusy] = useState(false)
  const [fixGapsMsg, setFixGapsMsg] = useState<string | null>(null)
  const [fixGapsOk, setFixGapsOk] = useState<boolean | null>(null)

  const [selectedGapBusy, setSelectedGapBusy] = useState(false)
  const [selectedGapMsg, setSelectedGapMsg] = useState<string | null>(null)
  const [selectedGapOk, setSelectedGapOk] = useState<boolean | null>(null)

  const [hasChecked, setHasChecked] = useState(false)

  const [gapsDrawerOpen, setGapsDrawerOpen] = useState(false)

  const [queues, setQueues] = useState<QueueSummaryRow[]>([])
  const [queuesErr, setQueuesErr] = useState<string | null>(null)
  const [queuesLoading, setQueuesLoading] = useState(false)

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryErr(null)
    try {
      const res = await fetchSepaReadinessSummary()
      setSummary(res)
      summaryLoadedAtRef.current = new Date().toISOString()
      if (!res.ok) setSummaryErr(res.error ?? 'Summary failed')
    } catch (e) {
      setSummaryErr(e instanceof Error ? e.message : 'Summary failed')
      setSummary(null)
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const loadQueues = useCallback(async () => {
    setQueuesLoading(true)
    setQueuesErr(null)
    try {
      const res = await fetchQueueSummary()
      if (!res.ok) {
        setQueuesErr(res.error ?? 'Queue summary unavailable (Ops token or broker).')
        setQueues([])
        return
      }
      setQueues(res.queues ?? [])
    } catch (e) {
      setQueuesErr(e instanceof Error ? e.message : 'Queue summary failed')
      setQueues([])
    } finally {
      setQueuesLoading(false)
    }
  }, [])

  const handleCheck = useCallback(() => {
    setHasChecked(true)
    void loadSummary()
    void loadQueues()
  }, [loadSummary, loadQueues])

  const runSnapshot = async () => {
    setSnapshotBusy(true)
    setSnapshotMsg(null)
    setSnapshotOk(null)
    try {
      const res = await postSepaReadinessSnapshot()
      if (!res.ok) {
        setSnapshotMsg(res.error ?? 'Snapshot failed')
        setSnapshotOk(false)
        return
      }
      setSnapshotMsg(
        `rows_affected=${fmt(res.rows_affected)}  elapsed=${fmt(res.elapsed_ms)}ms`,
      )
      setSnapshotOk(true)
      await loadSummary()
    } catch (e) {
      setSnapshotMsg(e instanceof Error ? e.message : 'Snapshot failed')
      setSnapshotOk(false)
    } finally {
      setSnapshotBusy(false)
    }
  }

  const runUnifiedStockSnapshot = async () => {
    setUnifiedSnapBusy(true)
    setUnifiedSnapMsg(null)
    setUnifiedSnapOk(null)
    try {
      const res = await postSepaStockUnifiedSnapshot()
      if (!res.ok) {
        setUnifiedSnapMsg(res.error ?? 'Unified snapshot refresh failed')
        setUnifiedSnapOk(false)
        return
      }
      const parts = [
        res.message,
        `symbols_total=${fmt(res.symbols_total)} chunks=${fmt(res.chunks)} rows_upserted=${fmt(res.rows_upserted)} elapsed=${fmt(res.elapsed_ms)}ms`,
      ]
      if (res.errors && res.errors.length > 0) {
        parts.push(`errors: ${res.errors.slice(0, 3).join(' · ')}`)
      }
      setUnifiedSnapMsg(parts.filter(Boolean).join(' — '))
      setUnifiedSnapOk(true)
      await loadSummary()
    } catch (e) {
      setUnifiedSnapMsg(e instanceof Error ? e.message : 'Unified snapshot refresh failed')
      setUnifiedSnapOk(false)
    } finally {
      setUnifiedSnapBusy(false)
    }
  }

  const runHolidaysSync = useCallback(async (): Promise<SepaSyncHolidaysResponse> => {
    setHolidaysSyncBusy(true)
    setHolidaysSyncMsg(null)
    setHolidaysSyncOk(null)
    try {
      const res = await postSepaSyncHolidays()
      setHolidaysSyncResult(res)
      if (!res.ok) {
        setHolidaysSyncMsg(res.error ?? 'Holidays sync failed')
        setHolidaysSyncOk(false)
        return res
      }
      const fetched = res.fetched ?? 0
      const inserted = res.inserted ?? 0
      const updated = res.updated ?? 0
      const skipped = res.skipped ?? 0
      setHolidaysSyncMsg(
        `Holidays synced — fetched ${fmt(fetched)}, inserted ${fmt(inserted)}, updated ${fmt(updated)}` +
          (skipped > 0 ? `, skipped ${fmt(skipped)}` : ''),
      )
      setHolidaysSyncOk(true)
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Holidays sync failed'
      setHolidaysSyncMsg(msg)
      setHolidaysSyncOk(false)
      return { ok: false, error: msg }
    } finally {
      setHolidaysSyncBusy(false)
    }
  }, [])

  const runUniverseEnqueue = async () => {
    setUniverseErr(null)
    const [tickerRes, holidaysRes] = await Promise.all([
      refJobSession.enqueueTickerReferenceJob(
        'feed_stocks_tickers_reference_universe',
        { full_universe: true, limit: 1000, sort: 'ticker', order: 'asc' },
        'high',
      ),
      runHolidaysSync(),
    ])
    const tickerErr = !tickerRes.ok ? (tickerRes.error ?? 'Ticker enqueue failed') : null
    const holidayErr = !holidaysRes.ok ? (holidaysRes.error ?? 'Holidays sync failed') : null
    const combined = [
      tickerErr ? `Tickers: ${tickerErr}` : null,
      holidayErr ? `Holidays: ${holidayErr}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    if (combined) setUniverseErr(combined)
  }

  const runGroupedHistoryBackfill = async () => {
    setGroupedHistoryBusy(true)
    setGroupedHistoryMsg(null)
    setGroupedHistoryOk(null)
    try {
      const res = await postSepaGroupedHistoryBackfill(420)
      if (!res.ok) {
        setGroupedHistoryMsg(res.error ?? 'Backfill failed')
        setGroupedHistoryOk(false)
        return
      }
      if (res.message) {
        setGroupedHistoryMsg(res.message)
        setGroupedHistoryOk(true)
        return
      }
      const queued = res.dates_queued ?? 0
      const checked = res.checked_dates ?? 0
      setGroupedHistoryMsg(
        queued === 0
          ? `All ${fmt(checked)} trading days already covered (≥1,000 symbols/day).`
          : `Queued ${fmt(queued)} jobs (of ${fmt(checked)} trading days). Each job = 1 API call → 5,000+ symbols.`,
      )
      setGroupedHistoryOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setGroupedHistoryMsg(e instanceof Error ? e.message : 'Backfill failed')
      setGroupedHistoryOk(false)
    } finally {
      setGroupedHistoryBusy(false)
    }
  }

  const runPriceGapBackfill = async () => {
    setPriceGapBusy(true)
    setPriceGapMsg(null)
    setPriceGapOk(null)
    try {
      const res = await postSepaPriceGapBackfill()
      if (!res.ok) {
        setPriceGapMsg(res.error ?? 'Backfill failed')
        setPriceGapOk(false)
        return
      }
      if (res.message) {
        setPriceGapMsg(res.message)
        setPriceGapOk(true)
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      setPriceGapMsg(`Dispatched ${fmt(chunks)} tasks covering ${fmt(gapCount)} gap symbols.`)
      setPriceGapOk(true)
      // Track first job and open Jobs sheet
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setPriceGapMsg(e instanceof Error ? e.message : 'Backfill failed')
      setPriceGapOk(false)
    } finally {
      setPriceGapBusy(false)
    }
  }

  const runPriceGapBackfillSelected = async (symbols: string[]) => {
    setSelectedGapBusy(true)
    setSelectedGapMsg(null)
    setSelectedGapOk(null)
    try {
      const res = await postSepaPriceGapBackfill(symbols)
      if (!res.ok) {
        setSelectedGapMsg(res.error ?? 'Backfill failed')
        setSelectedGapOk(false)
        return
      }
      if (res.message) {
        setSelectedGapMsg(res.message)
        setSelectedGapOk(true)
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      setSelectedGapMsg(`Dispatched ${fmt(chunks)} tasks for ${fmt(gapCount)} selected symbols.`)
      setSelectedGapOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setSelectedGapMsg(e instanceof Error ? e.message : 'Backfill failed')
      setSelectedGapOk(false)
    } finally {
      setSelectedGapBusy(false)
    }
  }

  const runFixGaps = async () => {
    setFixGapsBusy(true)
    setFixGapsMsg(null)
    setFixGapsOk(null)
    try {
      const backfill = await postSepaPriceGapBackfill()
      if (!backfill.ok) {
        setFixGapsMsg(backfill.error ?? 'Backfill failed')
        setFixGapsOk(false)
        return
      }
      const gapCount = backfill.gap_count ?? 0
      const chunks = backfill.chunks ?? 0
      if (gapCount === 0) {
        // No gaps — just refresh snapshot
        const snap = await postSepaReadinessSnapshot()
        if (!snap.ok) {
          setFixGapsMsg(snap.error ?? 'Snapshot refresh failed')
          setFixGapsOk(false)
          return
        }
        setFixGapsMsg(`No gaps found. Snapshot refreshed: ${fmt(snap.rows_affected)} rows.`)
        setFixGapsOk(true)
        await loadSummary()
        return
      }
      setFixGapsMsg(
        `Dispatched ${fmt(chunks)} backfill tasks for ${fmt(gapCount)} symbols. Re-run snapshot after bars complete.`,
      )
      setFixGapsOk(true)
      if (backfill.job_ids && backfill.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: backfill.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setFixGapsMsg(e instanceof Error ? e.message : 'Fix gaps failed')
      setFixGapsOk(false)
    } finally {
      setFixGapsBusy(false)
    }
  }

  const universeBusy = refJobSession.jobBusyKind === 'feed_stocks_tickers_reference_universe'
  const anyJobBusy = refJobSession.jobBusyKind != null
  const activeJobCount = refJobSession.activeJobCount

  const live = summary?.price_readiness_live
  const snap = summary?.snapshot_today
  const snapshotEmpty = summary?.snapshot_populated === false

  // Step check statuses
  const universeCount = summary?.universe_count ?? 0
  const tickersActive = summary?.tickers_active_count ?? 0
  const priceReady = live?.price_ready ?? 0
  const totalSymbols = live?.total_symbols ?? 0
  const vendorFillGap = summary?.stock_day_vendor_fill_gap_count
  const priceGap =
    vendorFillGap != null
      ? vendorFillGap
      : totalSymbols > 0
        ? totalSymbols - priceReady
        : null
  const notesCount = (summary?.notes_breakdown ?? []).reduce((s, r) => s + r.count, 0)

  const step1Status: CheckStatus = summaryLoading
    ? 'loading'
    : universeCount > 5000
    ? 'ok'
    : universeCount > 100
    ? 'warn'
    : summary
    ? 'error'
    : 'unknown'

  const holidaysSummary = summary?.holidays_summary
  const holidaysTotal = holidaysSummary?.total ?? 0
  const holidaysMassive = holidaysSummary?.massive_count ?? 0
  const holidaysSeed = holidaysSummary?.seed_count ?? 0
  const holidaysEarlyClose = holidaysSummary?.early_close_count ?? 0
  const holidaysLastSync = holidaysSummary?.last_massive_sync ?? null
  const holidaysLatest = holidaysSummary?.latest_date ?? null
  const holidaysEarliest = holidaysSummary?.earliest_date ?? null
  const holidaysStatus: CheckStatus = summaryLoading
    ? 'loading'
    : holidaysTotal >= 100
    ? 'ok'
    : holidaysTotal > 0
    ? 'warn'
    : summary
    ? 'error'
    : 'unknown'

  const unifiedSnapRows = summary?.stock_unified_snapshot_row_count
  const unifiedSnapStatus: CheckStatus = summaryLoading
    ? 'loading'
    : unifiedSnapRows != null && unifiedSnapRows > 0
    ? 'ok'
    : summary && universeCount > 0
    ? 'warn'
    : 'unknown'

  const barStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : priceGap === 0
    ? 'ok'
    : priceGap != null && priceGap < 500
    ? 'warn'
    : priceGap != null
    ? 'error'
    : 'unknown'

  const matSnapshotStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : summary?.snapshot_populated === true
    ? 'ok'
    : summary
    ? 'error'
    : 'unknown'

  const reviewStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : notesCount === 0 && summary?.snapshot_populated
    ? 'ok'
    : notesCount > 0
    ? (notesCount > 500 ? 'error' : 'warn')
    : 'unknown'

  const step1Done = universeCount > 0
  const unifiedSnapDone = (unifiedSnapRows ?? 0) > 0
  const barStepDone = (live?.total_symbols ?? 0) > 0
  const matSnapshotStepDone = summary?.snapshot_populated === true
  const reviewStepDone = matSnapshotStepDone && (snap?.price_ready ?? 0) > 0

  const lastCheckedNote = summaryLoadedAtRef.current
    ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}`
    : null

  const runbookSteps: Array<{
    id: 1 | 2 | 3 | 4 | 5
    title: string
    short: string
    status: CheckStatus
    done: boolean
    metric: string
  }> = [
    {
      id: 1,
      title: 'Universe + holidays',
      short: 'Reference data',
      status: step1Status === 'ok' && holidaysStatus === 'ok'
        ? 'ok'
        : step1Status === 'error' || holidaysStatus === 'error'
        ? 'error'
        : step1Status === 'loading' || holidaysStatus === 'loading'
        ? 'loading'
        : step1Status === 'warn' || holidaysStatus === 'warn'
        ? 'warn'
        : 'unknown',
      done: step1Done && holidaysTotal > 0,
      metric: `${fmt(universeCount)} symbols`,
    },
    {
      id: 2,
      title: 'Unified snapshots',
      short: 'Massive baseline',
      status: unifiedSnapStatus,
      done: unifiedSnapDone,
      metric: unifiedSnapRows != null ? `${fmt(unifiedSnapRows)} rows` : 'not loaded',
    },
    {
      id: 3,
      title: 'Stock day bars',
      short: 'Daily fill',
      status: barStepStatus,
      done: barStepStatus === 'ok',
      metric: priceGap != null ? `${fmt(priceGap)} gaps` : 'unchecked',
    },
    {
      id: 4,
      title: 'Readiness snapshot',
      short: 'Materialize',
      status: matSnapshotStepStatus,
      done: matSnapshotStepDone,
      metric: snap?.rows_total != null ? `${fmt(snap.rows_total)} rows` : 'today',
    },
    {
      id: 5,
      title: 'Review + fix',
      short: 'Close loop',
      status: reviewStepStatus,
      done: reviewStepDone,
      metric: notesCount > 0 ? `${fmt(notesCount)} failing` : 'ready',
    },
  ]

  return (
    <div className="sdp-root">
      <SectionPageTitle
        menu="Research"
        pageTitle={breadcrumbLabel}
        onMenuClick={onBreadcrumbResearch}
        menuNavigateAriaLabel="Go to Research home"
        infoText="Validate PostgreSQL ticker universe and stock_day coverage before full-market SEPA Phase4 runs."
      />

      {/* ── Step Actions Panel ─────────────────────────────────────────── */}
      <div className="sdp-actions-card">
        <div className="sdp-actions-title">Run book</div>

        <div className="sdp-runbook-stepper" role="tablist" aria-label="SEPA Data Ready run book steps">
          {runbookSteps.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={activeRunStep === s.id}
              aria-controls={`sepa-runbook-step-${s.id}`}
              className={[
                'sdp-runbook-tab',
                activeRunStep === s.id ? 'sdp-runbook-tab--active' : '',
                s.done ? 'sdp-runbook-tab--done' : '',
                `sdp-runbook-tab--${s.status}`,
              ].filter(Boolean).join(' ')}
              onClick={() => setActiveRunStep(s.id)}
            >
              <span className="sdp-runbook-tab-index">{s.id}</span>
              <span className="sdp-runbook-tab-text">
                <span className="sdp-runbook-tab-title">{s.title}</span>
                <span className="sdp-runbook-tab-sub">{s.short} · {s.metric}</span>
              </span>
              {idx < runbookSteps.length - 1 && <span className="sdp-runbook-tab-rail" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="sdp-step-list sdp-step-list--panel">

          {/* Step 1 — Tickers Universe + Market Holidays */}
          <div
            id="sepa-runbook-step-1"
            role="tabpanel"
            className={`sdp-step ${step1Done ? 'sdp-step--done' : ''} ${activeRunStep === 1 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">1</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Sync All Tickers + Market Holidays into{' '}
                <code>public.tickers</code> &amp; <code>public.reference_us_holidays</code>
              </div>

              <div className="sdp-step-twin-grid">
                {/* Tickers track */}
                <div className="sdp-step-twin-card">
                  <div className="sdp-step-twin-title">
                    <span className="sdp-step-twin-tag sdp-step-twin-tag--tickers">TICKERS</span>
                    <code>public.tickers</code>
                  </div>
                  <StepCheckStrip
                    hasChecked={hasChecked}
                    loading={summaryLoading && !summary}
                    status={step1Status}
                    primary={`${fmt(universeCount)} equity universe`}
                    primaryLabel=" · v_sepa_us_equity_universe"
                    secondary={tickersActive > 0 ? `${fmt(tickersActive)} active US stocks in DB` : null}
                    gap={universeCount < 100 ? universeCount : null}
                    gapUnit="tickers"
                    target="≥ 5,000 active US equity symbols"
                    note={
                      summary?.tickers_last_synced_at
                        ? `Last synced ${fmtRelativeTime(summary.tickers_last_synced_at)}`
                        : lastCheckedNote
                    }
                  />
                  <p className="sdp-step-desc">
                    Reference universe from Massive REST{' '}
                    <code>/v3/reference/tickers</code>. Celery queue{' '}
                    <code>stocks_massive</code>.
                  </p>
                </div>

                {/* Holidays track */}
                <div className="sdp-step-twin-card">
                  <div className="sdp-step-twin-title">
                    <span className="sdp-step-twin-tag sdp-step-twin-tag--holidays">HOLIDAYS</span>
                    <code>public.reference_us_holidays</code>
                  </div>
                  <StepCheckStrip
                    hasChecked={hasChecked}
                    loading={summaryLoading && !summary}
                    status={holidaysStatus}
                    primary={
                      holidaysTotal > 0
                        ? `${fmt(holidaysTotal)} holidays · ${fmt(holidaysMassive)} from Massive · ${fmt(holidaysSeed)} seeded`
                        : 'No holidays loaded'
                    }
                    primaryLabel=" · all exchanges"
                    secondary={
                      holidaysEarlyClose > 0
                        ? `${fmt(holidaysEarlyClose)} early-close days`
                        : null
                    }
                    target="Seed 2020-2027 + Massive upcoming (~12 months)"
                    note={
                      holidaysLastSync
                        ? `Massive sync ${fmtRelativeTime(holidaysLastSync)}` +
                          (holidaysEarliest && holidaysLatest
                            ? ` · ${holidaysEarliest} → ${holidaysLatest}`
                            : '')
                        : holidaysEarliest && holidaysLatest
                        ? `${holidaysEarliest} → ${holidaysLatest}`
                        : lastCheckedNote
                    }
                  />
                  <p className="sdp-step-desc">
                    Seeds NYSE/NASDAQ federal closures 2020-2027, then pulls{' '}
                    <code>/v1/marketstatus/upcoming</code> for early-close timing.
                    Used by K-line gap detection to skip closed days.
                  </p>
                </div>
              </div>

              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-check sdp-btn-check--sky"
                  onClick={handleCheck}
                  disabled={summaryLoading}
                  title="Reload counts for both tickers and holidays"
                >
                  {summaryLoading ? 'Checking…' : 'Check both'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runUniverseEnqueue()}
                  disabled={anyJobBusy || holidaysSyncBusy}
                  title="Enqueue ticker universe sync (Celery) and run Massive holidays sync in parallel"
                >
                  {universeBusy
                    ? 'Enqueueing tickers…'
                    : holidaysSyncBusy
                    ? 'Syncing both…'
                    : 'Sync tickers + holidays'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => void runHolidaysSync()}
                  disabled={holidaysSyncBusy}
                  title="Pull NYSE/NASDAQ holidays from Massive REST + apply embedded seed"
                >
                  {holidaysSyncBusy ? 'Syncing…' : 'Holidays only'}
                </button>
                {activeJobCount > 0 && (
                  <span className="ref-jobs-active-pill" aria-live="polite">
                    {activeJobCount} active
                  </span>
                )}
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => refJobSession.openJobsSheet()}
                >
                  Jobs
                </button>
                {onOpenCelerySettings && (
                  <button type="button" className="sdp-btn-ghost" onClick={onOpenCelerySettings}>
                    Celery settings
                  </button>
                )}
              </div>
              {holidaysSyncMsg != null && (
                <div className={`sdp-feedback sdp-msg--${holidaysSyncOk ? 'ok' : 'err'}`}>
                  {holidaysSyncMsg}
                  {holidaysSyncResult?.total_in_table != null && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)' }}>
                      total in table: {fmt(holidaysSyncResult.total_in_table)}
                    </span>
                  )}
                  {holidaysSyncResult?.massive_error && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)', color: 'var(--color-warn)' }}>
                      Massive: {holidaysSyncResult.massive_error}
                    </span>
                  )}
                  {holidaysSyncResult?.synced_at && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)' }}>
                      at {new Date(holidaysSyncResult.synced_at).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {universeErr != null && (
                <div className="sdp-feedback sdp-msg--err">{universeErr}</div>
              )}
            </div>
          </div>

          {/* Step 2 — Massive unified stock snapshot baseline (before stock_day backfill) */}
          <div
            id="sepa-runbook-step-2"
            role="tabpanel"
            className={`sdp-step ${unifiedSnapDone ? 'sdp-step--done' : ''} ${activeRunStep === 2 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">2</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Refresh <code>public.cache_stock_snapshot</code> (Massive <code>GET /v3/snapshot</code>, stocks)
              </div>
              <StepCheckStrip
                hasChecked={hasChecked}
                loading={summaryLoading && !summary}
                status={unifiedSnapStatus}
                primary={
                  unifiedSnapRows != null && unifiedSnapRows > 0
                    ? `${fmt(unifiedSnapRows)} symbols cached`
                    : 'No unified snapshot rows yet'
                }
                primaryLabel=" · cache_stock_snapshot"
                secondary={
                  summary?.stock_unified_snapshot_last_fetched_at
                    ? `Last fetch ${fmtRelativeTime(summary.stock_unified_snapshot_last_fetched_at)}`
                    : null
                }
                target="Run once after Step 1 before heavy stock_day backfill"
                note={lastCheckedNote}
              />
              <p className="sdp-step-desc">
                Batches all <code>v_sepa_us_equity_universe</code> symbols via <code>ticker.any_of</code> (≤250 per
                request). Flattens Massive <code>session</code>, <code>last_minute</code>, and optional{' '}
                <code>last_trade</code> / <code>last_quote</code> into scalar columns (no jsonb) for SQL joins.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-check sdp-btn-check--sky"
                  onClick={handleCheck}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? 'Checking…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runUnifiedStockSnapshot()}
                  disabled={unifiedSnapBusy || anyJobBusy}
                >
                  {unifiedSnapBusy ? 'Refreshing…' : 'Refresh unified snapshots'}
                </button>
              </div>
              {unifiedSnapMsg != null && (
                <div className={`sdp-feedback sdp-msg--${unifiedSnapOk ? 'ok' : 'err'}`}>{unifiedSnapMsg}</div>
              )}

              <SnapshotByTypeBreakdown rows={summary?.stock_unified_snapshot_by_type ?? null} />
            </div>
          </div>

          {/* Step 3 — Stock Day Bars */}
          <div
            id="sepa-runbook-step-3"
            role="tabpanel"
            className={`sdp-step ${barStepDone ? 'sdp-step--done' : ''} ${activeRunStep === 3 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">3</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">Backfill <code>public.stock_day</code> bars</div>
              <StepCheckStrip
                hasChecked={hasChecked}
                loading={summaryLoading && !summary}
                status={barStepStatus}
                primary={
                  totalSymbols > 0
                    ? `${fmt(priceReady)} / ${fmt(totalSymbols)} price_ready (${fmtPct(priceReady, totalSymbols)})`
                    : null
                }
                primaryLabel=" · cache vs stock_day + readiness fallback"
                gap={priceGap}
                gapUnit="symbols need daily fill"
                target="Vendor NY date from Step 2 cache ≤ last massive daily bar; else readiness rules"
                note={lastCheckedNote}
              />

              {/* Daily maintenance explanation */}
              <div className="sdp-maintenance-box">
                <div className="sdp-maintenance-box-title">Daily maintenance strategy</div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--auto">AUTO</span>
                  <span className="sdp-maintenance-text">
                    Beat task <code>massive-sepa-universe-grouped-daily</code> runs nightly at 22:00 UTC —
                    one <strong>Grouped Daily Bars</strong> API call covers all 5,000+ US stocks for today's date
                    (vs. 5,000+ calls for per-symbol approach).
                  </span>
                </div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--manual">MANUAL</span>
                  <span className="sdp-maintenance-text">
                    <em>Backfill 420d History</em> below queues one job per missing trading date.
                    Each job = 1 API call → OHLCV for all US stocks on that date.
                    Efficient initial setup: ~420 API calls total.
                  </span>
                </div>
              </div>

              <p className="sdp-step-desc">
                Celery <code>feed_stocks_aggregate</code> writes <code>source=massive</code> rows. The Check gap count
                uses <code>cache_stock_snapshot.last_minute_updated</code> (America/New_York date) vs{' '}
                <code>max(stock_day.bar_time)</code>;                 any snapshot-based check requires non-null <code>session_close</code> — if it is empty, that symbol is
                skipped for Step 3 gaps (no <code>stock_day</code> comparison and no readiness fallback), regardless of
                whether daily bars exist. After a calendar gap, the latest daily <code>stock_day.close</code> must differ
                from <code>session_close</code> (beyond a tiny absolute tolerance) to count as a vendor gap — matching
                closes mean the vendor snapshot already aligns with the last ingested bar.{' '}
                <code>tickers.instrument_type = WARRANT</code> symbols are excluded. Symbols with **no**{' '}
                <code>cache_stock_snapshot</code> row are never gaps. If a snapshot row has <code>session_close</code>{' '}
                but <code>last_minute_updated</code> is missing, the UI falls back to <code>NOT price_ready</code> on the
                readiness view.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-check sdp-btn-check--violet"
                  onClick={handleCheck}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? 'Checking…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runGroupedHistoryBackfill()}
                  disabled={groupedHistoryBusy}
                >
                  {groupedHistoryBusy ? 'Queuing jobs…' : 'Backfill 420d History (Grouped Daily)'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => refJobSession.openJobsSheet()}
                >
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${barStepStatus === 'ok' ? ' sdp-btn-gaps--ok' : priceGap != null && priceGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => setGapsDrawerOpen(true)}
                  disabled={barStepStatus === 'ok' || !hasChecked}
                  title="View per-symbol gap details and LLM-ready report"
                >
                  {barStepStatus === 'ok'
                    ? '✓ All price_ready'
                    : priceGap != null && priceGap > 0
                    ? `Gaps (${fmt(priceGap)}) →`
                    : 'View gaps →'}
                </button>
                {onOpenFeedMassiveStock && (
                  <button type="button" className="sdp-btn-ghost" onClick={onOpenFeedMassiveStock}>
                    Open Feed Massive Stock →
                  </button>
                )}
              </div>
              {groupedHistoryMsg != null && (
                <div className={`sdp-feedback sdp-msg--${groupedHistoryOk ? 'ok' : 'err'}`}>{groupedHistoryMsg}</div>
              )}
              {priceGapMsg != null && (
                <div className={`sdp-feedback sdp-msg--${priceGapOk ? 'ok' : 'err'}`}>{priceGapMsg}</div>
              )}
            </div>
          </div>

          {/* Step 4 — Readiness Snapshot */}
          <div
            id="sepa-runbook-step-4"
            role="tabpanel"
            className={`sdp-step ${matSnapshotStepDone ? 'sdp-step--done' : 'sdp-step--active'} ${activeRunStep === 4 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">4</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">Refresh readiness snapshot</div>
              <StepCheckStrip
                hasChecked={hasChecked}
                loading={summaryLoading && !summary}
                status={matSnapshotStepStatus}
                primary={
                  summary?.snapshot_populated === true
                    ? `${fmt(snap?.price_ready)} / ${fmt(snap?.included_in_universe)} price_ready today`
                    : 'Snapshot not populated for today'
                }
                primaryLabel=" · sepa_universe_readiness_daily"
                gap={
                  summary?.snapshot_populated
                    ? (snap?.included_in_universe ?? 0) - (snap?.price_ready ?? 0)
                    : null
                }
                gapUnit="symbols not price_ready"
                target="Snapshot populated today with price_ready > 0"
                note={lastCheckedNote}
              />
              <p className="sdp-step-desc">
                Materializes <code>sepa_universe_readiness_daily</code> for today by joining the universe view, bar counts,
                and optional fundamentals cache. Run after Step 3 (stock_day backfill) completes.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-check sdp-btn-check--amber"
                  onClick={handleCheck}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? 'Checking…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runSnapshot()}
                  disabled={snapshotBusy}
                >
                  {snapshotBusy ? 'Refreshing…' : 'Refresh snapshot'}
                </button>
              </div>
              {snapshotMsg != null && (
                <div className={`sdp-feedback sdp-msg--${snapshotOk ? 'ok' : 'err'}`}>{snapshotMsg}</div>
              )}
            </div>
          </div>

          {/* Step 5 — Review & Fix */}
          <div
            id="sepa-runbook-step-5"
            role="tabpanel"
            className={`sdp-step ${reviewStepDone ? 'sdp-step--done' : ''} ${activeRunStep === 5 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">5</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">Review metrics &amp; fix gaps</div>
              <StepCheckStrip
                hasChecked={hasChecked}
                loading={summaryLoading && !summary}
                status={reviewStepStatus}
                primary={
                  !summary?.snapshot_populated
                    ? 'Snapshot not yet populated — run Step 4 first'
                    : notesCount === 0
                    ? 'All universe symbols are price_ready'
                    : `${fmt(notesCount)} universe symbols not price_ready`
                }
                primaryLabel={
                  summary?.snapshot_populated && summary?.fund_cache_view_exists
                    ? ` · ${fmt(summary?.fund_cache_valid_count ?? null)} fund cache valid`
                    : undefined
                }
                gap={notesCount > 0 ? notesCount : null}
                gapUnit="symbols failing readiness"
                target="Notes breakdown empty · all symbols price_ready"
                note={lastCheckedNote}
              />
              <p className="sdp-step-desc">
                Check the readiness metrics below. Symbols where <code>price_ready = false</code> appear in
                the Notes breakdown with the failure reason. Use <em>Fix Gaps</em> to re-backfill those symbols, then re-run Step 4.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-check sdp-btn-check--teal"
                  onClick={handleCheck}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? 'Checking…' : 'Check'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFixGaps()}
                  disabled={fixGapsBusy || !summary?.snapshot_populated}
                  title={!summary?.snapshot_populated ? 'Run Step 4 first to populate the snapshot' : undefined}
                >
                  {fixGapsBusy ? 'Fixing…' : 'Fix Gaps'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => refJobSession.openJobsSheet()}
                >
                  View Jobs
                </button>
                {onOpenDataCoverageSummary && (
                  <button type="button" className="sdp-btn-ghost" onClick={onOpenDataCoverageSummary}>
                    Data Coverage →
                  </button>
                )}
              </div>
              {fixGapsMsg != null && (
                <div className={`sdp-feedback sdp-msg--${fixGapsOk ? 'ok' : 'err'}`}>{fixGapsMsg}</div>
              )}
            </div>
          </div>

        </div>

        {/* Quick nav + reload */}
        <div className="sdp-quick-nav">
          <button
            type="button"
            className="sdp-btn-ghost"
            onClick={handleCheck}
            disabled={summaryLoading}
          >
            {summaryLoading ? 'Reloading…' : '↻ Reload summary'}
          </button>
          {refJobSession.refJobItems.length > 0 && (
            <button
              type="button"
              className="sdp-btn-secondary"
              onClick={() => refJobSession.openJobsSheet()}
            >
              {activeJobCount > 0 && (
                <span className="ref-jobs-active-pill" aria-live="polite" style={{ marginRight: '0.35rem' }}>
                  {activeJobCount}
                </span>
              )}
              View Jobs
            </button>
          )}
          {summaryErr && (
            <span className="sdp-msg--err" style={{ fontSize: 'var(--text-caption)' }}>{summaryErr}</span>
          )}
        </div>
      </div>

      {/* ── Data Catalog ──────────────────────────────────────────────────── */}

      {summary?.data_catalog ? (
        <CatalogTabs catalog={summary.data_catalog} />
      ) : (
        summaryLoading ? (
          <div className="sdp-catalog-loading">
            {[0, 1, 2, 3].map((i) => <div key={i} className="sdp-skeleton-card" />)}
          </div>
        ) : (
          summary?.ok === true && (
            <div className="sdp-info-banner">
              Data catalog not returned. Deploy a backend that includes <code>data_catalog</code> on{' '}
              <code>/readiness/summary</code>, then reload summary.
            </div>
          )
        )
      )}

      {/* ── Readiness Metrics ─────────────────────────────────────────────── */}

      <div className="sdp-section-divider">
        <span className="sdp-section-divider-label">Readiness metrics</span>
        <div className="sdp-section-divider-line" />
      </div>

      {snapshotEmpty && (
        <div className="sdp-warn-banner">
          ⚠ Snapshot table is empty for today — run Step 4 (Refresh snapshot) to populate it.
        </div>
      )}

      <div className="sdp-metrics-strip">
        <div className="sdp-metric">
          <div className="sdp-metric-label">Universe</div>
          <div className="sdp-metric-value">{fmt(summary?.universe_count)}</div>
          <div className="sdp-metric-sub">v_sepa_us_equity_universe</div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Unified snapshot rows</div>
          <div className="sdp-metric-value">{fmt(summary?.stock_unified_snapshot_row_count ?? null)}</div>
          <div className="sdp-metric-sub">
            cache_stock_snapshot
            {summary?.stock_unified_snapshot_last_fetched_at
              ? ` · ${fmtRelativeTime(summary.stock_unified_snapshot_last_fetched_at)}`
              : ''}
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Daily fill gaps (Step 3)</div>
          <div
            className={`sdp-metric-value ${
              vendorFillGap != null && vendorFillGap === 0 ? 'sdp-metric-value--accent' : ''
            }`}
          >
            {fmt(vendorFillGap)}
          </div>
          <div className="sdp-metric-sub">cache.last_minute_updated (NY) vs max(stock_day)</div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Price ready (live)</div>
          <div className="sdp-metric-value sdp-metric-value--accent">
            {fmt(live?.price_ready)}
          </div>
          <div className="sdp-metric-sub">
            of {fmt(live?.total_symbols)} symbols · v_sepa_symbol_price_readiness
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Snapshot — price ready</div>
          <div className={`sdp-metric-value ${snap?.price_ready ? 'sdp-metric-value--accent' : ''}`}>
            {fmt(snap?.price_ready)}
          </div>
          <div className="sdp-metric-sub">
            of {fmt(snap?.included_in_universe)} included · {fmt(snap?.rows_total)} total rows
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Fund cache valid</div>
          <div className={`sdp-metric-value ${summary?.fund_cache_view_exists === false ? '' : ''}`}>
            {summary?.fund_cache_view_exists === false
              ? 'View not created'
              : fmt(summary?.fund_cache_valid_count ?? null)}
          </div>
          <div className="sdp-metric-sub">v_sepa_symbol_fund_cache_readiness (optional)</div>
        </div>
      </div>

      {/* ── Notes breakdown ───────────────────────────────────────────────── */}

      <div className="sdp-section-card">
        <div className="sdp-section-card-header">
          <span className="sdp-section-card-title">Notes breakdown</span>
          <button
            type="button"
            className="sdp-btn-ghost"
            onClick={() => void loadSummary()}
            disabled={summaryLoading}
          >
            Refresh
          </button>
        </div>
        <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-dim)', marginBottom: 'var(--space-3)' }}>
          Symbols included in universe, not price-ready, today
        </div>
        <div className="table-scroll-x">
          <table className="sdp-table">
            <thead>
              <tr>
                <th>Notes</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.notes_breakdown?.length ?? 0) > 0 ? (
                summary!.notes_breakdown!.map((row) => (
                  <tr key={row.notes}>
                    <td><code>{row.notes}</code></td>
                    <td>{row.count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="sdp-table-empty">
                    {summaryLoading ? 'Loading…' : 'No rows — snapshot empty or all symbols are price-ready.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Celery queues ─────────────────────────────────────────────────── */}

      <div className="sdp-section-card">
        <div className="sdp-section-card-header">
          <span className="sdp-section-card-title">Celery broker queues</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {onOpenCelerySettings && (
              <button type="button" className="sdp-btn-ghost" onClick={onOpenCelerySettings}>
                Open Settings → Celery
              </button>
            )}
            <button
              type="button"
              className="sdp-btn-ghost"
              onClick={() => void loadQueues()}
              disabled={queuesLoading}
            >
              {queuesLoading ? 'Loading…' : 'Reload'}
            </button>
          </div>
        </div>
        {queuesErr && (
          <div className="sdp-msg--info" style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-caption)' }}>
            {queuesErr}
          </div>
        )}
        <div className="table-scroll-x">
          <table className="sdp-table">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Pending</th>
                <th>Running</th>
              </tr>
            </thead>
            <tbody>
              {queues.length > 0 ? (
                queues.map((q) => (
                  <tr key={q.name}>
                    <td>{q.display_name?.trim() || formatQueueLabel(q.name)}</td>
                    <td>{fmt(q.pending_broker)}</td>
                    <td>{fmt(q.running_celery)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="sdp-table-empty">
                    {queuesLoading ? 'Loading…' : 'No queue data.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Gaps Drawer ───────────────────────────────────────────────────── */}
      <GapsDrawer
        open={gapsDrawerOpen}
        onClose={() => setGapsDrawerOpen(false)}
        priceGap={priceGap}
        onRunBackfill={() => void runPriceGapBackfill()}
        backfillBusy={priceGapBusy}
        backfillMsg={priceGapMsg}
        backfillOk={priceGapOk}
        onRunBackfillSelected={(syms) => void runPriceGapBackfillSelected(syms)}
        backfillSelectedBusy={selectedGapBusy}
        backfillSelectedMsg={selectedGapMsg}
        backfillSelectedOk={selectedGapOk}
      />
    </div>
  )
}

/** Public export: wraps inner page with MassiveRefJobSessionProvider so TickerReferenceJobsSheet is available. */
export function SepaDataReadyPage(props: SepaDataReadyPageProps) {
  return (
    <MassiveRefJobSessionProvider>
      <SepaDataReadyPageInner {...props} />
    </MassiveRefJobSessionProvider>
  )
}
