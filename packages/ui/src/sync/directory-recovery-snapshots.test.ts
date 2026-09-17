import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import {
  readDirectoryPermissionSnapshot,
  readDirectoryQuestionSnapshot,
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
const permission: PermissionRequest = { id: "permission", sessionID: "session", permission: "read", patterns: ["*"], metadata: {}, always: [] }
const question: QuestionRequest = { id: "question", sessionID: "session", questions: [] }
const session: Session = {
  id: "session", projectID: "project", slug: "session", directory: "/repo",
  title: "Session", version: "1", time: { created: 1, updated: 1 },
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
      handleEvent("/repo", { id: "event-busy", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } },
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
    recordDirectoryRecoveryEvent(store, { id: "event-idle", type: "session.idle", properties: { sessionID: "session" } })
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
        id: "old-archive", type: "session.updated",
        properties: { sessionID: session.id, info: { ...session, time: { created: 1, updated: 10, archived: 10 } } },
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
    recordDirectoryRecoveryEvent(a, { id: "event-busy", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    response.resolve({})
    expect(await first).toEqual({ session: { type: "busy" } })
    expect(await second).toEqual({})
  })

  test("a permission reply received before its ask is materialized prevents resurrection", async () => {
    const store = source()
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-replied", type: "permission.replied", properties: { sessionID: "session", requestID: permission.id, reply: "once" } })
    response.resolve([permission])
    expect(await snapshot).toEqual({})
  })

  test("a question reply prevents an old HTTP response from reopening it", async () => {
    const store = source()
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-replied", type: "question.replied", properties: { sessionID: "session", requestID: question.id, answers: [] } })
    response.resolve([question])
    expect(await snapshot).toEqual({})
  })

  test("new asks survive empty snapshots and supersede older copies of the same request", async () => {
    const store = source()
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    const newer: QuestionRequest = { ...question, questions: [{ question: "Proceed?", header: "Confirm", options: [] }] }
    recordDirectoryRecoveryEvent(store, { id: "event-asked", type: "question.asked", properties: newer })
    response.resolve([question])
    expect(await snapshot).toEqual({ session: [newer] })
    const permissionSnapshot = readDirectoryPermissionSnapshot(store, async () => [])
    recordDirectoryRecoveryEvent(store, { id: "event-asked", type: "permission.asked", properties: permission })
    expect(await permissionSnapshot).toEqual({ session: [permission] })
  })

  test("direct local mutations survive while unchanged stale requests are removed", async () => {
    const store = source({ question: { session: [question] } })
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    const added = { ...question, id: "new-question" }
    store.setState({ question: { session: [question, added] } })
    response.resolve([])
    expect(await snapshot).toEqual({ session: [added] })
  })

  test("deleting a session invalidates its status and blocking requests in every in-flight snapshot", async () => {
    const store = source()
    const statusResponse = deferred<State["session_status"]>()
    const permissionResponse = deferred<PermissionRequest[]>()
    const questionResponse = deferred<QuestionRequest[]>()
    const statuses = readDirectoryStatusSnapshot(store, () => statusResponse.promise)
    const permissions = readDirectoryPermissionSnapshot(store, () => permissionResponse.promise)
    const questions = readDirectoryQuestionSnapshot(store, () => questionResponse.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-deleted", type: "session.deleted", properties: { sessionID: session.id, info: session } })
    statusResponse.resolve({ session: { type: "busy" } })
    permissionResponse.resolve([permission])
    questionResponse.resolve([question])
    expect(await statuses).toEqual({})
    expect(await permissions).toEqual({})
    expect(await questions).toEqual({})
  })

  test("failed reads leave no event history for a later successful snapshot", async () => {
    const store = source()
    for (let index = 0; index < 100; index += 1) {
      await expect(readDirectoryStatusSnapshot(store, async () => { throw new Error("offline") })).rejects.toThrow("offline")
      recordDirectoryRecoveryEvent(store, { id: `event-${index}`, type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    }
    expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
  })
})
