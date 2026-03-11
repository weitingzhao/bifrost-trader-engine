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
  primaryAccountId: string
  setPrimaryAccountId: (v: string) => void
  streamPrimaryAccountId: string
  setStreamPrimaryAccountId: (v: string) => void
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
    primaryAccountId,
    setPrimaryAccountId,
    streamPrimaryAccountId,
    setStreamPrimaryAccountId,
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
  } = props

  return (
    <div id="settings-ib-connection" className="settings-ib-connection-group">
      <h3 className="settings-ib-group-title">IB Settings</h3>
      <div className="daemon-group" id="ib-primary">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Host User</span>
          <InfoTooltip text="Primary TWS: daemon + auto-trading + market data. One TWS per machine. Flex token used for this account's Flex Queries (e.g. Cash Transactions)." />
        </div>
        <div className="daemon-group-body">
          <div className="settings-ib-user-controls">
            <label className="settings-ib-user-label">
              IP/Host:
              <input
                type="text"
                value={ibHost}
                onChange={(e) => setIbHost(e.target.value)}
                placeholder="127.0.0.1"
                className="settings-ib-user-input"
              />
            </label>
            <label className="settings-ib-user-label">
              Port type:
              <select
                value={ibPortType}
                onChange={(e) => setIbPortType(e.target.value as PortType)}
                className="settings-ib-user-select"
              >
                <option value="tws_paper">TWS Paper (7497)</option>
                <option value="tws_live">TWS Live (7496)</option>
                <option value="gateway">Gateway (4002)</option>
              </select>
            </label>
          </div>
          <div className="settings-ib-user-controls settings-ib-user-token-row">
            <label className="settings-ib-user-label settings-ib-user-token-label">
              Flex token:
              <input
                type="text"
                placeholder="IB Flex token (for this account)"
                value={flexHostToken}
                onChange={(e) => setFlexHostToken(e.target.value)}
                className="settings-ib-user-token-input"
              />
            </label>
          </div>
        </div>
      </div>
      <div className="daemon-group" id="ib-second">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Second User</span>
          <InfoTooltip text="Second TWS (different machine): manual-only account. Leave empty if not used. Flex token for this account's Flex Queries." />
        </div>
        <div className="daemon-group-body">
          <div className="settings-ib-user-controls">
            <label className="settings-ib-user-label">
              IP/Host:
              <input
                type="text"
                value={ib2Host}
                onChange={(e) => setIb2Host(e.target.value)}
                placeholder="e.g. 192.168.10.31 (empty = disabled)"
                className="settings-ib-user-input"
              />
            </label>
            <label className="settings-ib-user-label">
              Port type:
              <select
                value={ib2PortType}
                onChange={(e) => setIb2PortType(e.target.value as PortType)}
                className="settings-ib-user-select"
                disabled={!ib2Host.trim()}
              >
                <option value="tws_paper">TWS Paper (7497)</option>
                <option value="tws_live">TWS Live (7496)</option>
                <option value="gateway">Gateway (4002)</option>
              </select>
            </label>
          </div>
          <div className="settings-ib-user-controls settings-ib-user-token-row">
            <label className="settings-ib-user-label settings-ib-user-token-label">
              Flex token:
              <input
                type="text"
                placeholder="IB Flex token (second IB, empty if not used)"
                value={flexSecondaryToken}
                onChange={(e) => setFlexSecondaryToken(e.target.value)}
                className="settings-ib-user-token-input"
                disabled={!ib2Host.trim()}
              />
            </label>
          </div>
        </div>
      </div>
      <div className="daemon-group" id="ib-trading-account">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Trading account (hedging & status)</span>
          <InfoTooltip text="The single IB account used by the daemon for auto-hedging and for writing status (positions, account summary). Must be one of Host User's managed accounts. Empty = use first account from Host User's TWS." />
        </div>
        <div className="daemon-group-body">
          <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <label>
              Account ID:
              <input
                type="text"
                value={primaryAccountId}
                onChange={(e) => setPrimaryAccountId(e.target.value)}
                placeholder="e.g. U17113214 (empty = first from Host User)"
                style={{ width: '12rem', marginLeft: '0.25rem' }}
              />
            </label>
          </div>
        </div>
      </div>
      <div className="daemon-group" id="ib-stream-accounts">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Stream accounts (Live page)</span>
          <InfoTooltip text="Account IDs used to categorize Market Streams on the Live page: Primary and Secondary. Positions from the primary account show as Primary; from the secondary as Secondary; from both as Both. Leave empty to hide the Account column and category filter." />
        </div>
        <div className="daemon-group-body">
          <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <label>
              Primary:
              <input
                type="text"
                value={streamPrimaryAccountId}
                onChange={(e) => setStreamPrimaryAccountId(e.target.value)}
                placeholder="e.g. U17113214 (empty = no label)"
                style={{ width: '12rem', marginLeft: '0.25rem' }}
                aria-label="Stream primary account ID"
              />
            </label>
            <label>
              Secondary:
              <input
                type="text"
                value={streamSecondaryAccountId}
                onChange={(e) => setStreamSecondaryAccountId(e.target.value)}
                placeholder="e.g. U98765432 (empty = no label)"
                style={{ width: '12rem', marginLeft: '0.25rem' }}
                aria-label="Stream secondary account ID"
              />
            </label>
          </div>
        </div>
      </div>
      <div className="daemon-group" id="ib-client-ids">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Client IDs</span>
          <InfoTooltip text="Per-role client IDs. Host = Host User; Secondary = Second IB (when configured). Market data is Host only—only the primary account has a data subscription; Secondary has no market data." />
        </div>
        <div className="daemon-group-body">
          <div className="flex-query-table-wrap">
            <table className="flex-query-table" aria-label="Client IDs by role and connection">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Host</th>
                  <th scope="col">Secondary</th>
                </tr>
              </thead>
              <tbody>
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
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="daemon-group" id="ib-flex">
        <div className="daemon-group-header">
          <span className="daemon-group-title">Flex Settings</span>
          <InfoTooltip text="One row per query type. Fill in Query IDs for Host and (optional) Second IB. Default Flex Query range is used when Fetch from IB (Flex) is called without a date range (e.g. from script or API). Tokens set above. See docs/FLEX_TRANSACTIONS.md." />
        </div>
        <div className="daemon-group-body">
          <div className="controls" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            <label>
              Default Flex Query range (days):
              <input
                type="number"
                min={1}
                max={9999}
                value={defaultFlexRangeDays}
                onChange={(e) => setDefaultFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 30))))}
                className="settings-flex-range-select"
                style={{ width: '5rem', marginLeft: '0.35rem' }}
                aria-label="Default Flex Query range in days"
              />
            </label>
            <label>
              Init Flex Query range (days):
              <input
                type="number"
                min={1}
                max={9999}
                value={initFlexRangeDays}
                onChange={(e) => setInitFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 360))))}
                className="settings-flex-range-select"
                style={{ width: '5rem', marginLeft: '0.35rem' }}
                aria-label="Init Flex Query range in days"
              />
            </label>
            <span className="section-hint" style={{ margin: 0 }}>Default: used when no from_date/to_date is sent (from_date = yesterday − N days, to_date = yesterday). Init: for initial/full pull (e.g. 360 days).</span>
          </div>
          <div className="flex-query-table-wrap">
            <table className="flex-query-table" aria-label="Flex Query IDs by type">
              <thead>
                <tr>
                  <th scope="col">Query type</th>
                  <th scope="col">Host</th>
                  <th scope="col">Secondary</th>
                </tr>
              </thead>
              <tbody>
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
                        aria-label={`${label} — Secondary Query ID`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
