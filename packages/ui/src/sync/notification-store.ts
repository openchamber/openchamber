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
import { clearNativeSessionNotifications } from "@/lib/nativeNotifications"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { getKnownSessionIds, getSessionFamilyIds, getUnreadSessionIds, markSessionsUnreadSeen, markSessionUnreadSeen } from "./session-unread"

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

/** Closes this browser's web-push notifications about the session, if it has any. */
function closeWebPushSessionNotifications(sessionId: string) {
  // Absent in VS Code webviews and on an insecure origin.
  void navigator.serviceWorker?.getRegistration()
    .then((registration) => registration?.getNotifications())
    .then((shown) => {
      // Push notifications carry `data.sessionId` (sw.ts).
      for (const notification of shown ?? []) {
        if (notification.data?.sessionId === sessionId) notification.close()
      }
    })
    .catch(() => { /* a browser without push notifications has nothing to close */ })
}

function clearSessionNotifications(sessionId: string, { clearNativeBanners = true } = {}) {
  clearDesktopSessionNotifications(sessionId)
  closeWebPushSessionNotifications(sessionId)
  // The native app removes the phone's delivered banners for this session and
  // every session nested under it: opening the parent shows the requests its
  // subagents wait on, and a pull-request alert names no session so it stays.
  // This is the local path; the clearing request below covers the phones only
  // while they can receive it.
  if (clearNativeBanners) void clearNativeSessionNotifications(getSessionFamilyIds(sessionId))
  // The server removes the session's pushed notifications from the phones and
  // resets their badge count, since the user is in the app.
  runtimeFetch(`/api/sessions/${encodeURIComponent(sessionId)}/view`, { method: "POST" })
    .catch(() => { /* the phones drop them with the next push */ })
}

/**
 * The user saw the session: its unread mark clears on every device, and so do
 * its notifications on this machine and on the phones, including ones that
 * left no unread mark, such as a permission request.
 */
export function markSessionViewed(sessionId: string) {
  markSessionUnreadSeen(sessionId)
  clearSessionNotifications(sessionId)
}

/** The user chose Mark as read: the session's own unread mark clears too, even on the open session. */
export function markSessionRead(sessionId: string) {
  markSessionUnreadSeen(sessionId, { explicit: true })
  clearSessionNotifications(sessionId)
}

/** Every unread session the client knows of is marked read, the way Mark as read does for one. */
export function markAllSessionsViewed() {
  // Every banner of a session this runtime knows goes, including ones that left
  // no unread mark, such as a permission request. Sessions of another paired
  // server stay.
  void clearNativeSessionNotifications(getKnownSessionIds())
  for (const sessionId of markSessionsUnreadSeen(getUnreadSessionIds(), { explicit: true })) {
    clearSessionNotifications(sessionId, { clearNativeBanners: false })
  }
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
