import { describe, expect, test } from "bun:test"

import type { SyntheticMessage } from "./model"
import { modelHandoffNote, readModelHandoff } from "./model-handoff"
import { readSessionNotice } from "./session-notices"

const asMessage = (note: ReturnType<typeof modelHandoffNote>): SyntheticMessage => ({
  id: "msg_note",
  sessionID: "ses_1",
  role: "synthetic",
  time: { created: 10 },
  text: note.text,
  description: note.description,
  metadata: note.metadata,
})

describe("modelHandoffNote", () => {
  const to = { providerID: "openai", modelID: "gpt-5", variant: "high" }

  test("names both models and where the previous one stopped", () => {
    const note = modelHandoffNote({
      from: { providerID: "anthropic", modelID: "claude-opus" },
      to,
      stop: { kind: "failed", error: "provider: overloaded" },
      mode: "stop",
      work: [],
    })
    expect(note.text).toContain("from `anthropic/claude-opus` to `openai/gpt-5#high`")
    expect(note.text).toContain("last turn failed with this error: provider: overloaded")
    expect(note.text).toContain("Pick up the task where the previous model left off")
    expect(note.description).toBe("Continued with openai/gpt-5#high")
  })

  test("continuing on the same model asks to continue without claiming a switch", () => {
    const note = modelHandoffNote({ from: { providerID: "openai", modelID: "gpt-5" }, to, stop: { kind: "idle" }, mode: "stop", work: [] })
    expect(note.text).toContain("The user asked you, `openai/gpt-5#high`, to continue this session.")
    expect(note.text).not.toContain("switched")
  })

  test("says what was stopped, or what keeps running and how its results arrive", () => {
    const work = [
      { kind: "shell" as const, shellID: "sh_1", command: "bun run dev" },
      { kind: "subagent" as const, sessionID: "ses_2", description: "Review" },
    ]
    const stopped = modelHandoffNote({ to, stop: { kind: "replying" }, mode: "stop", work })
    expect(stopped.text).toContain("The user also stopped the work it had running: the command `bun run dev` (shell ID: sh_1); the subagent \"Review\" (sessionID: ses_2).")
    const kept = modelHandoffNote({ to, stop: { kind: "replying" }, mode: "keep", work })
    expect(kept.text).toContain("Its work keeps running and reports back in this conversation when it finishes")
    expect(kept.text).toContain("Do not start it again or poll it")
  })

  test("cuts a long error down to its start", () => {
    const note = modelHandoffNote({ to, stop: { kind: "retrying", attempt: 4, error: "x".repeat(2_000) }, mode: "keep", work: [] })
    expect(note.text).toContain("(attempt 4) after this error: ")
    expect(note.text.length).toBeLessThan(1_200)
  })
})

describe("reading a handoff back", () => {
  test("the note round-trips through its metadata and titles a notice row", () => {
    const note = modelHandoffNote({
      from: { providerID: "anthropic", modelID: "claude-opus" },
      to: { providerID: "openai", modelID: "gpt-5" },
      stop: { kind: "waiting", on: "question" },
      mode: "keep",
      work: [],
    })
    const message = asMessage(note)
    expect(readModelHandoff(message)).toEqual({
      to: { providerID: "openai", modelID: "gpt-5" },
      from: { providerID: "anthropic", modelID: "claude-opus" },
      mode: "keep",
    })
    expect(readSessionNotice(message)).toEqual({ kind: "handoff", providerID: "openai", modelID: "gpt-5", text: note.text })
  })

  test("other synthetic messages are not handoffs", () => {
    const plugin: SyntheticMessage = { id: "msg_1", sessionID: "ses_1", role: "synthetic", time: { created: 1 }, text: "x", description: "Waiting for quota reset" }
    expect(readModelHandoff(plugin)).toBeUndefined()
    expect(readSessionNotice(plugin)?.kind).toBe("plugin")
  })
})
