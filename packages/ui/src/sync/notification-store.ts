// ---------------------------------------------------------------------------
// Notification store — what OpenCode reported for failed turns, and the
// "the user saw this session" entry point.
//
// Whether a session is unread is not kept here: OpenCode keeps it on the
// session record (`session-unread.ts`). This store holds the live error details
// the chat shows under a failed turn, which the record does not carry.
// ---------------------------------------------------------------------------

import { create } from "zustand"
import { clearDesktopSessionNotifications } from "@/lib/desktop"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { markSessionUnreadSeen } from "./session-unread"

export type ErrorNotification = {
  directory?: string
  session?: string
  time: number
  /** What OpenCode reported for the failed turn; both null when it gave no details. */
  error?: { name: string | null; message: string | null; responseBody?: string | null }
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function pruneNotifications(list: ErrorNotification[]): ErrorNotification[] {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

interface NotificationStore {
  list: ErrorNotification[]
  append: (notification: ErrorNotification) => void
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  list: [],
  append: (notification) => {
    set({ list: pruneNotifications([...get().list, notification]) })
  },
}))

export function appendErrorNotification(notification: ErrorNotification) {
  useNotificationStore.getState().append(notification)
}

/**
 * The user saw the session: its unread mark clears on every device, and so do
 * its native notifications, including ones that left no unread mark, such as a
 * permission request. The server also resets the phone's push badge count,
 * since the user is in the app.
 */
export function markSessionViewed(sessionId: string) {
  markSessionUnreadSeen(sessionId)
  clearDesktopSessionNotifications(sessionId)
  runtimeFetch(`/api/sessions/${encodeURIComponent(sessionId)}/view`, { method: "POST" })
    .catch(() => { /* the badge resets on the next engagement signal */ })
}

/** The newest error OpenCode reported for this session. */
export function useLatestSessionError(sessionId: string): ErrorNotification | null {
  return useNotificationStore((s) => {
    if (!sessionId) return null
    for (let index = s.list.length - 1; index >= 0; index -= 1) {
      const notification = s.list[index]
      if (notification.session === sessionId) return notification
    }
    return null
  })
}
