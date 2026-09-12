/**
 * Watchdog self-recovery for a directory whose status data is marked
 * unavailable while it has no active candidates (issue #2421 residue): a
 * failed status fetch followed by the session settling via a live
 * `session.idle` left the flag set with nothing left to poll, so
 * `useSessionKnownInactive` stayed false and move-to-worktree stayed disabled
 * for every session in that directory until a reconnect or reload.
 *
 * These tests drive the real `recoverUnavailableDirectoryStatus` scheduling
 * decision and the real authoritative `resyncDirectorySessionStatuses` fetch.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"

type StatusSnapshot = Record<string, SessionStatus | undefined>

let respondWithSnapshot: () => Promise<StatusSnapshot | null> = () => Promise.resolve({})
const statusSnapshotCalls: string[] = []

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSdkClient: () => ({}),
    getSessionStatusForDirectory: mock((directory: string) => {
      statusSnapshotCalls.push(directory)
      return respondWithSnapshot()
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => "test-runtime",
}))

import {
  isDirectoryStatusUnavailable,
  markDirectoryStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from "../global-session-status"
import {
  ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
  recoverUnavailableDirectoryStatus,
} from "../sync-context"

const SESSION_ID = "ses_1"

// SAFETY: The authoritative candidate helper reads only the session `id`.
const idleSessionRecord = { id: SESSION_ID } as State["session"][number]

const createStore = (initial: Partial<State> = {}): StoreApi<DirectoryStore> => (
  create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
)

/** A tick timestamp past the first cadence window. */
const cadenceBoundary = (): number => Date.now() + ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS

describe("recoverUnavailableDirectoryStatus (flagged idle directory)", () => {
  let lastStatusPollAt: Map<string, number>

  beforeEach(() => {
    respondWithSnapshot = () => Promise.resolve({})
    statusSnapshotCalls.length = 0
    resetGlobalSessionStatus()
    lastStatusPollAt = new Map()
  })

  test("runs one authoritative recovery fetch on the cadence with zero active candidates", async () => {
    const store = createStore({ session: [idleSessionRecord] })
    markDirectoryStatusUnavailable("/repo")

    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, cadenceBoundary())

    expect(statusSnapshotCalls).toEqual(["/repo"])
    expect(lastStatusPollAt.has("/repo")).toBe(true)
    // The successful snapshot clears the flag; a genuinely idle directory is
    // settled by omission in authoritative mode.
    expect(isDirectoryStatusUnavailable("/repo")).toBe(false)
    expect(store.getState().session_status[SESSION_ID]?.type).toBe("idle")
  })

  test("stops recovery once the successful fetch clears the flag", async () => {
    const store = createStore({ session: [idleSessionRecord] })
    markDirectoryStatusUnavailable("/repo")

    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, cadenceBoundary())
    expect(statusSnapshotCalls).toEqual(["/repo"])

    // Next watchdog tick: unflagged, so the recovery path is a no-op.
    await recoverUnavailableDirectoryStatus(
      "/repo",
      store,
      lastStatusPollAt,
      cadenceBoundary() + ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
    )
    expect(statusSnapshotCalls).toEqual(["/repo"])
  })

  test("keeps the flag and retries at most once per cadence window when the fetch fails", async () => {
    const store = createStore({ session: [idleSessionRecord] })
    markDirectoryStatusUnavailable("/repo")
    respondWithSnapshot = () => Promise.resolve(null)

    const firstTick = cadenceBoundary()
    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, firstTick)
    expect(statusSnapshotCalls).toEqual(["/repo"])
    expect(isDirectoryStatusUnavailable("/repo")).toBe(true)

    // Inside the window: no retry storm.
    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, firstTick + 1)
    expect(statusSnapshotCalls).toEqual(["/repo"])
    expect(isDirectoryStatusUnavailable("/repo")).toBe(true)

    // Next window: exactly one more attempt.
    await recoverUnavailableDirectoryStatus(
      "/repo",
      store,
      lastStatusPollAt,
      firstTick + ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
    )
    expect(statusSnapshotCalls).toEqual(["/repo", "/repo"])
    expect(isDirectoryStatusUnavailable("/repo")).toBe(true)
  })

  test("does not fetch for an unflagged idle directory", async () => {
    const store = createStore({ session: [idleSessionRecord] })

    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, cadenceBoundary())

    expect(statusSnapshotCalls).toEqual([])
    expect(lastStatusPollAt.size).toBe(0)
  })

  test("an authoritative recovery fetch seeds a missed busy status into both live owners", async () => {
    const store = createStore({ session: [idleSessionRecord] })
    markDirectoryStatusUnavailable("/repo")
    respondWithSnapshot = () => Promise.resolve({ [SESSION_ID]: { type: "busy" } })

    await recoverUnavailableDirectoryStatus("/repo", store, lastStatusPollAt, cadenceBoundary())

    // A missed busy status lands in the child store and the global index, and
    // the directory is fresh again.
    expect(store.getState().session_status[SESSION_ID]?.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get(SESSION_ID)?.status.type).toBe("busy")
    expect(isDirectoryStatusUnavailable("/repo")).toBe(false)
  })
})
