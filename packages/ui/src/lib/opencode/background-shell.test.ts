import { describe, expect, test } from "bun:test"

import {
  findShellCancellation,
  findShellCompletion,
  readShellCancellation,
  shellCancellationNote,
  readBackgroundShellID,
  readShellCompletion,
  runningShellFromWire,
  shellCompletionFailed,
} from "./background-shell"
import type { Message, SyntheticMessage, ToolPart } from "./model"

const call = (state: ToolPart["state"]): ToolPart => ({
  id: "prt_1",
  sessionID: "ses_1",
  messageID: "msg_1",
  type: "tool",
  callID: "call_1",
  tool: "shell",
  state,
})

const completion = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
  id: "msg_done",
  sessionID: "ses_1",
  role: "synthetic",
  time: { created: 5000 },
  text: '<shell id="job_1" state="completed" command="sleep 1">\n5 minutes elapsed\n</shell>',
  metadata: { source: "shell", shellID: "sh_1", jobID: "job_1", state: "completed", truncated: false, exit: 0 },
  ...overrides,
})

describe("readBackgroundShellID", () => {
  test("reads the shell of a call OpenCode moved to the background", () => {
    const part = call({
      status: "completed",
      input: { command: "sleep 300", background: true },
      output: "Command moved to the background (shell ID: sh_1).",
      metadata: { status: "running", shellID: "sh_1", truncated: false },
      time: { start: 1000, end: 1100 },
    })
    expect(readBackgroundShellID(part)).toBe("sh_1")
  })

  test("ignores a command that ran in the foreground", () => {
    const part = call({
      status: "completed",
      input: { command: "ls" },
      output: "a",
      metadata: { status: "completed", shellID: "sh_2", exit: 0, truncated: false },
      time: { start: 1000, end: 1100 },
    })
    expect(readBackgroundShellID(part)).toBeUndefined()
    expect(readBackgroundShellID(call({ status: "running", input: { command: "ls" }, time: { start: 1 } }))).toBeUndefined()
  })
})

describe("readShellCompletion", () => {
  test("unwraps the envelope and keeps the exit status", () => {
    expect(readShellCompletion(completion())).toEqual({
      shellID: "sh_1",
      state: "completed",
      exit: 0,
      signal: undefined,
      timeout: undefined,
      output: "5 minutes elapsed",
      endedAt: 5000,
    })
  })

  test("ignores other synthetic messages", () => {
    expect(readShellCompletion(completion({ metadata: { source: "subagent", childID: "ses_2", state: "completed" } }))).toBeUndefined()
    expect(readShellCompletion(completion({ metadata: undefined }))).toBeUndefined()
  })

  test("a non-zero exit, a signal, a timeout and a cancel all count as failed", () => {
    const read = (metadata: SyntheticMessage["metadata"]) => {
      const result = readShellCompletion(completion({ metadata }))
      if (!result) throw new Error("expected a completion")
      return result
    }
    expect(shellCompletionFailed(read({ source: "shell", shellID: "sh_1", state: "completed", exit: 0 }))).toBe(false)
    expect(shellCompletionFailed(read({ source: "shell", shellID: "sh_1", state: "completed", exit: 2 }))).toBe(true)
    expect(shellCompletionFailed(read({ source: "shell", shellID: "sh_1", state: "completed", signal: "SIGTERM" }))).toBe(true)
    expect(shellCompletionFailed(read({ source: "shell", shellID: "sh_1", state: "completed", timeout: true }))).toBe(true)
    expect(shellCompletionFailed(read({ source: "shell", shellID: "sh_1", state: "cancelled" }))).toBe(true)
  })

  test("finds the completion of one command among a session's messages", () => {
    const other = completion({ id: "msg_other", metadata: { source: "shell", shellID: "sh_9", state: "completed" } })
    const user: Message = { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1 } }
    expect(findShellCompletion([user, completion(), other], "sh_1")?.output).toBe("5 minutes elapsed")
    expect(findShellCompletion([user, other], "sh_1")).toBeUndefined()
  })
})

describe("runningShellFromWire", () => {
  const info = {
    id: "sh_1",
    status: "running",
    command: "sleep 300",
    file: "/tmp/sh_1.out",
    metadata: { sessionID: "ses_1" },
    time: { started: 1000 },
  }

  test("keeps running commands started for a session", () => {
    expect(runningShellFromWire(info)).toEqual({
      id: "sh_1",
      sessionID: "ses_1",
      command: "sleep 300",
      file: "/tmp/sh_1.out",
      startedAt: 1000,
    })
  })

  test("drops exited commands and commands without a session", () => {
    expect(runningShellFromWire({ ...info, status: "exited" })).toBeUndefined()
    expect(runningShellFromWire({ ...info, metadata: {} })).toBeUndefined()
  })
})

describe("stopping a background command", () => {
  const note = shellCancellationNote({ shellID: "sh_1", command: "bun run dev" })

  test("the note explains the error instead of forbidding the command", () => {
    expect(note.text).toContain("bun run dev")
    expect(note.text).toContain("sh_1")
    expect(note.text).toContain("Shell.NotFoundError")
    expect(note.text).toContain("the user cancelled it")
    expect(note.text).toContain("fine to run later")
    expect(/\bnever\b/i.test(note.text)).toBe(false)
  })

  test("the note is recognised by its metadata and found per shell", () => {
    const message: SyntheticMessage = {
      id: "msg_note",
      sessionID: "ses_1",
      role: "synthetic",
      time: { created: 4000 },
      text: note.text,
      description: note.description,
      metadata: note.metadata,
    }
    expect(readShellCancellation(message)).toEqual({ shellID: "sh_1", stoppedAt: 4000 })
    expect(readShellCancellation(completion())).toBeUndefined()
    expect(findShellCancellation([completion(), message], "sh_1")).toEqual({ stoppedAt: 4000 })
    expect(findShellCancellation([message], "sh_2")).toBeUndefined()
  })
})
