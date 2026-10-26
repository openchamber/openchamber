// ---------------------------------------------------------------------------
// Unread sessions: a turn that finished and nobody has looked at yet.
//
// OpenCode owns the state. Its session record carries `time.idle`, when the
// last turn ended, and `time.viewed`, a monotone watermark of the last idle
// transition a viewer saw. A session is unread while the turn that ended last
// is newer than the watermark. Because the record lives in OpenCode's database
// the mark survives restarts, and every client of the server sees the same one:
// a view recorded on the phone clears it on the desktop through the
// `session.viewed` event.
// ---------------------------------------------------------------------------

import { useCallback } from "react"
import { compact, type Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"

/**
 * Only top-level sessions are announced; a subtask reports to its parent. An
 * archived session is put away, whichever path archived it, so it is never
 * unread.
 */
export const isSessionUnread = (session: Session | undefined): boolean => {
  if (!session || session.parentID || session.time.archived !== undefined) return false
  const { idle, viewed } = session.time
  return idle !== undefined && (viewed === undefined || viewed < idle)
}

/** Unread, and the turn that left it unread failed. */
export const isSessionUnreadWithError = (session: Session | undefined): boolean => (
  isSessionUnread(session) && session?.outcome === "failed"
)

export const useSessionUnread = (sessionId: string): boolean => (
  useGlobalSessionsStore(useCallback((state) => isSessionUnread(state.entityById.get(sessionId)), [sessionId]))
)

/** Idle stamps being recorded right now, so repeated calls send one request. */
const pendingViews = new Map<string, number>()

/**
 * Records that the user saw the session's last turn. The local record takes
 * the watermark at once, so the mark clears without waiting for the round
 * trip; a failed write restores it, unless something newer replaced it.
 */
export const markSessionUnreadSeen = (sessionId: string): void => {
  const store = useGlobalSessionsStore.getState()
  const session = store.entityById.get(sessionId)
  if (!session || !isSessionUnread(session)) return
  const idle = session.time.idle
  if (idle === undefined || pendingViews.get(sessionId) === idle) return

  const previousViewed = session.time.viewed
  const runtimeKey = getRuntimeKey()
  pendingViews.set(sessionId, idle)
  store.upsertSession({ ...session, time: { ...session.time, viewed: idle } })

  void opencodeClient.viewSession(sessionId, idle, session.directory)
    .catch((error) => {
      console.warn("[session-unread] failed to record a view", error)
      if (runtimeKey !== getRuntimeKey()) return
      const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
      if (current?.time.viewed !== idle) return
      useGlobalSessionsStore.getState().upsertSession({
        ...current,
        time: compact({ ...current.time, viewed: previousViewed }),
      })
    })
    .finally(() => {
      if (pendingViews.get(sessionId) === idle) pendingViews.delete(sessionId)
    })
}
