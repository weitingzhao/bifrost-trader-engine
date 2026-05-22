/**
 * MessageCenter — floating toast stack + slide-in history drawer.
 *
 * The bell/badge entry point lives on the three-dot menu button in App.tsx.
 * This component is controlled externally via a ref (openDrawer()) and props
 * for dismissed state so the parent badge count stays in sync.
 */

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import type { SystemMessage } from '../types'
import {
  SYSTEM_MESSAGE_TOAST_VISIBLE_MS,
  getMessageLifeCompact,
  getMessageLifeCompactAria,
  needsLifecycleCountdownTick,
} from '../utils/systemMessageLifecycle'
import { cn } from '@/lib/utils'

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_VISIBLE_TOASTS = 5

// ─── label helpers ───────────────────────────────────────────────────────────

const SVC_LABELS: Record<string, string> = {
  ib_operator: 'Operator',
  ib_ingestor: 'Ingestor',
  ib_account_agent: 'Acct Agent',
  portfolio_flex: 'Flex',
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
  if (level === 'success') return 'bg-[var(--color-lamp-green)] shadow-[0_0_5px_var(--color-lamp-green)]'
  if (level === 'warning') return 'bg-[var(--color-lamp-yellow)] shadow-[0_0_5px_var(--color-lamp-yellow)]'
  if (level === 'error') return 'bg-[var(--color-lamp-red)] shadow-[0_0_5px_var(--color-lamp-red)]'
  return 'bg-[var(--color-lamp-gray)]'
}

function levelStatusClass(level?: string) {
  if (level === 'success') return 'text-[var(--color-lamp-green)]'
  if (level === 'warning') return 'text-[var(--color-lamp-yellow)]'
  if (level === 'error') return 'text-[var(--color-lamp-red)]'
  return ''
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
  nowMs: number
  onClose: () => void
}
function truncateDetail(s: string, maxLen: number) {
  const t = s.trim()
  if (t.length <= maxLen) return t
  return `${t.slice(0, maxLen)}…`
}

function Toast({ msg, nowMs, onClose }: ToastProps) {
  const statusText = msg.status_to ? statusLabel(msg.status_to) : msg.title
  const slotText = msg.slot ? slotLabel(msg.slot) : ''
  const showDetail =
    Boolean(msg.message && msg.message.trim()) && msg.topic && msg.topic !== 'ib.connection'
  const life = getMessageLifeCompact(msg, nowMs)
  return (
    <div className={cn('msc-toast', `level-${msg.level}`)} role="alert">
      <span
        className={cn('inline-block h-[7px] w-[7px] shrink-0 rounded-full', lampClass(msg.level))}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-wrap content-start items-center gap-[5px] overflow-hidden text-xs font-medium">
        <span className="shrink-0 font-bold whitespace-nowrap text-[var(--color-text-main)]">
          {svcLabel(msg.service)}
        </span>
        {slotText && (
          <span className="shrink-0 whitespace-nowrap text-[var(--color-text-muted)]">· {slotText}</span>
        )}
        <span className="shrink-0 text-[10px] text-[var(--color-text-dim)]" aria-hidden>
          →
        </span>
        <span className={cn('shrink-0 font-semibold whitespace-nowrap', levelStatusClass(msg.level))}>
          {statusText}
        </span>
        {showDetail && (
          <span className="max-h-[3.2em] flex-[1_1_100%] overflow-hidden text-[10.5px] leading-[1.35] font-normal text-[var(--color-text-dim)]">
            {truncateDetail(msg.message, 140)}
          </span>
        )}
        <span
          className="mt-1 flex-[1_1_100%] border-t border-white/[0.06] pt-[5px] text-[10px] leading-[1.2] font-semibold tracking-wide text-[var(--color-text-muted)] tabular-nums"
          aria-label={getMessageLifeCompactAria(life)}
        >
          {life}
        </span>
      </span>
      <button
        type="button"
        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-[17px] leading-none text-[var(--color-text-dim)] transition-[color,background] duration-[120ms] hover:bg-white/[0.09] hover:text-[var(--color-text-main)]"
        onClick={onClose}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  )
}

interface DrawerItemProps {
  msg: SystemMessage
  nowMs: number
  onDismiss: () => void
}
function DrawerItem({ msg, nowMs, onDismiss }: DrawerItemProps) {
  const statusText = msg.status_to ? statusLabel(msg.status_to) : msg.title
  const slotText = msg.slot ? slotLabel(msg.slot) : ''
  const detail = msg.message && msg.message.trim() ? msg.message.trim() : ''
  const life = getMessageLifeCompact(msg, nowMs)
  return (
    <div className="group flex items-start gap-2.5 border-b border-white/[0.035] px-3.5 py-2.25 transition-colors duration-[120ms] last:border-b-0 hover:bg-white/[0.025]">
      <span
        className={cn('mt-[3px] inline-block h-[7px] w-[7px] shrink-0 rounded-full', lampClass(msg.level))}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="font-bold text-[var(--color-text-main)]">{svcLabel(msg.service)}</span>
          {slotText && <span className="text-[var(--color-text-muted)]">· {slotText}</span>}
          <span className="text-[10px] text-[var(--color-text-dim)]" aria-hidden>
            →
          </span>
          <span className={cn('font-semibold', levelStatusClass(msg.level))}>{statusText}</span>
        </div>
        {detail && (
          <div className="mt-1 text-[11px] leading-[1.4] whitespace-pre-wrap text-[var(--color-text-muted)] break-words">
            {detail}
          </div>
        )}
        {msg.reason && (
          <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-dim)]">{msg.reason}</div>
        )}
        <div className="mt-[3px] flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-[10px] text-[var(--color-text-dim)] tabular-nums">
            {relTime(Number(msg.occurred_at))}
          </span>
          <span
            className="shrink-0 text-[10px] leading-[1.2] font-semibold tracking-wide text-[var(--color-text-muted)] tabular-nums"
            aria-label={getMessageLifeCompactAria(life)}
          >
            {life}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="mt-px flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-[17px] leading-none text-[var(--color-text-dim)] opacity-0 transition-[opacity,color,background] duration-[120ms] group-hover:opacity-100 hover:bg-white/[0.09] hover:text-[var(--color-text-main)]"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
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
        (m) => !dismissedIds.has(m.message_id) && now - Number(m.occurred_at) * 1000 < SYSTEM_MESSAGE_TOAST_VISIBLE_MS,
      )
      if (active.length === 0) return
      const earliest = Math.min(...active.map((m) => Number(m.occurred_at) * 1000))
      const delay = Math.max(100, earliest + SYSTEM_MESSAGE_TOAST_VISIBLE_MS - now)
      const t = setTimeout(() => forceUpdateRef.current(), delay)
      return () => clearTimeout(t)
    }, [messages, dismissedIds])

    // Per-second tick while banner or IB auto-dismiss countdown is active
    useEffect(() => {
      if (!needsLifecycleCountdownTick(messages, dismissedIds)) return
      const id = setInterval(() => forceUpdateRef.current(), 1000)
      return () => clearInterval(id)
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
      .filter((m) => !dismissedIds.has(m.message_id) && now - Number(m.occurred_at) * 1000 < SYSTEM_MESSAGE_TOAST_VISIBLE_MS)
      .sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at))
      .slice(0, MAX_VISIBLE_TOASTS)

    // ── render ───────────────────────────────────────────────────────────

    return (
      <>
        {/* ── Toast stack (position: fixed, top-right) ── */}
        {toastMessages.length > 0 && (
          <div
            className="pointer-events-none fixed top-[58px] right-3.5 z-[9000] flex flex-col gap-[7px]"
            aria-live="polite"
            aria-atomic="false"
            role="region"
            aria-label="System notifications"
          >
            {toastMessages.map((msg) => (
              <Toast key={msg.message_id} msg={msg} nowMs={now} onClose={() => onDismiss(msg.message_id)} />
            ))}
          </div>
        )}

        {/* ── Drawer ── */}
        {drawerOpen && (
          <>
            <div className="msc-backdrop" onClick={closeDrawer} aria-hidden />
            <div className="msc-drawer" role="dialog" aria-label="Message center" aria-modal>
              <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.065] px-3.5 pt-[13px] pb-[11px]">
                <span className="text-[13px] font-bold tracking-wide text-[var(--color-text-main)]">
                  Messages
                </span>
                {drawerMessages.length > 0 && (
                  <span className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-1.5 py-px text-[10px] leading-[1.5] font-bold text-[var(--color-text-muted)]">
                    {drawerMessages.length}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-[5px]">
                  {drawerMessages.length > 0 && (
                    <button
                      type="button"
                      className="msc-drawer-danger-action"
                      onClick={onDismissAll}
                      title="Dismiss all messages"
                    >
                      Dismiss all
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-dim)] transition-[color,background] duration-[130ms] hover:bg-white/[0.08] hover:text-[var(--color-text-main)]"
                    onClick={closeDrawer}
                    aria-label="Close message center"
                  >
                    <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <path d="M15 5L5 15M5 5l10 10" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto py-1.5 pb-4 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--color-border)] [&::-webkit-scrollbar-track]:bg-transparent">
                {drawerMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-12 text-xs text-[var(--color-text-dim)]">
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
                      nowMs={now}
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
