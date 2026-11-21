import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []
const removedSessionIds: string[] = []
let mutationCalls = 0
let runtimeKey = "runtime-a"
let runtimeWillChange: (() => void) | null = null

mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (session: Session) => session,
  isGlobalSessionDeferrableUpdate: (existing: Session, incoming: Session) => (
    existing.title === incoming.title && (
      existing.time?.updated !== incoming.time?.updated
      || existing.cost !== incoming.cost
      || JSON.stringify(existing.tokens) !== JSON.stringify(incoming.tokens)
    )
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
      noteDeferredSessionUpdate: () => undefined,
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
import {
  applySessionEventsToGlobalSessions,
  applySessionEventToGlobalSessions,
  readDeferredGlobalUpdates,
} from "../session-event-router"
import {
  registerBulkArchiveEchoes,
  releaseBulkArchiveEchoes,
  shouldConsumeBulkArchiveEcho,
} from "../bulk-archive-echo"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  title,
  time,
} as Session)

// v2 reports a changed session as a patch against the record the store holds.
const buildEvent = (session: Session): SyncEvent => ({
  type: "session.patched",
  properties: {
    sessionID: session.id,
    patch: { title: session.title, time: session.time },
  },
})

const buildDeleteEvent = (sessionId: string): SyncEvent => ({
  type: "session.deleted",
  properties: { sessionID: sessionId },
})

const buildLifecycleEvent = (type: "session.idle" | "session.error", sessionId: string): SyncEvent => (
  type === "session.idle"
    ? { type, properties: { sessionID: sessionId } }
    : { type, properties: { sessionID: sessionId, error: { type: "UnknownError", message: "failed" } } }
)

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    runtimeWillChange?.()
    runtimeKey = "runtime-a"
    currentSessions = []
    upsertedSessions.length = 0
    removedSessionIds.length = 0
    mutationCalls = 0
  })

  test("skips stale global session.patched echoes after a newer rename", () => {
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

  test("keeps every spend patch of a turn in the update committed at idle", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]
    const tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }

    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { cost: 1, time: { updated: 20 } } } })
    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { tokens } } })

    expect(upsertedSessions).toEqual([])
    expect(readDeferredGlobalUpdates().get("ses_1")).toMatchObject({ cost: 1, tokens })
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))
    expect(upsertedSessions).toHaveLength(1)
    expect(upsertedSessions[0]).toMatchObject({ cost: 1, tokens, time: { updated: 20 } })
    expect(readDeferredGlobalUpdates().size).toBe(0)
  })

  test("a deferred update keeps what another owner published meanwhile", () => {
    const initial = buildSession("Initial", { created: 1, updated: 10 })
    currentSessions = [initial]
    const tokens = { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }

    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { cost: 1, time: { updated: 20 } } } })
    // A view lands on the published record while the turn runs.
    currentSessions = [{ ...initial, time: { ...initial.time, viewed: 8 } }]
    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { tokens } } })
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions).toHaveLength(1)
    expect(upsertedSessions[0]).toMatchObject({ cost: 1, tokens, time: { updated: 20, viewed: 8 } })
  })

  test("spend a refresh published meanwhile wins over the deferred spend", () => {
    const initial = buildSession("Initial", { created: 1, updated: 10 })
    currentSessions = [initial]

    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { cost: 1, time: { updated: 20 } } } })
    currentSessions = [{ ...initial, cost: 2 }]
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))

    expect(upsertedSessions.map((session) => session.cost)).toEqual([2])
  })

  test("a structural patch publishes with the spend deferred before it", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { cost: 2, time: { updated: 20 } } } })
    applySessionEventToGlobalSessions({ type: "session.patched", properties: { sessionID: "ses_1", patch: { title: "Renamed" } } })

    expect(upsertedSessions).toHaveLength(1)
    expect(upsertedSessions[0]).toMatchObject({ title: "Renamed", cost: 2, time: { updated: 20 } })
    applySessionEventToGlobalSessions(buildLifecycleEvent("session.idle", "ses_1"))
    expect(upsertedSessions).toHaveLength(1)
  })

  test("applies substantive session updates immediately", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Renamed", { created: 1, updated: 20 })))

    expect(upsertedSessions.map((session) => session.title)).toEqual(["Renamed"])
  })

  test("applies a metadata broadcast to the global record at once", () => {
    currentSessions = [buildSession("Initial", { created: 1, updated: 10 })]

    applySessionEventToGlobalSessions({
      type: "session.patched",
      properties: { sessionID: "ses_1", patch: { metadata: { openchamber: { work: { state: "open" } } } } },
    })

    expect(upsertedSessions.map((session) => session.metadata)).toEqual([{ openchamber: { work: { state: "open" } } }])
    expect(upsertedSessions[0]?.title).toBe("Initial")
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
    } as SyncEvent))

    applySessionEventsToGlobalSessions(events)

    expect(mutationCalls).toBe(1)
    expect(upsertedSessions).toHaveLength(1_000)
  })

  test("consumes only the matching bulk archive echo", () => {
    registerBulkArchiveEchoes(runtimeKey, [{ id: "ses_1", archivedAt: 20 }], 100)

    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", {
      created: 1,
      updated: 20,
      archived: 20,
    })), runtimeKey, 101)).toBe(true)
    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", {
      created: 1,
      updated: 21,
      archived: 21,
    })), runtimeKey, 101)).toBe(false)
    expect(shouldConsumeBulkArchiveEcho(buildEvent(buildSession("Initial", {
      created: 1,
      updated: 20,
      archived: 20,
    })), "runtime-b", 101)).toBe(false)
  })

  test("does not consume an expired or released bulk archive echo", () => {
    registerBulkArchiveEchoes(runtimeKey, [{ id: "ses_1", archivedAt: 20 }], 100)
    const event = buildEvent(buildSession("Initial", { created: 1, updated: 20, archived: 20 }))

    expect(shouldConsumeBulkArchiveEcho(event, runtimeKey, 30_101)).toBe(false)

    registerBulkArchiveEchoes(runtimeKey, [{ id: "ses_1", archivedAt: 20 }], 100)
    releaseBulkArchiveEchoes(runtimeKey, ["ses_1"])
    expect(shouldConsumeBulkArchiveEcho(event, runtimeKey, 101)).toBe(false)
  })
})
