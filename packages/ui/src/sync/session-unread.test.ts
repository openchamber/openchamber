import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSessionUnread, isSessionUnreadWithError, markSessionUnreadSeen } from "./session-unread"

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
})
