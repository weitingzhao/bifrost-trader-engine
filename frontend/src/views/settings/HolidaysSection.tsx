import type { MarketHolidayRow } from '../../api'
import { msgErrorClass, msgOkClass } from '@/components/shared/appUi'
import { w9 } from '@/styles/wave9Classes'
import { InfoTooltip } from '../../components/InfoTooltip'
import { Button } from '@/components/ui/button'

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
    <div className={w9.daemonGroup} id="settings-holidays">
      <div className={w9.daemonGroupHeader}>
        <span className={w9.daemonGroupTitle}>US market holidays (NYSE)</span>
        <InfoTooltip text="Holidays used to decide trading days (e.g. Settings → Status → Feed → Interactive Brokers coverage yellow (end)). Add or delete as needed." />
      </div>
      <div className={w9.daemonGroupBody}>
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
              {Array.from({ length: currentYear + 2 - 2020 + 1 }, (_, i) => 2020 + i).map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </label>
          <Button type="button" variant="secondary" onClick={loadHolidays} disabled={holidaysLoading}>
            Refresh
          </Button>
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
          <Button type="button" onClick={onAddHoliday} disabled={holidaysLoading}>
            Add
          </Button>
        </div>
        {holidayMsg.text && (
          <div className={`settings-holidays-msg ${holidayMsg.isErr ? msgErrorClass : msgOkClass}`}>
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
                  <th>Exchange</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={`${h.exchange}-${h.holiday_date}`}>
                    <td className="settings-holidays-date-cell">{h.holiday_date}</td>
                    <td>{h.exchange}</td>
                    <td className="settings-holidays-label-cell">{h.label ?? h.name ?? '—'}</td>
                    <td>{h.status ?? '—'}</td>
                    <td style={{ fontSize: '0.75rem', opacity: 0.7 }}>{h.source ?? '—'}</td>
                    <td>
                      <Button type="button" variant="secondary" onClick={() => onDeleteHoliday(h.holiday_date)}>
                        Delete
                      </Button>
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
