import { beforeEach, describe, expect, mock, test } from "bun:test"

const runtimeFetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
let runtimeFetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> =
  async () => new Response(null, { status: 200 })

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: (input: string | URL | Request, init?: RequestInit) => {
    runtimeFetchCalls.push({ input, init })
    return runtimeFetchImpl(input, init)
  },
}))

import {
  appendNotification,
  applySessionAttentionEvent,
  hydrateSessionAttentionState,
  resetSessionViewReceiptThrottleForTests,
  useNotificationStore,
} from "./notification-store"

const emptyIndex = () => ({
  session: { unseenCount: {}, unseenHasError: {} },
  project: { unseenCount: {}, unseenHasError: {} },
})

describe("notification store attention sync", () => {
  const baseTime = Date.now()

  beforeEach(() => {
    runtimeFetchCalls.length = 0
    runtimeFetchImpl = async () => new Response(null, { status: 200 })
    resetSessionViewReceiptThrottleForTests()
    useNotificationStore.setState({ list: [], index: emptyIndex() })
  })

  test("viewed notifications send a throttled read receipt", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_viewed_append",
      time: baseTime + 50,
      viewed: true,
    })
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_viewed_append",
      time: baseTime + 60,
      viewed: true,
      error: { message: "same burst" },
    })

    expect(runtimeFetchCalls).toHaveLength(1)
    expect(String(runtimeFetchCalls[0]?.input)).toBe("/api/sessions/ses_viewed_append/view")
    expect(runtimeFetchCalls[0]?.init?.method).toBe("POST")
  })

  test("clears only notifications at or before the synced read timestamp", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: baseTime + 100,
      viewed: false,
    })
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_1",
      time: baseTime + 300,
      viewed: false,
      error: { message: "late" },
    })

    applySessionAttentionEvent({
      type: "openchamber:session-attention",
      properties: {
        sessionID: "ses_1",
        needsAttention: false,
        lastReadAt: baseTime + 200,
        timestamp: baseTime + 200,
      },
    })

    const list = useNotificationStore.getState().list
    expect(list).toHaveLength(2)
    expect(list[0]?.session).toBe("ses_1")
    expect(list[0]?.time).toBe(baseTime + 100)
    expect(list[0]?.viewed).toBe(true)
    expect(list[1]?.session).toBe("ses_1")
    expect(list[1]?.time).toBe(baseTime + 300)
    expect(list[1]?.viewed).toBe(false)
    expect(useNotificationStore.getState().sessionUnseenCount("ses_1")).toBe(1)
  })

  test("remote attention clears do not send a local read receipt", () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: baseTime + 100,
      viewed: false,
    })

    applySessionAttentionEvent({
      type: "openchamber:session-attention",
      properties: {
        sessionID: "ses_1",
        needsAttention: false,
        lastReadAt: baseTime + 100,
        timestamp: baseTime + 100,
      },
    })

    expect(runtimeFetchCalls).toHaveLength(0)
    expect(useNotificationStore.getState().sessionUnseenCount("ses_1")).toBe(0)
  })

  test("hydrates read state conservatively from the server snapshot", async () => {
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: baseTime + 100,
      viewed: false,
    })
    appendNotification({
      type: "turn-complete",
      directory: "/repo",
      session: "ses_1",
      time: baseTime + 400,
      viewed: false,
    })
    appendNotification({
      type: "error",
      directory: "/repo",
      session: "ses_2",
      time: baseTime + 150,
      viewed: false,
      error: { message: "still unread" },
    })

    runtimeFetchImpl = async () => new Response(JSON.stringify({
      sessions: {
        ses_1: {
          needsAttention: false,
          lastReadAt: baseTime + 250,
          timestamp: baseTime + 250,
        },
        ses_2: {
          needsAttention: true,
          lastReadAt: baseTime + 999,
          timestamp: baseTime + 999,
        },
        ses_3: {
          needsAttention: false,
          lastReadAt: baseTime + 999,
          timestamp: baseTime + 999,
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

    await hydrateSessionAttentionState()

    expect(runtimeFetchCalls).toHaveLength(1)
    expect(String(runtimeFetchCalls[0]?.input)).toBe("/api/sessions/attention")
    const list = useNotificationStore.getState().list
    expect(list).toHaveLength(3)
    expect(list[0]?.session).toBe("ses_1")
    expect(list[0]?.time).toBe(baseTime + 100)
    expect(list[0]?.viewed).toBe(true)
    expect(list[1]?.session).toBe("ses_1")
    expect(list[1]?.time).toBe(baseTime + 400)
    expect(list[1]?.viewed).toBe(false)
    expect(list[2]?.session).toBe("ses_2")
    expect(list[2]?.time).toBe(baseTime + 150)
    expect(list[2]?.viewed).toBe(false)
    expect(useNotificationStore.getState().sessionUnseenCount("ses_1")).toBe(1)
    expect(useNotificationStore.getState().sessionUnseenCount("ses_2")).toBe(1)
  })
})
