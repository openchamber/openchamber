/**
 * Tests for interrupted-turn reconciliation (#2577): when a managed OpenCode
 * process dies mid-turn, the persisted turn never settles — the trailing
 * assistant message has no time.completed and its tool parts stay running.
 * Once the session is authoritatively settled, `interruptedTurnToolParts`
 * completes the assistant message as aborted and finalizes orphaned parts.
 */
import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@/lib/opencode/model"
import { interruptedTurnToolParts } from "../sync-context"
import type { DirectoryStore } from "../child-store"
import { INITIAL_STATE } from "../types"

function state(overrides: Partial<DirectoryStore> = {}): DirectoryStore {
  return {
    ...INITIAL_STATE,
    session_status: {},
    message: {},
    part: {},
    form: {},
    permission: {},
    ...overrides,
  } as unknown as DirectoryStore
}

function toolPart(id: string, messageID: string, state: ToolPart["state"]): Part {
  return { id, messageID, sessionID: "ses_1", type: "tool", callID: `call-${id}`, tool: "bash", state }
}

function runningTool(id: string, messageID: string, start = 1000): Part {
  return toolPart(id, messageID, { status: "running", time: { start }, input: {} })
}

function completedTool(id: string, messageID: string): Part {
  return toolPart(id, messageID, { status: "completed", output: "", time: { start: 1000, end: 2000 }, input: {} })
}

function pendingTool(id: string, messageID: string): Part {
  return toolPart(id, messageID, { status: "pending", input: {}, raw: "" })
}

function unfinishedAssistantMessage(id: string): Message {
  return { id, sessionID: "ses_1", role: "assistant", modelID: "model", providerID: "provider", agent: "build", time: { created: 10 } }
}

function finishedAssistantMessage(id: string): Message {
  return { id, sessionID: "ses_1", role: "assistant", modelID: "model", providerID: "provider", agent: "build", time: { created: 10, completed: 2000 } }
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
    const part = result!.parts![0] as { state: { status: string; error: string; time: { end: number } } }
    expect(part.state.status).toBe("error")
    expect(part.state.error).toBe("Interrupted")
    expect(part.state.time.end).toBe(5000)
    expect(result!.messages[0]).toEqual({
      ...unfinishedAssistantMessage("msg_1"),
      time: { created: 10, completed: 5000 },
      error: { type: "aborted", message: "aborted" },
    })
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

  test("pending form means the turn is waiting for input, not interrupted", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
      form: { ses_1: [{ id: "form_1", sessionID: "ses_1", title: "Pick one", fields: [{ key: "a", type: "boolean" }] }] },
    })
    expect(interruptedTurnToolParts(store, "ses_1")).toBeNull()
  })

  test("pending permission means the turn is waiting for input, not interrupted", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
      permission: { ses_1: [{ id: "p_1", sessionID: "ses_1", action: "bash", resources: [], metadata: {} }] },
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
    const statuses = result!.parts!.map((part) => (part as { state: { status: string } }).state.status)
    expect(statuses).toEqual(["error", "completed", "error"])
  })

  test("unfinished assistant with no tools is completed as aborted", () => {
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: {},
    })

    const result = interruptedTurnToolParts(store, "ses_1", 5000)
    expect(result).not.toBeNull()
    expect(result!.parts).toBe(undefined)
    expect(result!.messages[0]).toEqual({
      ...unfinishedAssistantMessage("msg_1"),
      time: { created: 10, completed: 5000 },
      error: { type: "aborted", message: "aborted" },
    })
  })

  test("completed tools are untouched while the unfinished assistant is aborted", () => {
    const completed = completedTool("tool_2", "msg_1")
    const store = state({
      session_status: { ses_1: { type: "idle" } },
      message: { ses_1: [unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [completed] },
    })

    const result = interruptedTurnToolParts(store, "ses_1", 5000)
    expect(result).not.toBeNull()
    expect(result!.parts).toBe(undefined)
    expect(store.part.msg_1[0]).toBe(completed)
    expect(result!.messages[0]).toEqual({
      ...unfinishedAssistantMessage("msg_1"),
      time: { created: 10, completed: 5000 },
      error: { type: "aborted", message: "aborted" },
    })
  })
})
