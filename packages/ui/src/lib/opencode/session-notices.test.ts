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

  describe("a pull request wake", () => {
    const url = "https://github.com/acme/app/pull/7"
    const text = `<openchamber-pull-request url="${url}" number="7">\nPull request #7: a check failed (lint).\nYou are no longer watching it.\n</openchamber-pull-request>`

    test("reads what changed from the metadata and the number from the envelope", () => {
      const metadata = { source: "openchamber-pr-watch", url, events: ["checks-failed", "activity"], failedChecks: ["lint"], authors: ["bob"] }
      expect(readSessionNotice(synthetic("Pull request #7: a check failed (lint)", metadata, text))).toEqual({
        kind: "pull-request",
        url,
        number: 7,
        events: ["checks-failed", "activity"],
        failedChecks: ["lint"],
        authors: ["bob"],
        text,
      })
    })

    test("a message written before the names were in the metadata reads without them", () => {
      const notice = readSessionNotice(synthetic("Pull request #7: merged", { source: "openchamber-pr-watch", url, events: ["merged"] }, text))
      expect(notice).toMatchObject({ kind: "pull-request", number: 7, failedChecks: [], authors: [] })
    })

    test("survives as an Activity row", () => {
      const message = synthetic("Pull request #7: merged", { source: "openchamber-pr-watch", url, events: ["merged"] }, text)
      const notice = readSessionNotice(message)!
      expect(readSessionNoticePart(sessionNoticePart(message, notice, "assistant_1", "after"))).toEqual(notice)
    })

    test("an event this build does not know stays a plain notice", () => {
      const metadata = { source: "openchamber-pr-watch", url, events: ["reopened"] }
      expect(readSessionNotice(synthetic("Pull request #7: reopened", metadata, text))?.kind).toBe("plugin")
    })
  })

  describe("an extension wait's wake", () => {
    const text = `<openchamber-wait source="wait-kit/timer" wait="wait_1" outcome="fired">\nTimer (8 s) fired.\n8 seconds passed\n</openchamber-wait>`
    const summary = "8 seconds passed\nThe second line the description leaves out"
    const metadata = { source: "openchamber-wait", waitId: "wait_1", extension: "wait-kit", type: "timer", title: "Timer", label: "8 s", outcome: "fired", subject: "Timer (8 s)", summary }

    test("reads the wait's name and the whole report, and survives as an Activity row", () => {
      const message = synthetic("Timer (8 s): 8 seconds passed", metadata, text)
      const notice = readSessionNotice(message)!
      expect(notice).toEqual({ kind: "extension-wait", subject: "Timer (8 s)", outcome: "fired", summary, text })
      expect(readSessionNoticePart(sessionNoticePart(message, notice, "assistant_1", "after"))).toEqual(notice)
    })

    test("an outcome this build does not know stays a plain notice", () => {
      expect(readSessionNotice(synthetic("Timer (8 s): snoozed", { ...metadata, outcome: "snoozed" }, text))?.kind).toBe("plugin")
    })
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
