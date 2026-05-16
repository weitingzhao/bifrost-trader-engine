import { useMemo } from 'react'
import { classifyExpiration, expirationDaysFromToday, expirationKindLabel } from './expirationMeta'

export type OdChainExpiryBubblePickerProps = {
  options: string[]
  value: string
  onChange: (expiration: string) => void
  disabled?: boolean
  /** For label association from `htmlFor` */
  stripId?: string
  'aria-label'?: string
}

/** Horizontal row of expiry chips (no dropdown). */
export function OdChainExpiryBubblePicker({
  options,
  value,
  onChange,
  disabled = false,
  stripId: stripIdProp,
  'aria-label': ariaLabel = 'Chain and quotes expiration date',
}: OdChainExpiryBubblePickerProps) {
  const effective = useMemo(() => {
    if (options.length === 0) return ''
    return options.includes(value) ? value : options[0]
  }, [options, value])

  const isDisabled = disabled || options.length === 0

  return (
    <div
      id={stripIdProp}
      className="od-chain-expiry-strip"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map(exp => {
        const kind = classifyExpiration(exp)
        const sel = exp === effective
        return (
          <button
            key={exp}
            type="button"
            role="radio"
            aria-checked={sel}
            className={`od-chain-expiry-chip${sel ? ' od-chain-expiry-chip--active' : ''}`}
            disabled={isDisabled}
            onClick={() => onChange(exp)}
            title={`${exp} · ${expirationDaysFromToday(exp)}`}
          >
            <span className="od-chain-expiry-chip-line">
              <span className="od-chain-expiry-chip-date">{exp}</span>
              <span className="od-chain-expiry-chip-sep" aria-hidden>
                {' '}
                ·{' '}
              </span>
              <span className="od-chain-expiry-chip-dte">{expirationDaysFromToday(exp)}</span>
            </span>
            <span className="od-chain-expiry-chip-kinds" aria-hidden>
              {kind === 'weeklies' && (
                <span
                  className="option-discovery-expiration-kind-badge option-discovery-expiration-kind-badge--weeklies od-iv-term-exp-kind-bubble"
                  title={expirationKindLabel(kind)}
                >
                  W
                </span>
              )}
              {kind === 'quarterlies' && (
                <span
                  className="option-discovery-expiration-kind-badge option-discovery-expiration-kind-badge--quarterlies od-iv-term-exp-kind-bubble"
                  title={expirationKindLabel(kind)}
                >
                  Q
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
