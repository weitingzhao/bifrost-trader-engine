import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

export function KpiCard({
  label,
  value,
  hint,
  footer,
}: {
  label: string
  value: ReactNode
  hint?: string
  footer?: ReactNode
}) {
  return (
    <Card className="border-border/80 bg-card/60 shadow-sm">
      <CardHeader className="space-y-1 pb-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      {footer ? <CardContent className="pt-0 text-xs text-muted-foreground">{footer}</CardContent> : null}
    </Card>
  )
}
