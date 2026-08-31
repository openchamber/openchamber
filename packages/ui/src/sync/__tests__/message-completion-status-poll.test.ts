/**
 * Tests for the deferred status poll fired when an assistant message completes
 * (issue OPE-193): the busy spinner must not linger for up to a full watchdog
 * poll interval after a turn completed when the session.idle event was delayed
 * or lost — and a normal turn, whose session.idle arrives promptly, must not
 * cost a single extra request.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

type StatusSnapshot = Record<string, SessionStatus | undefined>

let respondWithSnapshot: () => Promise<StatusSnapshot | null> = () => Promise.resolve({ ses_1: { type: "idle" } })
const statusSnapshotCalls: string[] = []

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSessionStatusForDirectory: mock((directory: string) => {
      statusSnapshotCalls.push(directory)
      return respondWithSnapshot()
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => "test-runtime",
}))

import { maybePollStatusAfterMessageCompletion, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS } from "../sync-context"

const createStore = (status: SessionStatus): StoreApi<DirectoryStore> => {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    session_status: { ses_1: status },
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

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
})
