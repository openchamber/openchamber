/**
 * Tests for the deferred status poll fired when an assistant message completes
 * (issue OPE-193): the busy spinner must not linger for up to a full watchdog
 * poll interval after a turn completed when the session.idle event was delayed
 * or lost — and a normal turn, whose session.idle arrives promptly, must not
 * cost a single extra request.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

type StatusSnapshot = Record<string, SessionStatus | undefined>

let respondWithSnapshot: () => Promise<StatusSnapshot | null> = () => Promise.resolve({ ses_1: { type: "idle" } })
const statusSnapshotCalls: string[] = []
let runtimeKey = "test-runtime"
let sdkIdentity = {}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSdkClient: () => sdkIdentity,
    getSessionStatusForDirectory: mock((directory: string) => {
      statusSnapshotCalls.push(directory)
      return respondWithSnapshot()
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
}))

import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from "../global-session-status"
import { useSessionOrderingStore } from "../session-ordering"
import { useSessionActivityTimingStore } from "../session-activity-timing"

import {
  maybePollStatusAfterMessageCompletion,
  MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS,
  recoverInterruptedTurnAfterMessageLoad,
} from "../sync-context"

const createStore = (status?: SessionStatus): StoreApi<DirectoryStore> => {
  const session_status: DirectoryStore["session_status"] = {}
  if (status) session_status.ses_1 = status
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    session_status,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

// SAFETY: The recovery path reads only the identity, role, and completion time
// fields from this synthetic assistant message.
const unfinishedAssistant = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1 },
} as Message

// SAFETY: The recovery path reads only the tool discriminator and state fields
// from this synthetic part.
const runningTool = {
  id: "part_1",
  messageID: "msg_1",
  sessionID: "ses_1",
  type: "tool",
  tool: "bash",
  state: { status: "running", time: { start: 1 }, input: {} },
} as Part

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Past the deferral, plus room for the background-network task chain. */
const waitForPollSettled = async (): Promise<void> => {
  await sleep(MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS + 50)
  await sleep(50)
}

describe("maybePollStatusAfterMessageCompletion (issue OPE-193)", () => {
  beforeEach(() => {
    respondWithSnapshot = () => Promise.resolve({ ses_1: { type: "idle" } })
    statusSnapshotCalls.length = 0
    runtimeKey = "test-runtime"
    sdkIdentity = {}
  })

  test("does not poll when the store believes the session is already idle", async () => {
    const store = createStore({ type: "idle" })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual([])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
  })

  test("does not poll without a directory or session id", async () => {
    const store = createStore({ type: "busy" })

    maybePollStatusAfterMessageCompletion("", store, "ses_1")
    maybePollStatusAfterMessageCompletion("global", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual([])
  })

  test("issues no request when session.idle arrives inside the deferral window", async () => {
    const store = createStore({ type: "busy" })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    // The turn's own session.idle event lands well before the timer fires.
    await sleep(50)
    store.getState().patch({ session_status: { ses_1: { type: "idle" } } })
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual([])
  })

  test("settles a busy session to idle when the idle event never arrives", async () => {
    const store = createStore({ type: "busy" })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    // Nothing settles the session inside the window; the poll must run.
    expect(statusSnapshotCalls).toEqual([])

    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual(["/test/project", "/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
  })

  test("keeps the session busy when the snapshot confirms it is still active", async () => {
    const store = createStore({ type: "busy" })
    respondWithSnapshot = () => Promise.resolve({ ses_1: { type: "busy" } })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    // Monotonic poll confirms busy; the snapshot is not idle, so no
    // authoritative escalation runs.
    expect(statusSnapshotCalls).toEqual(["/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("preserves the busy status when the status fetch fails", async () => {
    const store = createStore({ type: "busy" })
    respondWithSnapshot = () => Promise.resolve(null)

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual(["/test/project"])
    // Failure is not treated as authoritative empty: the busy status stays
    // until the watchdog poll (or a live event) corrects it.
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("schedules one check for a burst of completions on the same session", async () => {
    const store = createStore({ type: "busy" })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    // One monotonic poll plus its authoritative escalation, not three.
    expect(statusSnapshotCalls).toEqual(["/test/project", "/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
  })

  test("recovers an unfinished turn after reload when status was initially unknown", async () => {
    const store = createStore()
    store.getState().patch({
      message: { ses_1: [unfinishedAssistant] },
      part: { msg_1: [runningTool] },
    })

    await recoverInterruptedTurnAfterMessageLoad("/test/project", store, "ses_1")

    expect(statusSnapshotCalls).toEqual(["/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
    const message = store.getState().message.ses_1[0]
    expect(message?.role).toBe("assistant")
    if (message?.role === "assistant") expect(message.time.completed).toBeDefined()
    const part = store.getState().part.msg_1[0]
    expect(part?.type).toBe("tool")
    if (part?.type === "tool") expect(part.state.status).toBe("error")
  })

  for (const change of ["runtime", "sdk", "request"] as const) {
    test(`discards delayed recovery after ${change} ownership changes`, async () => {
      const store = createStore()
      store.getState().patch({
        message: { ses_1: [unfinishedAssistant] },
        part: { msg_1: [runningTool] },
      })
      const before = store.getState()
      let resolveSnapshot: (snapshot: StatusSnapshot) => void = () => { throw new Error("Request not started") }
      respondWithSnapshot = () => new Promise((resolve) => { resolveSnapshot = resolve })
      let stale = false
      const recovery = recoverInterruptedTurnAfterMessageLoad("/test/project", store, "ses_1", () => stale)
      expect(statusSnapshotCalls).toEqual(["/test/project"])

      if (change === "runtime") runtimeKey = "runtime-b"
      if (change === "sdk") sdkIdentity = {}
      if (change === "request") stale = true
      applyGlobalSessionStatusSnapshot("/test/project", { ses_new: { type: "busy" } })
      const statuses = useGlobalSessionStatusStore.getState()
      const ordering = useSessionOrderingStore.getState()
      const timing = useSessionActivityTimingStore.getState()
      resolveSnapshot({ ses_old: { type: "busy" } })
      await recovery

      expect(store.getState()).toBe(before)
      expect(useGlobalSessionStatusStore.getState()).toBe(statuses)
      expect(useSessionOrderingStore.getState()).toBe(ordering)
      expect(useSessionActivityTimingStore.getState()).toBe(timing)
    })
  }

})
