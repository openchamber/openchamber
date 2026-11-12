import { describe, expect, test } from "bun:test"

import type { SyntheticMessage } from "./model"
import { readDispatchedSessionResult } from "./dispatched-session"
import { readSubagentRun } from "./subagent-run"
import { isBackgroundReportEntry, isSkippedTimelineMessage } from "@/components/chat/lib/timelineRoles"

// The shape `web/server/lib/dispatch-results` admits into the dispatching session.
const result = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
  id: "msg_result",
  sessionID: "ses_parent",
  role: "synthetic",
  time: { created: 30 },
  text: '<openchamber-session sessionID="ses_child" state="completed" title="Fix the toolbar">\n## Done\n\nToolbar fixed.\n</openchamber-session>',
  description: "Fix the toolbar",
  metadata: { source: "openchamber-session", sessionID: "ses_child", state: "completed", title: "Fix the toolbar" },
  ...overrides,
})

describe("readDispatchedSessionResult", () => {
  test("reads the session, state, title and unwrapped answer", () => {
    expect(readDispatchedSessionResult(result())).toEqual({
      sessionID: "ses_child",
      state: "completed",
      title: "Fix the toolbar",
      output: "## Done\n\nToolbar fixed.",
      reportedAt: 30,
    })
  })

  test("ignores other synthetic messages, a subagent report included", () => {
    expect(readDispatchedSessionResult(result({ metadata: undefined }))).toBeUndefined()
    expect(readDispatchedSessionResult(result({ metadata: { source: "subagent", childID: "ses_child", state: "completed" } }))).toBeUndefined()
    expect(readDispatchedSessionResult(result({ metadata: { source: "openchamber-session", sessionID: "ses_child", state: "running" } }))).toBeUndefined()
    expect(readSubagentRun(result())).toBeUndefined()
  })

  test("keeps text without the envelope as it is", () => {
    expect(readDispatchedSessionResult(result({ text: "plain" }))?.output).toBe("plain")
  })
})

describe("timeline roles", () => {
  test("a dispatched session's result is shown and opens a turn", () => {
    expect(isBackgroundReportEntry(result())).toBe(true)
    expect(isSkippedTimelineMessage(result())).toBe(false)
  })

  test("other synthetic messages stay hidden", () => {
    expect(isBackgroundReportEntry(result({ metadata: undefined }))).toBe(false)
    expect(isSkippedTimelineMessage(result({ metadata: undefined }))).toBe(true)
  })
})
