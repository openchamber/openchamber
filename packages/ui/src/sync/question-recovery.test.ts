import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QuestionRequest } from "@/types/question"
import { findPendingQuestionGaps } from "./question-recovery"

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

describe("findPendingQuestionGaps", () => {
  test("returns no gaps when every running question part has a matching store question", () => {
    const part = toolPart({ callID: "call_1" })
    const gaps = findPendingQuestionGaps([record([part])], [question({ tool: { messageID: "msg_1", callID: "call_1" } })])
    expect(gaps).toHaveLength(0)
  })

  test("returns a gap for a running question part with no matching store question", () => {
    const part = toolPart({ callID: "call_1" })
    const gaps = findPendingQuestionGaps([record([part])], [])
    expect(gaps).toHaveLength(1)
    expect(gaps[0].callID).toBe("call_1")
    expect(gaps[0].questions).toHaveLength(1)
  })

  test("ignores completed question parts", () => {
    const part = toolPart({ callID: "call_1", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 1, end: 2 } } })
    const gaps = findPendingQuestionGaps([record([part])], [])
    expect(gaps).toHaveLength(0)
  })

  test("ignores non-question tool parts", () => {
    const part = toolPart({ callID: "call_1", tool: "bash", state: { status: "running", input: { command: "ls" }, time: { start: 1 } } })
    const gaps = findPendingQuestionGaps([record([part])], [])
    expect(gaps).toHaveLength(0)
  })

  test("suppresses a part with no callID when the session already has a store question", () => {
    const part = toolPart({ callID: "" })
    const gaps = findPendingQuestionGaps([record([part])], [question()])
    expect(gaps).toHaveLength(0)
  })

  test("surfaces a part with no callID when the session has no store question", () => {
    const part = toolPart({ callID: "" })
    const gaps = findPendingQuestionGaps([record([part])], [])
    expect(gaps).toHaveLength(1)
  })

  test("surfaces gaps across multiple messages", () => {
    const gaps = findPendingQuestionGaps(
      [record([toolPart({ callID: "call_1" })]), record([toolPart({ callID: "call_2" })])],
      [],
    )
    expect(gaps.map((gap) => gap.callID).sort()).toEqual(["call_1", "call_2"])
  })
})
