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

const hasUnreadSession = (state: { entityById: ReadonlyMap<string, Session> }): boolean => {
  for (const session of state.entityById.values()) {
    if (isSessionUnread(session)) return true
  }
  return false
}

/** Whether any session is unread; for a control that only matters while it is shown. */
export const useHasUnreadSession = (): boolean => useGlobalSessionsStore(hasUnreadSession)

/** Idle stamps being recorded right now, so repeated calls send one request. */
const pendingViews = new Map<string, number>()

/**
 * Records that the user saw these sessions' last turns. The local records take
 * the watermark at once, in one store update, so the marks clear without
 * waiting for the round trip; a failed write restores its session's mark,
 * unless something newer replaced it. Returns the sessions it marked.
 */
export const markSessionsUnreadSeen = (sessionIds: Iterable<string>): string[] => {
  const store = useGlobalSessionsStore.getState()
  const runtimeKey = getRuntimeKey()
  const seen: Session[] = []
  const views: { session: Session; idle: number }[] = []
  for (const sessionId of sessionIds) {
    const session = store.entityById.get(sessionId)
    if (!session || !isSessionUnread(session)) continue
    const idle = session.time.idle
    if (idle === undefined || pendingViews.get(sessionId) === idle) continue
    pendingViews.set(sessionId, idle)
    views.push({ session, idle })
    seen.push({ ...session, time: { ...session.time, viewed: idle } })
  }
  if (seen.length === 0) return []
  store.upsertSessions(seen)

  for (const { session, idle } of views) {
    const sessionId = session.id
    void opencodeClient.viewSession(sessionId, idle, session.directory)
      .catch((error) => {
        console.warn("[session-unread] failed to record a view", error)
        if (runtimeKey !== getRuntimeKey()) return
        const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
        if (current?.time.viewed !== idle) return
        useGlobalSessionsStore.getState().upsertSession({
          ...current,
          time: compact({ ...current.time, viewed: session.time.viewed }),
        })
      })
      .finally(() => {
        if (pendingViews.get(sessionId) === idle) pendingViews.delete(sessionId)
      })
  }
  return seen.map((session) => session.id)
}

export const markSessionUnreadSeen = (sessionId: string): void => {
  markSessionsUnreadSeen([sessionId])
}

/** Every unread session the client knows of. */
export const getUnreadSessionIds = (): string[] => {
  const ids: string[] = []
  for (const session of useGlobalSessionsStore.getState().entityById.values()) {
    if (isSessionUnread(session)) ids.push(session.id)
  }
  return ids
}
