import { useEffect, useState } from 'react'
import type { FlexAccountItem } from '../../types'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  DEFAULT_BARS_FETCH,
  DEFAULT_DAEMON,
  DEFAULT_LISTENER,
  DEFAULT_REFRESH_EXECUTIONS,
  DEFAULT_WORKER,
  FLEX_QUERY_TYPES,
} from './settingsConstants'

type PortType = 'tws_live' | 'tws_paper' | 'gateway'

export interface IbConnectionSectionProps {
  ibHost: string
  setIbHost: (v: string) => void
  ibPortType: PortType
  setIbPortType: (v: PortType) => void
  flexHostToken: string
  setFlexHostToken: (v: string) => void
  ib2Host: string
  setIb2Host: (v: string) => void
  ib2PortType: PortType
  setIb2PortType: (v: PortType) => void
  flexSecondaryToken: string
  setFlexSecondaryToken: (v: string) => void
  hostAccountId: string
  setHostAccountId: (v: string) => void
  streamHostAccountId: string
  setStreamHostAccountId: (v: string) => void
  streamSecondaryAccountId: string
  setStreamSecondaryAccountId: (v: string) => void
  clientIdDaemon: number
  setClientIdDaemon: (v: number) => void
  clientIdListener: number
  setClientIdListener: (v: number) => void
  ib2ClientIdListener: number
  setIb2ClientIdListener: (v: number) => void
  clientIdAccount: number
  setClientIdAccount: (v: number) => void
  ib2ClientIdAccount: number
  setIb2ClientIdAccount: (v: number) => void
  clientIdMarkets: number
  setClientIdMarkets: (v: number) => void
  clientIdWorker: number
  setClientIdWorker: (v: number) => void
  defaultFlexRangeDays: number
  setDefaultFlexRangeDays: (v: number) => void
  initFlexRangeDays: number
  setInitFlexRangeDays: (v: number) => void
  flexAccounts: FlexAccountItem[]
  setFlexAccounts: (v: FlexAccountItem[] | ((prev: FlexAccountItem[]) => FlexAccountItem[])) => void
  /** Current hash-based sub-anchor (e.g. ib-users); when set, the corresponding group is expanded. */
  activeSubId?: string
}

export function IbConnectionSection(props: IbConnectionSectionProps) {
  const {
    ibHost,
    setIbHost,
    ibPortType,
    setIbPortType,
    flexHostToken,
    setFlexHostToken,
    ib2Host,
    setIb2Host,
    ib2PortType,
    setIb2PortType,
    flexSecondaryToken,
    setFlexSecondaryToken,
    hostAccountId,
    setHostAccountId,
    streamHostAccountId,
    setStreamHostAccountId,
    streamSecondaryAccountId,
    setStreamSecondaryAccountId,
    clientIdDaemon,
    setClientIdDaemon,
    clientIdListener,
    setClientIdListener,
    ib2ClientIdListener,
    setIb2ClientIdListener,
    clientIdAccount,
    setClientIdAccount,
    ib2ClientIdAccount,
    setIb2ClientIdAccount,
    clientIdMarkets,
    setClientIdMarkets,
    clientIdWorker,
    setClientIdWorker,
    defaultFlexRangeDays,
    setDefaultFlexRangeDays,
    initFlexRangeDays,
    setInitFlexRangeDays,
    flexAccounts,
    setFlexAccounts,
    activeSubId,
  } = props

  const [userGroupOpen, setUserGroupOpen] = useState(false)
  const [clientIdGroupOpen, setClientIdGroupOpen] = useState(false)
  const [streamAccountsGroupOpen, setStreamAccountsGroupOpen] = useState(false)
  const [flexQueryGroupOpen, setFlexQueryGroupOpen] = useState(false)

  // When user clicks a sidebar link: expand the target group, collapse the others, and scroll to it.
  useEffect(() => {
    if (!activeSubId) return
    setUserGroupOpen(activeSubId === 'ib-users')
    setClientIdGroupOpen(activeSubId === 'ib-client-ids')
    setStreamAccountsGroupOpen(activeSubId === 'ib-account')
    setFlexQueryGroupOpen(activeSubId === 'ib-flex-query')
  }, [activeSubId])

  return (
    <div id="settings-ib-connection" className="settings-ib-connection-group">
      <div className="daemon-group settings-ib-config-sheet" id="ib-config-sheet">
        <div className="daemon-group-header">
          <span className="daemon-group-title">IB Configure</span>
          <InfoTooltip text="Configure two IB connections: Host (TWS for daemon, auto-trading, market data) and Secondary (optional second TWS). Expand each group below to edit. Flex range preferences are at the bottom." />
        </div>
        <p className="settings-ib-config-subtitle">Host and Secondary (optional second TWS). Same fields for each.</p>
        <div className="daemon-group-body">
          <section className="settings-ib-section">
            <h3 className="settings-ib-config-sheet-title">User client related settings</h3>
            <div className="flex-query-table-wrap settings-ib-config-table-wrap">
            <table className="flex-query-table settings-ib-config-table" aria-label="User client related settings: Host and Secondary">
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
                <tr
                  id="ib-users"
                  className="settings-ib-collapsible-group-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setUserGroupOpen((o) => !o)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setUserGroupOpen((o) => !o) } }}
                  aria-expanded={userGroupOpen}
                  aria-label="User group"
                >
                  <td colSpan={3} className="settings-ib-collapsible-group-header">
                    <span className={`settings-ib-collapsible-chevron ${userGroupOpen ? 'open' : ''}`} aria-hidden>▼</span>
                    <span className="settings-ib-collapsible-group-title">User</span>
                  </td>
                </tr>
                {userGroupOpen && (
                  <>
                <tr>
                  <td className="flex-query-cell-type">IP/Host</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="text"
                      value={ibHost}
                      onChange={(e) => setIbHost(e.target.value)}
                      placeholder="127.0.0.1"
                      className="flex-query-input"
                      aria-label="IP/Host — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="text"
                      value={ib2Host}
                      onChange={(e) => setIb2Host(e.target.value)}
                      placeholder="e.g. 192.168.10.31 (empty = disabled)"
                      className="flex-query-input"
                      aria-label="IP/Host — Secondary"
                    />
                  </td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Port type</td>
                  <td className="flex-query-cell-input">
                    <select
                      value={ibPortType}
                      onChange={(e) => setIbPortType(e.target.value as PortType)}
                      className="flex-query-input"
                      aria-label="Port type — Host"
                    >
                      <option value="tws_paper">TWS Paper (7497)</option>
                      <option value="tws_live">TWS Live (7496)</option>
                      <option value="gateway">Gateway (4002)</option>
                    </select>
                  </td>
                  <td className="flex-query-cell-input">
                    <select
                      value={ib2PortType}
                      onChange={(e) => setIb2PortType(e.target.value as PortType)}
                      className="flex-query-input"
                      disabled={!ib2Host.trim()}
                      aria-label="Port type — Secondary"
                    >
                      <option value="tws_paper">TWS Paper (7497)</option>
                      <option value="tws_live">TWS Live (7496)</option>
                      <option value="gateway">Gateway (4002)</option>
                    </select>
                  </td>
                </tr>
                  </>
                )}
                <tr
                  className="settings-ib-collapsible-group-row"
                  id="ib-client-ids"
                  role="button"
                  tabIndex={0}
                  onClick={() => setClientIdGroupOpen((o) => !o)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setClientIdGroupOpen((o) => !o) } }}
                  aria-expanded={clientIdGroupOpen}
                  aria-label="Client ID group"
                >
                  <td colSpan={3} className="settings-ib-collapsible-group-header">
                    <span className={`settings-ib-collapsible-chevron ${clientIdGroupOpen ? 'open' : ''}`} aria-hidden>▼</span>
                    <span className="settings-ib-collapsible-group-title">Client ID</span>
                  </td>
                </tr>
                {clientIdGroupOpen && (
                  <>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Daemon</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Trading</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdDaemon}
                      onChange={(e) => setClientIdDaemon(parseInt(e.target.value, 10) || DEFAULT_DAEMON)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Trading — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Listener</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdListener}
                      onChange={(e) => setClientIdListener(parseInt(e.target.value, 10) || DEFAULT_LISTENER)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Listener — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={ib2ClientIdListener}
                      onChange={(e) => setIb2ClientIdListener(parseInt(e.target.value, 10) || 3)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Listener — Secondary"
                    />
                  </td>
                </tr>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Monitor</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Account</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdAccount}
                      onChange={(e) => setClientIdAccount(parseInt(e.target.value, 10) || DEFAULT_REFRESH_EXECUTIONS)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Account — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={ib2ClientIdAccount}
                      onChange={(e) => setIb2ClientIdAccount(parseInt(e.target.value, 10) || 102)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Account — Secondary"
                    />
                  </td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Market data</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={clientIdMarkets}
                      onChange={(e) => setClientIdMarkets(parseInt(e.target.value, 10) || DEFAULT_BARS_FETCH)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Market data — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                <tr className="client-ids-group-row">
                  <td colSpan={3} className="client-ids-group-header">Celery</td>
                </tr>
                <tr>
                  <td className="flex-query-cell-type">Market Data</td>
                  <td className="flex-query-cell-input">
                    <input
                      type="number"
                      min={1}
                      max={999}
                      value={clientIdWorker}
                      onChange={(e) => setClientIdWorker(parseInt(e.target.value, 10) || DEFAULT_WORKER)}
                      className="flex-query-input"
                      style={{ width: '4rem' }}
                      aria-label="Market Data (worker_market) — Host"
                    />
                  </td>
                  <td className="flex-query-cell-input">—</td>
                </tr>
                  </>
                )}
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
