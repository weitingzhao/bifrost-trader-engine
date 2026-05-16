import * as RadixDialog from '@radix-ui/react-dialog'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

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
 * Backed by Radix Dialog for focus trap, ESC handling, and screen reader support.
 *
 * pos=null → CSS-centered via translate(-50%,-50%); this is the safe default when
 * useLayoutEffect fires before the Radix Portal ref is available in React 18.
 * Once the ref is readable the effect sets explicit pixel coords for drag support.
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
  // null = use CSS centering (safe fallback); {left,top} = dragged to explicit position
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  useLayoutEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      setPos(null)
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
      setPos(p => (p === null ? null : clampToViewport(p.left, p.top, w, h)))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      // If still CSS-centered, read actual position from DOM before starting drag
      const el = panelRef.current
      const rect = el?.getBoundingClientRect()
      const currentLeft = pos?.left ?? rect?.left ?? 0
      const currentTop = pos?.top ?? rect?.top ?? 0
      dragging.current = true
      setIsDragging(true)
      dragOffset.current = { x: e.clientX - currentLeft, y: e.clientY - currentTop }
      if (pos === null && rect) {
        setPos({ left: rect.left, top: rect.top })
      }
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      e.preventDefault()
    },
    [pos],
  )

  useEffect(() => {
    if (!open) return
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const el = panelRef.current
      const w = el?.offsetWidth ?? 420
      const h = el?.offsetHeight ?? 200
      const next = clampToViewport(
        e.clientX - dragOffset.current.x,
        e.clientY - dragOffset.current.y,
        w,
        h,
      )
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

  const posStyle: CSSProperties =
    pos === null
      ? { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
      : { position: 'fixed', left: pos.left, top: pos.top, transform: 'none' }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !backdropLocked) onBackdropClick()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={`app-draggable-modal-overlay ${overlayClassName}`.trim()}
          onClick={() => {
            if (!backdropLocked) onBackdropClick()
          }}
        />
        <RadixDialog.Content
          ref={panelRef}
          className={`app-draggable-modal ${isDragging ? 'app-draggable-modal--dragging' : ''} ${panelClassName}`.trim()}
          style={{ maxWidth, ...panelStyle, ...posStyle }}
          aria-labelledby={titleId}
          /* Let overlay onClick handle backdrop close; disable Radix outside-click */
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          /* Prevent ESC close when a destructive action is in progress */
          onEscapeKeyDown={(e) => {
            if (backdropLocked) e.preventDefault()
          }}
        >
          <div
            className="app-draggable-modal-header"
            onPointerDown={onHeaderPointerDown}
            role="presentation"
            title="Drag to move"
          >
            <RadixDialog.Title id={titleId} className="app-draggable-modal-title">
              {title}
            </RadixDialog.Title>
            <span className="app-draggable-modal-grip" aria-hidden>
              ⋮⋮
            </span>
          </div>
          <div className="app-draggable-modal-body">{children}</div>
          <div className="app-draggable-modal-footer">{footer}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
