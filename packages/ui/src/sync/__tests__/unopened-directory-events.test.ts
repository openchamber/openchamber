import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from "../global-session-status"
import { useNotificationStore } from "../notification-store"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"

// Only the directory being worked in is bootstrapped, so every other project
// has no directory store. Its sessions still need unread dots and correctly
// routed events.

const session = (id: string, directory: string, parentID?: string): Session => {
  const record: Session = {
    id, directory, projectID: "project", title: id,
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  if (parentID) record.parentID = parentID
  return record
}

const resetNotifications = () => {
  useNotificationStore.setState({
    list: [],
    index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } },
  })
}

describe("events for directories without a store", () => {
  let childStores: ChildStoreManager

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    useGlobalSessionsStore.getState().applySnapshot([
      session("ses_far", "/far"),
      session("ses_far_child", "/far", "ses_far"),
    ], [], "ready")
    resetNotifications()
    replaceGlobalSessionStatusById(new Map())
  })

  afterEach(() => {
    childStores.disposeAll()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    resetNotifications()
    replaceGlobalSessionStatusById(new Map())
  })

  test("a turn finishing in an unopened directory records an unread notification", () => {
    const routingIndex = createEventRoutingIndex()
    const idle: SyncEvent = { type: "session.idle", properties: { sessionID: "ses_far" } }
    const error: SyncEvent = {
      type: "session.error",
      properties: { sessionID: "ses_far", error: { type: "UnknownError", message: "boom" } },
    }

    handleEvent("/far", idle, childStores, routingIndex, getRuntimeKey())
    handleEvent("/far", error, childStores, routingIndex, getRuntimeKey())

    const index = useNotificationStore.getState().index
    expect(index.session.unseenCount.ses_far).toBe(2)
    expect(index.session.unseenHasError.ses_far).toBe(true)
    expect(index.project.unseenCount["/far"]).toBe(2)
    expect(childStores.getChild("/far")).toBeUndefined()
  })

  test("a subtask finishing in an unopened directory is not a notification", () => {
    const routingIndex = createEventRoutingIndex()
    handleEvent("/far", { type: "session.idle", properties: { sessionID: "ses_far_child" } },
      childStores, routingIndex, getRuntimeKey())

    expect(useNotificationStore.getState().list).toEqual([])
  })

  test("a directory-less status event for a cached session is not filed into the only open store", () => {
    const routingIndex = createEventRoutingIndex()
    const open = childStores.getChild("/open")!
    handleEvent("global", { type: "session.status", properties: { sessionID: "ses_far", status: { type: "busy" } } },
      childStores, routingIndex, getRuntimeKey())

    expect(open.getState().session_status.ses_far).toBeUndefined()
    expect(useGlobalSessionStatusStore.getState().statusById.get("ses_far")).toEqual({ status: { type: "busy" }, directory: "/far" })
  })

  test("a directory-less event for an unknown session still uses the single-store fallback", () => {
    const routingIndex = createEventRoutingIndex()
    const open = childStores.getChild("/open")!
    handleEvent("global", { type: "session.status", properties: { sessionID: "ses_new", status: { type: "busy" } } },
      childStores, routingIndex, getRuntimeKey())

    expect(open.getState().session_status.ses_new).toEqual({ type: "busy" })
  })
})
