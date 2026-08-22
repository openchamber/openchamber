import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { isGlobalSessionRecencyOnlyUpdate, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from "@/lib/runtime-switch"
import { streamPerfCount, streamPerfMark } from "@/stores/utils/streamDebug"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import { isOpenChamberInternalSessionEvent } from "@/lib/sessionInternalMetadata"

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
  const currentSession = getGlobalSessionSnapshot(update.session.id)
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

  // SAFETY: OpenCode session lifecycle events own a properties object; this
  // narrow view reads only their shared info field before validating it.
  const properties = (event as { properties?: { info?: Partial<Session> } }).properties
  if (!properties) {
    return null
  }

  const info = properties.info
  if (!info) {
    return null
  }

  if (info.id?.constructor !== String || !info.time) {
    return null
  }

  // SAFETY: id and time are the required Session fields consumed by this
  // boundary; the SDK event contract supplies the remaining session fields.
  return stripSessionDiffSnapshots(info as Session)
}

const getGlobalSessionSnapshot = (sessionId: string): Session | null => {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

export const applySessionEventToGlobalSessions = (payload: Event, internalSessionGeneration?: number): void => {
  if (isOpenChamberInternalSessionEvent(payload, internalSessionGeneration)) return
  if (payload.type === "session.idle" || payload.type === "session.error") {
    // SAFETY: session.idle/error share this SDK-owned properties contract.
    const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID
    if (sessionID?.constructor === String) flushPendingGlobalSessionUpdate(sessionID)
    return
  }

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
    // SAFETY: session.deleted may identify the session directly or carry info.
    const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID ?? getSessionInfoFromPayload(payload)?.id
    if (sessionID) {
      pendingGlobalSessionUpdates.delete(sessionID)
      useGlobalSessionsStore.getState().removeSessions([sessionID])
    }
  }
}
