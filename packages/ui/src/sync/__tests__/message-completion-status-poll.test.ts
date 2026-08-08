/**
 * Tests for the immediate status poll fired when an assistant message
 * completes (issue OPE-193, B1): the busy spinner must not linger for up to a
 * full watchdog poll interval after a turn completed when the session.idle
 * event was delayed or lost.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

type StatusSnapshot = Record<string, SessionStatus | undefined>

let statusSnapshotResult: StatusSnapshot | null = { ses_1: { type: "idle" } }
let statusSnapshotErrors = 0
const statusSnapshotCalls: string[] = []

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSessionStatusForDirectory: mock((directory: string) => {
      statusSnapshotCalls.push(directory)
      if (statusSnapshotErrors > 0) {
        statusSnapshotErrors -= 1
        return Promise.resolve(null)
      }
      return Promise.resolve(statusSnapshotResult)
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => "test-runtime",
}))

import { maybePollStatusAfterMessageCompletion } from "../sync-context"

const createStore = (status: SessionStatus | undefined): StoreApi<DirectoryStore> => {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...(status ? { session_status: { ses_1: status } } : {}),
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

const waitForPollSettled = async (): Promise<void> => {
  // The helper runs under the background-network concurrency gate; give the
  // task chain (and any promise-based snapshot) real time to finish.
  await new Promise((resolve) => setTimeout(resolve, 25))
  await new Promise((resolve) => setTimeout(resolve, 25))
}

describe("maybePollStatusAfterMessageCompletion (issue OPE-193)", () => {
  beforeEach(() => {
    statusSnapshotResult = { ses_1: { type: "idle" } }
    statusSnapshotErrors = 0
    statusSnapshotCalls.length = 0
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

  test("settles a busy session to idle immediately when the snapshot omits it", async () => {
    const store = createStore({ type: "busy" })

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual(["/test/project", "/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
  })

  test("keeps the session busy when the snapshot confirms it is still active", async () => {
    const store = createStore({ type: "busy" })
    statusSnapshotResult = { ses_1: { type: "busy" } }

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    // Monotonic poll confirms busy; the snapshot is not idle, so no
    // authoritative escalation runs.
    expect(statusSnapshotCalls).toEqual(["/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("preserves the busy status when the status fetch fails", async () => {
    const store = createStore({ type: "busy" })
    statusSnapshotErrors = 1

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual(["/test/project"])
    // Failure is not treated as authoritative empty: the busy status stays
    // until the watchdog poll (or a live event) corrects it.
    expect(store.getState().session_status?.ses_1?.type).toBe("busy")
  })

  test("deduplicates concurrent polls for the same directory", async () => {
    const store = createStore({ type: "busy" })
    statusSnapshotResult = new Promise((resolve) => {
      setTimeout(() => resolve({ ses_1: { type: "idle" } }), 10)
    }) as unknown as StatusSnapshot

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    await waitForPollSettled()

    expect(statusSnapshotCalls).toEqual(["/test/project", "/test/project"])
  })

  test("does not poll again while a previous poll for the directory is in flight", async () => {
    const store = createStore({ type: "busy" })
    let release: () => void = () => {}
    statusSnapshotResult = new Promise((resolve) => {
      release = () => resolve({ ses_1: { type: "idle" } })
    }) as unknown as StatusSnapshot

    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    maybePollStatusAfterMessageCompletion("/test/project", store, "ses_1")
    release()
    await waitForPollSettled()

    // First call ran the poll; the second call was deduped by the in-flight
    // guard. The escalation (second fetch) is the authoritative resync.
    expect(statusSnapshotCalls).toEqual(["/test/project", "/test/project"])
    expect(store.getState().session_status?.ses_1?.type).toBe("idle")
  })
})
