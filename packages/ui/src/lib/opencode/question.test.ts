import { describe, expect, test } from "bun:test"
import { parseQuestionOutput, questionAnswers, questionCallKey, questionFormCall, questionFormFields, questionPrompts, questionRowContent } from "./question"
import type { ToolState, ToolStateCompleted } from "./model"

const asked = {
  questions: [
    {
      header: "Send as is",
      question: "What should the button send?",
      multiple: false,
      options: [
        { label: "My message (Recommended)", description: "Sends what you typed" },
        { label: "The spec", description: "Sends the written spec" },
      ],
    },
    {
      header: "Checks",
      question: "Which checks run?",
      multiple: true,
      options: [
        { label: "Types", description: "tsc" },
        { label: "Lint", description: "oxlint" },
      ],
    },
  ],
}

describe("question tool", () => {
  test("form fields match the ones OpenCode builds for the same questions", () => {
    // Field for field what `toField` in OpenCode's question tool returns
    // (packages/core/src/tool/plugin/question.ts), so a question answered
    // again validates and reads the way it did when the agent asked it.
    expect(questionFormFields(questionPrompts(asked))).toEqual([
      {
        key: "q0",
        title: "Send as is",
        description: "What should the button send?",
        type: "string",
        options: [
          { value: "My message (Recommended)", label: "My message (Recommended)", description: "Sends what you typed" },
          { value: "The spec", label: "The spec", description: "Sends the written spec" },
        ],
        custom: true,
      },
      {
        key: "q1",
        title: "Checks",
        description: "Which checks run?",
        type: "multiselect",
        options: [
          { value: "Types", label: "Types", description: "tsc" },
          { value: "Lint", label: "Lint", description: "oxlint" },
        ],
        custom: true,
      },
    ])
  })

  test("a malformed question keeps its place, so later answers stay on their questions", () => {
    const prompts = questionPrompts({ questions: [asked.questions[0], 42, asked.questions[1]] })

    expect(prompts.map((prompt) => prompt.question)).toEqual(["What should the button send?", "", "Which checks run?"])
    expect(questionFormFields(prompts).map((field) => field.key)).toEqual(["q0", "q1", "q2"])
  })

  test("input without questions has none", () => {
    expect(questionPrompts(undefined)).toEqual([])
    expect(questionPrompts({ questions: "nope" })).toEqual([])
  })

  test("only an answered call has answers", () => {
    const completed: ToolStateCompleted = {
      status: "completed",
      input: asked,
      output: "User has answered your questions: ...",
      metadata: { answers: [["The spec"], ["Types", "Lint"]] },
      time: { start: 1, end: 2 },
    }
    const dismissed: ToolState = { status: "error", input: asked, error: "The user dismissed this question", time: { start: 1, end: 2 } }
    const withoutAnswers: ToolStateCompleted = { ...completed, metadata: {} }

    expect(questionAnswers(completed)).toEqual([["The spec"], ["Types", "Lint"]])
    expect(questionAnswers(dismissed)).toBeNull()
    expect(questionAnswers(withoutAnswers)).toBeNull()
  })

  test("a question's form request names the call it belongs to", () => {
    const call = questionFormCall({ metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } } })

    expect(call).toEqual({ messageID: "msg_1", callID: "call_1" })
    expect(call ? questionCallKey(call) : null).toBe("msg_1:call_1")
    expect(questionFormCall({ metadata: { kind: "websearch.provider" } })).toBeNull()
    expect(questionFormCall({ metadata: { kind: "question", tool: { messageID: "msg_1" } } })).toBeNull()
    expect(questionFormCall({})).toBeNull()
  })

  test("a call that ended without answers still shows its questions", () => {
    // Before, a dismissed or failed call showed only its error and the
    // questions it asked were gone from the transcript.
    const dismissed: ToolState = { status: "error", input: asked, error: "The user dismissed this question", time: { start: 1, end: 2 } }
    const answered: ToolStateCompleted = {
      status: "completed",
      input: asked,
      output: "User has answered your questions: ...",
      metadata: { answers: [["The spec"], ["Types"]] },
      time: { start: 1, end: 2 },
    }

    expect(questionRowContent(dismissed, "")).toEqual({ kind: "questions" })
    expect(questionRowContent(answered, answered.output)).toEqual({ kind: "questions" })
    expect(questionRowContent({ status: "running", input: asked, time: { start: 1 } }, "")).toEqual({ kind: "questions" })
  })

  test("a call recorded before metadata.answers shows the answers from its text", () => {
    const output = 'User has answered your questions: "What should the button send?"="The spec", "Which checks run?"="Types, Lint". You can now continue with the user\'s answers in mind.'
    const legacy: ToolState = { status: "completed", input: asked, output, time: { start: 1, end: 2 } }

    expect(questionRowContent(legacy, output)).toEqual({
      kind: "legacy",
      pairs: [
        { question: "What should the button send?", answer: "The spec" },
        { question: "Which checks run?", answer: "Types, Lint" },
      ],
    })
    expect(parseQuestionOutput("something else")).toBeNull()
  })

  test("a call with no questions in its input shows its error, or waits", () => {
    expect(questionRowContent({ status: "error", input: {}, error: "Permission denied: question", time: { start: 1, end: 2 } }, ""))
      .toEqual({ kind: "error", message: "Permission denied: question" })
    expect(questionRowContent({ status: "pending", input: {}, raw: "" }, "")).toEqual({ kind: "awaiting" })
  })
})
