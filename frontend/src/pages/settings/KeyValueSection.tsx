import { InfoTooltip } from '../../components/InfoTooltip'

export interface KeyValueItemRow {
  key: string
  value: string
  description?: string | null
  updated_at?: string
  group_id?: number
}

export interface KeyValueGroupRow {
  id: number
  name: string
  description?: string | null
  sort_order?: number
}

export interface KeyValueSectionProps {
  keyValueItems: KeyValueItemRow[]
  keyValueLoading: boolean
  keyValueMsg: { text: string; isErr: boolean }
  keyValueGroups: KeyValueGroupRow[]
  selectedGroupName: string | null
  setSelectedGroupName: (v: string | null) => void
  newGroupName: string
  setNewGroupName: (v: string) => void
  newGroupDesc: string
  setNewGroupDesc: (v: string) => void
  editingGroupName: string | null
  setEditingGroupName: (v: string | null) => void
  editGroupName: string
  setEditGroupName: (v: string) => void
  editGroupDesc: string
  setEditGroupDesc: (v: string) => void
  newKey: string
  setNewKey: (v: string) => void
  newValue: string
  setNewValue: (v: string) => void
  newDesc: string
  setNewDesc: (v: string) => void
  editingKey: string | null
  setEditingKey: (v: string | null) => void
  editValue: string
  setEditValue: (v: string) => void
  editDesc: string
  setEditDesc: (v: string) => void
  loadKeyValueItemsForGroup: (groupName: string) => Promise<void>
  onAddGroup: () => Promise<void>
  onRefreshGroups: () => Promise<void>
  onSaveGroup: (group: KeyValueGroupRow) => Promise<void>
  onCancelEditGroup: () => void
  onStartEditGroup: (group: KeyValueGroupRow) => void
  onDeleteGroup: (group: KeyValueGroupRow) => Promise<void>
  onAddKeyValue: () => Promise<void>
  onClearSelection: () => void
  onSaveKeyValue: (row: KeyValueItemRow) => Promise<void>
  onCancelEditKey: () => void
  onStartEditKey: (row: KeyValueItemRow) => void
  onDeleteKeyValue: (row: KeyValueItemRow) => Promise<void>
}

export function KeyValueSection(props: KeyValueSectionProps) {
  const {
    keyValueItems,
    keyValueLoading,
    keyValueMsg,
    keyValueGroups,
    selectedGroupName,
    setSelectedGroupName,
    newGroupName,
    setNewGroupName,
    newGroupDesc,
    setNewGroupDesc,
    editingGroupName,
    editGroupName,
    setEditGroupName,
    editGroupDesc,
    setEditGroupDesc,
    newKey,
    setNewKey,
    newValue,
    setNewValue,
    newDesc,
    setNewDesc,
    editingKey,
    editValue,
    setEditValue,
    editDesc,
    setEditDesc,
    loadKeyValueItemsForGroup,
    onAddGroup,
    onRefreshGroups,
    onSaveGroup,
    onCancelEditGroup,
    onStartEditGroup,
    onDeleteGroup,
    onAddKeyValue,
    onClearSelection,
    onSaveKeyValue,
    onCancelEditKey,
    onStartEditKey,
    onDeleteKeyValue,
  } = props

  return (
    <div className="daemon-group" id="settings-key-value">
      <div className="daemon-group-header">
        <span className="daemon-group-title">Key-Value Config</span>
        <InfoTooltip text="Key-value options are grouped by Group. Each group can back a dropdown or option set (e.g. flex_settings for Flex default range). Add groups first, then select a group to add/edit key-value rows." />
      </div>
      <div className="daemon-group-body">
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Groups</h4>
        <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
          <input
            type="text"
            placeholder="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            className="settings-key-value-input"
            aria-label="New group name"
            style={{ width: '10rem' }}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newGroupDesc}
            onChange={(e) => setNewGroupDesc(e.target.value)}
            className="settings-key-value-input"
            aria-label="Group description"
            style={{ width: '14rem' }}
          />
          <button type="button" className="btn-resume" onClick={onAddGroup}>
            Add group
          </button>
          <button type="button" className="btn-pause" onClick={onRefreshGroups} disabled={keyValueLoading}>
            Refresh groups
          </button>
        </div>
        {keyValueGroups.length === 0 && !keyValueLoading ? (
          <p className="section-hint">No groups yet. Add a group name above (e.g. flex_range_options).</p>
        ) : (
          <table className="settings-key-value-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', marginBottom: '1rem' }} aria-label="Key-Value Groups">
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Name</th>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Description</th>
                <th style={{ width: '10rem' }} />
              </tr>
            </thead>
            <tbody>
              {keyValueGroups.map((g) => (
                <tr key={g.id}>
                  <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace' }}>
                    {editingGroupName === g.name ? (
                      <input type="text" value={editGroupName} onChange={(e) => setEditGroupName(e.target.value)} className="settings-key-value-input" style={{ width: '100%' }} aria-label="Edit group name" />
                    ) : (
                      g.name
                    )}
                  </td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>
                    {editingGroupName === g.name ? (
                      <input type="text" value={editGroupDesc} onChange={(e) => setEditGroupDesc(e.target.value)} placeholder="Optional" className="settings-key-value-input" style={{ width: '100%' }} aria-label="Edit group description" />
                    ) : (
                      g.description ?? '—'
                    )}
                  </td>
                  <td style={{ padding: '0.25rem' }}>
                    {editingGroupName === g.name ? (
                      <>
                        <button type="button" className="btn-resume" onClick={() => onSaveGroup(g)} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Save</button>
                        <button type="button" className="btn-pause" onClick={onCancelEditGroup} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn-resume" onClick={() => { setSelectedGroupName(g.name); loadKeyValueItemsForGroup(g.name) }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Select</button>
                        <button type="button" className="btn-resume" onClick={() => onStartEditGroup(g)} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Edit</button>
                        <button type="button" className="btn-pause" onClick={() => onDeleteGroup(g)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selectedGroupName != null && (
          <>
            <h4 style={{ marginBottom: '0.5rem' }}>Key-Values for group: {keyValueGroups.find(g => g.name === selectedGroupName)?.name ?? selectedGroupName}</h4>
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <input type="text" placeholder="Key" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="settings-key-value-input" aria-label="New key" style={{ width: '12rem' }} />
              <input type="text" placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="settings-key-value-input" aria-label="New value" style={{ width: '10rem' }} />
              <input type="text" placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className="settings-key-value-input" aria-label="Description" style={{ width: '14rem' }} />
              <button type="button" className="btn-resume" onClick={onAddKeyValue}>
                Add key-value
              </button>
              <button type="button" className="btn-pause" onClick={onClearSelection}>Clear selection</button>
            </div>
            {keyValueMsg.text && (
              <div className={keyValueMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: '0.5rem' }}>{keyValueMsg.text}</div>
            )}
            {keyValueLoading ? (
              <p>Loading…</p>
            ) : keyValueItems.length === 0 ? (
              <p className="section-hint">No key-values in this group. Add key/value above.</p>
            ) : (
              <table className="settings-key-value-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }} aria-label="Key-Values in group">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Key</th>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Value</th>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Description</th>
                    <th style={{ width: '9rem', minWidth: '9rem', textAlign: 'left', padding: '0.25rem 0.5rem' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {keyValueItems.map((row) => (
                    <tr key={`${selectedGroupName}-${row.key}`}>
                      <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace' }}>{row.key}</td>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        {editingKey === row.key ? (
                          <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)} className="settings-key-value-input" style={{ width: '100%', maxWidth: '14rem' }} aria-label={`Edit value for ${row.key}`} />
                        ) : (
                          <span>{row.value}</span>
                        )}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        {editingKey === row.key ? (
                          <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Optional" className="settings-key-value-input" style={{ width: '100%', maxWidth: '12rem' }} aria-label={`Edit description for ${row.key}`} />
                        ) : (
                          <span>{row.description ?? '—'}</span>
                        )}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem', whiteSpace: 'nowrap' }}>
                        {editingKey === row.key ? (
                          <>
                            <button type="button" className="btn-resume" onClick={() => onSaveKeyValue(row)} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Save</button>
                            <button type="button" className="btn-pause" onClick={onCancelEditKey} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn-resume" onClick={() => onStartEditKey(row)} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Edit</button>
                            <button type="button" className="btn-pause" onClick={() => onDeleteKeyValue(row)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}
