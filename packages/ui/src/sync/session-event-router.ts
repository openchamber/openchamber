import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { isGlobalSessionRecencyOnlyUpdate, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

const pendingGlobalSessionUpdates = new Map<string, { runtimeKey: string; session: Session }>()

const clearPendingGlobalSessionUpdates = (): void => {
  pendingGlobalSessionUpdates.clear()
}

const flushPendingGlobalSessionUpdate = (sessionID: string): void => {
  const update = pendingGlobalSessionUpdates.get(sessionID)
  pendingGlobalSessionUpdates.delete(sessionID)
  if (!update) return
  const runtimeKey = getRuntimeKey()
  if (update.runtimeKey !== runtimeKey) return
  const currentSession = useGlobalSessionsStore.getState().getSessionById(update.session.id)
  if (
    !currentSession
    || shouldSkipStaleSessionEvent(currentSession, update.session)
    || !isGlobalSessionRecencyOnlyUpdate(currentSession, update.session)
  ) return
  streamPerfMark("global_sessions.event_update_flush")
  useGlobalSessionsStore.getState().upsertSession(update.session)
  streamPerfCount("ui.global_sessions.event_update_publication")
}

const scheduleGlobalSessionUpdate = (session: Session): void => {
  pendingGlobalSessionUpdates.set(session.id, { runtimeKey: getRuntimeKey(), session })
  streamPerfCount("ui.global_sessions.event_update_deferred")
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

export const applySessionEventToGlobalSessions = (payload: Event): void => {
  if (payload.type === "session.idle" || payload.type === "session.error") {
    const sessionID = (payload as { properties?: { sessionID?: unknown } }).properties?.sessionID
    if (typeof sessionID === "string") flushPendingGlobalSessionUpdate(sessionID)
    return
  }

  if (payload.type === "session.created") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = useGlobalSessionsStore.getState().getSessionById(session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        useGlobalSessionsStore.getState().upsertSession(session)
      }
    }
    return
  }

  if (payload.type === "session.updated") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = useGlobalSessionsStore.getState().getSessionById(session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        if (currentSession && isGlobalSessionRecencyOnlyUpdate(currentSession, session)) {
          scheduleGlobalSessionUpdate(session)
        } else {
          pendingGlobalSessionUpdates.delete(session.id)
          useGlobalSessionsStore.getState().upsertSession(session)
          streamPerfCount("ui.global_sessions.event_update_immediate")
        }
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
