import { type ReactNode } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'
import { INSTANCE_DETAIL_SIDEBAR_WIDTH_PX } from '../constants/instanceDetailSidebar'

export interface DetailSidebarProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: number | string
  destroyOnClose?: boolean
  mode?: 'modal' | 'docked'
}

export function DetailSidebar({
  open,
  onClose,
  title,
  children,
  width = INSTANCE_DETAIL_SIDEBAR_WIDTH_PX,
  destroyOnClose = false,
  mode = 'modal',
}: DetailSidebarProps) {
  const widthStyle = typeof width === 'number' ? `${width}px` : width

  if (mode === 'docked') {
    if (!open) return null
    return (
      <div className="detail-sidebar-docked-root">
        <aside
          className="detail-sidebar-panel detail-sidebar-panel-docked is-open"
          role="complementary"
          aria-label={typeof title === 'string' ? title : 'Detail'}
          style={{ ['--detail-sidebar-width' as string]: widthStyle }}
        >
          <header className="detail-sidebar-header">
            <h2 className="detail-sidebar-title">{title ?? 'Detail'}</h2>
            <button
              type="button"
              className="detail-sidebar-close-btn"
              onClick={onClose}
              aria-label="Close detail panel"
              title="Close (Esc)"
            >
              ×
            </button>
          </header>
          <div className="detail-sidebar-content">{children}</div>
        </aside>
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent
        side="right"
        className="detail-sidebar-panel detail-sidebar-panel-modal"
        style={{ width: widthStyle, ['--detail-sidebar-width' as string]: widthStyle }}
      >
        {title != null && (
          <SheetHeader>
            <SheetTitle className="detail-sidebar-title">
              {title}
            </SheetTitle>
          </SheetHeader>
        )}
        {destroyOnClose && !open ? null : (
          <div className="detail-sidebar-content">{children}</div>
        )}
      </SheetContent>
    </Sheet>
  )
}
