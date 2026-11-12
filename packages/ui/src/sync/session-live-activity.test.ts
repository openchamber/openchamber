import { describe, expect, spyOn, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "./child-store"
import { getSessionLiveActivity, readSessionsLiveActivity, setActionRefs } from "./session-actions"
import { useGlobalSessionsStore } from "../stores/useGlobalSessionsStore"
import { replaceGlobalSessionStatusById } from "./global-session-status"

const session: Session = {
  id: "activity-session", directory: "/tree", projectID: "project",
  title: "Activity", time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("session live activity during initialization", () => {
  test("list coverage remains unknown until a live idle event or a successful status snapshot arrives", () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/tree", { bootstrap: false })
    setActionRefs(manager, () => "/tree")
    useGlobalSessionsStore.getState().applySnapshot([session], [])
    store.setState({ session: [session], sessionListSource: "authoritative" })
    try {
      expect(getSessionLiveActivity(session.id)).toBe("unknown")
      store.setState({ session_status: { [session.id]: { type: "idle" } } })
      expect(getSessionLiveActivity(session.id)).toBe("idle")
      store.setState({ session_status: { [session.id]: { type: "busy" } } })
      expect(getSessionLiveActivity(session.id)).toBe("active")
      store.setState({ session_status: {}, sessionStatusReady: true })
      expect(getSessionLiveActivity(session.id)).toBe("idle")
    } finally {
      manager.disposeAll()
      useGlobalSessionsStore.getState().resetForRuntimeSwitch()
      replaceGlobalSessionStatusById(new Map())
    }
  })

  test("a parent repository's initialized store cannot prove a worktree session idle", () => {
    const manager = new ChildStoreManager()
    const parent = manager.ensureChild("/repo", { bootstrap: false })
    const worktree = manager.ensureChild("/tree", { bootstrap: false })
    setActionRefs(manager, () => "/repo")
    useGlobalSessionsStore.getState().applySnapshot([session], [])
    parent.setState({ session: [session], sessionStatusReady: true })
    worktree.setState({ session: [session], sessionListSource: "authoritative" })
    try {
      expect(getSessionLiveActivity(session.id)).toBe("unknown")
      worktree.setState({ sessionStatusReady: true })
      expect(getSessionLiveActivity(session.id)).toBe("idle")
    } finally {
      manager.disposeAll()
      useGlobalSessionsStore.getState().resetForRuntimeSwitch()
      replaceGlobalSessionStatusById(new Map())
    }
  })
})

describe("readSessionsLiveActivity", () => {
  const readWith = async (
    snapshot: Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>,
    prepare?: (store: ReturnType<ChildStoreManager["ensureChild"]>) => void,
  ) => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/tree", { bootstrap: false })
    setActionRefs(manager, () => "/tree")
    useGlobalSessionsStore.getState().applySnapshot([session], [])
    prepare?.(store)
    const read = spyOn(opencodeClient, "getActiveSessionStatuses").mockImplementation(async () => snapshot)
    try {
      return { activity: await readSessionsLiveActivity([session.id], "/tree"), askedDirectories: read.mock.calls.map(([directory]) => directory) }
    } finally {
      read.mockRestore()
      manager.disposeAll()
      useGlobalSessionsStore.getState().resetForRuntimeSwitch()
      replaceGlobalSessionStatusById(new Map())
    }
  }

  test("a successful read settles a session no store has a status for", async () => {
    expect(await readWith({})).toEqual({ activity: "idle", askedDirectories: ["/tree"] })
    expect(await readWith({ [session.id]: { type: "busy" } })).toEqual({ activity: "active", askedDirectories: ["/tree"] })
  })

  test("a failed read stays unknown", async () => {
    expect(await readWith(null)).toEqual({ activity: "unknown", askedDirectories: ["/tree"] })
  })

  test("stores that already answer need no read", async () => {
    expect(await readWith(null, (store) => store.setState({ session_status: { [session.id]: { type: "idle" } } })))
      .toEqual({ activity: "idle", askedDirectories: [] })
    expect(await readWith(null, (store) => store.setState({ session_status: { [session.id]: { type: "busy" } } })))
      .toEqual({ activity: "active", askedDirectories: [] })
  })
})
