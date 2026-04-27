import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessSession } from "@openchamber/harness-contracts"
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
    }, {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "active" },
    }).sort()).toContain("active")
  })

  test("does not include a viewed session from another directory", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
    }, {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "active" },
    }).sort()).not.toContain("active")
  })
})
