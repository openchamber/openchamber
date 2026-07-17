import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []
const autoCloseDirectories: Array<Array<string | null | undefined>> = []

mock.module("../session-actions", () => ({
  closeProjectsWithoutActiveSessionsForDirectories: mock(async (directories: Iterable<string | null | undefined>) => {
    autoCloseDirectories.push([...directories])
  }),
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (session: Session) => (session as Session & { directory?: string }).directory ?? null,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
      removeSessions: (ids: string[]) => {
        currentSessions = currentSessions.filter((session) => !ids.includes(session.id))
      },
    }),
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

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    currentSessions = []
    upsertedSessions.length = 0
    autoCloseDirectories.length = 0
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    currentSessions = [buildSession("New Title", { created: 1, updated: 20 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })

  test("checks project closure after an authoritative archive event", () => {
    currentSessions = [{ ...buildSession("Session", { created: 1, updated: 10 }), directory: "/project" } as Session]

    applySessionEventToGlobalSessions(buildEvent({
      ...currentSessions[0],
      time: { created: 1, updated: 20, archived: 20 },
    }))

    expect(autoCloseDirectories).toEqual([["/project"]])
  })

  test("checks project closure after an authoritative delete event", () => {
    currentSessions = [{ ...buildSession("Session", { created: 1, updated: 10 }), directory: "/project" } as Session]

    applySessionEventToGlobalSessions({
      type: "session.deleted",
      properties: { sessionID: "ses_1" },
    } as Event)

    expect(autoCloseDirectories).toEqual([["/project"]])
  })
})
