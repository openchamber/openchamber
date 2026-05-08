import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { getApexSessionId, getApexUserActivityMap, useSessionUserActivityStore } from "./session-user-activity-store"

const session = (id: string, parentID?: string | null): Session => ({
  id,
  title: id,
  parentID: parentID ?? null,
  time: { created: 0, updated: 0, archived: 0 },
}) as unknown as Session

describe("session-user-activity-store", () => {
  beforeEach(() => {
    useSessionUserActivityStore.setState({ bySessionId: new Map(), resolvedSessionIds: new Set() })
  })

  test("records newer user timestamps only", () => {
    const store = useSessionUserActivityStore.getState()
    store.recordUserMessageAt("s-1", 100)
    const afterFirst = useSessionUserActivityStore.getState().bySessionId
    store.recordUserMessageAt("s-1", 90)
    const afterOlder = useSessionUserActivityStore.getState().bySessionId

    expect(afterFirst.get("s-1")).toBe(100)
    expect(afterOlder).toBe(afterFirst)
    expect(useSessionUserActivityStore.getState().resolvedSessionIds.has("s-1")).toBe(true)
  })

  test("reconciles from messages and removes entry when user messages are gone", () => {
    const store = useSessionUserActivityStore.getState()
    store.recordUserMessageAt("s-1", 120)

    const withUsers = [
      { id: "m-1", role: "assistant", time: { created: 130 } },
      { id: "m-2", role: "user", time: { created: 110 } },
      { id: "m-3", role: "user", time: { created: 140 } },
    ] as Message[]
    store.reconcileSessionFromMessages("s-1", withUsers)

    expect(useSessionUserActivityStore.getState().bySessionId.get("s-1")).toBe(140)

    const withoutUsers = [
      { id: "m-4", role: "assistant", time: { created: 150 } },
    ] as Message[]
    store.reconcileSessionFromMessages("s-1", withoutUsers)

    expect(useSessionUserActivityStore.getState().bySessionId.has("s-1")).toBe(false)
    expect(useSessionUserActivityStore.getState().resolvedSessionIds.has("s-1")).toBe(true)
  })

  test("invalidates stale activity when messages need reloading", () => {
    const store = useSessionUserActivityStore.getState()
    store.recordUserMessageAt("s-1", 120)

    store.invalidateSession("s-1")

    const state = useSessionUserActivityStore.getState()
    expect(state.bySessionId.has("s-1")).toBe(false)
    expect(state.resolvedSessionIds.has("s-1")).toBe(false)
  })

  test("resolves child sessions to the apex session", () => {
    const sessions = new Map([
      ["root", session("root")],
      ["child", session("child", "root")],
      ["grandchild", session("grandchild", "child")],
    ])

    expect(getApexSessionId("grandchild", sessions)).toBe("root")
  })

  test("aggregates child user activity onto the apex session", () => {
    const activity = getApexUserActivityMap(
      [session("root"), session("child", "root"), session("other")],
      new Map([["root", 100], ["child", 300], ["other", 200]]),
    )

    expect(activity.get("root")).toBe(300)
    expect(activity.get("other")).toBe(200)
  })
})
