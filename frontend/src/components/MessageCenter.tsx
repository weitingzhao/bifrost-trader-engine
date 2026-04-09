/**
 * MessageCenter — floating toast stack + slide-in history drawer.
 *
 * The bell/badge entry point lives on the three-dot menu button in App.tsx.
 * This component is controlled externally via a ref (openDrawer()) and props
 * for dismissed state so the parent badge count stays in sync.
 */

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import type { SystemMessage } from '../types'

// ─── constants ───────────────────────────────────────────────────────────────

const TOAST_TTL_MS = 10_000
const MAX_VISIBLE_TOASTS = 5

// ─── label helpers ───────────────────────────────────────────────────────────

const SVC_LABELS: Record<string, string> = {
  ib_operator: 'Operator',
  ib_ingestor: 'Ingestor',
  ib_account_agent: 'Acct Agent',
}
const SLOT_LABELS: Record<string, string> = { host: 'Host', secondary: 'Secondary' }
const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
}

function svcLabel(s?: string) {
  if (!s) return 'System'
  return SVC_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function slotLabel(s?: string) {
  if (!s) return ''
  return SLOT_LABELS[s.toLowerCase()] ?? s
}
function statusLabel(s?: string) {
  if (!s) return ''
  return STATUS_LABELS[s.toLowerCase()] ?? s
}
function lampClass(level?: string) {
  if (level === 'success') return 'msc-lamp-green'
  if (level === 'warning') return 'msc-lamp-yellow'
  if (level === 'error') return 'msc-lamp-red'
  return 'msc-lamp-gray'
}
function relTime(occurred_at: number) {
  const sec = Math.floor(Date.now() / 1000 - occurred_at)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

// ─── sub-components ──────────────────────────────────────────────────────────

interface ToastProps {
  msg: SystemMessage
  onClose: () => void
}
function truncateDetail(s: string, maxLen: number) {
  const t = s.trim()
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen)}…`
}

function Toast({ msg, onClose }: ToastProps) {
  const statusText = msg.status_to ? statusLabel(msg.status_to) : msg.title
  const slotText = msg.slot ? slotLabel(msg.slot) : ''
  const showDetail =
    Boolean(msg.message && msg.message.trim()) && msg.topic && msg.topic !== 'ib.connection'
  return (
    <div className={`msc-toast level-${msg.level}`} role="alert">
      <span className={`msc-lamp ${lampClass(msg.level)}`} aria-hidden />
      <span className="msc-toast-content">
        <span className="msc-toast-svc">{svcLabel(msg.service)}</span>
        {slotText && <span className="msc-toast-slot">· {slotText}</span>}
        <span className="msc-toast-arrow" aria-hidden>→</span>
        <span className={`msc-toast-status level-${msg.level}`}>{statusText}</span>
        {showDetail && (
          <span className="msc-toast-detail">{truncateDetail(msg.message, 140)}</span>
        )}
      </span>
      <button type="button" className="msc-close-btn" onClick={onClose} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  )
}

interface DrawerItemProps {
  msg: SystemMessage
  onDismiss: () => void
}
function DrawerItem({ msg, onDismiss }: DrawerItemProps) {
  const statusText = msg.status_to ? statusLabel(msg.status_to) : msg.title
  const slotText = msg.slot ? slotLabel(msg.slot) : ''
  const detail = msg.message && msg.message.trim() ? msg.message.trim() : ''
  return (
    <div className={`msc-drawer-item level-${msg.level}`}>
      <span className={`msc-lamp ${lampClass(msg.level)}`} aria-hidden />
      <div className="msc-drawer-item-body">
        <div className="msc-drawer-item-main">
          <span className="msc-drawer-item-svc">{svcLabel(msg.service)}</span>
          {slotText && <span className="msc-drawer-item-slot">· {slotText}</span>}
          <span className="msc-drawer-item-arrow" aria-hidden>→</span>
          <span className={`msc-drawer-item-status level-${msg.level}`}>{statusText}</span>
        </div>
        {detail && <div className="msc-drawer-item-detail">{detail}</div>}
        {msg.reason && <div className="msc-drawer-item-reason">{msg.reason}</div>}
        <div className="msc-drawer-item-time">{relTime(Number(msg.occurred_at))}</div>
      </div>
      <button type="button" className="msc-close-btn msc-drawer-item-dismiss" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

// ─── main component ──────────────────────────────────────────────────────────

export interface MessageCenterHandle {
  openDrawer: () => void
}

interface MessageCenterProps {
  messages: SystemMessage[]
  dismissedIds: Set<string>
  onDismiss: (id: string) => void
  onDismissAll: () => void
}

export const MessageCenter = forwardRef<MessageCenterHandle, MessageCenterProps>(
  ({ messages, dismissedIds, onDismiss, onDismissAll }, ref) => {
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [, forceUpdate] = useState(0)
    const forceUpdateRef = useRef(() => {})
    forceUpdateRef.current = () => forceUpdate((n) => n + 1)

    // ── expose openDrawer to parent via ref ──────────────────────────────

    useImperativeHandle(ref, () => ({
      openDrawer: () => setDrawerOpen(true),
    }), [])

    // ── drawer open/close ────────────────────────────────────────────────

    const closeDrawer = useCallback(() => setDrawerOpen(false), [])

    // Escape to close drawer
    useEffect(() => {
      if (!drawerOpen) return
      const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer() }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }, [drawerOpen, closeDrawer])

    // ── re-render when earliest active toast expires ─────────────────────

    useEffect(() => {
      const now = Date.now()
      const active = messages.filter(
        (m) => !dismissedIds.has(m.message_id) && now - Number(m.occurred_at) * 1000 < TOAST_TTL_MS,
      )
      if (active.length === 0) return
      const earliest = Math.min(...active.map((m) => Number(m.occurred_at) * 1000))
      const delay = Math.max(100, earliest + TOAST_TTL_MS - now)
      const t = setTimeout(() => forceUpdateRef.current(), delay)
      return () => clearTimeout(t)
    }, [messages, dismissedIds])

    // Refresh relative timestamps every 30 s while drawer is open
    useEffect(() => {
      if (!drawerOpen) return
      const t = setInterval(() => forceUpdateRef.current(), 30_000)
      return () => clearInterval(t)
    }, [drawerOpen])

    // ── derived ──────────────────────────────────────────────────────────

    const now = Date.now()
    const drawerMessages = messages
      .filter((m) => !dismissedIds.has(m.message_id))
      .sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at))
    const toastMessages = messages
      .filter((m) => !dismissedIds.has(m.message_id) && now - Number(m.occurred_at) * 1000 < TOAST_TTL_MS)
      .sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at))
      .slice(0, MAX_VISIBLE_TOASTS)

    // ── render ───────────────────────────────────────────────────────────

    return (
      <>
        {/* ── Toast stack (position: fixed, top-right) ── */}
        {toastMessages.length > 0 && (
          <div className="msc-toast-stack" aria-live="polite" aria-atomic="false" role="region" aria-label="System notifications">
            {toastMessages.map((msg) => (
              <Toast key={msg.message_id} msg={msg} onClose={() => onDismiss(msg.message_id)} />
            ))}
          </div>
        )}

        {/* ── Drawer ── */}
        {drawerOpen && (
          <>
            <div className="msc-backdrop" onClick={closeDrawer} aria-hidden />
            <div className="msc-drawer" role="dialog" aria-label="Message center" aria-modal>
              <div className="msc-drawer-header">
                <span className="msc-drawer-title">Messages</span>
                {drawerMessages.length > 0 && (
                  <span className="msc-drawer-badge">{drawerMessages.length}</span>
                )}
                <div className="msc-drawer-header-actions">
                  {drawerMessages.length > 0 && (
                    <button
                      type="button"
                      className="msc-drawer-action-btn msc-drawer-action-btn--danger"
                      onClick={onDismissAll}
                      title="Dismiss all messages"
                    >
                      Dismiss all
                    </button>
                  )}
                  <button
                    type="button"
                    className="msc-drawer-close"
                    onClick={closeDrawer}
                    aria-label="Close message center"
                  >
                    <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <path d="M15 5L5 15M5 5l10 10" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="msc-drawer-body">
                {drawerMessages.length === 0 ? (
                  <div className="msc-drawer-empty">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" aria-hidden>
                      <path strokeLinecap="round" d="M15 17H20L18.595 15.595A1 1 0 0118 14.812V11a6 6 0 00-9.33-4.993M9 9v5.818a1 1 0 01-.293.707L7 17h5m3 0v1a3 3 0 01-6 0v-1m6 0H9" />
                    </svg>
                    <span>No messages</span>
                  </div>
                ) : (
                  drawerMessages.map((msg) => (
                    <DrawerItem
                      key={msg.message_id}
                      msg={msg}
                      onDismiss={() => onDismiss(msg.message_id)}
                    />
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </>
    )
  }
)

MessageCenter.displayName = 'MessageCenter'
