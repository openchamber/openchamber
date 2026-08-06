/**
 * Tests for interrupted-turn reconciliation (#2577): when a managed OpenCode
 * process dies mid-turn, the persisted turn never settles — the trailing
 * assistant message has no time.completed and its tool parts stay running.
 * Once the session is authoritatively settled, `interruptedTurnToolParts`
 * finalizes the orphaned parts locally.
 */
import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { interruptedTurnToolParts } from "../sync-context"
import type { DirectoryStore } from "../child-store"
import { INITIAL_STATE } from "../types"

function state(overrides: Partial<DirectoryStore> = {}): DirectoryStore {
  return {
    ...INITIAL_STATE,
    session_status: {},
    message: {},
    part: {},
    question: {},
    permission: {},
    ...overrides,
  } as unknown as DirectoryStore
}

function runningTool(id: string, messageID: string, start = 1000): Part {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    state: { status: "running", time: { start }, input: {} },
  } as unknown as Part
}

function completedTool(id: string, messageID: string): Part {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    state: { status: "completed", time: { start: 1000, end: 2000 }, input: {} },
  } as unknown as Part
}

function pendingTool(id: string, messageID: string): Part {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    state: { status: "pending", time: { start: 1000 }, input: {} },
  } as unknown as Part
}

function unfinishedAssistantMessage(id: string): Message {
  return { id, sessionID: "ses_1", role: "assistant", parentID: "", modelID: "", providerID: "", mode: "primary", system: "", agent: "", model: "", time: { created: 10 } } as unknown as Message
}

function finishedAssistantMessage(id: string): Message {
  return { id, sessionID: "ses_1", role: "assistant", parentID: "", modelID: "", providerID: "", mode: "primary", system: "", agent: "", model: "", time: { created: 10, completed: 2000 } } as unknown as Message
}

describe("interruptedTurnToolParts (#2577)", () => {
  test("settled session with unfinished message and running tool finalizes the part", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })

    const result = interruptedTurnToolParts(store, "ses_1", 5000)
    expect(result).not.toBeNull()
    const part = result!.parts[0] as { state: { status: string; error: string; time: { end: number } } }
    expect(part.state.status).toBe("error")
    expect(part.state.error).toBe("Interrupted")
    expect(part.state.time.end).toBe(5000)
  })

  test("busy session is never marked (live work)", () => {
    const store = state({
      session_status: { ses_1: { type: "busy" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("absent status is unknown, not settled — never marked", () => {
    const store = state({
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("finished message is not an interruption (tail refresh reconciles it)", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [finishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("pending question means the turn is waiting for input, not interrupted", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
      question: { ses_1: [{ id: "q_1", sessionID: "ses_1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "" }] }] }] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("pending permission means the turn is waiting for input, not interrupted", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
      permission: { ses_1: [{ id: "p_1", sessionID: "ses_1", permission: "bash", patterns: [], metadata: {}, always: [] }] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("only active parts are finalized; completed parts are untouched", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: {
        msg_1: [runningTool("tool_1", "msg_1"), completedTool("tool_2", "msg_1"), pendingTool("tool_3", "msg_1")],
      },
    })

    const result = interruptedTurnToolParts(store, "ses_1", 5000)
    expect(result).not.toBeNull()
    const statuses = result!.parts.map((part) => (part as { state: { status: string } }).state.status)
    expect(statuses).toEqual(["error", "completed", "error"])
  })

  test("no active parts → no change", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [completedTool("tool_2", "msg_1")] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })
})
