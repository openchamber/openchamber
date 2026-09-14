import { beforeEach, describe, expect, test } from "bun:test"
import {
  beginQuestionSubmission,
  clearQuestionSubmission,
  getQuestionSubmission,
  releaseQuestionSubmission,
  resetQuestionSubmissionStateForTests,
  updateQuestionSubmission,
} from "./question-submission-state"

describe("question submission state", () => {
  beforeEach(() => {
    resetQuestionSubmissionStateForTests()
  })

  test("retains submitted answers while pending and after a definite failure", () => {
    const identity = { runtimeKey: "runtime-a", sessionID: "session-a", requestID: "question-a" }
    const answers = [["selected"], ["custom answer"]]

    expect(beginQuestionSubmission(identity, answers)).toBe(true)
    expect(getQuestionSubmission(identity)).toEqual({ answers, customAnswers: {}, pending: true })
    expect(beginQuestionSubmission(identity, answers)).toBe(false)

    releaseQuestionSubmission(identity)
    expect(getQuestionSubmission(identity)).toEqual({ answers, customAnswers: {}, pending: false })
  })

  test("retains retry edits across a remount after a definite failure", () => {
    const identity = { runtimeKey: "runtime-a", sessionID: "session-a", requestID: "question-a" }

    expect(beginQuestionSubmission(identity, [["A"]])).toBe(true)
    releaseQuestionSubmission(identity)

    // A remounted card reads this shadow before it retries the request.
    expect(updateQuestionSubmission(identity, 0, ["B"], "custom B")).toBe(true)
    expect(getQuestionSubmission(identity)).toEqual({
      answers: [["B"]],
      customAnswers: { 0: "custom B" },
      pending: false,
    })
    expect(beginQuestionSubmission(identity, [["B"]], { 0: "custom B" })).toBe(true)
    expect(getQuestionSubmission(identity)).toEqual({
      answers: [["B"]],
      customAnswers: { 0: "custom B" },
      pending: true,
    })

    expect(updateQuestionSubmission(identity, 0, ["C"], "custom C")).toBe(false)
    expect(getQuestionSubmission(identity)).toEqual({
      answers: [["B"]],
      customAnswers: { 0: "custom B" },
      pending: true,
    })
  })

  test("clears only the exact runtime, session, and request owner", () => {
    const runtimeA = { runtimeKey: "runtime-a", sessionID: "session-a", requestID: "question-a" }
    const sameRequestOtherRuntime = { ...runtimeA, runtimeKey: "runtime-b" }
    const otherRequest = { ...runtimeA, requestID: "question-b" }

    beginQuestionSubmission(runtimeA, [["a"]])
    beginQuestionSubmission(sameRequestOtherRuntime, [["b"]])
    beginQuestionSubmission(otherRequest, [["c"]])

    clearQuestionSubmission(runtimeA)

    expect(getQuestionSubmission(runtimeA)).toBeNull()
    expect(getQuestionSubmission(sameRequestOtherRuntime)).toEqual({ answers: [["b"]], customAnswers: {}, pending: true })
    expect(getQuestionSubmission(otherRequest)).toEqual({ answers: [["c"]], customAnswers: {}, pending: true })
  })
})
