import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []
const removedSessionIds: string[] = []
let runtimeKey = "runtime-a"
const runtimeWillChangeCallbacks: Array<() => void> = []

mock.module("@/stores/useGlobalSessionsStore", () => ({
  isGlobalSessionRecencyOnlyUpdate: (existing: Session, incoming: Session) => (
    existing.title === incoming.title && existing.time?.updated !== incoming.time?.updated
  ),
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
      upsertSessions: (sessions: Session[]) => {
        upsertedSessions.push(...sessions)
      },
      removeSessions: (ids: string[]) => {
        removedSessionIds.push(...ids)
      },
    }),
  },
}))
mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: (callback: () => void) => {
    runtimeWillChangeCallbacks.push(callback)
    return () => {
      const index = runtimeWillChangeCallbacks.indexOf(callback)
      if (index >= 0) runtimeWillChangeCallbacks.splice(index, 1)
    }
  },
}))
import { applySessionEventToGlobalSessions } from "../session-event-router"

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

const buildCreatedEvent = (session: Session): Event => ({
  type: "session.created",
  properties: { info: session },
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
    runtimeWillChangeCallbacks.forEach((callback) => callback())
    runtimeKey = "runtime-a"
    currentSessions = []
    upsertedSessions.length = 0
    removedSessionIds.length = 0
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
    runtimeWillChangeCallbacks.forEach((callback) => callback())
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toEqual([])
  })

  test("ignores internal session create and update events", () => {
    const internal = {
      ...buildSession("Walkthrough", { created: 1, updated: 10 }),
      metadata: { openchamber: { internalSession: { kind: "walkthrough-inference", version: 1 } } },
    } as Session

    applySessionEventToGlobalSessions(buildCreatedEvent(internal))
    applySessionEventToGlobalSessions(buildEvent({ ...internal, time: { created: 1, updated: 20 } }))
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", internal.id))

    expect(upsertedSessions).toEqual([])
  })

})
