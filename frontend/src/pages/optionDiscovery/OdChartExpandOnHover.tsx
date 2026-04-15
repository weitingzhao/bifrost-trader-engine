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

const PANEL_MIN_W = 420
const PANEL_MAX_W = 920
const PANEL_MIN_H = 220
const PANEL_ABS_MAX_W = 1400
const PANEL_ABS_MAX_H = 1200

/** Monotonic z-index so a newly opened panel stacks above earlier ones (multiple enlargements stay open). */
let nextExpandZ = 10060

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function computePanelPos(triggerEl: HTMLElement | null): { x: number; y: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const panelW = clamp(Math.min(PANEL_MAX_W, vw - 24), PANEL_MIN_W, PANEL_MAX_W)
  const estH = Math.min(540, vh * 0.58)
  if (!triggerEl) {
    return { x: Math.max(8, (vw - panelW) / 2), y: Math.max(8, vh * 0.06) }
  }
  const r = triggerEl.getBoundingClientRect()
  let x = r.left
  let y = r.bottom + 10
  if (x + panelW > vw - 8) x = vw - panelW - 8
  if (x < 8) x = 8
  if (y + estH > vh - 8) {
    y = clamp(r.top - estH - 10, 8, vh - estH - 8)
  }
  return { x, y: clamp(y, 8, vh - 80) }
}

/** Title row + hint + padding */
const PANEL_CHROME_H = 100

function defaultPanelSize(): { w: number; h: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = clamp(Math.min(vw * 0.92, PANEL_MAX_W), PANEL_MIN_W, PANEL_MAX_W)
  const plotH = Math.round(w * 0.45)
  const h = clamp(
    PANEL_CHROME_H + plotH,
    PANEL_MIN_H,
    Math.min(660, Math.round(vh * 0.58)),
  )
  return { w, h }
}

/**
 * Click the chart area to open a larger floating copy (click again on the same chart to close).
 * Opening another chart does not close an already-open enlargement. Overlay shell uses
 * pointer-events: none so the page behind stays interactive; only the panel captures input.
 * Drag the title bar to move; drag the bottom-right grip to resize.
 */
export function OdChartExpandOnHover({
  title,
  children,
  className = '',
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 24, y: 24 })
  /** User-resolved size; when null, `defaultPanelSize()` is used for layout */
  const [panelSize, setPanelSize] = useState<{ w: number; h: number } | null>(null)
  const [zIndex, setZIndex] = useState(10060)
  const titleId = useId()
  const triggerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const posRef = useRef(pos)
  posRef.current = pos

  const moveDrag = useRef(false)
  const moveRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 })

  const resizeDrag = useRef(false)
  const resizeRef = useRef({ startX: 0, startY: 0, origW: 0, origH: 0 })

  const displaySize = panelSize ?? defaultPanelSize()

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const toggle = useCallback(() => setOpen(o => !o), [])

  const onTriggerClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      toggle()
    },
    [toggle],
  )

  useLayoutEffect(() => {
    if (!open) {
      setPanelSize(null)
      return
    }
    setPos(computePanelPos(triggerRef.current))
    setZIndex(++nextExpandZ)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const onMoveDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      moveDrag.current = true
      moveRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      }
    },
    [pos.x, pos.y],
  )

  const onResizeDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeDrag.current = true
    const sz = panelSize ?? defaultPanelSize()
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: sz.w,
      origH: sz.h,
    }
  }, [panelSize])

  useEffect(() => {
    if (!open) return
    const onMove = (e: MouseEvent) => {
      const { x: px, y: py } = posRef.current
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (moveDrag.current) {
        const { startX, startY, origX, origY } = moveRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        const panel = panelRef.current
        const pw = panel?.offsetWidth ?? PANEL_MIN_W
        const ph = panel?.offsetHeight ?? 400
        setPos({
          x: clamp(origX + dx, 0, Math.max(0, vw - pw)),
          y: clamp(origY + dy, 0, Math.max(0, vh - ph)),
        })
        return
      }

      if (resizeDrag.current) {
        const { startX, startY, origW, origH } = resizeRef.current
        const dw = e.clientX - startX
        const dh = e.clientY - startY
        const maxW = Math.min(PANEL_ABS_MAX_W, vw - px - 8)
        const maxH = Math.min(PANEL_ABS_MAX_H, vh - py - 8)
        setPanelSize({
          w: clamp(origW + dw, PANEL_MIN_W, maxW),
          h: clamp(origH + dh, PANEL_MIN_H, maxH),
        })
      }
    }

    const onUp = () => {
      moveDrag.current = false
      resizeDrag.current = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [open])

  const panelStyle = {
    left: pos.x,
    top: pos.y,
    width: displaySize.w,
    height: displaySize.h,
  }

  return (
    <>
      <div
        ref={triggerRef}
        className={`od-chart-expand-trigger${className ? ` ${className}` : ''}`}
        onClick={onTriggerClick}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${title}. Click to open or close enlarged chart.`}
      >
        {children}
      </div>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="od-chart-expand-overlay" aria-hidden style={{ zIndex }}>
            <div
              ref={panelRef}
              className="od-chart-expand-panel"
              style={panelStyle}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
            >
              <div className="od-chart-expand-panel-head">
                <div
                  id={titleId}
                  className="od-chart-expand-panel-title od-chart-expand-panel-drag"
                  onMouseDown={onMoveDragStart}
                >
                  {title}
                </div>
                <button
                  type="button"
                  className="od-chart-expand-panel-close"
                  onClick={e => {
                    e.stopPropagation()
                    close()
                  }}
                  aria-label="Close enlarged chart"
                >
                  ×
                </button>
              </div>
              <div className="od-chart-expand-panel-body">{children}</div>
              <p className="od-chart-expand-panel-hint">
                Click the chart again to close this window, or use × / Esc. Other enlarged charts stay open. Drag the
                title bar to move; drag the corner grip to resize.
              </p>
              <div
                className="od-chart-expand-resize-grip"
                onMouseDown={onResizeDragStart}
                title="Drag to resize"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
