import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 12
const DEFAULT_MAX_W = 'min(420px, calc(100vw - 24px))'

function clampToViewport(left: number, top: number, width: number, height: number) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 800
  const vh = typeof window !== 'undefined' ? window.innerHeight : 600
  const maxL = Math.max(MARGIN, vw - width - MARGIN)
  const maxT = Math.max(MARGIN, vh - height - MARGIN)
  return {
    left: Math.min(Math.max(MARGIN, left), maxL),
    top: Math.min(Math.max(MARGIN, top), maxT),
  }
}

export interface DraggableModalProps {
  open: boolean
  onBackdropClick: () => void
  /** While true, backdrop does not dismiss (e.g. async confirm in progress). */
  backdropLocked?: boolean
  title: string
  titleId: string
  children: ReactNode
  footer: ReactNode
  /** Extra class on the panel (e.g. width utilities). */
  panelClassName?: string
  overlayClassName?: string
  /** Applied as `maxWidth` on the panel (CSS string). */
  maxWidth?: string
  panelStyle?: CSSProperties
}

/**
 * Modal with a drag handle in the header, structured body/footer, centered on open.
 * Renders via portal to `document.body`.
 */
export function DraggableModal({
  open,
  onBackdropClick,
  backdropLocked = false,
  title,
  titleId,
  children,
  footer,
  panelClassName = '',
  overlayClassName = '',
  maxWidth = DEFAULT_MAX_W,
  panelStyle,
}: DraggableModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  useLayoutEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const el = panelRef.current
    if (!el) return
    const w = el.offsetWidth || 420
    const h = el.offsetHeight || 200
    if (!wasOpenRef.current) {
      const vw = window.innerWidth
      const vh = window.innerHeight
      setPos(clampToViewport((vw - w) / 2, (vh - h) / 2, w, h))
    }
    wasOpenRef.current = true
  }, [open, title])

  useEffect(() => {
    if (!open) return
    const onResize = () => {
      const el = panelRef.current
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      setPos(p => clampToViewport(p.left, p.top, w, h))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      dragging.current = true
      setIsDragging(true)
      dragOffset.current = { x: e.clientX - pos.left, y: e.clientY - pos.top }
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      e.preventDefault()
    },
    [pos.left, pos.top],
  )

  useEffect(() => {
    if (!open) return
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const el = panelRef.current
      const w = el?.offsetWidth ?? 420
      const h = el?.offsetHeight ?? 200
      const next = clampToViewport(e.clientX - dragOffset.current.x, e.clientY - dragOffset.current.y, w, h)
      setPos(next)
    }
    const onUp = (e: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      setIsDragging(false)
      try {
        ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [open])

  if (!open) return null

  const overlay = (
    <div
      className={`app-draggable-modal-overlay ${overlayClassName}`.trim()}
      role="presentation"
      onClick={() => {
        if (!backdropLocked) onBackdropClick()
      }}
    >
      <div
        ref={panelRef}
        className={`app-draggable-modal ${isDragging ? 'app-draggable-modal--dragging' : ''} ${panelClassName}`.trim()}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          zIndex: 1,
          maxWidth,
          ...panelStyle,
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="app-draggable-modal-header"
          onPointerDown={onHeaderPointerDown}
          role="presentation"
          title="Drag to move"
        >
          <h3 id={titleId} className="app-draggable-modal-title">
            {title}
          </h3>
          <span className="app-draggable-modal-grip" aria-hidden>
            ⋮⋮
          </span>
        </div>
        <div className="app-draggable-modal-body">{children}</div>
        <div className="app-draggable-modal-footer">{footer}</div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
