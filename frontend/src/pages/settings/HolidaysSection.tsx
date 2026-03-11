import type { MarketHolidayRow } from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'

export interface HolidaysSectionProps {
  currentYear: number
  holidays: MarketHolidayRow[]
  holidaysYear: string
  setHolidaysYear: (v: string) => void
  holidaysLoading: boolean
  loadHolidays: () => void
  addDate: string
  setAddDate: (v: string) => void
  addLabel: string
  setAddLabel: (v: string) => void
  holidayMsg: { text: string; isErr: boolean }
  onAddHoliday: () => void
  onDeleteHoliday: (dateStr: string) => void
}

export function HolidaysSection({
  currentYear,
  holidays,
  holidaysYear,
  setHolidaysYear,
  holidaysLoading,
  loadHolidays,
  addDate,
  setAddDate,
  addLabel,
  setAddLabel,
  holidayMsg,
  onAddHoliday,
  onDeleteHoliday,
}: HolidaysSectionProps) {
  return (
    <div className="daemon-group" id="settings-holidays">
      <div className="daemon-group-header">
        <span className="daemon-group-title">US market holidays (NYSE)</span>
        <InfoTooltip text="Holidays used to decide trading days (e.g. Data page yellow (end)). Add or delete as needed." />
      </div>
      <div className="daemon-group-body">
        <div className="controls settings-holidays-filters" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
          <label>
            Year:
            <select
              value={holidaysYear}
              onChange={(e) => setHolidaysYear(e.target.value)}
              className="settings-holidays-input"
              aria-label="Filter holidays by year"
            >
              <option value="">All</option>
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-pause" onClick={loadHolidays} disabled={holidaysLoading}>
            Refresh
          </button>
        </div>
        <div className="settings-holidays-add-row">
          <label className="settings-holidays-add-label">
            Date
            <input
              type="date"
              value={addDate}
              onChange={(e) => setAddDate(e.target.value)}
              className="settings-holidays-input"
              aria-label="Holiday date"
            />
          </label>
          <label className="settings-holidays-add-label">
            Label
            <input
              type="text"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="e.g. New Year's Day"
              className="settings-holidays-input settings-holidays-input-text"
              aria-label="Holiday label"
            />
          </label>
          <button type="button" className="btn-resume" onClick={onAddHoliday} disabled={holidaysLoading}>
            Add
          </button>
        </div>
        {holidayMsg.text && (
          <div className={holidayMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: '0.5rem' }}>
            {holidayMsg.text}
          </div>
        )}
        {holidaysLoading ? (
          <p>Loading…</p>
        ) : holidays.length === 0 ? (
          <p>No holidays in database. Add a date and label below.</p>
        ) : (
          <table className="settings-holidays-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Date</th>
                <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Label</th>
                <th style={{ width: '4rem' }} />
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => (
                <tr key={h.holiday_date}>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{h.holiday_date}</td>
                  <td style={{ padding: '0.25rem 0.5rem' }}>{h.label ?? '—'}</td>
                  <td style={{ padding: '0.25rem' }}>
                    <button type="button" className="btn-pause" onClick={() => onDeleteHoliday(h.holiday_date)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
