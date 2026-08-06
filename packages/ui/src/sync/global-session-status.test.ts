import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  areGlobalSessionStatusEventsEnabled,
  isSessionStatusFresh,
  markDirectoryStatusUnavailable,
  markTransportStatusUnavailable,
  resetGlobalSessionStatus,
  useGlobalSessionStatusStore,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"

beforeEach(() => {
  resetGlobalSessionStatus()
  resetSessionOrdering()
})

describe("global session status index", () => {
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

  test("clears an explicitly idle known session when directory aliases differ", () => {
    applyGlobalSessionStatusSnapshot("/canonical/repo", { "session-a": { type: "busy" } }, ["session-a"])

    applyGlobalSessionStatusSnapshot("/alias/repo", { "session-a": { type: "idle" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
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
  test("initial state is fresh (no unavailable directories, transport flag false)", () => {
    const state = useGlobalSessionStatusStore.getState()
    expect(state.transportUnavailable).toBe(false)
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
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
    // A different directory is NOT marked unavailable by a /repo failure.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/other")).toBe(false)
  })

  test("markTransportStatusUnavailable sets the transport-wide flag without touching the per-directory set", () => {
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)
    // Transport flag is independent of the per-directory set.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)
  })

  test("markTransportStatusUnavailable is idempotent", () => {
    markTransportStatusUnavailable()
    markTransportStatusUnavailable()
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)
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

  test("a successful snapshot clears the transport-wide flag (first snapshot after a transport event)", () => {
    markTransportStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(true)

    // The first successful snapshot after a transport-wide event re-enables
    // event updates and clears the transport flag.
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
  })

  test("resetGlobalSessionStatus clears data, blocks events, and clears both unavailableDirectories and transportUnavailable (real runtime replacement)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    markTransportStatusUnavailable()

    // Real runtime replacement: destroy stale data, block events, clean reset.
    resetGlobalSessionStatus({ blockEventUpdates: true })

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.size).toBe(0)
    expect(useGlobalSessionStatusStore.getState().transportUnavailable).toBe(false)
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
    expect(isSessionStatusFresh("session-a")).toBe(true)
  })

  test("returns true for an unknown session (no preserved data → nothing stale)", () => {
    expect(isSessionStatusFresh("never-seen")).toBe(true)
  })

  test("returns false when the session's directory is in unavailableDirectories", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a")).toBe(false)
  })

  test("returns false when transportUnavailable is true, even for a directory not in the per-directory set", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    // /repo is not in unavailableDirectories, but the transport flag makes
    // every directory stale.
    expect(useGlobalSessionStatusStore.getState().unavailableDirectories.has("/repo")).toBe(false)
    expect(isSessionStatusFresh("session-a")).toBe(false)
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

    expect(isSessionStatusFresh("session-a")).toBe(false)
    // /repo-b's session is unaffected by /repo-a's failure.
    expect(isSessionStatusFresh("session-b")).toBe(true)
  })

  test("freshness is restored for a directory by its own successful snapshot", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a")).toBe(false)

    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    expect(isSessionStatusFresh("session-a")).toBe(true)
  })
})

// Control-path regression: `useSessionKnownInactive(sessionId)` is a pure
// selector over the same store state used by `isSessionStatusFresh` and the
// raw status entry. It is the gate for operations that require the session to
// be DEFINITELY inactive (e.g. move-to-worktree). `reconnecting` means
// "last known = busy/retry, current truth = unknown" — it must NOT be treated
// as inactive, so the operation fails closed while status is unavailable.
//
// The hook renders in React, but its logic is a pure function of store state,
// so we exercise the same selector directly to avoid a React test harness.
describe("useSessionKnownInactive selector logic (control path)", () => {
  // Mirrors useSessionKnownInactive in sync-context.tsx exactly. The
  // `status.type === "error"` branch is defensive (the SDK's SessionStatus type
  // is currently idle/busy/retry); the cast preserves the hook's runtime
  // semantics without tripping TS's no-overlap narrowing.
  const knownInactive = (sessionId: string): boolean => {
    const state = useGlobalSessionStatusStore.getState()
    const fresh = !state.transportUnavailable && (() => {
      const entry = state.statusById.get(sessionId)
      if (!entry) return true
      return !state.unavailableDirectories.has(entry.directory)
    })()
    if (!fresh) return false
    const status = state.statusById.get(sessionId)?.status
    return !status || status.type === "idle" || (status.type as string) === "error"
  }

  test("fresh + busy → false (operation blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(knownInactive("session-a")).toBe(false)
  })

  test("fresh + retry → false (operation blocked)", () => {
    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry", attempt: 1, message: "x", next: 5 },
    } as Record<string, { type?: string }>, ["session-a"])
    expect(knownInactive("session-a")).toBe(false)
  })

  test("fresh + idle → true (operation allowed)", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "idle" } }, ["session-a"])
    expect(knownInactive("session-a")).toBe(true)
  })

  test("fresh + no status (unknown) → true (operation allowed)", () => {
    expect(knownInactive("never-seen")).toBe(true)
  })

  test("unavailable + last known busy → false (blocked — the key fix for #2421)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")
    // The session looks "reconnecting" — current truth unknown, NOT inactive.
    expect(knownInactive("session-a")).toBe(false)
  })

  test("unavailable + no preserved status → true (no data to be stale; treated as fresh idle)", () => {
    // A session with no preserved busy/retry entry has nothing to be stale, so
    // `isSessionStatusFresh` returns true regardless of directory unavailability
    // (the flag only matters when preserved data exists). With fresh=true and
    // no status, the selector treats it as idle → allowed. This matches the
    // implementation contract: the unavailable flag gates *preserved* data, it
    // does not invent unknown-idle-blocking for sessions we never saw active.
    markDirectoryStatusUnavailable("/repo")
    expect(isSessionStatusFresh("session-a")).toBe(true)
    expect(knownInactive("session-a")).toBe(true)
  })

  test("transport-wide unavailable + last known busy → false (blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markTransportStatusUnavailable()
    expect(knownInactive("session-a")).toBe(false)
  })

  test("successful authoritative empty/idle snapshot → true (allowed)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")

    // Reconnect: authoritative empty snapshot confirms idle.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])
    expect(knownInactive("session-a")).toBe(true)
  })

  test("successful authoritative busy snapshot → false (blocked)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markDirectoryStatusUnavailable("/repo")

    // Reconnect: authoritative busy snapshot confirms still active.
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    expect(knownInactive("session-a")).toBe(false)
  })

  test("a failed fetch for /repo-a does not unblock a /repo-b idle session (directory scoping)", () => {
    applyGlobalSessionStatusSnapshot("/repo-a", { "session-a": { type: "busy" } }, ["session-a"])
    applyGlobalSessionStatusSnapshot("/repo-b", { "session-b": { type: "idle" } }, ["session-b"])

    markDirectoryStatusUnavailable("/repo-a")

    // /repo-a's session is blocked (unavailable + busy).
    expect(knownInactive("session-a")).toBe(false)
    // /repo-b's session is fresh + idle → allowed. A failure in another
    // directory must not block this directory's confirmed-idle session.
    expect(knownInactive("session-b")).toBe(true)
  })
})
