import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"

let currentSessions: Session[] = []
const upsertedSessions: Session[] = []

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
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
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    currentSessions = [buildSession("New Title", { created: 1, updated: 20 })]

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })
})
