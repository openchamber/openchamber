import { describe, expect, test } from "bun:test"

import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part, PermissionRequest, Session } from "@/lib/opencode/model"
import { applyDirectoryEvent, reduceGlobalEvent } from "./event-reducer"
import { INITIAL_STATE, type State } from "./types"

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "ses_1",
  projectID: "proj_1",
  directory: "/repo",
  title: "One",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...overrides,
})

const assistant = (overrides: Partial<Extract<Message, { role: "assistant" }>> = {}): Message => ({
  id: "msg_a",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 10 },
  agent: "build",
  providerID: "p",
  modelID: "m",
  ...overrides,
})

const permission = (id: string, sessionID = "ses_1"): PermissionRequest => ({
  id,
  sessionID,
  action: "edit",
  resources: [],
})

// INITIAL_STATE's nested records are shared module state, so every one a test
// mutates has to be replaced with a fresh object here.
const state = (overrides: Partial<State> = {}): State => ({
  ...INITIAL_STATE,
  session: [session()],
  message: { ses_1: [assistant()] },
  part: {},
  session_status: {},
  permission: {},
  form: {},
  sessionEventRevision: {},
  sessionDeletedRevision: {},
  ...overrides,
})

const apply = (draft: State, event: SyncEvent) => applyDirectoryEvent(draft, event)

describe("session events", () => {
  test("a patch updates the session in place and bumps its revision", () => {
    const draft = state()
    const changed = apply(draft, {
      type: "session.patched",
      properties: { sessionID: "ses_1", patch: { title: "Renamed", time: { updated: 5 } } },
    })
    expect(changed).toBe(true)
    expect(draft.session[0]).toMatchObject({ title: "Renamed", time: { created: 1, updated: 5 } })
    expect(draft.sessionEventRevision?.ses_1).toBe(1)
  })

  test("a patch for an unknown session is ignored", () => {
    const draft = state()
    expect(apply(draft, { type: "session.patched", properties: { sessionID: "ses_x", patch: { title: "x" } } })).toBe(false)
  })

  test("clearing the revert removes the marker", () => {
    const draft = state({ session: [session({ revert: { messageID: "msg_a" } })] })
    apply(draft, { type: "session.patched", properties: { sessionID: "ses_1", patch: { revert: null } } })
    expect("revert" in draft.session[0]).toBe(false)
  })

  describe("committing a revert", () => {
    const user = (id: string, created: number): Message => ({ id, sessionID: "ses_1", role: "user", time: { created } })
    const part = (messageID: string): Part => ({ id: `${messageID}:text:0`, sessionID: "ses_1", messageID, type: "text", text: "t" })
    const transcript = () => [user("msg_u1", 1), assistant({ id: "msg_a1", time: { created: 2 } }), user("msg_u2", 3), assistant({ id: "msg_a2", time: { created: 4 } })]
    const parts = () => ({ msg_a1: [part("msg_a1")], msg_u2: [part("msg_u2")], msg_a2: [part("msg_a2")] })

    test("drops the boundary message and everything after it, with their parts and the marker", () => {
      // A commit this client staged and then sent past.
      const draft = state({ session: [session({ revert: { messageID: "msg_u2" } })], message: { ses_1: transcript() }, part: parts() })
      expect(apply(draft, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_u2" } })).toBe(true)
      expect(draft.message.ses_1.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"])
      expect(Object.keys(draft.part)).toEqual(["msg_a1"])
      expect("revert" in draft.session[0]).toBe(false)
    })

    test("a commit from another client trims without a local marker", () => {
      const draft = state({ message: { ses_1: transcript() }, part: parts() })
      expect(apply(draft, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_u2" } })).toBe(true)
      expect(draft.message.ses_1.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"])
      expect(draft.part.msg_a2).toBeUndefined()
    })

    test("a boundary older than the loaded window empties it only when the marker agrees", () => {
      const agreed = state({ session: [session({ revert: { messageID: "msg_old" } })], message: { ses_1: transcript() }, part: parts() })
      expect(apply(agreed, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_old" } })).toBe(true)
      expect(agreed.message.ses_1).toEqual([])
      expect(Object.keys(agreed.part)).toEqual([])

      const unknown = state({ message: { ses_1: transcript() }, part: parts() })
      expect(apply(unknown, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_old" } })).toBe(false)
      expect(unknown.message.ses_1.map((m) => m.id)).toEqual(["msg_u1", "msg_a1", "msg_u2", "msg_a2"])
    })

    test("is a no-op for a session with nothing loaded and no marker", () => {
      const draft = state({ message: {} })
      expect(apply(draft, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_u2" } })).toBe(false)
    })
  })

  test("an archive patch drops the session and its caches", () => {
    const draft = state({ session_status: { ses_1: { type: "busy" } }, sessionStatusReady: true, sessionTotal: 1 })
    apply(draft, { type: "session.patched", properties: { sessionID: "ses_1", patch: { time: { archived: 9 } } } })
    expect(draft.session).toEqual([])
    expect(draft.message.ses_1).toBeUndefined()
    expect(draft.session_status.ses_1).toBeUndefined()
    expect(draft.sessionStatusInvalidated?.ses_1).toBe(true)
    expect(draft.sessionTotal).toBe(0)

    // The directory's earlier successful snapshot cannot certify a restored
    // session idle after archiving discarded its last live status.
    apply(draft, { type: "session.created", properties: { info: session() } })
    expect(draft.session_status.ses_1).toBeUndefined()
    expect(draft.sessionStatusInvalidated?.ses_1).toBe(true)
    apply(draft, { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
    expect(draft.session_status.ses_1).toEqual({ type: "busy" })
    expect(draft.sessionStatusInvalidated?.ses_1).toBeUndefined()
  })

  test("an unarchive patch clears the archive marker", () => {
    const draft = state({ session: [session({ time: { created: 1, updated: 1, archived: 5 } })] })
    apply(draft, { type: "session.patched", properties: { sessionID: "ses_1", patch: { time: { archived: null } } } })
    expect(draft.session[0].time).toEqual({ created: 1, updated: 1 })
  })

  test("deleting an archived session releases its invalidated status marker", () => {
    const draft = state({ session: [], sessionStatusInvalidated: { ses_1: true } })
    apply(draft, { type: "session.deleted", properties: { sessionID: "ses_1" } })
    expect(draft.sessionStatusInvalidated?.ses_1).toBeUndefined()
  })

  test("a create echo keeps what the store already learned about the session", () => {
    const draft = state({ session: [session({ title: "Learned", cost: 2 })] })
    apply(draft, { type: "session.created", properties: { info: session({ title: "", cost: 0 }) } })
    expect(draft.session[0]).toMatchObject({ title: "Learned", cost: 2 })
  })

  test("session.error settles the status to idle", () => {
    const draft = state({ session_status: { ses_1: { type: "busy" } } })
    apply(draft, { type: "session.error", properties: { sessionID: "ses_1", error: { type: "x", message: "boom" } } })
    expect(draft.session_status.ses_1).toEqual({ type: "idle" })
  })
})

describe("compaction events", () => {
  const running = (): Message => ({
    id: "msg_compact", sessionID: "ses_1", role: "compaction", time: { created: 5 }, status: "running", reason: "auto", summary: "",
  })

  test("summary deltas grow the running compaction", () => {
    const draft = state({ message: { ses_1: [assistant(), running()] } })
    expect(apply(draft, { type: "message.compaction.delta", properties: { sessionID: "ses_1", delta: "Hello" } })).toBe(true)
    expect(apply(draft, { type: "message.compaction.delta", properties: { sessionID: "ses_1", delta: " world" } })).toBe(true)
    expect(draft.message.ses_1[1]).toMatchObject({ id: "msg_compact", status: "running", summary: "Hello world" })
  })

  test("a delta without a running compaction changes nothing", () => {
    const draft = state()
    expect(apply(draft, { type: "message.compaction.delta", properties: { sessionID: "ses_1", delta: "x" } })).toBe(false)
  })

  test("the settled record replaces the running one instead of adding a second", () => {
    const draft = state({ message: { ses_1: [assistant(), running()] } })
    apply(draft, {
      type: "message.updated",
      properties: {
        info: { id: "msg_evt_9", sessionID: "ses_1", role: "compaction", time: { created: 9 }, status: "completed", reason: "auto", summary: "Done." },
      },
    })
    const compactions = draft.message.ses_1.filter((message) => message.role === "compaction")
    expect(compactions).toHaveLength(1)
    expect(compactions[0]).toMatchObject({ id: "msg_compact", time: { created: 5 }, status: "completed", summary: "Done." })
  })
})

describe("message events", () => {
  test("a patch completes the assistant message without replacing unrelated fields", () => {
    const draft = state()
    const changed = apply(draft, {
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID: "msg_a", patch: { time: { completed: 20 }, finish: "stop", cost: 0.5, retry: null } },
    })
    expect(changed).toBe(true)
    expect(draft.message.ses_1[0]).toMatchObject({ agent: "build", time: { created: 10, completed: 20 }, finish: "stop", cost: 0.5 })
  })

  test("a reported completion lifts the local interruption mark", () => {
    // `interruptedTurnToolParts` closes an open turn with `{type:"aborted"}`
    // when idle status lands before the completion event flushes.
    const marked = assistant({ time: { created: 10, completed: 15 }, error: { type: "aborted", message: "aborted" } })
    const draft = state({ message: { ses_1: [marked] } })
    apply(draft, {
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID: "msg_a", patch: { time: { completed: 20 }, finish: "stop" } },
    })
    expect(draft.message.ses_1[0]).toMatchObject({ time: { completed: 20 }, finish: "stop" })
    expect("error" in draft.message.ses_1[0]).toBe(false)

    // A turn that really failed keeps the error the server sent.
    const failed = state({ message: { ses_1: [marked] } })
    apply(failed, {
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID: "msg_a", patch: { time: { completed: 20 }, error: { type: "unknown", message: "boom" } } },
    })
    expect(failed.message.ses_1[0]).toMatchObject({ error: { type: "unknown", message: "boom" } })
  })

  test("a patch for a message not in memory asks for materialization", () => {
    const draft = state()
    const result = apply(draft, {
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID: "msg_missing", patch: { time: { completed: 20 } } },
    })
    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID: "ses_1", messageID: "msg_missing" },
    })
  })

  test("inbox delivery moves a user message to its delivery time", () => {
    const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 5 } }
    const draft = state({ message: { ses_1: [user, assistant()] } })
    apply(draft, { type: "message.patched", properties: { sessionID: "ses_1", messageID: "msg_u", patch: { time: { created: 30 } } } })
    expect(draft.message.ses_1.map((m) => m.id)).toEqual(["msg_a", "msg_u"])
  })

  test("a shell message is patched by shell id", () => {
    const shell: Message = {
      id: "msg_s",
      sessionID: "ses_1",
      role: "shell",
      time: { created: 5 },
      shellID: "sh_1",
      command: "ls",
      status: "running",
    }
    const draft = state({ message: { ses_1: [shell] } })
    apply(draft, {
      type: "message.patched",
      properties: {
        sessionID: "ses_1",
        messageID: "shell:sh_1",
        patch: { time: { completed: 9 }, shell: { status: "exited", exit: 0, output: { output: "a", cursor: 1, size: 1, truncated: false } } },
      },
    })
    expect(draft.message.ses_1[0]).toMatchObject({ status: "exited", exit: 0, time: { completed: 9 }, output: { output: "a" } })
  })

  test("a shell killed by a signal keeps the signal", () => {
    const shell: Message = {
      id: "msg_s",
      sessionID: "ses_1",
      role: "shell",
      time: { created: 5 },
      shellID: "sh_1",
      command: "sleep 60",
      status: "running",
    }
    const draft = state({ message: { ses_1: [shell] } })
    apply(draft, {
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID: "shell:sh_1", patch: { time: { completed: 9 }, shell: { status: "exited", signal: "SIGTERM" } } },
    })
    expect(draft.message.ses_1[0]).toMatchObject({ status: "exited", signal: "SIGTERM" })
    expect("exit" in draft.message.ses_1[0]).toBe(false)
  })
})

describe("streaming parts", () => {
  const textPart = (text: string, end?: number, start = 10): Part => ({
    id: "msg_a:text:0",
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "text",
    text,
    time: end === undefined ? { start } : { start, end },
  })

  test("deltas grow a text part and a final snapshot dedupes an overlapping delta", () => {
    const draft = state()
    apply(draft, { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("") } })
    apply(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "msg_a:text:0", field: "text", delta: "hel" } })
    apply(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "msg_a:text:0", field: "text", delta: "lo" } })
    expect(draft.part.msg_a[0]).toMatchObject({ text: "hello" })
    apply(draft, { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("hello wor", undefined) } })
    apply(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "msg_a:text:0", field: "text", delta: "world" } })
    expect(draft.part.msg_a[0]).toMatchObject({ text: "hello world" })
  })

  test("the ended snapshot keeps the start the stream began with", () => {
    const draft = state()
    apply(draft, { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("", undefined, 2000) } })
    apply(draft, { type: "message.part.updated", properties: { sessionID: "ses_1", part: textPart("done", 6000, 6000) } })
    expect(draft.part.msg_a[0]).toMatchObject({ text: "done", time: { start: 2000, end: 6000 } })

    const reasoning = state()
    const thought = (time: { start: number; end?: number }): Part => ({ id: "msg_a:reasoning:0", sessionID: "ses_1", messageID: "msg_a", type: "reasoning", text: "why", time })
    apply(reasoning, { type: "message.part.updated", properties: { sessionID: "ses_1", part: thought({ start: 2000 }) } })
    apply(reasoning, { type: "message.part.updated", properties: { sessionID: "ses_1", part: thought({ start: 6000, end: 6000 }) } })
    expect(reasoning.part.msg_a[0]).toMatchObject({ time: { start: 2000, end: 6000 } })
  })

  test("a delta for a part that never started asks for materialization", () => {
    const draft = state({ part: { msg_a: [] } })
    const result = apply(draft, {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_a", partID: "msg_a:text:3", field: "text", delta: "x" },
    })
    expect(result).toMatchObject({ changed: false, materialization: { reason: "missing-delta-part", partID: "msg_a:text:3" } })
  })

  test("a tool call moves pending → running → completed while keeping its name and input", () => {
    const draft = state()
    apply(draft, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "call_1", sessionID: "ses_1", messageID: "msg_a", type: "tool", callID: "call_1", tool: "bash", state: { status: "pending", input: {}, raw: "" } },
      },
    })
    apply(draft, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", field: "raw", delta: '{"command":' } })
    apply(draft, { type: "message.tool.transition", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: { kind: "input", raw: '{"command":"ls"}' } } })
    expect(draft.part.msg_a[0]).toMatchObject({ tool: "bash", state: { status: "pending", raw: '{"command":"ls"}' } })

    apply(draft, {
      type: "message.tool.transition",
      properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: { kind: "called", input: { command: "ls" }, executed: true, start: 11 } },
    })
    apply(draft, { type: "message.tool.transition", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: { kind: "progress", metadata: { title: "Listing" } } } })
    expect(draft.part.msg_a[0]).toMatchObject({ tool: "bash", executed: true, state: { status: "running", input: { command: "ls" }, metadata: { title: "Listing" }, time: { start: 11 } } })

    apply(draft, {
      type: "message.tool.transition",
      properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: { kind: "success", output: "a\nb", executed: true, end: 15 } },
    })
    const done = draft.part.msg_a[0]
    if (done.type !== "tool" || done.state.status !== "completed") throw new Error("expected completed tool")
    expect(done.state).toEqual({ status: "completed", input: { command: "ls" }, output: "a\nb", metadata: { title: "Listing" }, time: { start: 11, end: 15 } })

    // A late progress or a replay of the running snapshot cannot reopen a finished call.
    expect(apply(draft, { type: "message.tool.transition", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: { kind: "progress", metadata: {} } } })).toBe(false)
    expect(
      apply(draft, {
        type: "message.part.updated",
        properties: { sessionID: "ses_1", part: { ...done, state: { status: "running", input: { command: "ls" }, time: { start: 11 } } } },
      }),
    ).toBe(false)
  })

  test("a transition for an unknown call asks for materialization", () => {
    const draft = state({ part: { msg_a: [] } })
    const result = apply(draft, {
      type: "message.tool.transition",
      properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_9", transition: { kind: "failed", error: "x", executed: true, end: 1 } },
    })
    expect(result).toMatchObject({ changed: false, materialization: { reason: "missing-delta-part", partID: "call_9" } })
  })

  test("replacing parts of a message not in memory still stores them and asks for the message", () => {
    const draft = state({ message: { ses_1: [] } })
    const result = apply(draft, { type: "message.parts.replaced", properties: { sessionID: "ses_1", messageID: "msg_u", parts: [textPart("hi", 1)] } })
    expect(result).toMatchObject({ changed: true, materialization: { reason: "missing-owning-message", messageID: "msg_u" } })
    expect(draft.part.msg_u).toHaveLength(1)
  })
})

describe("requests and notices", () => {
  test("forms are tracked per session until settled", () => {
    const draft = state()
    apply(draft, { type: "form.created", properties: { form: { id: "form_1", sessionID: "ses_1", title: "Pick", fields: [{ key: "a", type: "boolean" }] } } })
    expect(draft.form.ses_1).toHaveLength(1)
    apply(draft, { type: "form.settled", properties: { sessionID: "ses_1", formID: "form_1" } })
    expect(draft.form.ses_1).toEqual([])
  })

  test("branch updates keep the default branch", () => {
    const draft = state({ vcs: { branch: "main", defaultBranch: "main" } })
    apply(draft, { type: "vcs.branch.updated", properties: { branch: "feature" } })
    expect(draft.vcs).toEqual({ branch: "feature", defaultBranch: "main" })
  })

  test("server.connected asks for a global refresh and catalog changes name their kind", () => {
    expect(reduceGlobalEvent({ type: "server.connected", properties: {} })).toEqual({ type: "refresh" })
    expect(reduceGlobalEvent({ type: "catalog.updated", properties: { kind: "agent" } })).toEqual({ type: "catalog", kind: "agent" })
    expect(reduceGlobalEvent({ type: "catalog.updated", properties: { kind: "plugin" } })).toEqual({ type: "catalog", kind: "plugin" })
  })
})

describe("ordering and trimming", () => {
  test("inserts a message by creation time rather than by id", () => {
    // Message ids wrapped around, so a newer message can sort below an older
    // one; only `time.created` decides the position.
    const legacy = assistant({ id: "msg_ffffffffffffLegacy", time: { created: 100 } })
    const current = assistant({ id: "msg_000000000000Current", time: { created: 200 } })
    const draft = state({ message: { ses_1: [legacy] } })

    expect(apply(draft, { type: "message.updated", properties: { info: current } })).toBe(true)
    expect(draft.message.ses_1).toEqual([legacy, current])
  })

  test("keeps parts of one message in arrival order across the part id rollover", () => {
    const legacyPart: Part = { id: "prt_ffffffffffffLegacy", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "legacy" }
    const currentPart: Part = { id: "prt_000000000000Current", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "current" }
    const draft = state({ part: { msg_a: [legacyPart] } })

    expect(apply(draft, { type: "message.part.updated", properties: { sessionID: "ses_1", part: currentPart } })).toBe(true)
    expect(draft.part.msg_a).toEqual([legacyPart, currentPart])
  })

  test("trimming past the limit spares a session that still has a pending permission", () => {
    const older = session({ id: "ses_0", title: "Older" })
    const draft = state({
      session: [older],
      limit: 1,
      permission: { ses_0: [permission("perm_1", "ses_0")] },
    })

    apply(draft, { type: "session.created", properties: { info: session({ id: "ses_2", title: "Newest" }) } })

    expect(draft.session.map((item) => item.id)).toEqual(["ses_0", "ses_2"])
  })

  test("trimming past the limit drops the oldest session with nothing pending", () => {
    const draft = state({ session: [session({ id: "ses_0", title: "Older" })], limit: 1 })

    apply(draft, { type: "session.created", properties: { info: session({ id: "ses_2", title: "Newest" }) } })

    expect(draft.session.map((item) => item.id)).toEqual(["ses_2"])
  })
})

describe("session status", () => {
  test("a repeated status event is not a change", () => {
    const draft = state()
    const event: SyncEvent = { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }

    expect(apply(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1
    expect(apply(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("a repeated idle event is not a change", () => {
    const draft = state()
    const event: SyncEvent = { type: "session.idle", properties: { sessionID: "ses_1" } }

    expect(apply(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1
    expect(apply(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("a repeated error event is not a change", () => {
    const draft = state()
    const event: SyncEvent = {
      type: "session.error",
      properties: { sessionID: "ses_1", error: { type: "UnknownError", message: "boom" } },
    }

    expect(apply(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1
    expect(apply(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("a retry status whose attempt advanced is a change", () => {
    const draft = state({ session_status: { ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } } })

    expect(apply(draft, {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } },
    })).toBe(true)
    expect(draft.session_status.ses_1).toEqual({ type: "retry", attempt: 2, message: "rate limited", next: 20 })
  })
})

describe("permission requests", () => {
  test("asking and replying rebuild the session's array instead of mutating it", () => {
    const initial = [permission("perm_1")]
    const draft = state({ permission: { ses_1: initial } })

    apply(draft, { type: "permission.asked", properties: permission("perm_2") })

    expect(draft.permission.ses_1).not.toBe(initial)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    apply(draft, { type: "permission.replied", properties: { sessionID: "ses_1", requestID: "perm_1" } })

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("replaying the same request replaces it in place rather than duplicating it", () => {
    const draft = state({ permission: { ses_1: [permission("perm_1")] } })

    apply(draft, { type: "permission.asked", properties: { ...permission("perm_1"), message: "second take" } })

    expect(draft.permission.ses_1).toHaveLength(1)
    expect(draft.permission.ses_1[0].message).toBe("second take")
  })

  test("replying to a request the store never saw is a no-op", () => {
    const draft = state()
    expect(apply(draft, { type: "permission.replied", properties: { sessionID: "ses_1", requestID: "perm_x" } })).toBe(false)
  })
})
