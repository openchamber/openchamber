/**
 * Tests for the deferred status poll fired when an assistant message completes
 * (issue OPE-193): the busy spinner must not linger for up to a full watchdog
 * poll interval after a turn completed when the session.idle event was delayed
 * or lost — and a normal turn, whose session.idle arrives promptly, must not
 * cost a single extra request.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { create, type StoreApi } from "zustand"
import type { Event, Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"
import { installHookTestDom } from "../../components/session/sidebar/test-utils/testDom"

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

import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  isSessionStatusFresh,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from "../global-session-status"
import { useSessionOrderingStore } from "../session-ordering"
import { useSessionActivityTimingStore } from "../session-activity-timing"

import {
  maybePollStatusAfterMessageCompletion,
  MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS,
  recoverInterruptedTurnAfterMessageLoad,
  useSessionDisplayStatus,
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

// SAFETY: This fixture provides the event fields the global status reducer reads.
const busyStatusEvent = (sessionId: string): Event => ({
  type: "session.status",
  properties: { sessionID: sessionId, status: { type: "busy" } },
} as Event)

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
    resetGlobalSessionStatus()
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

  // Issue #2421 / PR #2485 follow-up: a directory marked unavailable must be
  // fetched AUTHORITATIVELY, because only an authoritative reconcile may clear
  // the flag and it clears it atomically with applying the snapshot. A
  // monotonic success must never clear freshness: it cannot lower busy/retry,
  // so the preserved entry would render as a confirmed spinner until a second
  // fetch corrected it.
  test("a failed monotonic fetch marks the directory unavailable and preserves last-known busy", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))
    respondWithSnapshot = () => Promise.resolve(null)

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(true)
    expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(false)
    // Last known busy is preserved in both owners; failure is not idle.
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_1")?.status.type).toBe("busy")
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("a successful recovery fetch while unavailable is authoritative and confirms busy", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))

    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(false)

    respondWithSnapshot = () => Promise.resolve({ ses_1: { type: "busy" } })
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    // Fresh + busy confirmed by the authoritative apply, not a monotonic clear.
    expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_1")?.status.type).toBe("busy")
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("an authoritative recovery omission settles the session without a second fetch", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))

    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(true)

    // The session is gone from the snapshot: the recovery fetch already ran
    // authoritatively, so it settles by omission with no escalation fetch.
    respondWithSnapshot = () => Promise.resolve({})
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual([
      "/test/project",
      "/test/project",
    ])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_1")).toBe(false)
    expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(true)
  })

  test("recovery is idempotent once the authoritative fetch clears the flag", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))

    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(true)

    respondWithSnapshot = () => Promise.resolve({ ses_1: { type: "busy" } })
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    const recovered = useGlobalSessionStatusStore.getState().unavailableDirectories
    expect(recovered.has("/test/project")).toBe(false)

    // A repeat success is monotonic and publishes no freshness change.
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories).toBe(recovered)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_1")?.status.type).toBe("busy")
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("freshening one directory leaves another directory's flag untouched", async () => {
    const storeA = createStore({ type: "busy" })
    const storeB = createStore({ type: "busy" })

    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/repo-a", storeA, "ses_1")
    await waitForPollSettled()
    maybePollStatusAfterMessageCompletion("/repo-b", storeB, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)

    respondWithSnapshot = () => Promise.resolve({ ses_1: { type: "busy" } })
    maybePollStatusAfterMessageCompletion("/repo-b", storeB, "ses_1")
    await waitForPollSettled()

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    // /repo-a's failure is untouched by /repo-b's success.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(isSessionStatusFresh("ses_1", "/repo-a")).toBe(false)
    expect(isSessionStatusFresh("ses_1", "/repo-b")).toBe(true)
    expect(storeA.getState().session_status?.ses_1?.type).toBe("busy")
    expect(storeB.getState().session_status?.ses_1?.type).toBe("busy")
  })

  // Barrier: while the authoritative recovery response is in flight the
  // display must stay reconnecting, and the settled result must never pass
  // through a confirmed-busy frame produced by clearing freshness without an
  // authoritative reconcile.
  test("a pending authoritative recovery keeps preserved busy as reconnecting", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))
    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(true)

    let resolveSnapshot!: (snapshot: StatusSnapshot) => void
    respondWithSnapshot = () => new Promise((resolve) => { resolveSnapshot = resolve })

    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let display: ReturnType<typeof useSessionDisplayStatus> | undefined
    const Probe = () => {
      display = useSessionDisplayStatus("ses_1", "/test/project")
      return null
    }

    try {
      await act(async () => { root.render(React.createElement(Probe)) })
      expect(display?.type).toBe("reconnecting")

      maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
      await act(async () => { await waitForPollSettled() })
      expect(statusSnapshotCalls).toHaveLength(2)
      // The recovery result is still pending: never a confirmed spinner.
      expect(display?.type).toBe("reconnecting")

      await act(async () => {
        resolveSnapshot({})
        await sleep(50)
      })

      expect(display?.type).toBe("idle")
      expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(true)
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_1")).toBe(false)
      expect(store.getState().session_status?.ses_1?.type).toBe("idle")
    } finally {
      await act(async () => { root.unmount() })
      dom.restore()
    }
  })

  test("an authoritative recovery confirming busy settles as a confirmed busy", async () => {
    const store = createStore({ type: "busy" })
    applyGlobalSessionStatusEvent("/test/project", busyStatusEvent("ses_1"))
    respondWithSnapshot = () => Promise.resolve(null)
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/test/project")).toBe(true)

    let resolveSnapshot!: (snapshot: StatusSnapshot) => void
    respondWithSnapshot = () => new Promise((resolve) => { resolveSnapshot = resolve })

    const dom = installHookTestDom()
    const root = createRoot(dom.container)
    let display: ReturnType<typeof useSessionDisplayStatus> | undefined
    const Probe = () => {
      display = useSessionDisplayStatus("ses_1", "/test/project")
      return null
    }

    try {
      await act(async () => { root.render(React.createElement(Probe)) })
      expect(display?.type).toBe("reconnecting")

      maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
      await act(async () => { await waitForPollSettled() })
      expect(display?.type).toBe("reconnecting")

      await act(async () => {
        resolveSnapshot({ ses_1: { type: "busy" } })
        await sleep(50)
      })

      // B1 stays fixed: the authoritative confirmation ends reconnecting as a
      // real, confirmed busy rather than leaving it stuck.
      expect(display?.type).toBe("busy")
      expect(isSessionStatusFresh("ses_1", "/test/project")).toBe(true)
      expect(useGlobalSessionStatusStore.getState().statusById.get("ses_1")?.status.type).toBe("busy")
      expect(store.getState().session_status?.ses_1?.type).toBe("busy")
    } finally {
      await act(async () => { root.unmount() })
      dom.restore()
    }
  })
})
