import { beforeEach, describe, expect, test } from "bun:test"
import { useNotificationStore } from "./notification-store"
import { switchRuntimeEndpoint } from "@/lib/runtime-switch"

describe("failure notifications", () => {
  beforeEach(() => useNotificationStore.setState({ list: [] }))

  test("an older replay cannot replace a newer failure for the same session", () => {
    const now = Date.now()
    const current = { session: "ses_1", time: now, error: { name: null, message: "current" } }
    useNotificationStore.getState().append(current)
    useNotificationStore.getState().append({ session: "ses_1", time: now - 1000, error: { name: null, message: "old" } })
    expect(useNotificationStore.getState().list.at(-1)).toEqual(current)
    const other = { session: "ses_2", time: now - 1000 }
    useNotificationStore.getState().append(other)
    expect(useNotificationStore.getState().list).toEqual([current, other])
  })

  test("a different runtime can report an older failure for the same session id", () => {
    const now = Date.now()
    switchRuntimeEndpoint({ apiBaseUrl: "http://failure-a.test", runtimeKey: "failure-a" })
    useNotificationStore.getState().append({ session: "ses_1", time: now })
    switchRuntimeEndpoint({ apiBaseUrl: "http://failure-b.test", runtimeKey: "failure-b" })
    const otherRuntime = { session: "ses_1", time: now - 1000 }
    useNotificationStore.getState().append(otherRuntime)
    expect(useNotificationStore.getState().list).toEqual([otherRuntime])
  })
})
