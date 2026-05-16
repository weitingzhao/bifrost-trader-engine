import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

export interface AppSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface AppSelectProps {
  value: string
  onChange: (value: string) => void
  options: AppSelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}

/** Sentinel used to represent an empty/unset value inside Radix Select (which disallows empty strings). */
const EMPTY_VALUE = '__NONE__'

export function AppSelect({
  value,
  onChange,
  options,
  placeholder = '—',
  disabled,
  className,
  id,
  'aria-label': ariaLabel,
}: AppSelectProps) {
  return (
    <Select
      value={value || EMPTY_VALUE}
      onValueChange={(v) => onChange(v === EMPTY_VALUE ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger className={cn('app-select-trigger', className)} id={id} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="app-select-content">
        {options.map((opt) => (
          <SelectItem
            key={opt.value || EMPTY_VALUE}
            value={opt.value || EMPTY_VALUE}
            disabled={opt.disabled}
            className="app-select-item"
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
