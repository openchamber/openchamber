import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { getReconnectCandidateSessionIds, mergeBootstrapSessions } from "./reconnect-recovery"

function createSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    version: "1",
    ...overrides,
  } as Session
}

function createAssistantMessage(id: string, sessionID: string, completed?: number): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: completed ? { created: 1, updated: 1, completed } : { created: 1, updated: 1 },
    parts: [],
  } as unknown as Message
}

function createPart(id: string, messageID: string): Part {
  return { id, messageID, sessionID: "active", type: "text", text: "done" } as Part
}

describe("getReconnectCandidateSessionIds", () => {
  test("includes non-idle, incomplete assistant, and parent sessions", () => {
    const busyStatus = { type: "busy" } as SessionStatus

    expect(getReconnectCandidateSessionIds({
      session: [
        createSession("busy"),
        createSession("child", { parentID: "parent" }),
        createSession("parent"),
        createSession("incomplete"),
      ],
      session_status: { busy: busyStatus },
      message: {
        incomplete: [createAssistantMessage("m-1", "incomplete")],
      },
    }).sort()).toEqual(["busy", "incomplete", "parent"])
  })

  test("includes the currently viewed session even when it looks idle and complete", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
      part: {
        "m-1": [createPart("p-1", "m-1")],
      },
    }, {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "active" },
    }).sort()).toContain("active")
  })

  test("includes completed assistant sessions when the latest assistant parts are missing", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("blank")],
      session_status: { blank: { type: "idle" } as SessionStatus },
      message: {
        blank: [createAssistantMessage("m-1", "blank", 1)],
      },
      part: {},
    })).toEqual(["blank"])
  })

  test("does not include a viewed session from another directory", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
      part: {
        "m-1": [createPart("p-1", "m-1")],
      },
    }, {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "active" },
    }).sort()).not.toContain("active")
  })
})

describe("mergeBootstrapSessions", () => {
  test("recovers a referenced parent when the roots response is temporarily empty", () => {
    const parent = createSession("parent")
    const child = createSession("child", { parentID: "parent" })

    expect(mergeBootstrapSessions([], [child], [parent])).toEqual({
      sessions: [child, parent],
      rootCount: 1,
    })
  })

  test("recovers referenced parents from the broader response without retaining stale roots", () => {
    const parent = createSession("parent")
    const stale = createSession("stale")
    const child = createSession("child", { parentID: "parent" })

    expect(mergeBootstrapSessions([], [parent, child], [stale])).toEqual({
      sessions: [child, parent],
      rootCount: 1,
    })
  })

  test("treats a successful empty response as authoritative", () => {
    const persisted = createSession("persisted")

    expect(mergeBootstrapSessions([], [], [persisted])).toEqual({
      sessions: [],
      rootCount: 0,
    })
  })

  test("preserves known children when the child-session request fails", () => {
    const cachedParent = createSession("parent")
    const authoritativeParent = createSession("parent", { title: "Current" })
    const cachedChild = createSession("child", { parentID: "parent" })

    expect(mergeBootstrapSessions([authoritativeParent], null, [cachedChild, cachedParent])).toEqual({
      sessions: [cachedChild, authoritativeParent],
      rootCount: 1,
    })
  })

  test("overlays live session events that arrive after the request starts", () => {
    const staleResponse = createSession("existing", { title: "Stale" })
    const liveUpdate = createSession("existing", { title: "Live" })
    const liveCreate = createSession("new")

    expect(mergeBootstrapSessions([staleResponse], [], [liveUpdate, liveCreate], {
      baselineRevision: 4,
      eventRevision: { existing: 5, new: 6 },
    })).toEqual({
      sessions: [liveUpdate, liveCreate],
      rootCount: 2,
    })
  })

  test("does not resurrect a session deleted after the request starts", () => {
    const deleted = createSession("deleted")

    expect(mergeBootstrapSessions([deleted], [], [], {
      baselineRevision: 2,
      deletedRevision: { deleted: 3 },
    })).toEqual({
      sessions: [],
      rootCount: 0,
    })
  })
})
