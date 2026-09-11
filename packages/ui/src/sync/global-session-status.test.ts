import { beforeEach, describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  isCompleteSessionListForPruning,
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

describe("known-sessions completeness proof", () => {
  test("only an explicit authoritative list is a completeness proof for omission pruning", () => {
    expect(isCompleteSessionListForPruning("authoritative")).toBe(true)
    // "live" is set by a single event and is not a completeness proof.
    expect(isCompleteSessionListForPruning("live")).toBe(false)
    // "roots-only" is a failed-children-fetch fallback: never complete.
    expect(isCompleteSessionListForPruning("roots-only")).toBe(false)
    expect(isCompleteSessionListForPruning("empty")).toBe(false)
    expect(isCompleteSessionListForPruning("persisted")).toBe(false)
    expect(isCompleteSessionListForPruning(undefined)).toBe(false)
  })
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
})

describe("derived parent activity from background children", () => {
  const learnRelation = (childId: string, parentId: string) => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: childId, parentID: parentId } },
    } as unknown as Event)
  }

  const childStatus = (childId: string, type: "busy" | "retry" | "idle") => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: childId, status: { type } },
    } as unknown as Event)
  }

  test("parent becomes derived busy while a child is active and clears when the child settles", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")

    const entry = useGlobalSessionStatusStore.getState().statusById.get("parent-a")
    expect(entry?.status).toEqual({ type: "busy" })
    expect(entry?.derived).toBe(true)

    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("parent idle event does not clear derived child activity", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "idle" } },
    } as unknown as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("parent own raw busy wins over derived and survives child settle", () => {
    learnRelation("child-a", "parent-a")
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "busy" } },
    } as unknown as Event)
    childStatus("child-a", "busy")

    const entry = useGlobalSessionStatusStore.getState().statusById.get("parent-a")
    expect(entry?.status.type).toBe("busy")
    expect(entry?.derived).toBe(undefined)

    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "idle" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("retry keeps the parent busy and error settles it", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "retry")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.error",
      properties: { sessionID: "child-a" },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a second child keeps the parent busy after the first settles", () => {
    learnRelation("child-a", "parent-a")
    learnRelation("child-b", "parent-a")
    childStatus("child-a", "busy")
    childStatus("child-b", "busy")

    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    childStatus("child-b", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("session.deleted child clears the derived parent", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "child-a" },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("authoritative snapshot re-derives the parent from an active child and clears with the child", () => {
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    const entry = useGlobalSessionStatusStore.getState().statusById.get("parent-a")
    expect(entry?.status.type).toBe("busy")
    expect(entry?.derived).toBe(true)

    applyGlobalSessionStatusSnapshot(
      "/repo",
      {},
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)
  })

  test("event-derived parent survives a snapshot that omits it but keeps the busy child", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")

    applyGlobalSessionStatusSnapshot("/repo", { "child-a": { type: "busy" } }, ["parent-a", "child-a"])

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("reset clears relations so no stale derived entry survives", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(true)

    resetGlobalSessionStatus()
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)

    // No stale relation: a later child busy must not resurrect the old parent.
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("event reparent moves derived activity from the former parent to the new parent", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    learnRelation("child-a", "parent-b")

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("snapshot reparent clears the former parent and activates the new parent", () => {
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-b", "child-a"],
      [{ id: "parent-b" }, { id: "child-a", parentID: "parent-b" }],
    )

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
  })

  test("explicit parentID null detaches and clears the former parent while the child stays raw busy", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: null } },
    } as unknown as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("complete session update with omitted parentID detaches the former parent", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // A complete session record omits `parentID` for root sessions, so this
    // authoritative record makes the formerly-child session a root.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a" } },
    } as unknown as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("complete snapshot record with omitted parentID detaches the former parent", () => {
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a" }],
    )

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("a session update without record info does not mutate relations", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")

    // Partial payload without `info` carries no relationship data: no detach.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: {},
    } as unknown as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("deleting a parent orphans its children and is not recreated by their later status", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a" },
    } as unknown as Event)

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Later child status events must not recreate the deleted parent.
    childStatus("child-a", "busy")
    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a busy grandchild keeps every ancestor derived active", () => {
    learnRelation("child-a", "parent-a")
    learnRelation("grandchild-a", "child-a")
    childStatus("grandchild-a", "busy")

    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("grandchild-a")?.status.type).toBe("busy")

    childStatus("grandchild-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a middle session idle with an active grandchild keeps ancestors active", () => {
    learnRelation("child-a", "parent-a")
    learnRelation("grandchild-a", "child-a")
    childStatus("grandchild-a", "busy")
    childStatus("child-a", "idle")

    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    childStatus("grandchild-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("reparenting a middle session moves descendant activity to the new ancestor chain", () => {
    learnRelation("child-a", "parent-a")
    learnRelation("grandchild-a", "child-a")
    childStatus("grandchild-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    learnRelation("child-a", "parent-b")

    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("rejects a relation that would create an indirect parent cycle", () => {
    learnRelation("child-a", "parent-a")
    // Would form child-a ↔ parent-a: the proposed parent is a descendant of
    // the child, so it is rejected without storing a cycle.
    learnRelation("parent-a", "child-a")

    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // With no stored cycle, settling the only raw-active session clears every
    // derived entry instead of self-sustaining the pair.
    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)
  })

  test("a rejected indirect cycle cannot make a session derive from its own child", () => {
    learnRelation("child-a", "parent-a")
    learnRelation("parent-a", "child-a")

    childStatus("child-a", "idle")
    childStatus("parent-a", "busy")

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    // The rejected edge was not stored: the raw-busy parent does not derive
    // activity onto the child.
    expect(useGlobalSessionStatusStore.getState().statusById.has("child-a")).toBe(false)
  })

  test("raw busy replaces a matching derived entry and survives child settle (event path)", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Authoritative raw busy with the same type replaces the synthetic entry.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "busy" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)

    // Child settles: the raw-active parent must survive.
    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)
  })

  test("raw busy replaces a matching derived entry and survives child settle (snapshot path)", () => {
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Snapshot now carries authoritative raw parent busy: replaces the derived
    // entry even though the types match.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" }, "parent-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)

    // Child disappears from the authoritative snapshot: raw-active parent survives.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "parent-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)
  })

  test("a delayed stale session update cannot move a busy child away from its newer parent", () => {
    // Newer reparent record first.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-b", time: { updated: 200 } } },
    } as unknown as Event)
    // Delayed stale old-parent record (older time) arrives afterwards.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    childStatus("child-a", "busy")

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("an authoritative snapshot reconciles the relation and resets freshness", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    // The snapshot is authoritative: the child now belongs to parent-b, even
    // though its record timestamp is older than the previously seen event.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-b", "child-a"],
      [{ id: "parent-b", time: { updated: 90 } }, { id: "child-a", parentID: "parent-b", time: { updated: 90 } }],
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A stale event older than the snapshot's baseline is still skipped.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 80 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-b")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("re-applying the status snapshot with the authoritative session list derives a cold-start busy child parent", () => {
    // Cold start: the status snapshot was applied during bootstrap with an
    // empty session list (partial — no completeness proof), so the busy child
    // has no known parent yet.
    applyGlobalSessionStatusSnapshot("/repo", { "child-a": { type: "busy" } }, [])
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // loadSessions commits the authoritative list; the same snapshot is
    // re-applied with those records as a proven-complete list (sync-context
    // does this after the commit).
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a" }, { id: "child-a", parentID: "parent-a" }],
      true,
    )

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("an authoritative knownSessions omission prunes the child relation so a delayed busy status cannot rederive the parent", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // The authoritative complete list (completeness proven) excludes the
    // child: its relation is removed and the parent's derived entry clears.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["parent-a"], [{ id: "parent-a" }], true)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A delayed busy status must not recreate the old parent relation.
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("omission pruning is scoped to the snapshot directory", () => {
    // Relation and busy status live in another directory: this snapshot of
    // /repo must not prune them.
    applyGlobalSessionStatusEvent("/other-repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a" } },
    } as unknown as Event)
    applyGlobalSessionStatusEvent("/other-repo", {
      type: "session.status",
      properties: { sessionID: "child-a", status: { type: "busy" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusSnapshot("/repo", {}, ["parent-a"], [{ id: "parent-a" }], true)

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("an authoritative knownSessions omission prunes an idle child relation so a delayed busy status cannot rederive the parent", () => {
    // The child relation is learned but the child never had a status entry
    // (idle): ownership is tracked from the complete session record.
    learnRelation("child-a", "parent-a")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    applyGlobalSessionStatusSnapshot("/repo", {}, ["parent-a"], [{ id: "parent-a" }], true)

    // A delayed busy status must not recreate the pruned relation.
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("a partial knownSessions list never prunes an existing relation", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // No completeness proof: omission pruning must not run, so the relation
    // survives even though the authoritative raw snapshot idles both entries.
    applyGlobalSessionStatusSnapshot("/repo", {}, ["parent-a"], [{ id: "parent-a" }])
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A later busy status still derives the parent: the relation was kept.
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("a delayed same-recency relation record cannot reconnect a busy child to a deleted parent", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a" },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Delayed same-recency relation record: rejected by the deletion tombstone.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("a deletion tombstone baseline rejects same-recency records without prior relation recency but admits strictly newer re-creation", () => {
    // The parent is deleted before any relation record touched the child, so
    // the child has no prior tracked relation recency.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a", info: { id: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    // Same-recency record proposing the tombstoned parent: rejected.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Strictly newer record: admitted and participates normally.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 200 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("a snapshot record with same/lower recency cannot bypass a deletion tombstone", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a", info: { id: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    // Same-recency complete snapshot record proposing the tombstoned parent:
    // rejected, so the busy child cannot derive the deleted parent.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a", time: { updated: 100 } }, { id: "child-a", parentID: "parent-a", time: { updated: 100 } }],
      true,
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a strictly newer snapshot record recreates a tombstoned relation", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a", info: { id: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [{ id: "parent-a", time: { updated: 200 } }, { id: "child-a", parentID: "parent-a", time: { updated: 200 } }],
      true,
    )

    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("snapshot relation validation is order-independent against the snapshot-start tombstone baseline", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a", info: { id: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    // The parent record (@200, strictly newer) comes first and recreates the
    // parent itself, but must NOT authorize the older child->parent relation
    // (@100) later in the same snapshot: validation uses the frozen start
    // baseline, so the busy child cannot derive the deleted parent.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      { "child-a": { type: "busy" } },
      ["parent-a", "child-a"],
      [
        { id: "parent-a", time: { updated: 200 } },
        { id: "child-a", parentID: "parent-a", time: { updated: 100 } },
      ],
      true,
    )
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A strictly newer child relation (@201) is admitted and derives normally.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("a recreated parent session does not authorize a delayed stale child relation edge", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "parent-a", info: { id: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)

    // Parent-only snapshot record @200 recreates the parent session itself;
    // the deletion baseline that gates child->parent edges must survive.
    applyGlobalSessionStatusSnapshot(
      "/repo",
      {},
      ["parent-a"],
      [{ id: "parent-a", time: { updated: 200 } }],
      true,
    )

    // Delayed stale child->parent edge @100 (at the deletion baseline):
    // rejected even though the parent session was recreated.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A strictly newer edge @201 is admitted and derives normally.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
  })

  test("a complete session update with time.archived is treated as terminal deletion", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // Archive the parent: terminal like deletion, with the archived record's
    // recency as the tombstone baseline.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 150, archived: 150 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A same-recency delayed relation cannot restore the archived parent.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")
  })

  test("unversioned status updates for a tombstoned session id are ignored until a strictly newer record recreates it", () => {
    // Busy child derives the parent, then the parent is archived (terminal).
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 150, archived: 150 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Delayed unversioned busy status for the tombstoned parent: ignored, so
    // no raw or derived resurrection.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "busy" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("child-a")?.status.type).toBe("busy")

    // A strictly newer complete record recreates the session: its status now
    // applies normally.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 200 } } },
    } as unknown as Event)
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "busy" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)
  })

  test("a status snapshot cannot re-enable a tombstoned id without a newer complete record for that id", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 150, archived: 150 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Stale status snapshot reports the tombstoned id busy: ignored.
    applyGlobalSessionStatusSnapshot("/repo", { "parent-a": { type: "busy" } }, ["parent-a"])
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a newer child edge restores the relation but keeps the parent status-blocked until the parent itself has a newer record", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 100 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // Archive the parent (terminal).
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 150, archived: 150 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A strictly newer child->parent edge @201 restores the edge relation (the
    // busy child derives the parent again) but must NOT unblock the parent's
    // own unversioned status.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Raw unversioned busy status for the parent is still blocked: stays derived.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "parent-a", status: { type: "busy" } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // The parent itself gets a strictly-newer complete record (@200): its
    // snapshot status now applies normally (raw replaces derived).
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 200 } } },
    } as unknown as Event)
    applyGlobalSessionStatusSnapshot("/repo", { "parent-a": { type: "busy" } }, ["parent-a"])
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(undefined)
  })

  test("a delayed terminal record is ignored after a newer child edge restored the relation but a strictly newer terminal clears", () => {
    // Busy child derives the parent (relation @50), then the parent is
    // terminal @100 (strictly newer than the relation, so it applies).
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 50 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 100, archived: 100 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // A strictly newer busy child edge @201 restores the derived parent.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Delayed terminal record @100 (same as the original baseline): ignored,
    // so the restored derived parent survives.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 100, archived: 100 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // A strictly newer terminal @202 clears the restored relation.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 202, archived: 202 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("a terminal record equal to the newest accepted child recency is stale and does not clean up the restored relation", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 50 } } },
    } as unknown as Event)
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // First terminal @100 (strictly newer than the relation) applies.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 100, archived: 100 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)

    // Strictly newer child edge @201 restores the derived parent.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "child-a", parentID: "parent-a", time: { updated: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Terminal @201 (EQUAL to the newest accepted child recency) is stale:
    // the restored relation survives.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 201, archived: 201 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)

    // Terminal @202 (strictly newer) cleans up.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.updated",
      properties: { info: { id: "parent-a", time: { updated: 202, archived: 202 } } },
    } as unknown as Event)
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
  })

  test("uncomplicated status events with no tracked relations leave derived activity intact", () => {
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")

    // session-x has no parent and no children: its busy event cannot create or
    // remove any derived entry, so recompute must not disturb parent-a.
    childStatus("session-x", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-x")?.status.type).toBe("busy")

    // The unrelated event must not swallow the real work either: settling
    // child-a still clears the derived parent.
    childStatus("child-a", "idle")
    expect(useGlobalSessionStatusStore.getState().statusById.has("parent-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-x")?.status.type).toBe("busy")
  })

  test("an uncomplicated status event does not suppress later relation derivation", () => {
    childStatus("session-x", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("session-x")?.status.type).toBe("busy")

    // The recompute fast path must not suppress relation work: a later busy
    // child still derives its parent.
    learnRelation("child-a", "parent-a")
    childStatus("child-a", "busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.status.type).toBe("busy")
    expect(useGlobalSessionStatusStore.getState().statusById.get("parent-a")?.derived).toBe(true)
  })
})
