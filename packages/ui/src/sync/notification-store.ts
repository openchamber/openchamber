// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { retry } from "./retry"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationBase = {
  directory?: string
  session?: string
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error?: { message?: string; code?: string }
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const VIEW_RECEIPT_RETRY_DELAY_MS = 250
const VIEW_RECEIPT_THROTTLE_MS = 3_000

const EMPTY_INDEX: NotificationIndex = {
  session: { unseenCount: {}, unseenHasError: {} },
  project: { unseenCount: {}, unseenHasError: {} },
}
const sessionViewReceiptSentAt = new Map<string, number>()

type MarkSessionViewedOptions = {
  upTo?: number | null
}

type SessionAttentionState = {
  needsAttention: boolean
  lastReadAt: number | null
  lastActivityAt: number | null
  timestamp: number | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneNotifications(list: Notification[]): Notification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  }

  for (const n of list) {
    if (n.viewed) continue

    if (n.session) {
      index.session.unseenCount[n.session] = (index.session.unseenCount[n.session] ?? 0) + 1
      if (n.type === "error") index.session.unseenHasError[n.session] = true
    }
    if (n.directory) {
      index.project.unseenCount[n.directory] = (index.project.unseenCount[n.directory] ?? 0) + 1
      if (n.type === "error") index.project.unseenHasError[n.directory] = true
    }
  }

  return index
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function viewSessionNotifications(
  current: NotificationStore,
  sessionId: string,
  options?: MarkSessionViewedOptions,
): boolean {
  const unseenCount = current.index.session.unseenCount[sessionId] ?? 0
  if (unseenCount === 0) return false

  const upTo = isFiniteTimestamp(options?.upTo) ? options.upTo : null
  let changed = false
  const next = current.list.map((notification) => {
    if (notification.session !== sessionId || notification.viewed) {
      return notification
    }
    if (upTo !== null && notification.time > upTo) {
      return notification
    }
    changed = true
    return { ...notification, viewed: true }
  })

  if (!changed) return false
  useNotificationStore.setState({ list: next, index: buildIndex(next) })
  return true
}

async function postSessionViewReceipt(sessionId: string): Promise<void> {
  const response = await runtimeFetch(`/api/sessions/${sessionId}/view`, { method: "POST" })
  if (response.ok) return

  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    const error = new Error(`session view receipt failed (${response.status})`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
}

function shouldRetrySessionViewReceipt(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (typeof status === "number") {
    return status === 408 || status === 429 || (status >= 500 && status < 600)
  }
  return true
}

function shouldSendSessionViewReceipt(sessionId: string): boolean {
  if (!sessionId) return false
  const now = Date.now()
  const lastSentAt = sessionViewReceiptSentAt.get(sessionId) ?? 0
  if (now - lastSentAt < VIEW_RECEIPT_THROTTLE_MS) {
    return false
  }
  sessionViewReceiptSentAt.set(sessionId, now)
  return true
}

export function sendSessionViewReceiptIfNeeded(sessionId: string): void {
  if (!shouldSendSessionViewReceipt(sessionId)) return
  void retry(() => postSessionViewReceipt(sessionId), {
    attempts: 2,
    delay: VIEW_RECEIPT_RETRY_DELAY_MS,
    retryIf: shouldRetrySessionViewReceipt,
  }).catch(() => {
    // Older runtimes and transient failures should not block local unread clears.
  })
}

function parseSessionAttentionState(value: unknown): SessionAttentionState | null {
  if (!value || typeof value !== "object") return null
  const record = value as {
    sessionID?: unknown
    sessionId?: unknown
    needsAttention?: unknown
    lastReadAt?: unknown
    lastActivityAt?: unknown
    lastStatusChangeAt?: unknown
    timestamp?: unknown
  }

  const sessionId = typeof record.sessionID === "string" && record.sessionID.length > 0
    ? record.sessionID
    : typeof record.sessionId === "string" && record.sessionId.length > 0
      ? record.sessionId
      : null
  if (!sessionId) return null

  return {
    needsAttention: record.needsAttention === true,
    lastReadAt: isFiniteTimestamp(record.lastReadAt) ? record.lastReadAt : null,
    lastActivityAt: isFiniteTimestamp(record.lastActivityAt)
      ? record.lastActivityAt
      : isFiniteTimestamp(record.lastStatusChangeAt)
        ? record.lastStatusChangeAt
        : null,
    timestamp: isFiniteTimestamp(record.timestamp) ? record.timestamp : null,
  }
}

function applySessionAttentionState(sessionId: string, state: SessionAttentionState): boolean {
  if (state.needsAttention) return false
  const viewedAt = state.lastReadAt ?? state.timestamp
  if (!isFiniteTimestamp(viewedAt)) return false
  return viewSessionNotifications(useNotificationStore.getState(), sessionId, { upTo: viewedAt })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string, options?: MarkSessionViewedOptions) => boolean
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string) => number
  sessionHasError: (sessionId: string) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: [],
  index: EMPTY_INDEX,

  append: (notification) => {
    const current = get().list
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
  },

  markSessionViewed: (sessionId, options) => viewSessionNotifications(get(), sessionId, options),

  markProjectViewed: (directory) => {
    const current = get()
    const count = current.index.project.unseenCount[directory] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.directory === directory && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

  sessionUnseenCount: (sessionId) => get().index.session.unseenCount[sessionId] ?? 0,
  sessionHasError: (sessionId) => get().index.session.unseenHasError[sessionId] ?? false,
  projectUnseenCount: (directory) => get().index.project.unseenCount[directory] ?? 0,
  projectHasError: (directory) => get().index.project.unseenHasError[directory] ?? false,
}))

// ---------------------------------------------------------------------------
// Imperative API for non-React code (event handler in sync-context)
// ---------------------------------------------------------------------------

export function appendNotification(notification: Notification) {
  useNotificationStore.getState().append(notification)
  if (notification.viewed && notification.session) {
    sendSessionViewReceiptIfNeeded(notification.session)
  }
}

export function markSessionViewed(sessionId: string) {
  if (!sessionId) return
  const changed = useNotificationStore.getState().markSessionViewed(sessionId)
  if (!changed) return
  sendSessionViewReceiptIfNeeded(sessionId)
}

export function applySessionAttentionEvent(payload: unknown): boolean {
  if ((payload as { type?: unknown })?.type !== "openchamber:session-attention") {
    return false
  }

  const properties = (payload as { properties?: unknown }).properties
  const state = parseSessionAttentionState(properties)
  if (!state) return true
  const sessionId = typeof (properties as { sessionID?: unknown }).sessionID === "string"
    ? (properties as { sessionID: string }).sessionID
    : typeof (properties as { sessionId?: unknown }).sessionId === "string"
      ? (properties as { sessionId: string }).sessionId
      : ""
  if (!sessionId) return true
  applySessionAttentionState(sessionId, state)
  return true
}

export function reconcileSessionAttentionSnapshot(snapshot: Record<string, unknown>): void {
  for (const [sessionId, rawState] of Object.entries(snapshot)) {
    const state = parseSessionAttentionState({ ...(rawState as object), sessionID: sessionId })
    if (!state) continue
    applySessionAttentionState(sessionId, state)
  }
}

export async function hydrateSessionAttentionState(): Promise<void> {
  const response = await runtimeFetch("/api/sessions/attention")
  if (!response.ok) return
  const payload = await response.json().catch(() => null)
  if (!payload || typeof payload !== "object") return
  const sessions = (payload as { sessions?: unknown }).sessions
  if (!sessions || typeof sessions !== "object") return
  reconcileSessionAttentionSnapshot(sessions as Record<string, unknown>)
}

export function resetSessionViewReceiptThrottleForTests(): void {
  sessionViewReceiptSentAt.clear()
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((s) => s.index.session.unseenCount[sessionId] ?? 0)
}
