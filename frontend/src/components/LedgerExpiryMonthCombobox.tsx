import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatExpiryMonthKey } from '../utils/ledgerFilterSuggestions'

export interface LedgerExpiryMonthComboboxProps {
  /** `YYYY-MM` or empty string for no filter */
  value: string
  onChange: (monthKey: string) => void
  monthKeys: string[]
  disabled?: boolean
  'aria-label'?: string
  className?: string
  inputClassName?: string
}

function monthMatchesQuery(key: string, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const label = formatExpiryMonthKey(key).toLowerCase()
  const compact = key.replace(/-/g, '')
  const qCompact = s.replace(/[^0-9]/g, '')
  return (
    key.toLowerCase().includes(s) ||
    label.includes(s) ||
    (qCompact.length > 0 && compact.includes(qCompact))
  )
}

/**
 * Searchable combobox for expiry month (YYYY-MM); list is filtered from loaded ledger months + fallback range.
 */
export function LedgerExpiryMonthCombobox({
  value,
  onChange,
  monthKeys,
  disabled = false,
  'aria-label': ariaLabel = 'Expiry month filter',
  className = '',
  inputClassName = '',
}: LedgerExpiryMonthComboboxProps) {
  const reactId = useId()
  const listboxId = `${reactId}-exp-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const closedDisplay = value.trim() ? formatExpiryMonthKey(value.trim()) : 'All expiries'
  /** Same tone as Search symbol placeholder (replay-filter-input::placeholder). */
  const closedValueDim = !open && !value.trim()

  const filtered = useMemo(() => monthKeys.filter(k => monthMatchesQuery(k, query)), [monthKeys, query])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  return (
    <div ref={rootRef} className={`ledger-expiry-combobox ${className}`.trim()}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        disabled={disabled}
        readOnly={!open}
        autoComplete="off"
        spellCheck={false}
        placeholder={open ? 'Search expiry month…' : undefined}
        title={!open && !disabled ? 'Expiry month filter — click to search or pick' : undefined}
        className={`replay-filter-input replay-filter-select ledger-expiry-combobox__input ${
          closedValueDim ? 'ledger-filter-combobox__value--dim' : ''
        } ${inputClassName}`.trim()}
        value={open ? query : closedDisplay}
        onChange={e => {
          if (disabled) return
          setOpen(true)
          setQuery(e.target.value)
        }}
        onFocus={() => {
          if (disabled) return
          setOpen(true)
          setQuery('')
        }}
        onKeyDown={e => {
          if (
            e.key === 'Enter' &&
            open &&
            filtered.length === 1 &&
            value.trim() !== filtered[0]
          ) {
            e.preventDefault()
            onChange(filtered[0])
            close()
          }
        }}
      />
      {open && !disabled ? (
        <ul id={listboxId} role="listbox" className="ledger-filter-combobox__list">
          <li
            role="option"
            aria-selected={!value.trim()}
            className={`ledger-filter-combobox__option ${!value.trim() ? 'ledger-filter-combobox__option--active' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              onChange('')
              close()
            }}
          >
            All expiries
          </li>
          {filtered.map(k => {
            const active = value.trim() === k
            const sub = k.replace(/-/g, '')
            return (
              <li
                key={k}
                role="option"
                aria-selected={active}
                className={`ledger-filter-combobox__option ${active ? 'ledger-filter-combobox__option--active' : ''}`}
                onMouseDown={e => {
                  e.preventDefault()
                  onChange(k)
                  close()
                }}
              >
                <span className="ledger-filter-combobox__option-title">{formatExpiryMonthKey(k)}</span>
                <span className="ledger-filter-combobox__option-sub">{sub}</span>
              </li>
            )
          })}
          {filtered.length === 0 ? (
            <li className="ledger-filter-combobox__empty" role="presentation">
              No matching months
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
