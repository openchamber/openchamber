import type { Event, Session } from "@opencode-ai/sdk/v2/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { stripSessionDiffSnapshots } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

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
  if (payload.type === "session.created" || payload.type === "session.updated") {
    const session = getSessionInfoFromPayload(payload)
    if (session) {
      const currentSession = getGlobalSessionSnapshot(session.id)
      if (!shouldSkipStaleSessionEvent(currentSession, session)) {
        useGlobalSessionsStore.getState().upsertSession(session)
      }
    }
    return
  }

  if (payload.type === "session.deleted") {
    const sessionID = (payload as { properties?: { sessionID?: string } }).properties?.sessionID ?? getSessionInfoFromPayload(payload)?.id
    if (sessionID) {
      useGlobalSessionsStore.getState().removeSessions([sessionID])
    }
  }
}
