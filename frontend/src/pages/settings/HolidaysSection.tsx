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
        <div className="controls settings-holidays-filters">
          <label>
            Year
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
          <div className={`settings-holidays-msg ${holidayMsg.isErr ? 'msg-error' : 'msg-ok'}`}>
            {holidayMsg.text}
          </div>
        )}
        {holidaysLoading ? (
          <p className="settings-holidays-empty">Loading…</p>
        ) : holidays.length === 0 ? (
          <p className="settings-holidays-empty">No holidays in database. Add a date and label below.</p>
        ) : (
          <div className="settings-holidays-table-wrap">
            <table className="settings-holidays-table" aria-label="US market holidays">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Label</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={h.holiday_date}>
                    <td className="settings-holidays-date-cell">{h.holiday_date}</td>
                    <td className="settings-holidays-label-cell">{h.label ?? '—'}</td>
                    <td>
                      <button type="button" className="btn-pause" onClick={() => onDeleteHoliday(h.holiday_date)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
