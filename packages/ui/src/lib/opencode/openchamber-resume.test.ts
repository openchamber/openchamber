import { describe, expect, test } from "bun:test"

import { isBackgroundReportEntry, isSkippedTimelineMessage } from "@/components/chat/lib/timelineRoles"
import type { Message, Metadata } from "./model"
import { questionAnswerMetadata, readOpenChamberResume } from "./openchamber-resume"

const synthetic = (metadata: Metadata | undefined, text = "agent text"): Message => ({
  id: "msg_s",
  sessionID: "ses_1",
  role: "synthetic",
  time: { created: 9 },
  text,
  metadata,
})

describe("readOpenChamberResume", () => {
  test("reads a restart resume the server sent", () => {
    const message = synthetic({
      source: "openchamber-notice", kind: "restart-resume", trigger: "continue", at: 5, cause: "process-exited",
      tool: { name: "shell", input: "sleep 600" },
    })

    expect(readOpenChamberResume(message)).toEqual({
      source: "openchamber-notice", kind: "restart-resume", trigger: "continue", at: 5, cause: "process-exited",
      tool: { name: "shell", input: "sleep 600" }, text: "agent text", sentAt: 9,
    })
  })

  test("reads the answer to an interrupted question", () => {
    const message = synthetic(questionAnswerMetadata({ cause: "inactivity", at: 7, answers: [{ question: "Color?", answer: "Blue" }] }))

    expect(readOpenChamberResume(message)).toMatchObject({ kind: "question-answer", cause: "inactivity", answers: [{ question: "Color?", answer: "Blue" }] })
  })

  test("is undefined for other synthetic messages and for a user message with the same text", () => {
    expect(readOpenChamberResume(synthetic(undefined))).toBeUndefined()
    expect(readOpenChamberResume(synthetic({ source: "openchamber-session", sessionID: "x", state: "completed" }))).toBeUndefined()
    const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
    expect(readOpenChamberResume(user)).toBeUndefined()
  })

  test("renders as a timeline row that opens a turn, not as hidden plumbing", () => {
    const message = synthetic({ source: "openchamber-notice", kind: "restart-resume", at: 5, cause: "unknown", tool: null })

    expect(isBackgroundReportEntry(message)).toBe(true)
    expect(isSkippedTimelineMessage(message)).toBe(false)
    expect(isSkippedTimelineMessage(synthetic(undefined))).toBe(true)
  })

  test("reads what the PR fix loop found, and the bare notice of an item queued before it was described", () => {
    const notice = {
      source: "openchamber-notice", kind: "fix-loop", loopId: "fixloop_1", trigger: "ci", iteration: 1, maxIterations: 10, headSha: "abcdef1234567",
      pr: { owner: "o", repo: "r", number: 5, url: "u", title: "T" }, checks: [{ name: "test", url: null }],
      feedback: [{ type: "thread", author: "rev", url: "c", path: "a.ts", line: 3 }],
    }
    expect(readOpenChamberResume(synthetic(notice, "full CI log"))).toMatchObject({ kind: "fix-loop", trigger: "ci", text: "full CI log", checks: [{ name: "test" }] })
    const bare = readOpenChamberResume(synthetic({ source: "openchamber-notice", kind: "fix-loop", loopId: "fixloop_1" }))
    expect(bare).toMatchObject({ kind: "fix-loop", trigger: "unknown", checks: [], feedback: [] })
    expect(bare?.kind === "fix-loop" ? bare.pr : "wrong kind").toBeUndefined()
    expect(isBackgroundReportEntry(synthetic(notice))).toBe(true)
    expect(readOpenChamberResume(synthetic({ source: "openchamber-notice", kind: "fix-loop" }))).toBeUndefined()
  })

  test("opens a system turn when a bot delivers a synthetic event", () => {
    // Given provider-neutral metadata retained on a synthetic message.
    const metadata = { source: "openchamber-notice", kind: "bot", projectId: "project", itemId: "item", eventId: "event" }
    const message = synthetic(metadata, "Provider feedback")
    // When the timeline parses it.
    const notice = readOpenChamberResume(message)
    // Then it is a visible turn-opening system row with the full payload.
    expect(notice).toEqual({ ...metadata, text: "Provider feedback", sentAt: 9 })
    expect(isBackgroundReportEntry(message)).toBe(true)
    expect(isSkippedTimelineMessage(message)).toBe(false)
  })

  test("does not grant notice presentation to user metadata or incomplete bot identity", () => {
    // Given the same metadata on user input and malformed synthetic identities.
    const metadata = { source: "openchamber-notice", kind: "bot", projectId: "project", itemId: "item", eventId: "event" }
    const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 }, metadata }
    // When each trust boundary is read, then only complete synthetic identities qualify.
    expect(readOpenChamberResume(user)).toBeUndefined()
    for (const key of ["projectId", "itemId", "eventId"] as const) {
      expect(readOpenChamberResume(synthetic({ ...metadata, [key]: " " }))).toBeUndefined()
    }
  })
})
