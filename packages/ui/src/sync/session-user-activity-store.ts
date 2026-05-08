import { create } from "zustand"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"

export type SessionUserActivityState = {
  bySessionId: Map<string, number>
  resolvedSessionIds: Set<string>
  recordUserMessageAt: (sessionId: string, createdAt: number) => void
  reconcileSessionFromMessages: (sessionId: string, messages: Message[]) => void
  invalidateSession: (sessionId: string) => void
}

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

export const getLatestUserMessageTimestamp = (messages: Message[]): number | null => {
  let latest: number | null = null
  for (const message of messages) {
    if (message.role !== "user") {
      continue
    }
    const createdAt = toFiniteNumber(message.time?.created)
    if (createdAt === null) {
      continue
    }
    if (latest === null || createdAt > latest) {
      latest = createdAt
    }
  }
  return latest
}

export const getApexSessionId = (sessionId: string, sessionsById: Map<string, Session>): string => {
  let currentId = sessionId
  const seen = new Set<string>()

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = sessionsById.get(currentId) as (Session & { parentID?: string | null }) | undefined
    const parentId = session?.parentID
    if (!parentId) {
      return currentId
    }
    currentId = parentId
  }

  return sessionId
}

export const getApexUserActivityMap = (
  sessions: Session[],
  lastUserMessageAtBySessionId: Map<string, number>,
): Map<string, number> => {
  if (lastUserMessageAtBySessionId.size === 0) {
    return lastUserMessageAtBySessionId
  }

  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const activityByApexSessionId = new Map<string, number>()
  lastUserMessageAtBySessionId.forEach((timestamp, sessionId) => {
    const apexSessionId = getApexSessionId(sessionId, sessionsById)
    const existing = activityByApexSessionId.get(apexSessionId)
    if (existing === undefined || timestamp > existing) {
      activityByApexSessionId.set(apexSessionId, timestamp)
    }
  })
  return activityByApexSessionId
}

export const useSessionUserActivityStore = create<SessionUserActivityState>()((set) => ({
  bySessionId: new Map<string, number>(),
  resolvedSessionIds: new Set<string>(),

  recordUserMessageAt: (sessionId, createdAt) => {
    if (!sessionId || !Number.isFinite(createdAt)) {
      return
    }
    set((state) => {
      const existing = state.bySessionId.get(sessionId)
      const resolved = state.resolvedSessionIds.has(sessionId)
      if (existing !== undefined && createdAt <= existing && resolved) {
        return state
      }
      const nextActivity = existing !== undefined && createdAt <= existing
        ? state.bySessionId
        : new Map(state.bySessionId).set(sessionId, createdAt)
      const nextResolved = resolved
        ? state.resolvedSessionIds
        : new Set(state.resolvedSessionIds).add(sessionId)
      return { bySessionId: nextActivity, resolvedSessionIds: nextResolved }
    })
  },

  reconcileSessionFromMessages: (sessionId, messages) => {
    if (!sessionId) {
      return
    }
    const latest = getLatestUserMessageTimestamp(messages)
    set((state) => {
      const existing = state.bySessionId.get(sessionId)
      const resolved = state.resolvedSessionIds.has(sessionId)
      if (latest === null) {
        if (existing === undefined && resolved) {
          return state
        }
        const nextActivity = existing === undefined ? state.bySessionId : new Map(state.bySessionId)
        if (existing !== undefined) {
          nextActivity.delete(sessionId)
        }
        const nextResolved = resolved
          ? state.resolvedSessionIds
          : new Set(state.resolvedSessionIds).add(sessionId)
        return { bySessionId: nextActivity, resolvedSessionIds: nextResolved }
      }

      if (existing === latest && resolved) {
        return state
      }
      const nextActivity = existing === latest
        ? state.bySessionId
        : new Map(state.bySessionId).set(sessionId, latest)
      const nextResolved = resolved
        ? state.resolvedSessionIds
        : new Set(state.resolvedSessionIds).add(sessionId)
      return { bySessionId: nextActivity, resolvedSessionIds: nextResolved }
    })
  },

  invalidateSession: (sessionId) => {
    if (!sessionId) {
      return
    }
    set((state) => {
      const hasActivity = state.bySessionId.has(sessionId)
      const resolved = state.resolvedSessionIds.has(sessionId)
      if (!hasActivity && !resolved) {
        return state
      }

      const nextActivity = hasActivity ? new Map(state.bySessionId) : state.bySessionId
      if (hasActivity) {
        nextActivity.delete(sessionId)
      }
      const nextResolved = resolved ? new Set(state.resolvedSessionIds) : state.resolvedSessionIds
      if (resolved) {
        nextResolved.delete(sessionId)
      }
      return { bySessionId: nextActivity, resolvedSessionIds: nextResolved }
    })
  },
}))
