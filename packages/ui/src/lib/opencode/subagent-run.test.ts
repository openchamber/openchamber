import { describe, expect, test } from "bun:test"

import type { Session, SyntheticMessage } from "./model"
import { isRunningSubagentRunMessage, readSubagentRun, runningSubagentRunMessage } from "./subagent-run"

const report = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
  id: "msg_report",
  sessionID: "ses_parent",
  role: "synthetic",
  time: { created: 20 },
  text: '<subagent sessionID="ses_child" state="completed" description="review changes">\n## Findings\n\nNone.\n</subagent>',
  description: "review changes",
  metadata: { source: "subagent", childID: "ses_child", agent: "general", state: "completed" },
  ...overrides,
})

describe("readSubagentRun", () => {
  test("reads the child, state and unwrapped result of a report", () => {
    expect(readSubagentRun(report())).toEqual({
      childSessionID: "ses_child",
      agent: "general",
      state: "completed",
      description: "review changes",
      output: "## Findings\n\nNone.",
    })
  })

  test("ignores synthetic messages that are not subagent reports", () => {
    expect(readSubagentRun(report({ metadata: undefined }))).toBeUndefined()
    expect(readSubagentRun(report({ metadata: { source: "plugin", childID: "ses_child", state: "completed" } }))).toBeUndefined()
    expect(readSubagentRun(report({ metadata: { source: "subagent", state: "completed" } }))).toBeUndefined()
  })

  test("keeps text without the envelope as is", () => {
    expect(readSubagentRun(report({ text: "plain" }))?.output).toBe("plain")
  })
})

describe("runningSubagentRunMessage", () => {
  test("builds a running entry that reads back as a run and cannot be cut at", () => {
    const child: Session = {
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "proj",
      directory: "/repo",
      title: "review changes",
      agent: "general",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10, updated: 10 },
    }
    const message = runningSubagentRunMessage("ses_parent", child)

    expect(readSubagentRun(message)).toMatchObject({ childSessionID: "ses_child", state: "running", description: "review changes" })
    expect(message.time.created).toBe(10)
    expect(isRunningSubagentRunMessage(message.id)).toBe(true)
    expect(isRunningSubagentRunMessage("msg_report")).toBe(false)
  })
})
