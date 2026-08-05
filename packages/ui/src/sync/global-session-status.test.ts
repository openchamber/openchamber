import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusSnapshot,
  areGlobalSessionStatusEventsEnabled,
  markGlobalSessionStatusUnavailable,
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
// status data and model unavailability as a freshness flag, NOT as idle.
// unknown/unavailable != idle.
describe("transient unavailability preserves status data (statusUnavailable flag)", () => {
  test("initial state is fresh (statusUnavailable false)", () => {
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("markGlobalSessionStatusUnavailable preserves status data and sets the flag", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")

    markGlobalSessionStatusUnavailable()

    // Status data preserved, not destroyed; flag set.
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("repeated markGlobalSessionStatusUnavailable stays idempotent and keeps preserving data", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    markGlobalSessionStatusUnavailable()
    markGlobalSessionStatusUnavailable()
    markGlobalSessionStatusUnavailable()

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)
  })

  test("a successful authoritative empty snapshot clears the flag and lowers to idle", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markGlobalSessionStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)

    // Reconnect brings a fresh authoritative empty snapshot: idle is applied,
    // and the unavailability flag is cleared.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("a successful authoritative busy snapshot after reconnect clears the flag and applies busy", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markGlobalSessionStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)

    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("a retry snapshot after reconnect preserves full retry details and clears the flag", () => {
    markGlobalSessionStatusUnavailable()

    applyGlobalSessionStatusSnapshot("/repo", {
      "session-a": { type: "retry", attempt: 3, message: "backing off", next: 45 },
    } as Record<string, { type?: string }>, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status).toEqual({
      type: "retry", attempt: 3, message: "backing off", next: 45,
    })
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("a snapshot that changes nothing still clears an existing unavailability flag", () => {
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])
    markGlobalSessionStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)

    // Same busy snapshot re-applied: data unchanged, but freshness restored.
    applyGlobalSessionStatusSnapshot("/repo", { "session-a": { type: "busy" } }, ["session-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("resetGlobalSessionStatus clears data, blocks events, and resets the freshness flag (real runtime replacement)", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)
    markGlobalSessionStatusUnavailable()

    // Real runtime replacement: destroy stale data, block events, clean reset.
    resetGlobalSessionStatus({ blockEventUpdates: true })

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().acceptEventUpdates).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(false)
  })

  test("events are still applied while statusUnavailable is true (flag is freshness, not a gate)", () => {
    // statusUnavailable is a freshness signal, not an event gate. A live busy
    // event arriving during a transient outage still updates the index; the
    // flag just tells consumers the last *fetch* was stale.
    markGlobalSessionStatusUnavailable()
    expect(useGlobalSessionStatusStore.getState().statusUnavailable).toBe(true)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("session-a")?.status.type).toBe("busy")
  })
})
