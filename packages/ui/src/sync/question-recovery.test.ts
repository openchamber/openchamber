import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QuestionRequest } from "@/types/question"
import { hasActiveQuestionToolInCurrentTurn, recoverPendingQuestionWithRetry, hasPendingQuestionGap } from "./question-recovery"

const message = (role: "user" | "assistant", parts: Part[] = []) => ({
  info: { id: `${role}-${parts.length}`, sessionID: "ses_1", role } as Message,
  parts,
})

const questionTool = (status: "pending" | "running" | "completed"): Part => ({
  id: `tool-${status}`,
  sessionID: "ses_1",
  messageID: "assistant-1",
  type: "tool",
  tool: "question",
  state: { status, input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: status === "completed" ? 2 : undefined } },
} as Part)

describe("hasActiveQuestionToolInCurrentTurn", () => {
  test("detects a pending or running question in the current turn", () => {
    expect(hasActiveQuestionToolInCurrentTurn([message("user"), message("assistant", [questionTool("pending")])])).toBe(true)
    expect(hasActiveQuestionToolInCurrentTurn([message("user"), message("assistant", [questionTool("running")])])).toBe(true)
  })

  test("ignores completed questions and active questions from an older turn", () => {
    expect(hasActiveQuestionToolInCurrentTurn([message("assistant", [questionTool("completed")])])).toBe(false)
    expect(hasActiveQuestionToolInCurrentTurn([
      message("assistant", [questionTool("running")]),
      message("user"),
      message("assistant"),
    ])).toBe(false)
  })
})

describe("recoverPendingQuestionWithRetry", () => {
  test("retries the cold-start inconsistency with bounded delays and stops on recovery", async () => {
    const delays: number[] = []
    let attempts = 0

    const recovered = await recoverPendingQuestionWithRetry(
      async () => {
        attempts += 1
        return attempts === 3
      },
      { sleep: async (delayMs) => { delays.push(delayMs) } },
    )

    expect(recovered).toBe(true)
    expect(attempts).toBe(3)
    expect(delays).toEqual([500, 1500])
  })

  test("does no more work after cancellation", async () => {
    let attempts = 0
    const recovered = await recoverPendingQuestionWithRetry(
      async () => {
        attempts += 1
        return false
      },
      { isCancelled: () => true, sleep: async () => undefined },
    )

    expect(recovered).toBe(false)
    expect(attempts).toBe(0)
  })
})

function toolPart(overrides: Partial<Part>): Part {
  return {
    id: "prt_1",
    sessionID: "ses_a",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "question",
    state: { status: "running", input: { questions: [{ question: "Continue?", header: "Q", options: [] }] } },
    ...overrides,
  } as Part
}

function record(parts: Part[]): { info: Message; parts: Part[] } {
  return { info: { id: "msg_1", sessionID: "ses_a", role: "assistant", time: { created: 1 } } as Message, parts }
}

function question(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_a",
    questions: [{ question: "Continue?", header: "Q", options: [] }],
    ...overrides,
  }
}

describe("hasPendingQuestionGap", () => {
  test("returns false when every running question part has a matching store question", () => {
    const part = toolPart({ callID: "call_1" })
    expect(hasPendingQuestionGap([record([part])], [question({ tool: { messageID: "msg_1", callID: "call_1" } })])).toBe(false)
  })

  test("returns true for a running question part with no matching store question", () => {
    const part = toolPart({ callID: "call_1" })
    expect(hasPendingQuestionGap([record([part])], [])).toBe(true)
  })

  test("ignores completed question parts", () => {
    const part = toolPart({ callID: "call_1", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 1, end: 2 } } })
    expect(hasPendingQuestionGap([record([part])], [])).toBe(false)
  })

  test("ignores non-question tool parts", () => {
    const part = toolPart({ callID: "call_1", tool: "bash", state: { status: "running", input: { command: "ls" }, time: { start: 1 } } })
    expect(hasPendingQuestionGap([record([part])], [])).toBe(false)
  })

  test("suppresses a part with no callID when the session already has a store question", () => {
    const part = toolPart({ callID: "" })
    expect(hasPendingQuestionGap([record([part])], [question()])).toBe(false)
  })

  test("surfaces a part with no callID when the session has no store question", () => {
    const part = toolPart({ callID: "" })
    expect(hasPendingQuestionGap([record([part])], [])).toBe(true)
  })

  test("surfaces a gap across multiple messages", () => {
    expect(hasPendingQuestionGap(
      [record([toolPart({ callID: "call_1" })]), record([toolPart({ callID: "call_2" })])],
      [],
    )).toBe(true)
  })
})
