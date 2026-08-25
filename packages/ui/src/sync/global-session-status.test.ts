import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  useGlobalSessionStatusStore,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"
import { resetSessionActivityTiming, useSessionActivityTimingStore } from "./session-activity-timing"

beforeEach(() => {
  useGlobalSessionStatusStore.setState({ statusById: new Map() })
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

    useGlobalSessionStatusStore.setState({ statusById: new Map() })

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
})
