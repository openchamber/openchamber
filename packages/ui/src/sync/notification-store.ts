// ---------------------------------------------------------------------------
// Notification store — session turn-complete and error tracking
//
// Tracks session turn-complete and error notifications with viewed/unviewed
// state. Replaces the old sessionAttentionStates polling system.
// ---------------------------------------------------------------------------

import { create } from "zustand"

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NotificationStore {
  list: Notification[]
  index: NotificationIndex

  // Mutations
  append: (notification: Notification) => void
  markSessionViewed: (sessionId: string) => void
  markProjectViewed: (directory: string) => void

  // Selectors
  sessionUnseenCount: (sessionId: string) => number
  sessionHasError: (sessionId: string) => boolean
  projectUnseenCount: (directory: string) => number
  projectHasError: (directory: string) => boolean
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: [],
  index: {
    session: { unseenCount: {}, unseenHasError: {} },
    project: { unseenCount: {}, unseenHasError: {} },
  },

  append: (notification) => {
    const current = get().list
    const next = pruneNotifications([...current, notification])
    set({ list: next, index: buildIndex(next) })
  },

  markSessionViewed: (sessionId) => {
    const current = get()
    const count = current.index.session.unseenCount[sessionId] ?? 0
    if (count === 0) return

    const next = current.list.map((n) =>
      n.session === sessionId && !n.viewed ? { ...n, viewed: true } : n,
    )
    set({ list: next, index: buildIndex(next) })
  },

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
}

export function markSessionViewed(sessionId: string) {
  useNotificationStore.getState().markSessionViewed(sessionId)
}

// ---------------------------------------------------------------------------
// React hooks for fine-grained subscriptions
// ---------------------------------------------------------------------------

export function useSessionUnseenCount(sessionId: string): number {
  return useNotificationStore((s) => s.index.session.unseenCount[sessionId] ?? 0)
}

export function useSessionHasError(sessionId: string): boolean {
  return useNotificationStore((s) => s.index.session.unseenHasError[sessionId] ?? false)
}

export function useProjectUnseenCount(directory: string): number {
  return useNotificationStore((s) => s.index.project.unseenCount[directory] ?? 0)
}
