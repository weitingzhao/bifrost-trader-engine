import { filterInputClass } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

export interface LedgerSymbolComboboxProps {
  value: string
  onChange: (symbol: string) => void
  /** Distinct symbols from the ledger (uppercase); shown as suggestions. */
  suggestions: string[]
  disabled?: boolean
  'aria-label'?: string
  className?: string
  inputClassName?: string
}

function filterSuggestions(suggestions: string[], q: string): string[] {
  const t = q.trim().toUpperCase()
  if (!t) return suggestions.slice(0, 60)
  const out: string[] = []
  for (const s of suggestions) {
    const u = s.toUpperCase()
    if (u.startsWith(t) || u.includes(t)) out.push(s)
    if (out.length >= 80) break
  }
  return out
}

/**
 * Symbol filter with typeahead: always editable; prefix search (e.g. NV → NVDA) still works via value.
 */
export function LedgerSymbolCombobox({
  value,
  onChange,
  suggestions,
  disabled = false,
  'aria-label': ariaLabel = 'Symbol filter',
  className = '',
  inputClassName = '',
}: LedgerSymbolComboboxProps) {
  const reactId = useId()
  const listboxId = `${reactId}-sym-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => filterSuggestions(suggestions, value), [suggestions, value])

  const close = useCallback(() => setOpen(false), [])

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

  const showList = open && !disabled && filtered.length > 0

  return (
    <div ref={rootRef} className={`ledger-symbol-combobox ${className}`.trim()}>
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listboxId : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search symbol…"
        title="Type a prefix (e.g. NV) or pick a symbol from the list"
        className={cn(filterInputClass(), w9.ledgerSymbolComboboxInput, inputClassName)}
        value={value}
        onChange={e => {
          if (disabled) return
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (disabled) return
          setOpen(true)
        }}
      />
      {showList ? (
        <ul id={listboxId} role="listbox" className="ledger-filter-combobox__list">
          {filtered.map(sym => (
            <li
              key={sym}
              role="option"
              aria-selected={value.trim().toUpperCase() === sym.toUpperCase()}
              className={`ledger-filter-combobox__option ledger-filter-combobox__option--symbol ${
                value.trim().toUpperCase() === sym.toUpperCase()
                  ? 'ledger-filter-combobox__option--active'
                  : ''
              }`}
              onMouseDown={e => {
                e.preventDefault()
                onChange(sym)
                close()
              }}
            >
              <span className="ledger-filter-combobox__option-title">{sym}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
