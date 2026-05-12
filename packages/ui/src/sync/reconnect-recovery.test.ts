import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"

function createSession(id: string, overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id,
    backendId: "opencode",
    title: id,
    time: { created: 1, updated: 1 },
    ...overrides,
  }
}

function createAssistantMessage(id: string, sessionID: string, completed?: number): HarnessMessage {
  return {
    id,
    sessionId: sessionID,
    role: "assistant",
    time: completed ? { created: 1, completed } : { created: 1 },
  }
}

function createPart(id: string, messageID: string): HarnessPart {
  return { id, messageId: messageID, sessionId: "active", kind: "text", text: "done" }
}

describe("getReconnectCandidateSessionIds", () => {
  test("includes non-idle, incomplete assistant, and parent sessions", () => {
    const busyStatus = { type: "busy" } as SessionStatus

    expect(getReconnectCandidateSessionIds({
      session: [
        createSession("busy"),
        createSession("child", { parentId: "parent" }),
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
