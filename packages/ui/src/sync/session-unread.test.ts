import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import * as metadataRoute from "./session-archive-batch"
import {
  getUnreadSessionIds,
  isSessionMarkedUnread,
  isSessionUnread,
  isSessionUnreadWithError,
  markSessionsUnreadSeen,
  markSessionUnread,
  markSessionUnreadSeen,
  releaseKeptUnreadMarks,
} from "./session-unread"

const session = (id: string, time: Partial<Session["time"]> = {}, extra: Partial<Session> = {}): Session => ({
  id, directory: "/repo", projectID: "project", title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, ...time },
  ...extra,
})

const record = (id: string) => useGlobalSessionsStore.getState().entityById.get(id)

describe("isSessionUnread", () => {
  test("a finished turn nobody has seen is unread until a view reaches it", () => {
    expect(isSessionUnread(session("a"))).toBe(false)
    expect(isSessionUnread(session("a", { idle: 10 }))).toBe(true)
    expect(isSessionUnread(session("a", { idle: 10, viewed: 5 }))).toBe(true)
    expect(isSessionUnread(session("a", { idle: 10, viewed: 10 }))).toBe(false)
    expect(isSessionUnread(undefined)).toBe(false)
  })

  test("subtasks and archived sessions are never unread", () => {
    expect(isSessionUnread(session("child", { idle: 10 }, { parentID: "parent" }))).toBe(false)
    expect(isSessionUnread(session("a", { idle: 10, archived: 20 }))).toBe(false)
  })

  test("an unread failed turn carries the error mark", () => {
    expect(isSessionUnreadWithError(session("a", { idle: 10 }, { outcome: "failed" }))).toBe(true)
    expect(isSessionUnreadWithError(session("a", { idle: 10 }, { outcome: "succeeded" }))).toBe(false)
    expect(isSessionUnreadWithError(session("a", { idle: 10, viewed: 10 }, { outcome: "failed" }))).toBe(false)
  })
})

describe("markSessionUnreadSeen", () => {
  let view = spyOn(opencodeClient, "viewSession")

  beforeEach(() => {
    view = spyOn(opencodeClient, "viewSession")
    useGlobalSessionsStore.getState().applySnapshot([session("a", { idle: 10, viewed: 5 })], [], "ready")
  })

  afterEach(() => {
    view.mockRestore()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  test("clears the mark at once and records the view in OpenCode once", async () => {
    view.mockResolvedValue(undefined)
    markSessionUnreadSeen("a")
    markSessionUnreadSeen("a")
    expect(record("a")?.time.viewed).toBe(10)
    expect(view.mock.calls).toEqual([["a", 10, "/repo"]])
    await Promise.resolve()
    expect(isSessionUnread(record("a"))).toBe(false)
  })

  test("a failed write brings the mark back", async () => {
    let reject: (error: Error) => void = () => undefined
    view.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    markSessionUnreadSeen("a")
    expect(isSessionUnread(record("a"))).toBe(false)
    reject(new Error("offline"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record("a")?.time.viewed).toBe(5)
    expect(isSessionUnread(record("a"))).toBe(true)
  })

  test("a failed write leaves a newer turn's state alone", async () => {
    let reject: (error: Error) => void = () => undefined
    view.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    markSessionUnreadSeen("a")
    // Another device saw a later turn before this write failed.
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 20, viewed: 20, updated: 2 }))
    reject(new Error("offline"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record("a")?.time.viewed).toBe(20)
  })

  test("a session that is already seen sends nothing", () => {
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 10, viewed: 10, updated: 2 }))
    markSessionUnreadSeen("a")
    markSessionUnreadSeen("missing")
    expect(view.mock.calls).toEqual([])
  })

  test("marking all clears every unread mark in one store update and records each view", () => {
    view.mockResolvedValue(undefined)
    useGlobalSessionsStore.getState().upsertSessions([
      session("b", { idle: 30 }),
      session("c", { idle: 40, viewed: 40 }),
    ])
    let updates = 0
    const unsubscribe = useGlobalSessionsStore.subscribe(() => { updates += 1 })
    const marked = markSessionsUnreadSeen(getUnreadSessionIds())
    unsubscribe()
    expect(marked.sort()).toEqual(["a", "b"])
    expect(updates).toBe(1)
    expect(getUnreadSessionIds()).toEqual([])
    expect(view.mock.calls.sort()).toEqual([["a", 10, "/repo"], ["b", 30, "/repo"]])
  })
})

const marked = (at = 50) => ({ metadata: { openchamber: { markedUnread: { at } } } })

describe("sessions the user marked unread", () => {
  let view = spyOn(opencodeClient, "viewSession")
  let update = spyOn(metadataRoute, "requestSessionMetadataUpdate")

  beforeEach(() => {
    view = spyOn(opencodeClient, "viewSession").mockResolvedValue(undefined)
    update = spyOn(metadataRoute, "requestSessionMetadataUpdate")
      .mockImplementation(async (_id, patch) => ({ outcome: "updated", metadata: patch }))
    releaseKeptUnreadMarks()
    useGlobalSessionsStore.getState().applySnapshot([session("a", { idle: 10, viewed: 10 })], [], "ready")
  })

  afterEach(() => {
    view.mockRestore()
    update.mockRestore()
    releaseKeptUnreadMarks()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  test("a mark makes a read session unread, without the failed-turn mark", () => {
    expect(isSessionUnread(session("a", { idle: 10, viewed: 10 }, marked()))).toBe(true)
    expect(isSessionMarkedUnread(session("a", { idle: 10, viewed: 10 }, marked()))).toBe(true)
    expect(isSessionUnreadWithError(session("a", { idle: 10, viewed: 10 }, { ...marked(), outcome: "failed" }))).toBe(false)
    expect(isSessionUnread(session("child", {}, { ...marked(), parentID: "parent" }))).toBe(false)
    expect(isSessionUnread(session("a", { archived: 20 }, marked()))).toBe(false)
  })

  test("marking writes the mark into the session metadata and shows it at once", async () => {
    const saved = markSessionUnread("a")
    expect(isSessionMarkedUnread(record("a"))).toBe(true)
    expect(await saved).toBe(true)
    expect(update.mock.calls.length).toBe(1)
    const [id, patch, directory] = update.mock.calls[0]
    expect(id).toBe("a")
    expect(directory).toBe("/repo")
    expect(/^\{"openchamber":\{"markedUnread":\{"at":\d+\}\}\}$/.test(JSON.stringify(patch))).toBe(true)
    expect(isSessionUnread(record("a"))).toBe(true)
  })

  test("a failed write takes the mark back", async () => {
    update.mockResolvedValue({ outcome: "unavailable", reason: "offline" })
    expect(await markSessionUnread("a")).toBe(false)
    expect(isSessionUnread(record("a"))).toBe(false)
  })

  test("looking at the session keeps the mark until the user opens another one", async () => {
    await markSessionUnread("a")
    markSessionUnreadSeen("a")
    expect(isSessionMarkedUnread(record("a"))).toBe(true)
    expect(update.mock.calls.length).toBe(1)

    releaseKeptUnreadMarks()
    markSessionUnreadSeen("a")
    expect(isSessionUnread(record("a"))).toBe(false)
    expect(update.mock.calls[1]?.[1]).toEqual({ openchamber: { markedUnread: null } })
    await Promise.resolve()
    expect(isSessionUnread(record("a"))).toBe(false)
  })

  test("Mark as read clears a mark made in this window at once", async () => {
    await markSessionUnread("a")
    markSessionUnreadSeen("a", { explicit: true })
    expect(isSessionUnread(record("a"))).toBe(false)
    // Opening it later does not bring a kept mark back.
    markSessionUnreadSeen("a")
    expect(update.mock.calls.length).toBe(2)
  })

  test("a mark from another device clears when the session is opened here", () => {
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 10, viewed: 10, updated: 2 }, marked()))
    markSessionUnreadSeen("a")
    expect(isSessionUnread(record("a"))).toBe(false)
    expect(view.mock.calls).toEqual([])
    expect(update.mock.calls.map(([id, patch]) => [id, patch])).toEqual([["a", { openchamber: { markedUnread: null } }]])
  })

  test("a late answer keeps metadata another feature wrote meanwhile", async () => {
    let answer: (value: metadataRoute.SessionMetadataUpdateResult) => void = () => undefined
    update.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const saved = markSessionUnread("a")
    // A pin lands while the mark is on its way; the answer predates it.
    const current = record("a")
    if (!current) throw new Error("missing session")
    useGlobalSessionsStore.getState().upsertSession({
      ...current,
      metadata: { openchamber: { markedUnread: { at: 1 }, pinned: { at: 7 } } },
    })
    answer({ outcome: "updated", metadata: { openchamber: { markedUnread: { at: 1 } } } })
    expect(await saved).toBe(true)
    expect(record("a")?.metadata).toMatchObject({ openchamber: { pinned: { at: 7 } } })
    expect(isSessionMarkedUnread(record("a"))).toBe(true)
  })

  test("a failed clear keeps the mark without sending it again on the next view", () => {
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 10, viewed: 10, updated: 2 }, marked()))
    update.mockResolvedValue({ outcome: "unavailable", reason: "offline" })
    markSessionUnreadSeen("a")
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(isSessionMarkedUnread(record("a"))).toBe(true)
      markSessionUnreadSeen("a")
      expect(update.mock.calls.length).toBe(1)
      markSessionUnreadSeen("a", { explicit: true })
      expect(update.mock.calls.length).toBe(2)
    })
  })

  test("marking all read clears marks and unseen turns together", async () => {
    useGlobalSessionsStore.getState().upsertSessions([session("b", { idle: 30 })])
    await markSessionUnread("a")
    const cleared = markSessionsUnreadSeen(getUnreadSessionIds(), { explicit: true })
    expect(cleared.sort()).toEqual(["a", "b"])
    expect(getUnreadSessionIds()).toEqual([])
    expect(view.mock.calls).toEqual([["b", 30, "/repo"]])
  })
})
