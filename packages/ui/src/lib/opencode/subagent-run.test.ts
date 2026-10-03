import { describe, expect, test } from "bun:test"

import type { AssistantMessage, Session, SyntheticMessage, ToolPart } from "./model"
import {
  findSubagentRun,
  isRunningSubagentRunMessage,
  readBackgroundSubagentChildID,
  readSubagentRun,
  runningSubagentRunMessage,
  keepCommandSubagentReports,
} from "./subagent-run"

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
      reportedAt: 20,
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

describe("subagent calls that went to the background", () => {
  const call = (metadata: Record<string, string>, status: "completed" | "running" = "completed"): ToolPart => ({
    id: "prt_call",
    sessionID: "ses_parent",
    messageID: "msg_assistant",
    type: "tool",
    callID: "call_1",
    tool: "subagent",
    state: status === "completed"
      ? { status, input: { agent: "general" }, output: "working in the background", metadata, time: { start: 1, end: 2 } }
      : { status, input: { agent: "general" }, metadata, time: { start: 1 } },
  })
  const assistant: AssistantMessage = {
    id: "msg_assistant", sessionID: "ses_parent", role: "assistant", time: { created: 5 },
    agent: "build", providerID: "p", modelID: "m",
  }

  test("reads the child of a backgrounded call only", () => {
    expect(readBackgroundSubagentChildID(call({ status: "running", sessionID: "ses_child" }))).toBe("ses_child")
    expect(readBackgroundSubagentChildID(call({ status: "completed", sessionID: "ses_child" }))).toBeUndefined()
    expect(readBackgroundSubagentChildID(call({ sessionID: "ses_child" }, "running"))).toBeUndefined()
  })

  test("finds the report of one child", () => {
    expect(findSubagentRun([report()], "ses_child")?.reportedAt).toBe(20)
    expect(findSubagentRun([report()], "ses_other")).toBeUndefined()
  })

  test("keeps only the reports of commands that started inside the loaded records", () => {
    const records = [
      { info: assistant, parts: [call({ status: "running", sessionID: "ses_child" })] },
      { info: report(), parts: [] },
      { info: report({ id: "msg_command", metadata: { source: "subagent", childID: "ses_command", state: "completed" } }), parts: [] },
      { info: report({ id: "msg_earlier", metadata: { source: "subagent", childID: "ses_earlier", state: "completed" } }), parts: [] },
      { info: report({ id: "msg_unknown", metadata: { source: "subagent", childID: "ses_unknown", state: "completed" } }), parts: [] },
    ]
    const startedAt = new Map([["ses_child", 6], ["ses_command", 7], ["ses_earlier", 1]])
    const kept = keepCommandSubagentReports(records, (id) => startedAt.get(id))
    expect(kept.map((record) => record.info.id)).toEqual(["msg_assistant", "msg_command"])
  })

  test("returns the same records when nothing is dropped", () => {
    const records = [{ info: report(), parts: [] }]
    expect(keepCommandSubagentReports(records, () => 20)).toBe(records)
})
})
