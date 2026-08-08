import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QuestionRequest } from "@/types/question"
import { hasPendingQuestionGap } from "./question-recovery"

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
