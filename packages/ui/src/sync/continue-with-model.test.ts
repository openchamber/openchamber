import { describe, expect, test } from "bun:test"

import type { Message, Part, ToolPart } from "@/lib/opencode/model"
import {
  blockingCallsSettled,
  canContinueWithAnotherModel,
  continueWithModel,
  describeHandoffStop,
  findBlockingCalls,
  runningSubagentsBelow,
  type ContinueDeps,
  type ContinueSnapshot,
  type ContinueTarget,
} from "./continue-with-model"

const target: ContinueTarget = { sessionId: "ses_1", directory: "/repo" }
const selection = { providerID: "openai", modelID: "gpt-5", variant: "high", agent: "build" }

const snapshot = (overrides: Partial<ContinueSnapshot> = {}): ContinueSnapshot => ({
  stop: { kind: "retrying", attempt: 3, error: "429: rate limited" },
  from: { providerID: "anthropic", modelID: "claude-opus" },
  shells: [
    { shellID: "sh_own", command: "bun run dev", sessionID: "ses_1", shellDirectory: "/repo", background: true },
    { shellID: "sh_child", command: "bun test", sessionID: "ses_child", shellDirectory: "/repo", background: true },
  ],
  subagents: [
    { sessionID: "ses_grandchild", parentID: "ses_child", directory: "/repo", description: "Look deeper", depth: 2 },
    { sessionID: "ses_child", parentID: "ses_1", directory: "/repo", description: "Review", depth: 1 },
  ],
  blocking: null,
  ...overrides,
})

type Recorder = { calls: string[]; notes: string[]; deps: ContinueDeps }

/** Deps that record every call; `overrides` replace single calls to fail or stall them. */
const recorder = (overrides: Partial<ContinueDeps> = {}): Recorder => {
  const calls: string[] = []
  const notes: string[] = []
  const deps: ContinueDeps = {
    isRuntimeCurrent: () => true,
    moveBlockingWorkToBackground: async () => { calls.push("background") },
    waitForBlockingCalls: async (_target, blocking) => {
      calls.push(`wait:${blocking.callIDs.join(",")}`)
      return true
    },
    interrupt: async () => { calls.push("interrupt") },
    clearInterruptedPermissions: async (_target, scope) => { calls.push(`clear:${scope}`) },
    switchSelection: async (_target, chosen) => { calls.push(`switch:${chosen.providerID}/${chosen.modelID}#${chosen.variant}`) },
    admitNote: async (_target, note) => {
      calls.push("note")
      notes.push(note.text)
    },
    stopShells: async (owner, shells) => { calls.push(`shells:${owner.sessionID}:${shells.map((shell) => shell.shellID).join(",")}`) },
    stopSubagent: async (subagent) => { calls.push(`subagent:${subagent.sessionID}`) },
    sendContinue: async (_target, prompt) => { calls.push(`send:${prompt}`) },
    ...overrides,
  }
  return { calls, notes, deps }
}

const run = (mode: "stop" | "keep", deps: ContinueDeps, state: ContinueSnapshot = snapshot()) => (
  continueWithModel({ target, mode, selection, prompt: "Continue", snapshot: state }, deps)
)

describe("continue with another model: stop everything", () => {
  test("stops the turn, switches, adds the note, sends, then stops the work deepest first", async () => {
    const { calls, deps } = recorder()
    expect(await run("stop", deps)).toEqual({ status: "continued", failedStops: 0 })
    expect(calls).toEqual([
      "interrupt",
      "clear:session",
      "switch:openai/gpt-5#high",
      "note",
      "send:Continue",
      "subagent:ses_grandchild",
      "shells:ses_child:sh_child",
      "subagent:ses_child",
      "shells:ses_1:sh_own",
      "clear:tree",
    ])
  })

  test("never moves work to the background", async () => {
    const { calls, deps } = recorder()
    await run("stop", deps, snapshot({ blocking: { messageID: "msg_a", callIDs: ["call_1"] } }))
    expect(calls).not.toContain("background")
    expect(calls.some((call) => call.startsWith("wait:"))).toBe(false)
  })

  test("leaves a command the turn waits on to the interrupt", async () => {
    const { calls, deps } = recorder()
    await run("stop", deps, snapshot({
      shells: [{ shellID: "sh_fg", command: "bun test", sessionID: "ses_1", shellDirectory: "/repo", background: false }],
      subagents: [],
    }))
    expect(calls.some((call) => call.startsWith("shells:"))).toBe(false)
    expect(calls).toContain("interrupt")
  })

  test("one failed stop neither blocks the others nor the continue", async () => {
    const { calls, deps } = recorder({
      stopShells: async (owner) => {
        if (owner.sessionID === "ses_child") throw new Error("gone")
        calls.push(`shells:${owner.sessionID}`)
      },
    })
    expect(await run("stop", deps)).toEqual({ status: "continued", failedStops: 1 })
    expect(calls).toContain("subagent:ses_child")
    expect(calls).toContain("shells:ses_1")
    expect(calls).toContain("send:Continue")
  })

  test("tells the new model what stopped and where", async () => {
    const { notes, deps } = recorder()
    await run("stop", deps)
    expect(notes[0]).toContain("`anthropic/claude-opus`")
    expect(notes[0]).toContain("`openai/gpt-5#high`")
    expect(notes[0]).toContain("(attempt 3) after this error: 429: rate limited")
    expect(notes[0]).toContain("The user also stopped the work it had running")
    expect(notes[0]).toContain("`bun run dev` (shell ID: sh_own)")
    expect(notes[0]).toContain('"Review" (sessionID: ses_child)')
    // Only the session's own subagents are named; the one below stops with it.
    expect(notes[0]).not.toContain("ses_grandchild")
  })
})

describe("continue with another model: keep work running", () => {
  test("hands the waited-on calls to the background before stopping the turn, and stops no work", async () => {
    const { calls, deps } = recorder()
    expect(await run("keep", deps, snapshot({ blocking: { messageID: "msg_a", callIDs: ["call_1", "call_2"] } })))
      .toEqual({ status: "continued", failedStops: 0 })
    expect(calls).toEqual([
      "background",
      "wait:call_1,call_2",
      "interrupt",
      "clear:session",
      "switch:openai/gpt-5#high",
      "note",
      "send:Continue",
    ])
  })

  test("stops nothing when the handoff to the background does not show up", async () => {
    const { calls, deps } = recorder({ waitForBlockingCalls: async () => false })
    expect(await run("keep", deps, snapshot({ blocking: { messageID: "msg_a", callIDs: ["call_1"] } })))
      .toEqual({ status: "failed", step: "handoff", stopped: false })
    expect(calls).toEqual(["background"])
  })

  test("a failed move to the background stops nothing", async () => {
    const { calls, deps } = recorder({ moveBlockingWorkToBackground: async () => { throw new Error("503") } })
    const result = await run("keep", deps)
    expect(result).toMatchObject({ status: "failed", step: "background", stopped: false })
    expect(calls).toEqual([])
  })

  test("waits for nothing when the turn waits on no call", async () => {
    const { calls, deps } = recorder()
    await run("keep", deps)
    expect(calls.slice(0, 2)).toEqual(["background", "interrupt"])
  })

  test("tells the new model that the work keeps running", async () => {
    const { notes, deps } = recorder()
    await run("keep", deps)
    expect(notes[0]).toContain("Its work keeps running and reports back in this conversation when it finishes")
    expect(notes[0]).toContain("`bun test` (shell ID: sh_child)")
    expect(notes[0]).not.toContain("The user also stopped")
  })
})

describe("continue with another model: failures and guards", () => {
  test("an interrupt that fails changes nothing else", async () => {
    const { calls, deps } = recorder({ interrupt: async () => { throw new Error("offline") } })
    expect(await run("stop", deps)).toMatchObject({ status: "failed", step: "interrupt", stopped: false })
    expect(calls).toEqual([])
  })

  test("a failed switch leaves the session stopped and sends nothing", async () => {
    const { calls, deps } = recorder({ switchSelection: async () => { throw new Error("unknown model") } })
    expect(await run("stop", deps)).toMatchObject({ status: "failed", step: "switch", stopped: true })
    expect(calls).toEqual(["interrupt", "clear:session"])
  })

  test("a failed send is reported, and the work the user asked to stop still stops", async () => {
    const { calls, deps } = recorder({ sendContinue: async () => { throw new Error("circuit open") } })
    expect(await run("stop", deps)).toMatchObject({ status: "failed", step: "send", stopped: true })
    expect(calls).toContain("subagent:ses_child")
    expect(calls).toContain("shells:ses_1:sh_own")
  })

  test("a runtime switch ends the sequence before the session moves on", async () => {
    let current = true
    const { calls, deps } = recorder({
      isRuntimeCurrent: () => current,
      interrupt: async () => {
        calls.push("interrupt")
        current = false
      },
    })
    expect(await run("stop", deps)).toEqual({ status: "runtime-changed", stopped: true })
    expect(calls).toEqual(["interrupt", "clear:session"])
  })

  test("a second continue for the same session while one runs is refused", async () => {
    let release: () => void = () => undefined
    const { deps } = recorder({ interrupt: () => new Promise<void>((resolve) => { release = resolve }) })
    const first = run("stop", deps)
    expect(await run("stop", recorder().deps)).toEqual({ status: "busy" })
    release()
    expect(await first).toMatchObject({ status: "continued" })
    // Once the first one settled, the session can be continued again.
    expect(await run("stop", recorder().deps)).toMatchObject({ status: "continued" })
  })
})

describe("where the previous model stopped", () => {
  const assistant = (overrides: Partial<Extract<Message, { role: "assistant" }>> = {}): Message => ({
    id: "msg_a",
    sessionID: "ses_1",
    role: "assistant",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude-opus",
    time: { created: 2 },
    ...overrides,
  })
  const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
  const tool = (callID: string, name: string, input: ToolPart["state"]["input"], status: "running" | "completed" = "running"): ToolPart => ({
    id: callID,
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    callID,
    tool: name,
    state: status === "running"
      ? { status, input, time: { start: 1 } }
      : { status, input, output: "", time: { start: 1, end: 2 } },
  })
  const stopOf = (input: Partial<Parameters<typeof describeHandoffStop>[0]> & { parts?: Part[] }) => describeHandoffStop({
    messages: input.messages ?? [user, assistant()],
    partsOf: () => input.parts ?? [],
    active: input.active ?? false,
    hasQuestion: input.hasQuestion ?? false,
    hasPermission: input.hasPermission ?? false,
    reportedError: input.reportedError,
  })

  test("a scheduled retry names its attempt and error", () => {
    const retrying = assistant({ retry: { attempt: 2, at: 99, error: { type: "provider", message: "overloaded" } } })
    expect(stopOf({ active: true, messages: [user, retrying] })).toEqual({ kind: "retrying", attempt: 2, error: "provider: overloaded" })
  })

  test("a wait for the user wins over the running turn", () => {
    expect(stopOf({ active: true, hasQuestion: true })).toEqual({ kind: "waiting", on: "question" })
    expect(stopOf({ active: true, hasPermission: true })).toEqual({ kind: "waiting", on: "permission" })
  })

  test("running calls are named, otherwise the model is replying", () => {
    expect(stopOf({ active: true, parts: [tool("call_1", "shell", { command: "bun test" })] }))
      .toEqual({ kind: "working", tools: ["the command `bun test`"] })
    expect(stopOf({ active: true, parts: [tool("call_1", "shell", { command: "ls" }, "completed")] })).toEqual({ kind: "replying" })
  })

  test("an idle session reads its failure, and a user's stop is not one", () => {
    expect(stopOf({ messages: [user, assistant({ error: { type: "provider", message: "model not found" } })] }))
      .toEqual({ kind: "failed", error: "provider: model not found" })
    expect(stopOf({ messages: [user, assistant({ error: { type: "MessageAbortedError", message: "aborted" } })] })).toEqual({ kind: "idle" })
    expect(stopOf({ messages: [user], reportedError: "quota exhausted" })).toEqual({ kind: "failed", error: "quota exhausted" })
    expect(stopOf({ messages: [user] })).toEqual({ kind: "failed" })
    expect(stopOf({})).toEqual({ kind: "idle" })
  })
})

describe("calls the turn waits on", () => {
  const assistant: Message = { id: "msg_a", sessionID: "ses_1", role: "assistant", agent: "build", providerID: "p", modelID: "m", time: { created: 2 } }
  const part = (callID: string, name: string, status: "running" | "completed", metadata?: ToolPart["state"]["input"]): Part => ({
    id: callID,
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    callID,
    tool: name,
    state: status === "running"
      ? { status, input: {}, metadata, time: { start: 1 } }
      : { status, input: {}, output: "", time: { start: 1, end: 2 } },
  })

  test("shells and subagents block, a call waiting for permission does not", () => {
    const parts = [
      part("call_shell", "shell", "running"),
      part("call_sub", "subagent", "running"),
      part("call_asking", "shell", "running"),
      part("call_read", "read", "running"),
      part("call_done", "shell", "completed"),
      part("call_code", "execute", "running", { shellID: "sh_9" }),
    ]
    expect(findBlockingCalls({ messages: [assistant], partsOf: () => parts, permissionCallIDs: new Set(["call_asking"]) }))
      .toEqual({ messageID: "msg_a", callIDs: ["call_shell", "call_sub", "call_code"] })
    expect(findBlockingCalls({ messages: [assistant], partsOf: () => [part("call_read", "read", "running")], permissionCallIDs: new Set() })).toBeNull()
  })

  test("settled once every waited-on call has left the running state", () => {
    const blocking = { messageID: "msg_a", callIDs: ["call_shell", "call_sub"] }
    expect(blockingCallsSettled(blocking, [part("call_shell", "shell", "completed"), part("call_sub", "subagent", "running")])).toBe(false)
    expect(blockingCallsSettled(blocking, [part("call_shell", "shell", "completed"), part("call_sub", "subagent", "completed")])).toBe(true)
    // A call the store does not hold is not proof of a handoff.
    expect(blockingCallsSettled(blocking, [part("call_shell", "shell", "completed")])).toBe(false)
  })
})

describe("running subagents", () => {
  const parents = new Map([["ses_child", "ses_1"], ["ses_grandchild", "ses_child"], ["ses_other", "ses_9"]])
  test("lists the session's active subagents at any depth, deepest first", () => {
    expect(runningSubagentsBelow({
      rootId: "ses_1",
      activeSessionIds: new Set(["ses_1", "ses_child", "ses_grandchild", "ses_other"]),
      parentOf: (id) => parents.get(id),
      describe: (id) => ({ directory: "/repo", title: id === "ses_child" ? "Review" : undefined }),
    })).toEqual([
      { sessionID: "ses_grandchild", parentID: "ses_child", directory: "/repo", description: undefined, depth: 2 },
      { sessionID: "ses_child", parentID: "ses_1", directory: "/repo", description: "Review", depth: 1 },
    ])
  })
})

describe("when the action is offered", () => {
  test("on a top-level session, never on a subagent or without a session", () => {
    expect(canContinueWithAnotherModel({ id: "ses_1" })).toBe(true)
    expect(canContinueWithAnotherModel({ id: "ses_child", parentID: "ses_1" })).toBe(false)
    expect(canContinueWithAnotherModel(null)).toBe(false)
    expect(canContinueWithAnotherModel(undefined)).toBe(false)
  })
})
