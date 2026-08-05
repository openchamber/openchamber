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

      const changed = markDirectorySessionStatusesUnavailable()

      // A transient unavailability must NOT lower busy to idle and must NOT
      // destroy the global live index. Status data is preserved as last known;
      // only the freshness flag flips so consumers can show "reconnecting".
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
      expect(store.getState().message.ses_a).toBe(messages)
      expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
      expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
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
      // the freshness flag (a clean reset, not a transient failure).
      resetGlobalSessionStatus({ blockEventUpdates: true })
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
      expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
      expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)

      // The new runtime's authoritative empty snapshot lowers the child store
      // to idle and re-enables event updates, clearing the unavailability flag.
      reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")

      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
      expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
      expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(true)
      expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
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

  test("busy + one failed/null watchdog status fetch → status preserved, unavailable flag set", () => {
    const store = busyStore()
    seedGlobalBusy()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)

    // Watchdog null-fetch path (resyncDirectorySessionStatuses calls this).
    const changed = markDirectorySessionStatusesUnavailable()

    expect(changed).toBe(false)
    // Child store: busy preserved, NOT lowered to idle.
    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    // Global index: busy preserved, NOT destroyed.
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    // Freshness flag set.
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("busy + repeated failed/null status fetches → status preserved, flag stays set", () => {
    const store = busyStore()
    seedGlobalBusy()

    markDirectorySessionStatusesUnavailable()
    markDirectorySessionStatusesUnavailable()
    markDirectorySessionStatusesUnavailable()

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("busy + transient SSE disconnect (markDirectorySessionStatusesUnavailable) → status preserved, NOT idle", () => {
    const store = busyStore()
    seedGlobalBusy()

    // onDisconnect path marks unavailable without destroying data.
    markDirectorySessionStatusesUnavailable()

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("busy + transport switch (markDirectorySessionStatusesUnavailable) → status preserved, NOT idle", () => {
    const store = busyStore()
    seedGlobalBusy()

    // onTransportSwitch path marks unavailable without destroying data.
    markDirectorySessionStatusesUnavailable()

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("successful authoritative {} after reconnect → idle applied, unavailable flag cleared", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)

    // Reconnect brings a fresh authoritative empty snapshot.
    const changed = reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")

    expect(changed).toBe(true)
    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("successful authoritative busy snapshot after reconnect → busy applied, flag cleared", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable()

    reconcileDirectorySessionStatusSnapshot(
      "/repo", store, { ses_a: { type: "busy" } }, ["ses_a"], "authoritative",
    )

    expect(store.getState().session_status.ses_a).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_a")?.status).toEqual(BUSY)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("monotonic poll after unavailability does NOT lower busy to idle (escalation still applies)", () => {
    const store = busyStore()
    seedGlobalBusy()
    markDirectorySessionStatusesUnavailable()

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
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)

    // A stale status event from the old runtime is blocked.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    } as never)
    expect(useGlobalSessionStatusStore.getState().statusById.has("ses_a")).toBe(false)

    // The new runtime's authoritative snapshot re-enables events.
    reconcileDirectorySessionStatusSnapshot("/repo", store, {}, ["ses_a"], "authoritative")
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(true)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("markDirectorySessionStatusesUnavailable does not touch the child store's session_status map", () => {
    const store = createDirectoryStore({
      session: [{ id: "ses_a" } as State["session"][number]],
      session_status: { ses_a: BUSY, ses_b: { type: "retry", attempt: 1, message: "x", next: 5 } },
    })
    const before = { ...store.getState().session_status }

    markDirectorySessionStatusesUnavailable()

    // The child store's status map is byte-for-byte preserved.
    expect(store.getState().session_status).toEqual(before)
  })
})
