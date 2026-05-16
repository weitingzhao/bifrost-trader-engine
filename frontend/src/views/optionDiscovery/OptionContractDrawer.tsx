import type { ReactNode } from 'react'
import { RightInspectorDrawer } from '../../components/RightInspectorDrawer'

/** Option Discovery contract detail; uses shared {@link RightInspectorDrawer} shell. */
export function OptionContractDrawer({
  open,
  ariaLabel = 'Option contract detail',
  children,
}: {
  open: boolean
  ariaLabel?: string
  children: ReactNode
}) {
  return (
    <RightInspectorDrawer open={open} ariaLabel={ariaLabel}>
      {children}
    </RightInspectorDrawer>
  )
}
