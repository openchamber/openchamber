import { beforeEach, describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  applySessionStatusSnapshot,
  markDirectorySessionStatusesUnavailable,
  needsSnapshotAfterStatusPoll,
  reconcileDirectorySessionStatusSnapshot,
  shouldTriggerStaleResync,
} from "../sync-context"
import {
  applyGlobalSessionStatusEvent,
  isSessionStatusFresh,
  markTransportStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from "../global-session-status"
import { resetSessionOrdering } from "../session-ordering"

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function streamingMessage() {
  // Trailing assistant message with no `time.completed` → actively streaming.
  return [{ id: "msg_1", role: "assistant", time: { created: 1 } }] as unknown as State["message"][string]
}

function completedMessage() {
  return [{ id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } }] as unknown as State["message"][string]
}

const BUSY: SessionStatus = { type: "busy" }

describe("applySessionStatusSnapshot", () => {
  beforeEach(() => {
    resetGlobalSessionStatus()
    resetSessionOrdering()
  })

  describe("monotonic mode (periodic poll)", () => {
    test("does NOT lower a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "monotonic")
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("does NOT lower a busy session even when the snapshot reports it idle", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      applySessionStatusSnapshot(store, { ses_a: { type: "idle" } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("raises an idle/unknown session to busy when the snapshot reports it active (missed event)", () => {
      const store = createDirectoryStore({ session_status: {} })
      const changed = applySessionStatusSnapshot(store, { ses_a: { type: "busy" } }, ["ses_a"], "monotonic")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("updates busy → retry from the snapshot", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const retry: SessionStatus = { type: "retry", attempt: 2, message: "x", next: 30 }
      applySessionStatusSnapshot(store, { ses_a: { type: "retry", attempt: 2, message: "x", next: 30 } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(retry)
    })
  })

  describe("authoritative mode (reconnect / escalated resync)", () => {
    test("lowers a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: completedMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("snapshot is the source of truth: lowers to idle even if the trailing message looks unfinished", () => {
      // The live /session/status snapshot wins over derived message state — a
      // stale/lost message.updated must never pin a session busy after the
      // server says idle. (Recovery from a missed idle event.)
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: streamingMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("reconciles the child store and global live index together", () => {
      const store = createDirectoryStore({
        session: [{ id: "ses_a" } as State["session"][number]],
        session_status: { ses_a: BUSY },
      })
      applyGlobalSessionStatusEvent("/repo", {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      } as never)

      reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")

      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
    })

    test("does not treat unavailable OpenCode as an empty snapshot: preserves last known status and marks unavailable", () => {
      const messages = streamingMessage()
      const store = createDirectoryStore({
        session: [{ id: "ses_a" } as State["session"][number]],
        session_status: { ses_a: BUSY },
        message: { ses_a: messages },
      })
      applyGlobalSessionStatusEvent("/repo", {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      } as never)

      const changed = markDirectorySessionStatusesUnavailable("/repo")

      // A transient unavailability must NOT lower busy to idle and must NOT
      // destroy the global live index. Status data is preserved as last known;
      // only the directory-scoped freshness flag flips so consumers can show
      // "reconnecting".
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
      expect(store.getState().message.ses_a).toBe(messages)
      expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
      expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
      expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
    })

    test("replacement followed by a new runtime's empty snapshot cannot retain old busy state", () => {
      const store = createDirectoryStore({
        session: [{ id: "ses_a" } as State["session"][number]],
        session_status: { ses_a: BUSY },
      })
      applyGlobalSessionStatusEvent("/repo", {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      } as never)

      // A real runtime replacement destroys stale data and blocks old events
      // (issue #2421). resetGlobalSessionStatus clears the index and resets
      // both freshness flags (a clean reset, not a transient failure).
      resetGlobalSessionStatus({ blockEventUpdates: true })
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
      expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)
      expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
      expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)

      // The new runtime's authoritative empty snapshot lowers the child store
      // to idle and re-enables event updates.
      reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")

      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
      expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(true)
      expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
    })
  })
})

describe("needsSnapshotAfterStatusPoll", () => {
  test("escalates when the store says busy but the snapshot omits it", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: completedMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("escalates regardless of a still-streaming trailing message (snapshot drives recovery)", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: streamingMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("does NOT escalate when the snapshot confirms the session is active", () => {
    const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", { type: "busy" })).toBe(false)
  })

  test("does NOT escalate when the store already considers the session idle", () => {
    const store = createDirectoryStore({ session_status: {} })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(false)
  })
})

describe("shouldTriggerStaleResync", () => {
  const STALE_MS = 20_000
  const COOLDOWN_MS = 15_000

  test("does NOT trigger when heartbeats are recent (quiet-but-connected session)", () => {
    // 5s ago a heartbeat arrived — stream is alive even though no meaningful
    // events came through. This is the core fix for issue #1656.
    const now = 100_000
    const lastStreamActivityAt = now - 5_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("does NOT trigger when a non-heartbeat event is recent", () => {
    const now = 100_000
    const lastStreamActivityAt = now - 3_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when no events at all (including heartbeats) for the stale threshold", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when within the resync cooldown even if stream is stale", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - 5_000 // only 5s ago, cooldown is 15s
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when stream is stale AND cooldown has elapsed", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - COOLDOWN_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when no events have been received yet (lastStreamActivityAt is 0)", () => {
    // Prevents firing before the first heartbeat arrives
    expect(shouldTriggerStaleResync(0, 0, 100_000, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("uses default thresholds when omitted", () => {
    const now = 100_000
    // 25s since last activity (> 20s default), 20s since last resync (> 15s default)
    expect(shouldTriggerStaleResync(now - 25_000, now - 20_000, now)).toBe(true)
    // 10s since last activity (< 20s default)
    expect(shouldTriggerStaleResync(now - 10_000, 0, now)).toBe(false)
  })
})

// Regression tests for issue #2421 / PR #2485: transient unavailability
// (null watchdog fetch, SSE disconnect, transport switch) must preserve last
// known busy/retry status and mark it unavailable, NOT lower it to idle.
//
// Freshness is directory-scoped: a failed fetch for `/repo-a` marks only
// `/repo-a` unavailable. A transport-wide disconnect/switch marks all
// directories unavailable via `markTransportStatusUnavailable`.
describe("transient unavailability preserves busy/retry status (unknown != idle)", () => {
  beforeEach(() => {
    resetGlobalSessionStatus()
    resetSessionOrdering()
  })

  function busyStore() {
    return createDirectoryStore({
      session: [{ id: "ses_a" } as State["session"][number]],
      session_status: { ses_a: BUSY },
      message: { ses_a: streamingMessage() },
    })
  }

  function seedGlobalBusy() {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    } as never)
  }

  test("busy + one failed/null watchdog status fetch → status preserved, directory marked unavailable", () => {
    const store = busyStore()
    seedGlobalBusy()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)

    // Watchdog null-fetch path (resyncDirectorySessionStatuses calls this).
    const changed = markDirectorySessionStatusesUnavailable("/repo")

    expect(changed).toBe(false)
    // Child store: busy preserved, NOT lowered to idle.
    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    // Global index: busy preserved, NOT destroyed.
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    // Directory-scoped freshness flag set; transport flag untouched.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
  })

  test("busy + repeated failed/null status fetches → status preserved, flag stays set", () => {
    const store = busyStore()
    seedGlobalBusy()

    markDirectorySessionStatusesUnavailable("/repo")
    markDirectorySessionStatusesUnavailable("/repo")
    markDirectorySessionStatusesUnavailable("/repo")

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
  })

  test("busy + transient SSE disconnect (transport-wide) → status preserved, NOT idle, all directories stale", () => {
    const store = busyStore()
    seedGlobalBusy()

    // onDisconnect path marks the transport unavailable without destroying data.
    markTransportStatusUnavailable()

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)
    expect(isSessionStatusFresh("ses_a")).toBe(false)
  })

  test("busy + transport switch (transport-wide) → status preserved, NOT idle, all directories stale", () => {
    const store = busyStore()
    seedGlobalBusy()

    // onTransportSwitch path marks the transport unavailable without destroying data.
    markTransportStatusUnavailable()

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)
  })

  test("successful authoritative {} after reconnect → idle applied, directory flag cleared", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable("/repo")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)

    // Reconnect brings a fresh authoritative empty snapshot.
    const changed = reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")

    expect(changed).toBe(true)
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("successful authoritative busy snapshot after reconnect → busy applied, flag cleared", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable("/repo")

    reconcileDirectorySessionStatusSnapshot(
      "/repo", store, { ses_a: { type: "busy" } }, ["ses_a"], "authoritative",
    )

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("monotonic poll after unavailability does NOT lower busy to idle (escalation still applies)", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable("/repo")

    // A monotonic poll (the watchdog's default) never lowers busy to idle from
    // omission; it would escalate via needsSnapshotAfterStatusPoll instead.
    const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "monotonic")

    expect(changed).toBe(false)
    expect(store.getState().session_status.ses_a).toEqual(BUSY)
  })

  test("real runtime replacement (resetGlobalSessionStatus) clears stale data and blocks events", () => {
    const store = busyStore()
    seedGlobalBusy()

    // Real runtime replacement: stale activity from the old runtime must NOT
    // be presented as current (issue #2421).
    resetGlobalSessionStatus({ blockEventUpdates: true })

    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)

    // A stale status event from the old runtime is blocked.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    } as never)
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)

    // The new runtime's authoritative snapshot re-enables events.
    reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("markDirectorySessionStatusesUnavailable does not touch the child store's session_status map", () => {
    const store = createDirectoryStore({
      session: [{ id: "ses_a" } as State["session"][number]],
      session_status: { ses_a: BUSY, ses_b: { type: "retry", attempt: 1, message: "x", next: 5 } },
    })
    const before = { ...store.getState().session_status }

    markDirectorySessionStatusesUnavailable("/repo")

    // The child store's status map is byte-for-byte preserved.
    expect(store.getState().session_status).toEqual(before)
  })
})

// Directory-scoped freshness: a failed fetch for one directory must not mark
// another directory unavailable, and a successful snapshot for one directory
// must not clear another directory's unavailable flag. Completion order across
// concurrent per-directory resyncs must not affect the final state.
describe("directory-scoped unavailability (per-directory isolation)", () => {
  beforeEach(() => {
    resetGlobalSessionStatus()
    resetSessionOrdering()
  })

  function busyStoreFor(directory: string, sessionId: string) {
    return createDirectoryStore({
      session: [{ id: sessionId } as State["session"][number]],
      session_status: { [sessionId]: BUSY },
      message: { [sessionId]: streamingMessage() },
    })
  }

  function seedGlobalBusyFor(directory: string, sessionId: string) {
    applyGlobalSessionStatusEvent(directory, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "busy" } },
    } as never)
  }

  test("a failed fetch for /repo-a marks only /repo-a unavailable, not /repo-b", () => {
    seedGlobalBusyFor("/repo-a", "ses_a")
    seedGlobalBusyFor("/repo-b", "ses_b")

    markDirectorySessionStatusesUnavailable("/repo-a")

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    // /repo-b is NOT marked unavailable by /repo-a's failure.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    expect(isSessionStatusFresh("ses_a")).toBe(false)
    expect(isSessionStatusFresh("ses_b")).toBe(true)
  })

  test("a successful snapshot for /repo-b does NOT clear /repo-a's unavailable flag", () => {
    const storeB = busyStoreFor("/repo-b", "ses_b")
    seedGlobalBusyFor("/repo-a", "ses_a")
    seedGlobalBusyFor("/repo-b", "ses_b")
    markDirectorySessionStatusesUnavailable("/repo-a")
    markDirectorySessionStatusesUnavailable("/repo-b")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)

    // A fresh snapshot for /repo-b only clears /repo-b.
    reconcileDirectorySessionStatusSnapshot("/repo-b", storeB, {}, ["ses_b"], "authoritative")

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    // /repo-a stays unavailable — a concurrent success in another directory
    // must not freshen this directory's stale data.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
  })

  test("unavailableDirectories is a Set of normalized directory paths", () => {
    // Trailing slashes normalize away, so "/repo-a/" and "/repo-a" map to one entry.
    markDirectorySessionStatusesUnavailable("/repo-a/")
    markDirectorySessionStatusesUnavailable("/repo-b")
    const dirs = useGlobalSessionStatusStore.getState().unavailableDirectories
    expect(dirs.has("/repo-a")).toBe(true)
    expect(dirs.has("/repo-b")).toBe(true)
    expect(dirs.size).toBe(2)
  })

  // Multi-directory race: completion order must not matter. Whether A fails
  // first or B succeeds first, A is reconnecting and B is fresh idle.
  test("completion order does not matter: A fails, B succeeds → A reconnecting, B fresh idle", () => {
    const storeA = busyStoreFor("/repo-a", "ses_a")
    const storeB = busyStoreFor("/repo-b", "ses_b")
    seedGlobalBusyFor("/repo-a", "ses_a")
    // B is idle per its snapshot (no busy seed beyond the store default; clear it).
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.idle",
      properties: { sessionID: "ses_b" },
    } as never)

    // A's fetch fails first, then B's fetch succeeds.
    markDirectorySessionStatusesUnavailable("/repo-a")
    reconcileDirectorySessionStatusSnapshot("/repo-b", storeB, {}, ["ses_b"], "authoritative")

    // A: unavailable + preserved busy → reconnecting (not fresh).
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status.type).toBe("busy")
    expect(isSessionStatusFresh("ses_a")).toBe(false)
    // B: fresh + idle.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_b")).toBe(false)
    expect(isSessionStatusFresh("ses_b")).toBe(true)
    // A's store is untouched by B's success.
    expect(storeA.getState().session_status.ses_a).toEqual(BUSY)
  })

  test("completion order does not matter: B succeeds, A fails → same result (A reconnecting, B fresh idle)", () => {
    const storeA = busyStoreFor("/repo-a", "ses_a")
    const storeB = busyStoreFor("/repo-b", "ses_b")
    seedGlobalBusyFor("/repo-a", "ses_a")
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.idle",
      properties: { sessionID: "ses_b" },
    } as never)

    // B's fetch succeeds first, then A's fetch fails.
    reconcileDirectorySessionStatusSnapshot("/repo-b", storeB, {}, ["ses_b"], "authoritative")
    markDirectorySessionStatusesUnavailable("/repo-a")

    // Same final state as the opposite completion order.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status.type).toBe("busy")
    expect(isSessionStatusFresh("ses_a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_b")).toBe(false)
    expect(isSessionStatusFresh("ses_b")).toBe(true)
    expect(storeA.getState().session_status.ses_a).toEqual(BUSY)
  })

  test("both unavailable, then a successful snapshot for A → A fresh, B still unavailable", () => {
    const storeA = busyStoreFor("/repo-a", "ses_a")
    seedGlobalBusyFor("/repo-a", "ses_a")
    seedGlobalBusyFor("/repo-b", "ses_b")
    markDirectorySessionStatusesUnavailable("/repo-a")
    markDirectorySessionStatusesUnavailable("/repo-b")

    // A's reconnect succeeds with a busy snapshot; B is still down.
    reconcileDirectorySessionStatusSnapshot("/repo-a", storeA, { ses_a: { type: "busy" } }, ["ses_a"], "authoritative")

    // A: freshened by its own snapshot.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(false)
    expect(isSessionStatusFresh("ses_a")).toBe(true)
    // B: still unavailable — A's success did not freshen B.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)
    expect(isSessionStatusFresh("ses_b")).toBe(false)
  })

  test("transport-wide unavailable, then per-directory snapshots freshen each directory independently", () => {
    const storeA = busyStoreFor("/repo-a", "ses_a")
    const storeB = busyStoreFor("/repo-b", "ses_b")
    seedGlobalBusyFor("/repo-a", "ses_a")
    seedGlobalBusyFor("/repo-b", "ses_b")
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)
    expect(isSessionStatusFresh("ses_a")).toBe(false)
    expect(isSessionStatusFresh("ses_b")).toBe(false)

    // A's snapshot arrives first: A is fresh, B is still stale (transport flag
    // cleared by A's snapshot, but B's own directory flag is set by nothing
    // here — transport freshness is restored per-directory by each snapshot).
    reconcileDirectorySessionStatusSnapshot("/repo-a", storeA, { ses_a: { type: "busy" } }, ["ses_a"], "authoritative")
    expect(isSessionStatusFresh("ses_a")).toBe(true)
    // B has no entry in unavailableDirectories and transportUnavailable was
    // cleared by A's snapshot, so B is now fresh too (its preserved busy is
    // confirmed). This matches the store contract: the first snapshot after a
    // transport event clears transportUnavailable; each directory's own
    // unavailableDirectories entry (if any) is cleared by its own snapshot.
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)

    // B's snapshot arrives and confirms busy.
    reconcileDirectorySessionStatusSnapshot("/repo-b", storeB, { ses_b: { type: "busy" } }, ["ses_b"], "authoritative")
    expect(isSessionStatusFresh("ses_b")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_b")?.status.type).toBe("busy")
  })
})
