import { describe, expect, test } from "bun:test"

import type { AssistantMessage, Session, SyntheticMessage, ToolPart } from "./model"
import {
  findSubagentCancellation,
  findSubagentRun,
  isRunningSubagentRunMessage,
  classifySubagentReports,
  readBackgroundSubagentChildID,
  readSubagentRun,
  runningSubagentRunMessage,
  subagentCancellationNote,
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

  // oh-my-opencode-slim's `task revive` reports the run it continued in the
  // envelope OpenCode uses for a `task` tool result.
  const revived = (state: "completed" | "error"): SyntheticMessage => ({
    id: "msg_revived",
    sessionID: "ses_parent",
    role: "synthetic",
    time: { created: 90 },
    text: [
      `<task id="ses_child" state="${state}">`,
      `<summary>Background task ${state === "completed" ? "completed" : "failed"}: review changes</summary>`,
      `<${state === "completed" ? "task_result" : "task_error"}>`,
      state === "completed" ? "## Findings\n\nNone." : "Provider error",
      `</${state === "completed" ? "task_result" : "task_error"}>`,
      "</task>",
    ].join("\n"),
    metadata: { "oh-my-opencode-slim.internalInitiator": true },
  })

  test("reads a run another tool reported in a task envelope", () => {
    expect(readSubagentRun(revived("completed"))).toMatchObject({
      childSessionID: "ses_child", state: "completed", output: "## Findings\n\nNone.", reportedAt: 90,
    })
    expect(readSubagentRun(revived("error"))).toMatchObject({ state: "error", output: "Provider error" })
  })

  test("reads the envelope followed by the comment that marks it internal", () => {
    // The shape oh-my-opencode-slim writes: the envelope, then its own marker.
    const message = revived("completed")
    expect(readSubagentRun({ ...message, text: `${message.text}\n<!-- SLIM_INTERNAL_INITIATOR -->\n` })?.output)
      .toBe("## Findings\n\nNone.")
  })

  test("ignores a task envelope that only says the run is going on", () => {
    const notice = revived("completed")
    expect(readSubagentRun({ ...notice, text: '<task id="ses_child" state="running">\n<summary>Background task continues on a fallback model</summary>\n<task_fallback>\nboom\n</task_fallback>\n</task>' })).toBeUndefined()
  })

  test("takes the newest record of a child a revive continued", () => {
    expect(findSubagentRun([report(), revived("completed")], "ses_child")).toMatchObject({
      state: "completed", output: "## Findings\n\nNone.", reportedAt: 90,
    })
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
    const { records: kept, completionNotices } = classifySubagentReports(records, (id) => startedAt.get(id))
    // The called child's report stays, and reads as a notice instead of a row.
    expect(kept.map((record) => record.info.id)).toEqual(["msg_assistant", "msg_report", "msg_command"])
    expect([...completionNotices.keys()]).toEqual(["msg_report"])
  })

  test("returns the same records when nothing is dropped or noticed", () => {
    const records = [{ info: report(), parts: [] }]
    const classified = classifySubagentReports(records, () => 20)
    expect(classified.records).toBe(records)
    expect(classified.completionNotices.size).toBe(0)
  })

  describe("a report of a run this transcript called", () => {
    const withDescription = (description: string): ToolPart => ({
      ...call({ sessionID: "ses_child" }),
      state: {
        status: "completed",
        input: { description, agent: "general" },
        output: "working in the background",
        metadata: { sessionID: "ses_child" },
        time: { start: 1, end: 2 },
      },
    })

    test("keeps a completion notice named by the call", () => {
      const records = [
        { info: assistant, parts: [withDescription("review changes")] },
        { info: report(), parts: [] },
      ]
      const classified = classifySubagentReports(records, () => 6)
      expect(classified.records).toHaveLength(2)
      expect(classified.completionNotices.get("msg_report")).toEqual({ description: "review changes" })
    })

    test("reads a task record another tool wrote for the same child", () => {
      const revived: SyntheticMessage = {
        id: "msg_task_record",
        sessionID: "ses_parent",
        role: "synthetic",
        time: { created: 40 },
        text: [
          '<task id="ses_child" state="completed">',
          '<summary>Background task completed: review changes</summary>',
          '<task_result>',
          '## Findings\n\nNone.',
          '</task_result>',
          '</task>',
        ].join("\n"),
        metadata: { "oh-my-opencode-slim.internalInitiator": true },
      }
      const records = [
        { info: assistant, parts: [withDescription("review changes")] },
        { info: revived, parts: [] },
      ]
      const classified = classifySubagentReports(records, () => 6)
      expect(classified.records).toHaveLength(2)
      expect(classified.completionNotices.get("msg_task_record")).toEqual({ description: "review changes" })
    })

    test("leaves a report that has not settled out, since the call's row shows it running", () => {
      const records = [
        { info: assistant, parts: [withDescription("review changes")] },
        {
          info: report({
            id: "msg_running",
            metadata: { source: "subagent", childID: "ses_child", state: "running" },
          }),
          parts: [],
        },
      ]
      const classified = classifySubagentReports(records, () => 6)
      expect(classified.records.map((record) => record.info.id)).toEqual(["msg_assistant"])
      expect(classified.completionNotices.size).toBe(0)
    })

    test("keeps every report of the same child, so each run reads where it ended", () => {
      const first = report({ id: "msg_first" })
      const second = report({ id: "msg_second", time: { created: 30 } })
      const records = [
        { info: assistant, parts: [withDescription("review changes")] },
        { info: first, parts: [] },
        { info: second, parts: [] },
      ]
      const classified = classifySubagentReports(records, () => 6)
      expect(classified.records.map((record) => record.info.id)).toEqual(["msg_assistant", "msg_first", "msg_second"])
      expect([...classified.completionNotices.keys()]).toEqual(["msg_first", "msg_second"])
    })

    test("keeps a report of a command child that no call names", () => {
      const command = report({ id: "msg_command", metadata: { source: "subagent", childID: "ses_command", state: "completed" } })
      const records = [
        { info: assistant, parts: [withDescription("review changes")] },
        { info: command, parts: [] },
      ]
      const classified = classifySubagentReports(records, (id) => (id === "ses_command" ? 7 : undefined))
      expect(classified.records.map((record) => record.info.id)).toEqual(["msg_assistant", "msg_command"])
      expect(classified.completionNotices.size).toBe(0)
    })
  })
})

describe("stopping a subagent", () => {
  const note = subagentCancellationNote({ childSessionID: "ses_child", description: "review changes" })

  test("the note explains the cancellation instead of forbidding the work", () => {
    expect(note.text).toContain('"review changes"')
    expect(note.text).toContain("ses_child")
    expect(note.text).toContain("the user cancelled it")
    expect(note.text).toContain("fine to delegate later")
    expect(/\bnever\b/i.test(note.text)).toBe(false)
  })

  test("the note is recognised by its metadata and found per child", () => {
    const message: SyntheticMessage = {
      id: "msg_note",
      sessionID: "ses_parent",
      role: "synthetic",
      time: { created: 30 },
      text: note.text,
      description: note.description,
      metadata: note.metadata,
    }
    expect(findSubagentCancellation([report(), message], "ses_child")).toBe(true)
    expect(findSubagentCancellation([message], "ses_other")).toBe(false)
    expect(findSubagentCancellation([report()], "ses_child")).toBe(false)
  })
})
