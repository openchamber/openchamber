import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  areGlobalSessionStatusEventsEnabled,
  isSessionStatusFresh,
  markDirectoryStatusUnavailable,
  markTransportStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
  replaceGlobalSessionStatusById,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"
import { resetSessionActivityTiming, useSessionActivityTimingStore } from "./session-activity-timing"

beforeEach(() => {
  resetGlobalSessionStatus()
  resetSessionOrdering()
  resetSessionActivityTiming()
})

describe("global session status index", () => {
  const activeSessionIds = (): ReadonlySet<string> => useGlobalSessionStatusStore.getState().activeSessionIds

  test("preserves full retry status details from live events", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: {
        sessionID: "session-a",
        status: { type: "retry", attempt: 2, message: "waiting" },
      },
    } as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status).toEqual({
      type: "retry",
      attempt: 2,
      message: "waiting",
    })
  })

  test("keeps active membership stable across active status detail and directory updates", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const before = activeSessionIds()

    applyGlobalSessionStatusEvent("/other-repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 2, message: "waiting" } },
    } as Event)

    expect(activeSessionIds()).toBe(before)
  })

  test("replaces active membership only when a session becomes idle or active", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as Event)
    const idle = activeSessionIds()
    expect(idle).not.toBe(active)
    expect(idle?.has("session-a")).toBe(false)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(activeSessionIds()).not.toBe(idle)
    expect(activeSessionIds()?.has("session-a")).toBe(true)
  })

  test("removes deleted sessions from active membership", () => {
    // SAFETY: This fixture matches the SDK event shape consumed by the status event reducer.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "session-a" },
    } as Event)

    expect(activeSessionIds()).not.toBe(active)
    expect(activeSessionIds().has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
  })

  test("promotes on active and settled lifecycle edges only", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    const busyRank = useSessionOrderingStore.getState().rankById.get("session-a")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 1, message: "wait", next: 1 } },
    } as Event)
    expect(useSessionOrderingStore.getState().rankById.get("session-a")).toBe(busyRank)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as Event)
    const idleRank = useSessionOrderingStore.getState().rankById.get("session-a")
    expect(idleRank).toBeGreaterThan(busyRank ?? 0)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.error",
      properties: { sessionID: "session-a" },
    } as Event)
    expect(useSessionOrderingStore.getState().rankById.get("session-a")).toBe(idleRank)
  })

  test("authoritative snapshots clear absent active entries for their directory", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])
    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
  })

  test("keeps active membership stable for snapshots with the same active IDs", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    const before = activeSessionIds()

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry" },
    }, ["session-a"])

    expect(activeSessionIds()).toBe(before)
  })

  test("updates active membership when a snapshot adds and removes IDs", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    const before = activeSessionIds()

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "busy" },
      "session-b": { type: "busy" },
    }, ["session-a", "session-b"])
    const added = activeSessionIds()
    expect(added).not.toBe(before)
    expect(added?.has("session-a")).toBe(true)
    expect(added?.has("session-b")).toBe(true)

    applyGlobalSessionStatusSnapshot("/repo", { "session-b": { type: "busy" } }, ["session-a", "session-b"])
    const removed = activeSessionIds()
    expect(removed).not.toBe(added)
    expect(removed?.has("session-a")).toBe(false)
    expect(removed?.has("session-b")).toBe(true)
  })

  test("clears active membership when a runtime reset replaces status state", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    replaceGlobalSessionStatusById(new Map())

    expect(activeSessionIds()?.size).toBe(0)
  })

  test("clears an explicitly idle known session when directory aliases differ", () => {
    applyGlobalSessionStatusSnapshot("/canonical/repo", { "session-a": { type: "busy" } }, ["session-a"])

    applyGlobalSessionStatusSnapshot("/alias/repo", { "session-a": { type: "idle" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
  })

  test("publishes status, ordering, and timing once for a large event batch", () => {
    let statusPublications = 0
    let orderingPublications = 0
    let timingPublications = 0
    const unsubscribeStatus = useGlobalSessionStatusStore.subscribe(() => { statusPublications += 1 })
    const unsubscribeOrdering = useSessionOrderingStore.subscribe(() => { orderingPublications += 1 })
    const unsubscribeTiming = useSessionActivityTimingStore.subscribe(() => { timingPublications += 1 })
    const events = Array.from({ length: 1_000 }, (_, index) => ({
      type: "session.status",
      properties: { sessionID: `session-${index}`, status: { type: "busy" } },
    } as Event))

    applyGlobalSessionStatusEvents("/repo", events)

    unsubscribeStatus()
    unsubscribeOrdering()
    unsubscribeTiming()
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.size).toBe(1_000)
    expect(statusPublications).toBe(1)
    expect(orderingPublications).toBe(1)
    expect(timingPublications).toBe(1)
  })

  test("keeps lifecycle event order inside a batch", () => {
    applyGlobalSessionStatusEvents("/repo", [
      {
        type: "session.status",
        properties: { sessionID: "session-a", status: { type: "busy" } },
      } as Event,
      {
        type: "session.deleted",
        properties: { sessionID: "session-a" },
      } as Event,
    ])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
    expect(useSessionActivityTimingStore.getState().startedAt.has("session-a")).toBe(false)
  })

  test("blocks old status events across a runtime boundary until a new snapshot arrives", () => {
    resetGlobalSessionStatus({ blockEventUpdates: true })
    expect(areGlobalSessionStatusEventsEnabled()).toBe(false)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)

    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])
    expect(areGlobalSessionStatusEventsEnabled()).toBe(true)
  })
})

// Regression tests for issue #2421 / PR #2485: a transient unavailability
// (null status fetch, disconnect, transport switch) must preserve last known
// status data and model unavailability as a directory-scoped freshness flag,
// NOT as idle. unknown/unavailable != idle.
//
// Freshness is directory-scoped: a failed fetch for `/repo-a` marks only
// `/repo-a` unavailable, so a concurrent successful snapshot for `/repo-b`
// cannot make `/repo-a`'s preserved busy/retry entries appear fresh again.
// A transport-wide disconnect/switch (`markTransportStatusUnavailable`) marks
// every directory stale; each directory is freshened individually by its next
// successful authoritative snapshot.
describe("directory-scoped unavailability preserves status data", () => {
  test("initial state is fresh (no unavailable directories)", () => {
    const state = useGlobalSessionStatusStore.getState()
    expect(state.unavailableDirectories.size).toBe(0)
  })

  test("markDirectoryStatusUnavailable preserves status data and marks only that directory", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")

    markDirectoryStatusUnavailable("/repo")

    // Status data preserved, not destroyed; only /repo marked unavailable.
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
    // A different directory is NOT marked unavailable by a /repo failure.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/other")).toBe(false)
  })

  test("markTransportStatusUnavailable adds every known directory to unavailableDirectories", () => {
    // With no active statusById entries and no knownDirectories, nothing is
    // added. The transport-wide flag is now modelled as the per-directory set
    // containing every known directory, NOT as a separate boolean.
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)

    applyGlobalSessionStatusEvent("/repo-a", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.status",
      properties: { sessionID: "session-b", status: { type: "busy" } },
    } as Event)

    markTransportStatusUnavailable()
    // Every directory that has a statusById entry is now unavailable.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(2)
  })

  test("markTransportStatusUnavailable accepts knownDirectories for idle-only directories", () => {
    // A directory with only idle sessions has no statusById entry; pass it via
    // knownDirectories so its freshness can still be determined.
    markTransportStatusUnavailable(["/repo-idle"])
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-idle")).toBe(true)
  })

  test("markTransportStatusUnavailable is idempotent", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    markTransportStatusUnavailable()
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(1)
  })

  test("markDirectoryStatusUnavailable is idempotent for the same directory", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    markDirectoryStatusUnavailable("/repo")
    markDirectoryStatusUnavailable("/repo")
    markDirectoryStatusUnavailable("/repo")

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
    // Set stays a single entry.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(1)
  })

  test("a successful authoritative empty snapshot clears only that directory's flag and lowers to idle", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)

    // Reconnect brings a fresh authoritative empty snapshot: idle is applied,
    // and only /repo's unavailability flag is cleared.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("a successful authoritative busy snapshot after reconnect clears the directory flag and applies busy", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)

    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("a retry snapshot after reconnect preserves full retry details and clears the directory flag", () => {
    markDirectoryStatusUnavailable("/repo")

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry", attempt: 3, message: "backing off", next: 45 },
    } as Record<string, { type?: string }>, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status).toEqual({
      type: "retry", attempt: 3, message: "backing off", next: 45,
    })
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("a snapshot that changes nothing still clears an existing directory unavailability flag", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    markDirectoryStatusUnavailable("/repo")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)

    // Same busy snapshot re-applied: data unchanged, but freshness restored.
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("a successful snapshot for /repo-b does NOT clear /repo-a from unavailableDirectories (directory scoping)", () => {
    markDirectoryStatusUnavailable("/repo-a")
    markDirectoryStatusUnavailable("/repo-b")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)

    // A fresh snapshot for /repo-b only clears /repo-b.
    applyGlobalSessionStatusSnapshot("/repo-b", {}, [])

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(false)
    // /repo-a stays unavailable — a concurrent success in another directory
    // must not freshen this directory's stale data.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
  })

  test("transport-wide marks all known directories; a successful snapshot clears only that directory", () => {
    // After a transport-wide event, every known directory is in
    // unavailableDirectories. A successful snapshot for one directory clears
    // only that directory; the others remain unavailable until their own
    // snapshots arrive.
    applyGlobalSessionStatusSnapshot("/repo-a", { "session-a": { type: "busy" } }, ["session-a"])
    applyGlobalSessionStatusSnapshot("/repo-b", { "session-b": { type: "busy" } }, ["session-b"])

    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)

    // /repo-a's reconnect succeeds first.
    applyGlobalSessionStatusSnapshot("/repo-a", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-a")).toBe(false)
    // /repo-b stays unavailable — A's success does not freshen B.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo-b")).toBe(true)
  })

  test("resetGlobalSessionStatus clears data, blocks events, and clears unavailableDirectories (real runtime replacement)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    markTransportStatusUnavailable(["/repo"])

    // Real runtime replacement: destroy stale data, block events, clean reset.
    resetGlobalSessionStatus({ blockEventUpdates: true })

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)
  })

  test("events are still applied while a directory is unavailable (flag is freshness, not a gate)", () => {
    // The unavailable flag is a freshness signal, not an event gate. A live busy
    // event arriving during a transient outage still updates the index; the
    // flag just tells consumers the last *fetch* was stale.
    markDirectoryStatusUnavailable("/repo")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
  })

  test("unavailableDirectories is a Set of normalized directory paths", () => {
    // Trailing slashes normalize away, so "/repo/" and "/repo" map to one entry.
    markDirectoryStatusUnavailable("/repo/")
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(true)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(1)
  })
})

// isSessionStatusFresh: directory-scoped freshness predicate used by the
// control path (`useSessionKnownInactive`). A failed fetch for `/repo-a` does
// not make `/repo-b`'s status stale; a transport-wide event marks all stale.
describe("isSessionStatusFresh (directory-scoped freshness)", () => {
  test("returns true for a session whose directory is fresh", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(true)
  })

  test("returns true for an unknown session in a fresh directory (no preserved data → nothing stale)", () => {
    expect(isSessionStatusFresh("never-seen", "/repo")).toBe(true)
  })

  test("returns false when the session's directory is in unavailableDirectories", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(false)
  })

  test("returns false when the directory is unavailable even with no statusById entry (key fix for #2421)", () => {
    // A session with no active-status entry whose directory is unavailable
    // must NOT be treated as fresh. This is the key fix: the unavailable
    // flag gates control decisions regardless of whether preserved busy/retry
    // data exists. `statusById` stores only busy/retry; absence means "last
    // known was idle", NOT "definitely idle right now while unavailable".
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(false)
  })

  test("matches normalized Windows directory aliases", () => {
    markDirectoryStatusUnavailable("C:/Repo")

    expect(isSessionStatusFresh("session-a", "c:\\Repo\\")).toBe(false)
  })

  test("returns true when the directory is not in unavailableDirectories (fresh), even with no statusById entry", () => {
    expect(isSessionStatusFresh("never-seen", "/repo")).toBe(true)
  })

  test("returns false for every known directory after a transport-wide event", () => {
    applyGlobalSessionStatusEvent("/repo-a", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.status",
      properties: { sessionID: "session-b", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    // Both directories are in unavailableDirectories, so both sessions are stale.
    expect(isSessionStatusFresh("session-a", "/repo-a")).toBe(false)
    expect(isSessionStatusFresh("session-b", "/repo-b")).toBe(false)
  })

  test("a failed fetch for /repo-a does not make a /repo-b session stale (directory scoping)", () => {
    applyGlobalSessionStatusEvent("/repo-a", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.status",
      properties: { sessionID: "session-b", status: { type: "busy" } },
    } as Event)

    markDirectoryStatusUnavailable("/repo-a")

    expect(isSessionStatusFresh("session-a", "/repo-a")).toBe(false)
    // /repo-b's session is unaffected by /repo-a's failure.
    expect(isSessionStatusFresh("session-b", "/repo-b")).toBe(true)
  })

  test("freshness is restored for a directory by its own successful snapshot", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(false)

    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(true)
  })

  test("after a transport-wide event, each directory is freshened independently by its own snapshot", () => {
    applyGlobalSessionStatusEvent("/repo-a", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    applyGlobalSessionStatusEvent("/repo-b", {
      type: "session.status",
      properties: { sessionID: "session-b", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    expect(isSessionStatusFresh("session-a", "/repo-a")).toBe(false)
    expect(isSessionStatusFresh("session-b", "/repo-b")).toBe(false)

    // /repo-a's snapshot arrives and freshens only /repo-a.
    applyGlobalSessionStatusSnapshot("/repo-a", { "session-a": { type: "busy" } }, ["session-a"])
    expect(isSessionStatusFresh("session-a", "/repo-a")).toBe(true)
    // /repo-b stays stale until its own snapshot arrives.
    expect(isSessionStatusFresh("session-b", "/repo-b")).toBe(false)

    applyGlobalSessionStatusSnapshot("/repo-b", { "session-b": { type: "busy" } }, ["session-b"])
    expect(isSessionStatusFresh("session-b", "/repo-b")).toBe(true)
  })
})

// Control-path regression: `useSessionKnownInactive(sessionId, directory)` is
// a pure selector over the same store state used by `isSessionStatusFresh` and
// the raw status entry. It is the gate for operations that require the session
// to be DEFINITELY inactive (e.g. move-to-worktree). `reconnecting` means
// "last known = busy/retry, current truth = unknown" — it must NOT be treated
// as inactive, so the operation fails closed while status is unavailable.
//
// The `directory` parameter is required: a session with no active-status entry
// whose directory is unavailable must fail closed, because absence in
// `statusById` means "last known was idle", NOT "definitely idle right now
// while the directory is unavailable".
//
// The hook renders in React, but its logic is a pure function of store state,
// so we exercise the same selector directly to avoid a React test harness.
describe("useSessionKnownInactive selector logic (control path)", () => {
  // Mirrors useSessionKnownInactive in sync-context.tsx exactly. The
  // `status.type === "error"` branch is defensive (the SDK's SessionStatus type
  // is currently idle/busy/retry); the cast preserves the hook's runtime
  // semantics without tripping TS's no-overlap narrowing.
  const knownInactive = (sessionId: string, directory: string): boolean => {
    const state = useGlobalSessionStatusStore.getState()
    if (!directory) return true
    const fresh = !state.unavailableDirectories.has(directory)
    if (!fresh) return false
    const status = state.statusById.get(sessionId)?.status
    return !status || status.type === "idle" || (status.type as string) === "error"
  }

  test("fresh + busy → false (operation blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("fresh + retry → false (operation blocked)", () => {
    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry", attempt: 1, message: "x", next: 5 },
    } as Record<string, { type?: string }>, ["session-a"])
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("fresh + idle → true (operation allowed)", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "idle" } }, ["session-a"])
    expect(knownInactive("session-a", "/repo")).toBe(true)
  })

  test("fresh + no status (unknown) → true (operation allowed)", () => {
    expect(knownInactive("never-seen", "/repo")).toBe(true)
  })

  test("unavailable + last known busy → false (blocked — the key fix for #2421)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    // The session looks "reconnecting" — current truth unknown, NOT inactive.
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("unavailable + no active status entry → false (blocked — key fix for #2421)", () => {
    // A session with no active-status entry whose directory is unavailable
    // must fail closed. `statusById` stores only busy/retry; absence means
    // "last known was idle", NOT "definitely idle right now while the
    // directory is unavailable". The unavailable flag is a freshness signal
    // over the directory, independent of whether preserved busy/retry data
    // exists, so control decisions fail closed.
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a", "/repo")).toBe(false)
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("transport-wide unavailable + last known busy → false (blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("transport-wide unavailable + no active status entry → false (blocked)", () => {
    // After a transport-wide event, the directory is in unavailableDirectories
    // even for sessions with no statusById entry.
    markTransportStatusUnavailable(["/repo"])
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("successful authoritative empty/idle snapshot → true (allowed)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")

    // Reconnect: authoritative empty snapshot confirms idle.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])
    expect(knownInactive("session-a", "/repo")).toBe(true)
  })

  test("successful authoritative busy snapshot → false (blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")

    // Reconnect: authoritative busy snapshot confirms still active.
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    expect(knownInactive("session-a", "/repo")).toBe(false)
  })

  test("a failed fetch for /repo-a does not unblock a /repo-b idle session (directory scoping)", () => {
    applyGlobalSessionStatusSnapshot("/repo-a", { "session-a": { type: "busy" } }, ["session-a"])
    applyGlobalSessionStatusSnapshot("/repo-b", { "session-b": { type: "idle" } }, ["session-b"])

    markDirectoryStatusUnavailable("/repo-a")

    // /repo-a's session is blocked (unavailable + busy).
    expect(knownInactive("session-a", "/repo-a")).toBe(false)
    // /repo-b's session is fresh + idle → allowed. A failure in another
    // directory must not block this directory's confirmed-idle session.
    expect(knownInactive("session-b", "/repo-b")).toBe(true)
  })
})
