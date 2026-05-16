import type { ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export type SimpleColumn<T> = {
  id: string
  header: string
  cell: (row: T) => ReactNode
  className?: string
}

export function DataTable<T>({
  columns,
  rows,
  empty,
  getRowKey,
}: {
  columns: SimpleColumn<T>[]
  rows: T[]
  empty?: ReactNode
  getRowKey: (row: T, index: number) => string
}) {
  if (rows.length === 0) {
    return empty ?? <div className="text-sm text-muted-foreground">No rows.</div>
  }
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.id} className={c.className}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={getRowKey(row, i)}>
              {columns.map((c) => (
                <TableCell key={c.id} className={c.className}>
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
