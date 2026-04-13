import { useEffect, useState } from 'react'
import type { FlexAccountItem } from '../../types'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  FLEX_QUERY_TYPES,
} from './settingsConstants'

type PortType = 'tws_live' | 'tws_paper' | 'gateway'

export interface IbConnectionSectionProps {
  ibHost: string
  ibPortType: PortType
  flexHostToken: string
  setFlexHostToken: (v: string) => void
  ib2Host: string
  ib2PortType: PortType
  flexSecondaryToken: string
  setFlexSecondaryToken: (v: string) => void
  hostAccountId: string
  setHostAccountId: (v: string) => void
  streamHostAccountId: string
  setStreamHostAccountId: (v: string) => void
  streamSecondaryAccountId: string
  setStreamSecondaryAccountId: (v: string) => void
  clientIdDaemon: number
  clientIdListener: number
  ib2ClientIdListener: number
  clientIdOperator: number
  ib2ClientIdOperator: number
  /** IB ingestor client ID (Host only; YAML ib.host.client_id.ingestor). */
  clientIdIbIngestor: number
  /** IB Account Agent — Host (YAML ib.host.client_id.account_agent). */
  clientIdAccountAgent: number
  /** IB Account Agent — Secondary (YAML ib.secondary.client_id.account_agent). */
  ib2ClientIdAccountAgent: number
  clientIdWorker: number
  defaultFlexRangeDays: number
  setDefaultFlexRangeDays: (v: number) => void
  initFlexRangeDays: number
  setInitFlexRangeDays: (v: number) => void
  flexAccounts: FlexAccountItem[]
  setFlexAccounts: (v: FlexAccountItem[] | ((prev: FlexAccountItem[]) => FlexAccountItem[])) => void
  /** Current hash-based sub-anchor; expands Account / Flex Query groups. User & Client ID are always visible. */
  activeSubId?: string
}

export function IbConnectionSection(props: IbConnectionSectionProps) {
  const {
    ibHost,
    ibPortType,
    flexHostToken,
    setFlexHostToken,
    ib2Host,
    ib2PortType,
    flexSecondaryToken,
    setFlexSecondaryToken,
    hostAccountId,
    setHostAccountId,
    streamHostAccountId,
    setStreamHostAccountId,
    streamSecondaryAccountId,
    setStreamSecondaryAccountId,
    clientIdDaemon,
    clientIdListener,
    ib2ClientIdListener,
    clientIdOperator,
    ib2ClientIdOperator,
    clientIdIbIngestor,
    clientIdAccountAgent,
    ib2ClientIdAccountAgent,
    clientIdWorker,
    defaultFlexRangeDays,
    setDefaultFlexRangeDays,
    initFlexRangeDays,
    setInitFlexRangeDays,
    flexAccounts,
    setFlexAccounts,
    activeSubId,
  } = props

  const [streamAccountsGroupOpen, setStreamAccountsGroupOpen] = useState(false)
  const [flexQueryGroupOpen, setFlexQueryGroupOpen] = useState(false)

  // Sidebar anchor: expand editable groups only (User & Client ID are always visible, read-only).
  useEffect(() => {
    if (!activeSubId) return
    setStreamAccountsGroupOpen(activeSubId === 'ib-account')
    setFlexQueryGroupOpen(activeSubId === 'ib-flex-query')
  }, [activeSubId])

  return (
    <div id="settings-ib-connection" className="settings-ib-connection-group">
      <div className="daemon-group settings-ib-config-sheet" id="ib-config-sheet">
        <div className="daemon-group-header">
          <span className="daemon-group-title">IB Configure</span>
          <InfoTooltip text="User and Client ID blocks are read-only and reflect config.yaml. Edit that file and restart processes to change host, port, or client IDs. Account, Flex Query, and preferences below can still be saved to the database." />
        </div>
        <p className="settings-ib-config-subtitle">Host, Secondary, and all Client IDs come from config.yaml (ib.host and optional ib.secondary). Read-only below. Account stream IDs, Flex, and range preferences are saved via this page.</p>
        <div className="daemon-group-body">
          <section className="settings-ib-section">
            <h3 className="settings-ib-config-sheet-title">Host &amp; Client ID (read-only · YAML)</h3>
            <div className="flex-query-table-wrap settings-ib-config-table-wrap">
            <table className="flex-query-table settings-ib-config-table" aria-label="IB connection: read-only User and Client ID from config.yaml; editable Account and Flex below">
              <colgroup>
                <col className="settings-ib-config-col-label" />
                <col className="settings-ib-config-col-host" />
                <col className="settings-ib-config-col-secondary" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="settings-ib-config-th-label" aria-label="Field" />
                  <th scope="col" className="settings-ib-config-th-host">Host</th>
                  <th scope="col" className="settings-ib-config-th-secondary">Secondary</th>
                </tr>
              </thead>
              <tbody>
                <tr id="ib-users" className="settings-ib-readonly-section-header">
                  <td colSpan={3}>
                    <span className="settings-ib-collapsible-group-title">User</span>
                    <span className="settings-ib-readonly-badge" aria-hidden>Read-only</span>
                    <span className="settings-ib-readonly-inline-hint">IP/host and port type from config.yaml.</span>
                  </td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">IP/Host</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="text"
                      value={ibHost}
                      readOnly
                      placeholder="127.0.0.1"
                      className="flex-query-input settings-ib-readonly-field"
                      aria-label="IP/Host — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="text"
                      value={ib2Host}
                      readOnly
                      placeholder="e.g. 192.168.10.31 (empty = disabled)"
                      className="flex-query-input settings-ib-readonly-field"
                      aria-label="IP/Host — Secondary (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Port type</td>
                  <td className="flex-query-cell-input">
                    <select
                      value={ibPortType}
                      className="flex-query-input settings-ib-readonly-field"
                      disabled
                      aria-label="Port type — Host (read-only, config.yaml)"
                    >
                      <option value="tws_paper">TWS Paper (7497)</option>
                      <option value="tws_live">TWS Live (7496)</option>
                      <option value="gateway">Gateway (4002)</option>
                    </select>
                  </td>
                  <td className="flex-query-cell-input">
                    <select
                      value={ib2PortType}
                      className="flex-query-input settings-ib-readonly-field"
                      disabled
                      aria-label="Port type — Secondary (read-only, config.yaml)"
                    >
                      <option value="tws_paper">TWS Paper (7497)</option>
                      <option value="tws_live">TWS Live (7496)</option>
                      <option value="gateway">Gateway (4002)</option>
                    </select>
                  </td>
                </tr>
                <tr id="ib-client-ids" className="settings-ib-readonly-section-header">
                  <td colSpan={3}>
                    <span className="settings-ib-collapsible-group-title">Client ID</span>
                    <span className="settings-ib-readonly-badge" aria-hidden>Read-only</span>
                    <span className="settings-ib-readonly-inline-hint">From config.yaml; restart processes after changes.</span>
                  </td>
                </tr>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Daemon</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Trading</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdDaemon}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="Trading — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Listener</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdListener}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="Listener — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={ib2ClientIdListener}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="Listener — Secondary (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                </tr>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Socket Services</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Operator (cmd RPC)</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdOperator}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="IB Operator (cmd RPC) client ID — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    {ib2Host.trim() ? (
                      <input
                        type="number"
                        value={ib2ClientIdOperator}
                        readOnly
                        className="flex-query-input settings-ib-readonly-field"
                        style={{ width: '4rem' }}
                        aria-label="IB Operator (cmd RPC) client ID — Secondary (read-only, config.yaml)"
                        tabIndex={-1}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">
                    Ingestor
                    <InfoTooltip text="Client ID for scripts/systemd/run_ib_ingestor.py (YAML ib.host.client_id.ingestor; legacy key ib_market_ingest still read server-side). Host only — Secondary has no ingestor client." />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdIbIngestor}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="IB ingestor client ID — Host (read-only, config.yaml ib.host.client_id.ingestor)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">
                    Account Agent
                    <InfoTooltip text="Client IDs for scripts/systemd/run_ib_account_agent.py: Host uses ib.host.client_id.account_agent; Secondary uses ib.secondary.client_id.account_agent when Second IB is configured. Distinct from Operator and Ingestor." />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdAccountAgent}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="IB Account Agent client ID — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    {ib2Host.trim() ? (
                      <input
                        type="number"
                        value={ib2ClientIdAccountAgent}
                        readOnly
                        className="flex-query-input settings-ib-readonly-field"
                        style={{ width: '4rem' }}
                        aria-label="IB Account Agent client ID — Secondary (read-only, config.yaml)"
                        tabIndex={-1}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Celery</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Market Data</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      value={clientIdWorker}
                      readOnly
                      className="flex-query-input settings-ib-readonly-field"
                      style={{ width: '4rem' }}
                      aria-label="Market Data (worker_market) — Host (read-only, config.yaml)"
                      tabIndex={-1}
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                <tr
                  id="ib-account"
                  className="settings-ib-collapsible-group-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setStreamAccountsGroupOpen((o) => !o)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStreamAccountsGroupOpen((o) => !o) } }}
                  aria-expanded={streamAccountsGroupOpen}
                  aria-label="Account group"
                >
                  <td colSpan={3} className="settings-ib-collapsible-group-header">
                    <span className={`settings-ib-collapsible-chevron ${streamAccountsGroupOpen ? 'open' : ''}`} aria-hidden>▼</span>
                    <span className="settings-ib-collapsible-group-title">Account</span>
                  </td>
                </tr>
                {streamAccountsGroupOpen && (
                  <>
                  <tr>
                    <td className="flex-query-cell-type">Event Account</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="text"
                        value={streamHostAccountId}
                        onChange={(e) => setStreamHostAccountId(e.target.value)}
                        placeholder="Host (e.g. U17113214)"
                        className="flex-query-input"
                        style={{ maxWidth: '100%' }}
                        aria-label="Stream host account ID — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">
                      <input
                        type="text"
                        value={streamSecondaryAccountId}
                        onChange={(e) => setStreamSecondaryAccountId(e.target.value)}
                        placeholder="Secondary (e.g. U98765432)"
                        className="flex-query-input"
                        style={{ maxWidth: '100%' }}
                        aria-label="Stream secondary account ID — Secondary"
                      />
                    </td>
                  </tr>
                  <tr id="ib-trading-account">
                    <td className="flex-query-cell-type">Trading Account</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="text"
                        value={hostAccountId}
                        onChange={(e) => setHostAccountId(e.target.value)}
                        placeholder="e.g. U17113214 (empty = first from Host User)"
                        className="flex-query-input"
                        style={{ maxWidth: '100%' }}
                        aria-label="Trading Account — Host"
                        title="The single IB account used by the daemon for auto-hedging and for writing status (positions, account summary). Must be one of Host User's managed accounts. Empty = use first account from Host User's TWS."
                      />
                    </td>
                    <td className="flex-query-cell-input">—</td>
                  </tr>
                  </>
                )}
                <tr
                  id="ib-flex-query"
                  className="settings-ib-collapsible-group-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setFlexQueryGroupOpen((o) => !o)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFlexQueryGroupOpen((o) => !o) } }}
                  aria-expanded={flexQueryGroupOpen}
                  aria-label="Flex Query group"
                >
                  <td colSpan={3} className="settings-ib-collapsible-group-header">
                    <span className={`settings-ib-collapsible-chevron ${flexQueryGroupOpen ? 'open' : ''}`} aria-hidden>▼</span>
                    <span className="settings-ib-collapsible-group-title">Flex Query</span>
                  </td>
                </tr>
                {flexQueryGroupOpen && (
                  <>
                    <tr>
                      <td className="flex-query-cell-type">Flex token</td>
                      <td className="flex-query-cell-input">
                        <input
                          type="text"
                          placeholder="IB Flex token (Host account)"
                          value={flexHostToken}
                          onChange={(e) => setFlexHostToken(e.target.value)}
                          className="flex-query-input"
                          style={{ maxWidth: '100%' }}
                          aria-label="Flex token — Host"
                        />
                      </td>
                      <td className="flex-query-cell-input">
                        <input
                          type="text"
                          placeholder="IB Flex token (empty if not used)"
                          value={flexSecondaryToken}
                          onChange={(e) => setFlexSecondaryToken(e.target.value)}
                          className="flex-query-input"
                          style={{ maxWidth: '100%' }}
                          disabled={!ib2Host.trim()}
                          aria-label="Flex token — Secondary"
                        />
                      </td>
                    </tr>
                    {FLEX_QUERY_TYPES.map(({ purpose, label }, i) => (
                      <tr key={purpose}>
                        <td className="flex-query-cell-type">{label}</td>
                        <td className="flex-query-cell-input">
                          <input
                            type="text"
                            placeholder="Query ID"
                            value={flexAccounts[i]?.query_host_id ?? ''}
                            onChange={(e) => {
                              const next = [...flexAccounts]
                              if (!next[i]) next[i] = { purpose, query_label: label, query_host_id: '', query_secondary_id: '' }
                              next[i] = { ...next[i], query_host_id: e.target.value }
                              setFlexAccounts(next)
                            }}
                            className="flex-query-input"
                            style={{ maxWidth: '100%' }}
                            aria-label={`${label} — Host Query ID`}
                          />
                        </td>
                        <td className="flex-query-cell-input">
                          <input
                            type="text"
                            placeholder="Query ID"
                            value={flexAccounts[i]?.query_secondary_id ?? ''}
                            onChange={(e) => {
                              const next = [...flexAccounts]
                              if (!next[i]) next[i] = { purpose, query_label: label, query_host_id: '', query_secondary_id: '' }
                              next[i] = { ...next[i], query_secondary_id: e.target.value }
                              setFlexAccounts(next)
                            }}
                            className="flex-query-input"
                            style={{ maxWidth: '100%' }}
                            aria-label={`${label} — Secondary Query ID`}
                          />
                        </td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
          </section>
          <section className="settings-ib-section settings-ib-preference-section">
            <h3 className="settings-ib-config-sheet-title">IB Preference</h3>
            <div id="flex-preference" className="settings-flex-preference">
              <h4 className="settings-flex-preference-title">Flex Preference</h4>
              <p className="settings-ib-config-subtitle">Default ranges for Flex Query when no date range is sent. Init: for initial/full pull.</p>
              <div className="controls settings-ib-preference-controls">
                <label className="settings-ib-preference-range-row">
                  Default range
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={defaultFlexRangeDays}
                    onChange={(e) => setDefaultFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 30))))}
                    className="settings-flex-range-select"
                    aria-label="Default Flex Query range in days"
                  />
                  <span className="settings-ib-range-suffix">days</span>
                </label>
                <label className="settings-ib-preference-range-row">
                  Init range
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={initFlexRangeDays}
                    onChange={(e) => setInitFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 360))))}
                    className="settings-flex-range-select"
                    aria-label="Init Flex Query range in days"
                  />
                  <span className="settings-ib-range-suffix">days</span>
                </label>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
