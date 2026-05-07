import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"

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

function createPart(messageID: string, id = "p-1"): Part {
  return { id, messageID, type: "text", text: "hello" } as unknown as Part
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
      part: { "m-1": [] }, // incomplete message has no parts yet
    }).sort()).toEqual(["busy", "incomplete", "parent"])
  })

  test("includes the currently viewed session even when it looks idle and complete", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
      part: { "m-1": [createPart("m-1")] },
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
      part: { "m-1": [createPart("m-1")] },
    }, {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "active" },
    }).sort()).not.toContain("active")
  })

  test("includes session with completed assistant but empty parts", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("s-1")],
      session_status: { "s-1": { type: "idle" } as SessionStatus },
      message: {
        "s-1": [createAssistantMessage("m-1", "s-1", 1)],
      },
      part: {}, // message m-1 has no parts at all
    })).toContain("s-1")
  })

  test("includes session with completed assistant but parts array is empty", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("s-2")],
      session_status: { "s-2": { type: "idle" } as SessionStatus },
      message: {
        "s-2": [createAssistantMessage("m-2", "s-2", 1)],
      },
      part: { "m-2": [] }, // message m-2 has empty parts array
    })).toContain("s-2")
  })

  test("does not include session with completed assistant and populated parts", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("s-3")],
      session_status: { "s-3": { type: "idle" } as SessionStatus },
      message: {
        "s-3": [createAssistantMessage("m-3", "s-3", 1)],
      },
      part: { "m-3": [createPart("m-3")] },
    })).not.toContain("s-3")
  })
})
