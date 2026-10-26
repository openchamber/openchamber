import { describe, expect, test } from "bun:test"

import { CONTEXT_METADATA_KEY } from "@/lib/messages/contextParts"

import { shellCancellationNote } from "./background-shell"
import type { Message, Metadata, SyntheticMessage } from "./model"
import { readSessionNotice, readSessionNoticePart, sessionNoticePart, sessionNoticePlacement } from "./session-notices"
import { subagentCancellationNote } from "./subagent-run"

const synthetic = (description: string | undefined, metadata?: Metadata, text = "model text"): Message => {
  const message: SyntheticMessage = { id: "msg_1", sessionID: "ses_1", role: "synthetic", time: { created: 5 }, text }
  if (description !== undefined) message.description = description
  if (metadata) message.metadata = metadata
  return message
}

const instructionsUpdate = (sources: string[], text = "updated"): Message => ({
  id: "msg_2",
  sessionID: "ses_1",
  role: "system",
  time: { created: 5 },
  text,
  description: `Instructions updated: ${sources.join(", ")}`,
  metadata: { notice: "instructions", instructionSources: sources },
})

describe("readSessionNotice: shown", () => {
  test("a move reads the new working folder from the text", () => {
    const text = "The environment you are running in is now:\n<env>\n  Working directory: /repo/.worktrees/fix-login\n</env>"
    expect(readSessionNotice(instructionsUpdate(["core/environment", "core/skill-guidance"], text))).toEqual({
      kind: "moved",
      folder: "/repo/.worktrees/fix-login",
      text,
    })
    expect(readSessionNotice(instructionsUpdate(["core/environment"]))).toEqual({ kind: "moved", folder: null, text: "updated" })
  })

  test("a plugin's notice reads its description as it is", () => {
    expect(readSessionNotice(synthetic("Retry round 3 · waiting for quota reset"))).toEqual({
      kind: "plugin",
      label: "Retry round 3 · waiting for quota reset",
      text: "model text",
    })
  })

  test("a restart", () => {
    expect(readSessionNotice(synthetic("Continuing after restart", { notice: "restart" }))?.kind).toBe("restart")
  })

  test("a !command that could not start", () => {
    expect(readSessionNotice(synthetic("npm run dev", { source: "shell", state: "error" }))).toEqual({
      kind: "command-failed",
      command: "npm run dev",
      text: "model text",
    })
  })
})

describe("readSessionNotice: hidden", () => {
  test("a message without a description, or an empty one", () => {
    expect(readSessionNotice(synthetic(undefined))).toBeUndefined()
    expect(readSessionNotice(synthetic("  "))).toBeUndefined()
  })

  test("the rest about the session's instructions", () => {
    expect(readSessionNotice(instructionsUpdate(["core/mcp-guidance", "core/skill-guidance", "core/date"]))).toBeUndefined()
    expect(readSessionNotice(synthetic("Loaded packages/ui/AGENTS.md", { instruction: { paths: ["/repo/packages/ui/AGENTS.md"] } }))).toBeUndefined()
  })

  test("composer context", () => {
    const context = { [CONTEXT_METADATA_KEY]: { kind: "terminal", terminalId: "t1", terminalLabel: "Terminal", startLine: 1, endLine: 2, output: "ls" } }
    expect(readSessionNotice(synthetic("Terminal", context))).toBeUndefined()
  })

  test("a subagent report and a dispatched session's result", () => {
    expect(readSessionNotice(synthetic("review", { source: "subagent", childID: "ses_c", state: "completed" }))).toBeUndefined()
    expect(readSessionNotice(synthetic("Fix it", { source: "openchamber-session", sessionID: "ses_d", state: "completed" }))).toBeUndefined()
  })

  test("a background command's completion", () => {
    expect(readSessionNotice(synthetic("ls", { source: "shell", shellID: "sh_1", state: "error" }))).toBeUndefined()
  })

  test("the notes that the user stopped a subagent or a command", () => {
    const subagent = subagentCancellationNote({ childSessionID: "ses_c", description: "review" })
    const shell = shellCancellationNote([{ shellID: "sh_1", command: "ls" }])
    expect(readSessionNotice(synthetic(subagent.description, subagent.metadata))).toBeUndefined()
    expect(readSessionNotice(synthetic(shell.description, shell.metadata))).toBeUndefined()
  })

  test("ACP embedded context", () => {
    expect(readSessionNotice(synthetic("ACP embedded context"))).toBeUndefined()
  })
})

describe("sessionNoticePart", () => {
  test("round-trips the notice through the Activity row", () => {
    const message = synthetic("Waiting for quota reset")
    const notice = readSessionNotice(message)!
    const part = sessionNoticePart(message, notice, "msg_step", "after")

    expect(part.messageID).toBe("msg_step")
    expect(readSessionNoticePart(part)).toEqual(notice)
    expect(sessionNoticePlacement(part)).toBe("after")
  })
})
