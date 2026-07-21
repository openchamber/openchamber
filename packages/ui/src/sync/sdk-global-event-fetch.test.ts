import { describe, expect, test } from "bun:test"
import { createSdkGlobalEventFetch } from "./sdk-global-event-fetch"

type FetchCall = {
  input: RequestInfo | URL
  init?: RequestInit
}

function createRecorder() {
  const calls: FetchCall[] = []
  const fetchRuntime: typeof fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response(null, { status: 204 })
  }
  return { calls, fetchRuntime }
}

describe("createSdkGlobalEventFetch", () => {
  const canonicalUrls = [
    "https://packaged-ui.example/global/event",
    "https://packaged-ui.example/api/global/event",
    "https://remote.example/global/event",
  ]
  for (const url of canonicalUrls) {
    test(`canonicalizes the global event route from ${url}`, async () => {
      const { calls, fetchRuntime } = createRecorder()

      await createSdkGlobalEventFetch(fetchRuntime)(url)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toBe("/api/global/event")
      expect(calls[0]?.init?.method).toBe("GET")
    })
  }

  test("preserves query, headers, signal, and normalized request options", async () => {
    const { calls, fetchRuntime } = createRecorder()
    const abort = new AbortController()
    const request = new Request("https://packaged-ui.example/global/event?directory=%2Frepo&cursor=two", {
      headers: { "Last-Event-ID": "evt_42" },
      signal: abort.signal,
      cache: "no-store",
      credentials: "include",
      integrity: "sha256-test",
      keepalive: true,
      mode: "cors",
      redirect: "manual",
      referrer: "https://packaged-ui.example/source",
      referrerPolicy: "strict-origin",
    })

    await createSdkGlobalEventFetch(fetchRuntime)(request)

    expect(calls[0]?.input).toBe("/api/global/event?directory=%2Frepo&cursor=two")
    const init = calls[0]?.init
    expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("evt_42")
    const forwardedSignal = init?.signal
    expect(forwardedSignal).toBeDefined()
    expect(forwardedSignal?.aborted).toBe(false)
    expect(init?.method).toBe("GET")
    expect(init?.cache).toBe("no-store")
    expect(init?.credentials).toBe("include")
    expect(init?.integrity).toBe(request.integrity)
    expect(init?.keepalive).toBe(request.keepalive)
    expect(init?.mode).toBe("cors")
    expect(init?.redirect).toBe("manual")
    expect(init?.referrer).toBe(request.referrer)
    expect(init?.referrerPolicy).toBe(request.referrerPolicy)

    abort.abort()
    expect(forwardedSignal?.aborted).toBe(true)
  })

  const passthroughRequests = [
    new Request("https://packaged-ui.example/global/event", { method: "POST" }),
    new Request("https://packaged-ui.example/global/events"),
    new Request("https://packaged-ui.example/api/event"),
  ]
  for (const request of passthroughRequests) {
    test(`passes ${request.method} ${new URL(request.url).pathname} through as its normalized Request`, async () => {
      const { calls, fetchRuntime } = createRecorder()

      await createSdkGlobalEventFetch(fetchRuntime)(request)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toBeInstanceOf(Request)
      const forwarded = calls[0]?.input
      expect(forwarded).not.toBe(request)
      expect(forwarded instanceof Request ? forwarded.url : "").toBe(request.url)
      expect(forwarded instanceof Request ? forwarded.method : "").toBe(request.method)
      expect(calls[0]?.init).toBe(undefined)
    })
  }
})
