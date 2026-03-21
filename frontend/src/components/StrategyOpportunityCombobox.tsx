import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StrategyOpportunity } from '../api'

export interface StrategyOpportunityComboboxProps {
  opportunities: StrategyOpportunity[]
  value: number | ''
  onChange: (strategyOpportunityId: number | '') => void
  /** Disables interaction (e.g. while parent loads). */
  disabled?: boolean
  id?: string
  'aria-label'?: string
  className?: string
  inputClassName?: string
}

function opportunityLabel(o: StrategyOpportunity): string {
  return (o.name?.trim() || `#${o.strategy_opportunity_id}`).trim()
}

function opportunityMatchesQuery(o: StrategyOpportunity, q: string): boolean {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const parts: string[] = [
    o.name ?? '',
    String(o.strategy_opportunity_id),
    (o.structure_name ?? '').trim(),
    (o.scope_type ?? '').trim(),
    ...(o.symbols ?? []).map(x => String(x).trim()),
  ]
  return parts.some(p => p.toLowerCase().includes(s))
}

/**
 * Searchable combobox for strategy opportunities: filters by name, id, structure, scope type, and symbols.
 */
export function StrategyOpportunityCombobox({
  opportunities,
  value,
  onChange,
  disabled = false,
  id: idProp,
  'aria-label': ariaLabel = 'Strategy filter',
  className = '',
  inputClassName = '',
}: StrategyOpportunityComboboxProps) {
  const reactId = useId()
  const listboxId = `${reactId}-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => opportunities.find(o => o.strategy_opportunity_id === value) ?? null,
    [opportunities, value],
  )

  const closedDisplay = value === '' || !selected ? 'All strategies' : opportunityLabel(selected)
  const closedValueDim = !open && (value === '' || !selected)

  const filtered = useMemo(() => {
    return opportunities.filter(o => opportunityMatchesQuery(o, query))
  }, [opportunities, query])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close()
      }
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

  const pickAll = useCallback(() => {
    onChange('')
    close()
  }, [onChange, close])

  const pickOne = useCallback(
    (id: number) => {
      onChange(id)
      close()
    },
    [onChange, close],
  )

  return (
    <div
      ref={rootRef}
      className={`strategy-opp-combobox ${className}`.trim()}
    >
      <input
        id={idProp}
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
        placeholder={open ? 'Search strategy, structure, symbol…' : undefined}
        title={!open && !disabled ? 'Strategy filter — click to search or pick' : undefined}
        className={`replay-filter-input replay-filter-select strategy-opp-combobox__input ${
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
          if (e.key === 'Enter' && open && filtered.length === 1 && value !== filtered[0].strategy_opportunity_id) {
            e.preventDefault()
            pickOne(filtered[0].strategy_opportunity_id)
          }
        }}
      />
      {open && !disabled ? (
        <ul
          id={listboxId}
          role="listbox"
          className="ledger-filter-combobox__list"
        >
          <li
            role="option"
            aria-selected={value === ''}
            className={`ledger-filter-combobox__option ${value === '' ? 'ledger-filter-combobox__option--active' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              pickAll()
            }}
          >
            All strategies
          </li>
          {filtered.map(o => {
            const label = opportunityLabel(o)
            const sub = [o.structure_name?.trim(), (o.symbols ?? []).filter(Boolean).join(', ')]
              .filter(Boolean)
              .join(' · ')
            const active = value === o.strategy_opportunity_id
            return (
              <li
                key={o.strategy_opportunity_id}
                role="option"
                aria-selected={active}
                className={`ledger-filter-combobox__option ${active ? 'ledger-filter-combobox__option--active' : ''}`}
                onMouseDown={e => {
                  e.preventDefault()
                  pickOne(o.strategy_opportunity_id)
                }}
              >
                <span className="ledger-filter-combobox__option-title">{label}</span>
                {sub ? (
                  <span className="ledger-filter-combobox__option-sub">{sub}</span>
                ) : null}
              </li>
            )
          })}
          {filtered.length === 0 ? (
            <li className="ledger-filter-combobox__empty" role="presentation">
              No matching strategies
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
