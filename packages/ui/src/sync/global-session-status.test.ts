import { beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import {
  applyGlobalSessionStatusEvent,
  applyGlobalSessionStatusEvents,
  applyGlobalSessionStatusSnapshot,
  getDirectoryOwnedSessionIds,
  hasActiveSubagent,
  reconcileGlobalSessionStatusWithActive,
  setSessionParentResolver,
  useGlobalSessionStatusStore,
  replaceGlobalSessionStatusById,
  resolveSessionTurnActivity,
  subscribeSessionStatusTransitions,
} from "./global-session-status"
import { resetSessionOrdering, useSessionOrderingStore } from "./session-ordering"
import { resetSessionActivityTiming, useSessionActivityTimingStore } from "./session-activity-timing"
import { applyBackgroundShellEvents, resetBackgroundShells } from "./background-shells"
import { applyPrWatches, resetPrWatchesForRuntimeSwitch } from "./pr-watch"

beforeEach(() => {
  replaceGlobalSessionStatusById(new Map())
  resetSessionOrdering()
  resetSessionActivityTiming()
})

describe("global session status index", () => {
  const activeSessionIds = (): ReadonlySet<string> => useGlobalSessionStatusStore.getState().activeSessionIds

  test("transition listeners see intermediate activity before a single batch publication and unsubscribe", () => {
    const transitions: string[][] = []
    let publications = 0
    const unsubscribeStore = useGlobalSessionStatusStore.subscribe(() => { publications += 1 })
    const unsubscribe = subscribeSessionStatusTransitions((_id, active) => {
      transitions.push([...active])
    })
    try {
      applyGlobalSessionStatusEvents("/repo", [
        { type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
        { type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } },
        { type: "session.idle", properties: { sessionID: "parent" } },
        { type: "session.idle", properties: { sessionID: "child" } },
      ])
      expect(transitions).toEqual([["parent"], ["parent", "child"], ["child"], []])
      expect(publications).toBe(1)
      unsubscribe()
      applyGlobalSessionStatusEvent("/repo", {
        type: "session.idle", properties: { sessionID: "parent" },
      })
      expect(transitions).toHaveLength(4)
    } finally {
      unsubscribe()
      unsubscribeStore()
    }
  })

  test("a parent directory snapshot cannot settle a worktree session merely contained in its list", () => {
    const sessions = ["/repo", "/tree"].map((directory) => ({
      id: directory, directory, projectID: "project", title: "Session", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }))
    applyGlobalSessionStatusSnapshot("/tree", { "/tree": { type: "busy" } })
    const ownedIds = getDirectoryOwnedSessionIds("/repo", sessions)
    expect(ownedIds).toEqual(["/repo"])
    applyGlobalSessionStatusSnapshot("/repo", {}, ownedIds)
    expect(activeSessionIds().has("/tree")).toBe(true)
  })

  test("preserves full retry status details from live events", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: {
        sessionID: "session-a",
        status: { type: "retry", attempt: 2, message: "waiting" },
      },
    } as SyncEvent)

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
    } as SyncEvent)
    const before = activeSessionIds()

    applyGlobalSessionStatusEvent("/other-repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 2, message: "waiting" } },
    } as SyncEvent)

    expect(activeSessionIds()).toBe(before)
  })

  test("replaces active membership only when a session becomes idle or active", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as SyncEvent)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as SyncEvent)
    const idle = activeSessionIds()
    expect(idle).not.toBe(active)
    expect(idle?.has("session-a")).toBe(false)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as SyncEvent)
    expect(activeSessionIds()).not.toBe(idle)
    expect(activeSessionIds()?.has("session-a")).toBe(true)
  })

  test("removes deleted sessions from active membership", () => {
    // SAFETY: This fixture matches the SDK event shape consumed by the status event reducer.
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as SyncEvent)
    const active = activeSessionIds()

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.deleted",
      properties: { sessionID: "session-a" },
    } as SyncEvent)

    expect(activeSessionIds()).not.toBe(active)
    expect(activeSessionIds().has("session-a")).toBe(false)
    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
  })

  test("promotes on active and settled lifecycle edges only", () => {
    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "busy" } },
    } as SyncEvent)
    const busyRank = useSessionOrderingStore.getState().rankById.get("session-a")

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.status",
      properties: { sessionID: "session-a", status: { type: "retry", attempt: 1, message: "wait", next: 1 } },
    } as SyncEvent)
    expect(useSessionOrderingStore.getState().rankById.get("session-a")).toBe(busyRank)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.idle",
      properties: { sessionID: "session-a" },
    } as SyncEvent)
    const idleRank = useSessionOrderingStore.getState().rankById.get("session-a")
    expect(idleRank).toBeGreaterThan(busyRank ?? 0)

    applyGlobalSessionStatusEvent("/repo", {
      type: "session.error",
      properties: { sessionID: "session-a" },
    } as SyncEvent)
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
      "session-a": { type: "retry", attempt: 1, message: "wait", next: 1 },
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
    } as SyncEvent)

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
      properties: { sessionID: `session-${index}`, status: { type: "busy" }, turnStart: { at: Date.now(), source: "live" } },
    } as SyncEvent))

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
      } as SyncEvent,
      {
        type: "session.deleted",
        properties: { sessionID: "session-a" },
      } as SyncEvent,
    ])

    expect(useGlobalSessionStatusStore.getState().statusById.has("session-a")).toBe(false)
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
    expect(useSessionActivityTimingStore.getState().startedAt.has("session-a")).toBe(false)
  })
})

describe("what a session row says keeps its turn open", () => {
  test("its own run first, then a running workflow over its agents' subagent state, then a command", () => {
    expect(resolveSessionTurnActivity("running", true, true)).toBe("running")
    // A workflow's agents are subagents; the row names the workflow instead.
    expect(resolveSessionTurnActivity("subagent", true, false)).toBe("workflow")
    // Between phases no agent is busy, and the workflow still runs.
    expect(resolveSessionTurnActivity(null, true, false)).toBe("workflow")
    expect(resolveSessionTurnActivity("subagent", false, true)).toBe("subagent")
    expect(resolveSessionTurnActivity(null, false, true)).toBe("shell")
    expect(resolveSessionTurnActivity(null, false, false)).toBeNull()
    // An agent waiting on its pull request reads as working, after anything that really runs.
    expect(resolveSessionTurnActivity(null, false, false, true)).toBe("pullRequest")
    expect(resolveSessionTurnActivity(null, false, true, true)).toBe("shell")
    expect(resolveSessionTurnActivity("running", false, false, true)).toBe("running")
    // An image the session waits on comes after a command and before a pull request.
    expect(resolveSessionTurnActivity(null, false, false, true, true)).toBe("image")
    expect(resolveSessionTurnActivity(null, false, true, false, true)).toBe("shell")
    // So does one waiting on a timer or an extension, last of all.
    expect(resolveSessionTurnActivity(null, false, false, false, false, true)).toBe("extensionWait")
    expect(resolveSessionTurnActivity(null, false, false, true, false, true)).toBe("pullRequest")
    expect(resolveSessionTurnActivity("subagent", false, false, false, false, true)).toBe("subagent")
  })
})

describe("background subagent keeps its parent's turn open", () => {
  // Turns this client saw begin: the start rides on the event.
  const busy = (sessionID: string): SyncEvent => ({
    type: "session.status",
    properties: { sessionID, status: { type: "busy" }, turnStart: { at: Date.now(), source: "live" } },
  })
  const idle = (sessionID: string): SyncEvent => ({ type: "session.idle", properties: { sessionID } } as SyncEvent)
  const timing = () => useSessionActivityTimingStore.getState()

  beforeEach(() => {
    setSessionParentResolver((sessionId) => (sessionId === "child" ? "parent" : undefined))
  })

  test("the parent's timer runs through the pause and settles when the subagent ends", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("parent"), busy("child")])
    applyGlobalSessionStatusEvents("/repo", [idle("parent")])

    const active = useGlobalSessionStatusStore.getState().activeSessionIds
    expect(active.has("parent")).toBe(false)
    expect(hasActiveSubagent("parent", active)).toBe(true)
    expect(timing().startedAt.has("parent")).toBe(true)
    expect(timing().settledMs.has("parent")).toBe(false)

    applyGlobalSessionStatusEvents("/repo", [idle("child")])
    expect(timing().startedAt.has("parent")).toBe(false)
    expect(timing().settledMs.has("parent")).toBe(true)
  })

  test("a subagent deeper than eight levels still counts, and a parent cycle ends the walk", () => {
    const parents = new Map<string, string>()
    for (let depth = 1; depth <= 12; depth += 1) {
      parents.set(`child_${depth}`, depth === 1 ? "root" : `child_${depth - 1}`)
    }
    const resolve = (id: string) => parents.get(id)
    expect(hasActiveSubagent("root", new Set(["child_12"]), resolve)).toBe(true)
    expect(hasActiveSubagent("unrelated", new Set(["child_12"]), resolve)).toBe(false)

    const cycle = new Map([["a", "b"], ["b", "a"]])
    expect(hasActiveSubagent("root", new Set(["a"]), (id) => cycle.get(id))).toBe(false)
    expect(hasActiveSubagent("b", new Set(["a"]), (id) => cycle.get(id))).toBe(true)
  })

  test("the parent's resumed run does not move the start of the turn it belongs to", () => {
    const hostBusy = (sessionID: string, at: number): SyncEvent => ({
      type: "session.status",
      properties: { sessionID, status: { type: "busy" }, turnStart: { at, source: "host" } },
    })
    applyGlobalSessionStatusEvents("/repo", [hostBusy("parent", Date.now() - 60_000), busy("child")])
    applyGlobalSessionStatusEvents("/repo", [idle("parent")])
    const start = timing().startedAt.get("parent")

    applyGlobalSessionStatusEvents("/repo", [hostBusy("parent", Date.now())])
    expect(timing().startedAt.get("parent")).toBe(start)
  })

  test("a caller can resolve nested lineage without changing the display resolver", () => {
    const parents = new Map([["grandchild", "nested-child"], ["nested-child", "nested-parent"]])
    const active = new Set(["grandchild"])
    expect(hasActiveSubagent("nested-parent", active, (id) => parents.get(id))).toBe(true)
    expect(hasActiveSubagent("nested-parent", active)).toBe(false)
    expect(hasActiveSubagent("parent", new Set(["child"]))).toBe(true)
  })

  test("a subagent ending while the parent runs again leaves the parent's timer alone", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("parent"), busy("child")])
    applyGlobalSessionStatusEvents("/repo", [idle("parent")])
    applyGlobalSessionStatusEvents("/repo", [idle("child"), busy("parent")])

    expect(timing().startedAt.has("parent")).toBe(true)
    applyGlobalSessionStatusEvents("/repo", [idle("parent")])
    expect(timing().settledMs.has("parent")).toBe(true)
  })

  test("a status snapshot does not settle a parent whose subagent is running", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("parent"), busy("child")])
    applyGlobalSessionStatusSnapshot("/repo", { child: { type: "busy" } }, ["parent", "child"])
    expect(timing().startedAt.has("parent")).toBe(true)
  })
})

describe("a background command keeps its session's turn open", () => {
  // Turns this client saw begin: the start rides on the event.
  const busy = (sessionID: string): SyncEvent => ({
    type: "session.status",
    properties: { sessionID, status: { type: "busy" }, turnStart: { at: Date.now(), source: "live" } },
  })
  const idle = (sessionID: string): SyncEvent => ({ type: "session.idle", properties: { sessionID } } as SyncEvent)
  const started: SyncEvent = {
    type: "shell.started",
    properties: { shell: { id: "sh_1", sessionID: "session", command: "sleep 300", file: "/tmp/sh_1.out", startedAt: 1 } },
  }
  const ended: SyncEvent = { type: "shell.ended", properties: { shellID: "sh_1", end: { kind: "exited", status: "exited", exit: 0 }, endedAt: 2 } }
  const timing = () => useSessionActivityTimingStore.getState()

  beforeEach(() => resetBackgroundShells())

  test("the timer runs through the pause and settles when the command ends", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyBackgroundShellEvents("/repo", [started])
    applyGlobalSessionStatusEvents("/repo", [idle("session")])

    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has("session")).toBe(false)
    expect(timing().startedAt.has("session")).toBe(true)

    applyBackgroundShellEvents("/repo", [ended])
    expect(timing().startedAt.has("session")).toBe(false)
    expect(timing().settledMs.has("session")).toBe(true)
  })

  test("a command ending while the session runs again leaves the timer alone", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyBackgroundShellEvents("/repo", [started])
    applyGlobalSessionStatusEvents("/repo", [idle("session"), busy("session")])
    applyBackgroundShellEvents("/repo", [ended])
    expect(timing().startedAt.has("session")).toBe(true)
  })

  test("a status snapshot does not settle a session waiting on its command", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyBackgroundShellEvents("/repo", [started])
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session"])
    expect(timing().startedAt.has("session")).toBe(true)
  })
})

// Oracle: OpenCode's `session.active` list is the authority for host sessions.
// A session the index holds as running stays exactly when the list names it,
// the list does not speak for it (`covers`), a write landed after the read
// started, or this is the first read in a row to miss it; the exhaustive table
// below derives every expectation from that rule.
describe("reconciling the index with OpenCode's running list", () => {
  const busy = (sessionID: string): SyncEvent => ({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
  const running = (): string[] => [...useGlobalSessionStatusStore.getState().statusById.keys()].sort()
  const coversAll = () => true
  const nothingRuns = async () => new Set<string>()
  const deferred = () => {
    let resolve!: (value: ReadonlySet<string> | null) => void
    const promise = new Promise<ReadonlySet<string> | null>((complete) => { resolve = complete })
    return { promise, resolve }
  }

  test("settles exactly the covered sessions two reads in a row miss, for every combination", async () => {
    const ids = ["a", "b", "c"]
    for (let mask = 0; mask < 4 ** ids.length; mask += 1) {
      replaceGlobalSessionStatusById(new Map())
      const listed = new Set(ids.filter((_, index) => ((mask >> (index * 2)) & 1) === 1))
      const covered = new Set(ids.filter((_, index) => ((mask >> (index * 2 + 1)) & 1) === 1))
      applyGlobalSessionStatusEvents("/repo", ids.map(busy))

      await reconcileGlobalSessionStatusWithActive(async () => listed, (sessionId) => covered.has(sessionId))
      expect(running()).toEqual(ids)
      await reconcileGlobalSessionStatusWithActive(async () => listed, (sessionId) => covered.has(sessionId))

      const expected = ids.filter((id) => listed.has(id) || !covered.has(id))
      expect(running()).toEqual(expected)
      expect([...useGlobalSessionStatusStore.getState().activeSessionIds].sort()).toEqual(expected)
    }
  })

  test("a turn OpenCode resumes after a restart survives the read that missed it", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("resuming")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    await reconcileGlobalSessionStatusWithActive(async () => new Set(["resuming"]), coversAll)
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(running()).toEqual(["resuming"])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(running()).toEqual([])
  })

  test("a repeated busy event after a miss starts confirmation over", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("resumed")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    applyGlobalSessionStatusEvents("/repo", [busy("resumed")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(running()).toEqual(["resumed"])
  })

  test("an inconclusive read resets earlier missing evidence", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("resumed")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    await reconcileGlobalSessionStatusWithActive(async () => null, coversAll)
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(running()).toEqual(["resumed"])
  })

  test("overlapping callers cannot count one in-flight snapshot twice", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("resumed")])
    const read = deferred()
    const first = reconcileGlobalSessionStatusWithActive(() => read.promise, coversAll)
    let secondRead = false
    await reconcileGlobalSessionStatusWithActive(async () => {
      secondRead = true
      return new Set()
    }, coversAll)
    read.resolve(new Set())
    await first
    expect(secondRead).toBe(false)
    expect(running()).toEqual(["resumed"])
  })

  test("a settled session counts as observed, so the host seed cannot add it back", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("finished-subagent")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(useGlobalSessionStatusStore.getState().observedById.has("finished-subagent")).toBe(true)
  })

  test("a write that lands while the read is in flight wins over the read", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("restarted"), busy("finished")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    const read = deferred()
    const reconcile = reconcileGlobalSessionStatusWithActive(() => read.promise, coversAll)
    applyGlobalSessionStatusEvents("/repo", [busy("restarted")])
    applyGlobalSessionStatusEvents("/repo", [busy("started-during-read")])
    read.resolve(new Set())
    await reconcile
    expect(running()).toEqual(["restarted", "started-during-read"])
  })

  test("a failed read settles nothing", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    await reconcileGlobalSessionStatusWithActive(async () => null, coversAll)
    await reconcileGlobalSessionStatusWithActive(async () => null, coversAll)
    expect(running()).toEqual(["session"])
  })

  test("a read started before a runtime switch does not touch the new runtime's index", async () => {
    applyGlobalSessionStatusEvents("/repo", [busy("other-runtime")])
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    const read = deferred()
    const reconcile = reconcileGlobalSessionStatusWithActive(() => read.promise, coversAll)
    replaceGlobalSessionStatusById(new Map([["other-runtime", { status: { type: "busy" }, directory: "/repo" }]]))
    read.resolve(new Set())
    await reconcile
    expect(running()).toEqual(["other-runtime"])
    // The switch also forgot the earlier miss: one more read is not enough.
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    expect(running()).toEqual(["other-runtime"])
  })

  test("settling the last running subagent settles its parent's turn", async () => {
    setSessionParentResolver((sessionId) => (sessionId === "child" ? "parent" : undefined))
    applyGlobalSessionStatusEvents("/repo", [busy("parent"), busy("child")])
    applyGlobalSessionStatusEvents("/repo", [{ type: "session.idle", properties: { sessionID: "parent" } }])
    expect(useSessionActivityTimingStore.getState().startedAt.has("parent")).toBe(true)

    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)
    await reconcileGlobalSessionStatusWithActive(nothingRuns, coversAll)

    expect(running()).toEqual([])
    expect(useSessionActivityTimingStore.getState().settledMs.has("parent")).toBe(true)
  })
})

describe("a pull request watch keeps its session's turn open", () => {
  const busy = (sessionID: string): SyncEvent => ({
    type: "session.status",
    properties: { sessionID, status: { type: "busy" }, turnStart: { at: Date.now(), source: "live" } },
  })
  const idle = (sessionID: string): SyncEvent => ({ type: "session.idle", properties: { sessionID } } as SyncEvent)
  const watch = {
    sessionID: "session", directory: "/repo", url: "https://example.test/pr/1", number: 1, title: "PR", status: "pending" as const, startedAt: 1,
  }
  const timing = () => useSessionActivityTimingStore.getState()

  beforeEach(() => {
    resetBackgroundShells()
    resetPrWatchesForRuntimeSwitch()
  })

  test("the timer runs through the wait and settles when the user stops the watch", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyPrWatches(1, "session", [watch])
    applyGlobalSessionStatusEvents("/repo", [idle("session")])
    expect(timing().startedAt.has("session")).toBe(true)

    applyPrWatches(2, "session", [])
    expect(timing().startedAt.has("session")).toBe(false)
    expect(timing().settledMs.has("session")).toBe(true)
  })

  test("a wake runs on inside the same turn", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyPrWatches(1, "session", [watch])
    applyGlobalSessionStatusEvents("/repo", [idle("session")])
    const start = timing().startedAt.get("session")

    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyPrWatches(2, "session", [])
    expect(timing().startedAt.get("session")).toBe(start)
  })

  test("a watch ending leaves a session its command still holds", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyPrWatches(1, "session", [watch])
    applyBackgroundShellEvents("/repo", [{
      type: "shell.started",
      properties: { shell: { id: "sh_1", sessionID: "session", command: "sleep 300", file: "/tmp/sh_1.out", startedAt: 1 } },
    }])
    applyGlobalSessionStatusEvents("/repo", [idle("session")])
    applyPrWatches(2, "session", [])
    expect(timing().startedAt.has("session")).toBe(true)
  })

  test("a status snapshot does not settle a session waiting on its pull request", () => {
    applyGlobalSessionStatusEvents("/repo", [busy("session")])
    applyPrWatches(1, "session", [watch])
    applyGlobalSessionStatusSnapshot("/repo", {}, ["session"])
    expect(timing().startedAt.has("session")).toBe(true)
  })
})
