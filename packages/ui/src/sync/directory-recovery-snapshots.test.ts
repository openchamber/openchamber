import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import type { PermissionRequest, FormRequest, Session } from "@/lib/opencode/model"
import { INITIAL_STATE, type State } from "./types"
import {
  readDirectoryPermissionSnapshot,
  readDirectoryFormSnapshot,
  readDirectoryStatusSnapshot,
  recordDirectoryRecoveryEvent,
} from "./directory-recovery-snapshots"
import { ChildStoreManager } from "./child-store"
import { createEventRoutingIndex, handleEvent } from "./sync-context"
import { getRuntimeKey } from "../lib/runtime-switch"
import { replaceGlobalSessionStatusById } from "./global-session-status"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { resolve, promise }
}
const source = (initial: Partial<State> = {}) => createStore<State>(() => ({ ...INITIAL_STATE, ...initial }))
const permission: PermissionRequest = { id: "permission", sessionID: "session", action: "read", resources: ["*"], metadata: {} }
const form: FormRequest = { id: "form", sessionID: "session", title: "Pick", fields: [{ key: "answer", type: "boolean" }] }
const session: Session = {
  id: "session", projectID: "project", directory: "/repo",
  title: "Session", time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("directory recovery snapshots", () => {
  test("the event pipeline preserves repeated busy events without publishing a redundant store update", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [session], session_status: { session: { type: "busy" } } })
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications += 1 })
    try {
      handleEvent("/repo", { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } },
        manager, createEventRoutingIndex(), getRuntimeKey(), true)
      response.resolve({})
      expect(await snapshot).toEqual({ session: { type: "busy" } })
      expect(publications).toBe(0)
    } finally {
      response.resolve({})
      unsubscribe()
      manager.disposeAll()
      replaceGlobalSessionStatusById(new Map())
    }
  })

  test("a newer idle event cannot be overwritten by an old busy snapshot", async () => {
    const store = source()
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "session.idle", properties: { sessionID: "session" } })
    response.resolve({ session: { type: "busy" } })
    expect(await snapshot).toEqual({ session: { type: "idle" } })
  })

  test("an archive event rejected by the reducer cannot erase pending requests from a snapshot", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [{ ...session, time: { created: 1, updated: 20 } }] })
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    try {
      handleEvent("/repo", {
        type: "session.patched",
        properties: { sessionID: session.id, patch: { time: { updated: 10, archived: 10 } } },
      }, manager, createEventRoutingIndex(), getRuntimeKey(), true, undefined, undefined, true)
      response.resolve([permission])
      expect(await snapshot).toEqual({ session: [permission] })
      expect(store.getState().session[0].time.archived).toBeUndefined()
    } finally {
      response.resolve([])
      manager.disposeAll()
    }
  })

  test("equal session IDs in different stores do not share in-flight events", async () => {
    const a = source()
    const b = source()
    const response = deferred<State["session_status"]>()
    const first = readDirectoryStatusSnapshot(a, () => response.promise)
    const second = readDirectoryStatusSnapshot(b, () => response.promise)
    recordDirectoryRecoveryEvent(a, { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    response.resolve({})
    expect(await first).toEqual({ session: { type: "busy" } })
    expect(await second).toEqual({})
  })

  test("a permission reply received before its ask is materialized prevents resurrection", async () => {
    const store = source()
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "permission.replied", properties: { sessionID: "session", requestID: permission.id } })
    response.resolve([permission])
    expect(await snapshot).toEqual({})
  })

  test("a settled form cannot be reopened by an old HTTP response", async () => {
    const store = source()
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "form.settled", properties: { sessionID: "session", formID: form.id } })
    response.resolve([form])
    expect(await snapshot).toEqual({})
  })

  test("new asks survive empty snapshots and supersede older copies of the same request", async () => {
    const store = source()
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    const newer: FormRequest = { ...form, title: "Proceed?" }
    recordDirectoryRecoveryEvent(store, { type: "form.created", properties: { form: newer } })
    response.resolve([form])
    expect(await snapshot).toEqual({ session: [newer] })
    const permissionSnapshot = readDirectoryPermissionSnapshot(store, async () => [])
    recordDirectoryRecoveryEvent(store, { type: "permission.asked", properties: permission })
    expect(await permissionSnapshot).toEqual({ session: [permission] })
  })

  test("direct local mutations survive while unchanged stale requests are removed", async () => {
    const store = source({ form: { session: [form] } })
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    const added = { ...form, id: "new-form" }
    store.setState({ form: { session: [form, added] } })
    response.resolve([])
    expect(await snapshot).toEqual({ session: [added] })
  })

  test("deleting a session invalidates its status and blocking requests in every in-flight snapshot", async () => {
    const store = source()
    const statusResponse = deferred<State["session_status"]>()
    const permissionResponse = deferred<PermissionRequest[]>()
    const formResponse = deferred<FormRequest[]>()
    const statuses = readDirectoryStatusSnapshot(store, () => statusResponse.promise)
    const permissions = readDirectoryPermissionSnapshot(store, () => permissionResponse.promise)
    const forms = readDirectoryFormSnapshot(store, () => formResponse.promise)
    recordDirectoryRecoveryEvent(store, { type: "session.deleted", properties: { sessionID: session.id } })
    statusResponse.resolve({ session: { type: "busy" } })
    permissionResponse.resolve([permission])
    formResponse.resolve([form])
    expect(await statuses).toEqual({})
    expect(await permissions).toEqual({})
    expect(await forms).toEqual({})
  })

  test("failed reads leave no event history for a later successful snapshot", async () => {
    const store = source()
    for (let index = 0; index < 100; index += 1) {
      await expect(readDirectoryStatusSnapshot(store, async () => { throw new Error("offline") })).rejects.toThrow("offline")
      recordDirectoryRecoveryEvent(store, { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    }
    expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
  })
})
