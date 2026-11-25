import { describe, expect, test } from "bun:test"

import type { Metadata, ToolState } from "./model"
import { answeredQuestions } from "./questionAnswers"

describe("answeredQuestions", () => {
  const input = { questions: [{ question: "Ship it?" }, { question: "Tag it?" }] }
  const completed = (metadata?: Metadata): ToolState => ({ status: "completed", input, output: "", metadata, time: { start: 1, end: 2 } })

  test("reads each question with the picks the call recorded, a blank one included", () => {
    expect(answeredQuestions("question", completed({ answers: [["Yes", "Later"], []] }))).toEqual([
      { question: "Ship it?", picks: ["Yes", "Later"] },
      { question: "Tag it?", picks: [] },
    ])
  })

  test("leaves a waiting, dismissed or unrecorded call to its tool row", () => {
    expect(answeredQuestions("question", { status: "running", input, time: { start: 1 } })).toBeNull()
    expect(answeredQuestions("question", completed({ answers: [[], []] }))).toBeNull()
    expect(answeredQuestions("question", completed({ answers: [["Yes"]] }))).toBeNull()
    expect(answeredQuestions("question", completed())).toBeNull()
    expect(answeredQuestions("shell", completed({ answers: [["Yes"], ["No"]] }))).toBeNull()
  })
})
