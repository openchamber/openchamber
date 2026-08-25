import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []
const removedSessionIds: string[] = []
let mutationCalls = 0
let runtimeKey = "runtime-a"
let runtimeWillChange: (() => void) | null = null

mock.module("@/stores/useGlobalSessionsStore", () => ({
  isGlobalSessionRecencyOnlyUpdate: (existing: Session, incoming: Session) => (
    existing.title === incoming.title && existing.time?.updated !== incoming.time?.updated
  ),
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      entityById: new Map(currentSessions.map((session) => [session.id, session])),
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
      upsertSessions: (sessions: Session[]) => {
        upsertedSessions.push(...sessions)
      },
      removeSessions: (ids: string[]) => {
        removedSessionIds.push(...ids)
      },
      applySessionMutations: (mutations: Array<
        { type: "upsert"; session: Session } | { type: "remove"; sessionId: string }
      >) => {
        mutationCalls += 1
        for (const mutation of mutations) {
          if (mutation.type === "upsert") upsertedSessions.push(mutation.session)
          else removedSessionIds.push(mutation.sessionId)
        }
      },
    }),
  },
}))
mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: (callback: () => void) => {
    runtimeWillChange = callback
    return () => undefined
  },
}))
import { applySessionEventsToGlobalSessions, applySessionEventToGlobalSessions } from "../session-event-router"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  title,
  time,
} as Session)

const buildEvent = (session: Session): Event => ({
  type: "session.updated",
  properties: {
    info: session,
  },
} as Event)

const buildDeleteEvent = (sessionId: string): Event => ({
  type: "session.deleted",
  properties: { sessionID: sessionId },
} as Event)

const buildLifecycleEvent = (type: "session.idle" | "session.error", sessionId: string): Event => ({
  type,
  properties: { sessionID: sessionId },
} as Event)

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    runtimeWillChange?.()
    runtimeKey = "runtime-a"
    currentSessions = []
    upsertedSessions.length = 0
    removedSessionIds.length = 0
    mutationCalls = 0
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    currentSessions = [buildSession("New Title", { created: 1, updated: 20 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })

  test("commits only the latest recency update when a session becomes idle", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 30 })))

    expect(upsertedSessions).toEqual([])
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))
    expect(upsertedSessions.map((session) => session.time.updated)).toEqual([30])
  })

  test("applies substantive session updates immediately", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Renamed", { created: 1, updated: 20 })))

    expect(upsertedSessions.map((session) => session.title)).toEqual(["Renamed"])
  })

  test("cancels a pending global update when the session is deleted", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))
    applySessionEventToGlobalSessions(buildDeleteEvent("ses_1"))
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toEqual([])
    expect(removedSessionIds).toEqual(["ses_1"])
  })

  test("discards pending global updates when the runtime changes", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]
    applySessionEventToGlobalSessions(buildEvent(buildSession("Initial", { created: 1, updated: 20 })))

    runtimeKey = "runtime-b"
    runtimeWillChange?.()
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toEqual([])
  })

  test("commits an ordered event batch once", () => {
    const events = Array.from({ length: 1_000 }, (_, index) => ({
      type: "session.created",
      properties: {
        info: {
          id: `ses_${index}`,
          title: `Session ${index}`,
          time: { created: index, updated: index },
        },
      },
    } as Event))

    applySessionEventsToGlobalSessions(events)

    expect(mutationCalls).toBe(1)
    expect(upsertedSessions).toHaveLength(1_000)
  })
})
