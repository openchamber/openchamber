import { describe, expect, test } from "bun:test"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { getSessionLiveActivity, setActionRefs } from "./session-actions"
import { useGlobalSessionsStore } from "../stores/useGlobalSessionsStore"
import { replaceGlobalSessionStatusById } from "./global-session-status"

const session: Session = {
  id: "activity-session", slug: "activity-session", directory: "/tree", projectID: "project",
  title: "Activity", version: "1", time: { created: 1, updated: 1 },
}

describe("session live activity during initialization", () => {
  test("list coverage remains unknown until a live idle event or a successful status snapshot arrives", () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/tree", { bootstrap: false })
    const sdk = createOpencodeClient({ baseUrl: "https://activity.test" })
    setActionRefs(sdk, manager, () => "/tree")
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
    setActionRefs(createOpencodeClient({ baseUrl: "https://activity.test" }), manager, () => "/repo")
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
