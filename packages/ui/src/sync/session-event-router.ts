import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

const GLOBAL_SESSION_UPDATE_FLUSH_MS = 1_000
const pendingGlobalSessionUpdates = new Map<string, { runtimeKey: string; session: Session }>()
let pendingGlobalSessionUpdateTimer: ReturnType<typeof setTimeout> | null = null

const clearPendingGlobalSessionUpdates = (): void => {
  if (pendingGlobalSessionUpdateTimer) {
    clearTimeout(pendingGlobalSessionUpdateTimer)
    pendingGlobalSessionUpdateTimer = null
  }
  pendingGlobalSessionUpdates.clear()
}

const flushPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdateTimer = null
  const updates = [...pendingGlobalSessionUpdates.values()]
  pendingGlobalSessionUpdates.clear()
  const runtimeKey = getRuntimeKey()
  const sessions: Session[] = []
  for (const update of updates) {
    if (update.runtimeKey !== runtimeKey) continue
    const currentSession = getGlobalSessionSnapshot(update.session.id)
    if (!shouldSkipStaleSessionEvent(currentSession, update.session)) {
      sessions.push(update.session)
    }
  }
  if (sessions.length > 0) {
    useGlobalSessionsStore.getState().upsertSessions(sessions)
    streamPerfCount("ui.global_sessions.event_update_publication", sessions.length)
  }
}

const scheduleGlobalSessionUpdate = (session: Session): void => {
  pendingGlobalSessionUpdates.set(session.id, { runtimeKey: getRuntimeKey(), session })
  streamPerfCount("ui.global_sessions.event_update_deferred")
  if (!pendingGlobalSessionUpdateTimer) {
    pendingGlobalSessionUpdateTimer = setTimeout(flushPendingGlobalSessionUpdates, GLOBAL_SESSION_UPDATE_FLUSH_MS)
  }
}

subscribeRuntimeEndpointWillChange(clearPendingGlobalSessionUpdates)

const getSessionInfoFromPayload = (event: Event): Session | null => {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") {
    return null
  }

  const properties = (event as { properties?: unknown }).properties
  if (!properties || typeof properties !== "object") {
    return null
  }

  const info = (properties as { info?: unknown }).info
  if (!info || typeof info !== "object") {
    return null
  }

  const session = info as Partial<Session>
  if (typeof session.id !== "string" || !session.time) {
    return null
  }

  return stripSessionDiffSnapshots(session as Session)
}

const getGlobalSessionSnapshot = (sessionId: string): Session | null => {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

export const applySessionEventToGlobalSessions = (payload: Event): void => {
  if (payload.type === "session.created") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = getGlobalSessionSnapshot(session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        useGlobalSessionsStore.getState().upsertSession(session)
      }
    }
    return
  }

  if (payload.type === "session.updated") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = getGlobalSessionSnapshot(session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        if (currentSession) scheduleGlobalSessionUpdate(session)
        else useGlobalSessionsStore.getState().upsertSession(session)
      }
    }
    return
  }

  if (payload.type === "session.deleted") {
    const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID ?? getSessionInfoFromPayload(payload)?.id
    if (sessionID) {
      pendingGlobalSessionUpdates.delete(sessionID)
      useGlobalSessionsStore.getState().removeSessions([sessionID])
    }
  }
}
