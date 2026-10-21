import { beforeEach, describe, expect, test } from "bun:test"
import type { PersistentPtyInfo } from "@opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import {
  agentTerminalState,
  applyPersistentPtyEvents,
  dismissAgentTerminal,
  persistentPtyRevision,
  refreshSessionTerminals,
  replaceSessionTerminals,
  resetPersistentPtys,
  stopAgentTerminal,
  usePersistentPtysStore,
} from "./persistent-ptys"

const terminal = (id: string, sessionID: string, overrides: Partial<PersistentPtyInfo> = {}): PersistentPtyInfo => ({
  id,
  title: `title ${id}`,
  command: "bash",
  args: [],
  cwd: "/repo",
  status: "running",
  pid: 1,
  sessionID,
  foregroundProcess: null,
  size: { cols: 120, rows: 40 },
  output: { head: 0, tail: 0 },
  ...overrides,
})

const added = (sessionID: string, id: string): SyncEvent => ({
  type: "persistent-pty.added",
  properties: { sessionID, terminal: terminal(id, sessionID) },
})

const removed = (sessionID: string, ptyID: string): SyncEvent => ({
  type: "persistent-pty.removed",
  properties: { sessionID, ptyID },
})

const ids = (): string[] => [...usePersistentPtysStore.getState().byId.keys()].sort()
const stateOf = (id: string) => {
  const pty = usePersistentPtysStore.getState().byId.get(id)
  return pty ? agentTerminalState(pty) : undefined
}

/** A removal that resolves when the test says so, to order it against the removal event. */
const deferredRemoval = () => {
  const calls: string[] = []
  let finish: () => void = () => undefined
  const remove = (ptyID: string) => {
    calls.push(ptyID)
    return new Promise<void>((done) => { finish = done })
  }
  return { calls, remove, finish: () => finish() }
}

const stillRunning = async (ptyID: string) => terminal(ptyID, "ses_a")

describe("persistent PTY index", () => {
  beforeEach(() => {
    resetPersistentPtys()
  })

  test("added terminals carry the directory they were announced in, removed ones leave", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1"), added("ses_a", "pty_2")])
    expect(ids()).toEqual(["pty_1", "pty_2"])
    expect(usePersistentPtysStore.getState().byId.get("pty_1")?.directory).toBe("/repo")

    applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1")])
    expect(ids()).toEqual(["pty_2"])
  })

  test("a session's list read replaces only that session's terminals", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_old"), added("ses_b", "pty_b")])

    replaceSessionTerminals("ses_a", "/repo", [terminal("pty_new", "ses_a")], persistentPtyRevision())

    expect(ids()).toEqual(["pty_b", "pty_new"])
  })

  test("events that are not terminal events leave the index untouched", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const before = usePersistentPtysStore.getState().byId

    applyPersistentPtyEvents("/repo", [{ type: "vcs.branch.updated", properties: {} }])

    expect(usePersistentPtysStore.getState().byId).toBe(before)
  })
})

describe("how a terminal ended", () => {
  beforeEach(() => {
    resetPersistentPtys()
  })

  test("a list read learns that a terminal exited, with its code when the process left one", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_failed"), added("ses_a", "pty_signal"), added("ses_a", "pty_live")])
    expect(stateOf("pty_failed")).toEqual({ kind: "running" })

    await refreshSessionTerminals("ses_a", "/repo", async () => [
      terminal("pty_failed", "ses_a", { status: "exited", exitCode: 2 }),
      terminal("pty_signal", "ses_a", { status: "exited" }),
      terminal("pty_live", "ses_a"),
    ])

    expect(stateOf("pty_failed")).toEqual({ kind: "exited", exitCode: 2 })
    expect(stateOf("pty_signal")).toEqual({ kind: "exited" })
    expect(stateOf("pty_live")).toEqual({ kind: "running" })
  })

  test("a list read that brings nothing new publishes nothing", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const before = usePersistentPtysStore.getState().byId

    await refreshSessionTerminals("ses_a", "/repo", async () => [terminal("pty_1", "ses_a", { output: { head: 0, tail: 512 } })])

    expect(usePersistentPtysStore.getState().byId).toBe(before)
  })

  test("a list read keeps what an event said after the read started", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const since = persistentPtyRevision()
    applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1"), added("ses_a", "pty_2")])

    // The read started before both events: it still lists pty_1 and not pty_2.
    replaceSessionTerminals("ses_a", "/repo", [terminal("pty_1", "ses_a")], since)

    expect(ids()).toEqual(["pty_2"])
  })

  test("the user's stop keeps the terminal as stopped, whether OpenCode's removal event comes first, later or never", async () => {
    for (const order of ["event first", "event later", "no event"] as const) {
      resetPersistentPtys()
      applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
      const removal = deferredRemoval()
      const stopping = stopAgentTerminal("pty_1", stillRunning, removal.remove)
      await Promise.resolve()
      await Promise.resolve()
      expect(removal.calls).toEqual(["pty_1"])

      if (order === "event first") applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1")])
      removal.finish()
      await stopping
      if (order === "event later") applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1")])

      expect({ order, state: stateOf("pty_1") }).toEqual({ order, state: { kind: "stopped" } })
    }
  })

  test("a terminal that exited before the stop keeps its exit and is not removed", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const removal = deferredRemoval()

    await stopAgentTerminal("pty_1", async () => terminal("pty_1", "ses_a", { status: "exited", exitCode: 1 }), removal.remove)

    expect(removal.calls).toEqual([])
    expect(stateOf("pty_1")).toEqual({ kind: "exited", exitCode: 1 })
  })

  test("a failed removal rejects and leaves the terminal running", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])

    await expect(stopAgentTerminal("pty_1", stillRunning, async () => {
      throw new Error("offline")
    })).rejects.toThrow("offline")

    expect(stateOf("pty_1")).toEqual({ kind: "running" })
  })

  test("a list read while the stop is in flight leaves the terminal to the stop", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const removal = deferredRemoval()
    const stopping = stopAgentTerminal("pty_1", stillRunning, removal.remove)
    await Promise.resolve()
    await Promise.resolve()

    // OpenCode already removed it; the list read lands before the stop settles.
    replaceSessionTerminals("ses_a", "/repo", [], persistentPtyRevision())
    removal.finish()
    await stopping

    expect(stateOf("pty_1")).toEqual({ kind: "stopped" })
  })

  test("a removal nobody here asked for drops the terminal", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1")])
    expect(ids()).toEqual([])
  })

  test("a stopped terminal stays through later list reads until dismissed, without asking OpenCode", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    await stopAgentTerminal("pty_1", stillRunning, async () => undefined)
    replaceSessionTerminals("ses_a", "/repo", [], persistentPtyRevision())
    expect(stateOf("pty_1")).toEqual({ kind: "stopped" })

    const removal = deferredRemoval()
    await dismissAgentTerminal("pty_1", removal.remove)
    expect(removal.calls).toEqual([])
    expect(ids()).toEqual([])
  })

  test("dismissing an exited terminal removes it in OpenCode first; a failed removal keeps the row", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    replaceSessionTerminals("ses_a", "/repo", [terminal("pty_1", "ses_a", { status: "exited", exitCode: 0 })], persistentPtyRevision())

    await expect(dismissAgentTerminal("pty_1", async () => {
      throw new Error("offline")
    })).rejects.toThrow("offline")
    expect(ids()).toEqual(["pty_1"])

    const removed: string[] = []
    await dismissAgentTerminal("pty_1", async (ptyID) => { removed.push(ptyID) })
    expect(removed).toEqual(["pty_1"])
    expect(ids()).toEqual([])
  })

  test("a runtime switch forgets every terminal, and a read from before it does not commit", async () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    let answer: (terminals: PersistentPtyInfo[]) => void = () => undefined
    const reading = refreshSessionTerminals("ses_a", "/repo", () => new Promise((done) => { answer = done }))

    resetPersistentPtys()
    expect(ids()).toEqual([])
    answer([terminal("pty_stale", "ses_a")])
    await reading

    expect(ids()).toEqual([])
  })
})
