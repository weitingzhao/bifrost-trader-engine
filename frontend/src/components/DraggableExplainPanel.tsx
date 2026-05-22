import { w9 } from '@/styles/wave9Classes'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const PANEL_MAX_W = 820
const PANEL_MARGIN = 10
const ANCHOR_OFFSET = 10

function clampToViewport(left: number, top: number, width: number, height: number) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 800
  const vh = typeof window !== 'undefined' ? window.innerHeight : 600
  const maxL = Math.max(PANEL_MARGIN, vw - width - PANEL_MARGIN)
  const maxT = Math.max(PANEL_MARGIN, vh - height - PANEL_MARGIN)
  return {
    left: Math.min(Math.max(PANEL_MARGIN, left), maxL),
    top: Math.min(Math.max(PANEL_MARGIN, top), maxT),
  }
}

export interface DraggableExplainPanelProps {
  open: boolean
  /** When this changes while the panel stays open, position is preserved (e.g. hovered another cell). */
  explanationId: string
  anchor: { x: number; y: number }
  onClose: () => void
  title: string
  children: ReactNode
}

/**
 * Floating panel: opens from hover anchor, draggable by header, closes only via button (or Escape).
 */
export function DraggableExplainPanel({
  open,
  explanationId: _explanationId,
  anchor,
  onClose,
  title,
  children,
}: DraggableExplainPanelProps) {
  void _explanationId
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const el = panelRef.current
    const w = el?.offsetWidth ?? PANEL_MAX_W
    const h = el?.offsetHeight ?? 420
    if (!wasOpenRef.current) {
      setPos(
        clampToViewport(
          anchor.x + ANCHOR_OFFSET,
          anchor.y + ANCHOR_OFFSET,
          w,
          h,
        ),
      )
    }
    wasOpenRef.current = true
  }, [open, anchor.x, anchor.y])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      dragging.current = true
      dragOffset.current = { x: e.clientX - pos.left, y: e.clientY - pos.top }
      e.preventDefault()
    },
    [pos.left, pos.top],
  )

  useEffect(() => {
    if (!open) return
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const el = panelRef.current
      const w = el?.offsetWidth ?? PANEL_MAX_W
      const h = el?.offsetHeight ?? 300
      const next = clampToViewport(
        e.clientX - dragOffset.current.x,
        e.clientY - dragOffset.current.y,
        w,
        h,
      )
      setPos(next)
    }
    const onUp = () => {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [open])

  if (!open) return null

  const node = (
    <div
      ref={panelRef}
      className="draggable-explain-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 10050,
        maxWidth: PANEL_MAX_W,
        width: 'min(calc(100vw - 1.5rem), ' + PANEL_MAX_W + 'px)',
      }}
    >
      <div
        className={w9.draggableExplainPanelHeader}
        onMouseDown={onHeaderMouseDown}
        role="presentation"
      >
        <h3 id={titleId} className={w9.draggableExplainPanelTitle}>
          {title}
        </h3>
        <button
          type="button"
          className={w9.draggableExplainPanelClose}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className={w9.draggableExplainPanelBody}>{children}</div>
      <p className={w9.draggableExplainPanelHint}>
        Drag the header to move. Click × or press Escape to close.
      </p>
    </div>
  )

  return createPortal(node, document.body)
}
